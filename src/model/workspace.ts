// The manager's state for one environment and every operation on it. The UI reads the signals and calls the methods;
// nothing else changes the state. Dialogs and notifications go through `ui` (set by the workbench), so this module
// has no UI of its own.
//
// Versions of a web resource (docs/ARCHITECTURE.md §3): published, saved (the latest saved: a draft on the server
// when it differs from published), base (the saved version a local draft started from), draft (the user's unsaved
// edit, kept in IndexedDB), theirs (a saved version found newer than base when saving).

import type { Conn } from '../core/connect';
import { Emitter, Signal } from '../core/emitter';
import { SessionError, guid, isAbort, isGuid, mayHaveRun, type Http, type LogEntry } from '../core/http';
import { storageProblem } from '../core/idb';
import { base64ToText, debounce, errorText, fingerprint, plural, pool, textToBase64 } from '../core/util';
import { ConflictError, explain } from '../dataverse/common';
import * as wr from '../dataverse/webresources';
import * as sol from '../dataverse/solutions';
import type { Diagnostic } from '../editor/lint';
import {
  DEFAULT_EXPLORER_SETTINGS,
  DEFAULT_SETTINGS,
  firstPartyPrefixes,
  isMicrosoftName,
  type AllSettings,
  type Base,
  type Change,
  type Conflict,
  type Content,
  type Draft,
  type Filter,
  type Props,
  type Scope,
  type Solution,
  type WebResource,
} from './model';
import { extensionNote, nameProblem, resxProblem } from './names';
import * as store from './store';
import { TYPES, isScriptCompanion, isTextType, type WrType } from './types';

export interface ConfirmOptions {
  title?: string;
  message: string;
  detail?: string;
  type?: 'info' | 'warning' | 'error' | 'question';
  buttons: Array<{ label: string; value: string; primary?: boolean; danger?: boolean }>;
  cancelValue: string;
  list?: string[];
  checkbox?: { label: string; checked?: boolean };
}

export interface NotifyOptions {
  severity: 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
  actions?: Array<{ label: string; run: () => void; primary?: boolean }>;
  sticky?: boolean;
  progress?: boolean | number;
  source?: string;
}

export interface UiHooks {
  confirm(o: ConfirmOptions): Promise<{ value: string; checked: boolean }>;
  notify(o: NotifyOptions): { update(p: Partial<NotifyOptions>): void; close(): void };
}

export interface OutputLine {
  at: number;
  level: 'info' | 'warn' | 'error' | 'trace';
  channel: 'Manager' | 'Dataverse';
  text: string;
}

export interface SaveResult {
  key: string;
  name: string;
  ok: boolean;
  id?: string;
  conflict?: boolean;
  skipped?: string;
  error?: string;
  warning?: string;
  /** Something was written to the server (also when the result is a conflict found right after the write). */
  written?: boolean;
}

const MAX_OUTPUT = 2000;

/** The draft key of a web resource not created yet. */
export const newKey = (name: string) => 'new:' + name.toLowerCase();

const sameProps = (a: Partial<Props>, b: Partial<Props>, keys: Array<keyof Props>) => keys.every((k) => (a[k] ?? null) === (b[k] ?? null) || (k === 'dependencyXml' && (a[k] || '') === (b[k] || '')));

/** The base a draft gets from a saved version of the server. */
const baseFrom = (c: Content): Base => ({ modifiedOn: c.modifiedOn, version: c.version, hash: fingerprint(c.b64), b64: c.b64, props: { ...c.props } });

/** Two drafts that change the same things in the same way, from the same version (null: no draft). */
export function sameDraft(a: Draft | null, b: Draft | null): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.name === b.name &&
    a.text === b.text &&
    a.b64 === b.b64 &&
    (a.bom ?? null) === (b.bom ?? null) &&
    JSON.stringify(a.props ?? null) === JSON.stringify(b.props ?? null) &&
    (a.base?.version ?? null) === (b.base?.version ?? null) &&
    (a.base?.hash ?? null) === (b.base?.hash ?? null)
  );
}

/**
 * What a manager tab does with another tab's change of a draft (Workspace.onPeer). Each tab knows which revision of
 * the draft both last had (`shared`: the last one it wrote or took from the other tab) and its own revision now
 * (`mine`: of its draft, or of the removal of the draft; '' for none).
 *  - 'have': it already has that revision;
 *  - 'take': the change was made on top of what this tab has, and this tab changed nothing since: it follows;
 *  - 'theirs' / 'mine': both tabs changed it since they last agreed. Both tabs decide the same way, so they agree
 *    again: a draft wins over a removal (a save or discard in one tab never throws away typing in the other), else
 *    the later change (then the larger revision). The losing change is kept in the local history.
 */
export function peerDecision(o: { local: Draft | null; mine: string; shared: string; incoming: Draft | null; rev: string; parent: string }): 'have' | 'take' | 'theirs' | 'mine' {
  if (o.rev && o.rev === o.mine) return 'have';
  if ((o.mine === o.shared && o.parent === o.shared) || sameDraft(o.local, o.incoming)) return 'take';
  if (!o.local) return 'theirs';
  if (!o.incoming) return 'mine';
  if (o.incoming.updatedAt !== o.local.updatedAt) return o.incoming.updatedAt > o.local.updatedAt ? 'theirs' : 'mine';
  return o.rev > o.mine ? 'theirs' : 'mine';
}

/** The published content of web resources by id, with who published it: kept in the history before a publish. */
type LiveVersions = Map<string, { b64: string; by: string }>;

/** A row version (an ETag such as W/"1234567", or the number) as a number to compare; -1 when there is none. */
const rowVersion = (v: string) => Number(/\d+/.exec(v)?.[0] ?? -1);

/** The revision of a draft stored by a build that didn't keep them: the same in every tab that reads it. */
const storedRev = (d: Draft) => (typeof d.rev === 'string' && d.rev ? d.rev : `stored.${d.updatedAt}`);

/** The properties a draft changes, in words (for a version kept in the local history). */
const propsText = (p: Partial<Props> | undefined) =>
  p
    ? Object.entries(p)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ')
    : '';

export class Workspace {
  readonly http: Http;
  /** The key of this environment in this browser's storage. */
  readonly env: string;
  ui: UiHooks = {
    confirm: async (o) => ({ value: window.confirm(`${o.message}\n\n${o.detail || ''}`) ? o.buttons.find((b) => b.primary)?.value || o.buttons[0].value : o.cancelValue, checked: !!o.checkbox?.checked }),
    notify: (o) => {
      console.log(`[${o.severity}] ${o.message}`);
      return { update() {}, close() {} };
    },
  };

  readonly settings = new Signal<AllSettings>({ ...DEFAULT_SETTINGS, ...DEFAULT_EXPLORER_SETTINGS });
  readonly resources = new Signal<ReadonlyMap<string, WebResource>>(new Map());
  readonly solutions = new Signal<Solution[]>([]);
  /** Why the solutions could not be read the last time ('' when they were): the list read before is in `solutions`. */
  readonly solutionsProblem = new Signal('');
  /** The language codes provisioned in the environment (null until read: the Explorer's language filter reads them). */
  readonly provisioned = new Signal<ReadonlySet<number> | null>(null);
  readonly scope = new Signal<Scope>({ kind: 'all' });
  /** Ids of the web resources in the scope's solution (null: every web resource). */
  readonly scopeIds = new Signal<ReadonlySet<string> | null>(null);
  readonly filter = new Signal<Filter>({ text: '', types: [], managed: true, hideMicrosoft: true, changedOnly: false, hidden: false, provisionedOnly: false });
  readonly drafts = new Signal<ReadonlyMap<string, Draft>>(new Map());
  readonly conflicts = new Signal<ReadonlyMap<string, Conflict>>(new Map());
  /** What is loading ('' when nothing). */
  readonly loading = new Signal('');
  /** Why the list could not be read ('' when it could). */
  readonly loadError = new Signal('');
  /** Keys being saved or published, with what is happening to them. */
  readonly working = new Signal<ReadonlyMap<string, string>>(new Map());
  readonly output = new Signal<OutputLine[]>([]);
  readonly problems = new Signal<ReadonlyMap<string, Diagnostic[]>>(new Map());
  /** Bumped whenever a cached saved or published content changes (open editors compare and refresh). */
  readonly contentTick = new Signal(0);
  /** The session expired: every request fails until the page is reloaded. */
  readonly sessionLost = new Signal('');
  /** The environment blocks unmanaged customizations, or the user may not write web resources ('' when writable). */
  readonly lockReason = new Signal('');
  readonly loadedAt = new Signal(0);
  /** A key changed: a new web resource was created (its draft key "new:<name>" became its id). */
  readonly rekeyed = new Emitter<{ from: string; to: string }>();

  /** The solution chosen in this session for new web resources (null: not asked yet; '' = the default solution only). */
  newSolution: string | null = null;
  /** Reloads the Dynamics page to try a published change (set by the app; drafts are kept first). */
  reloadPage: (() => void) | null = null;
  /** The keys of the web resources open in editors (set by the workbench), checked for others' changes too. */
  openKeys: () => string[] = () => [];
  /**
   * The keys whose saved versions the content cache never lets go of (set by the app: those of every open tab, as
   * properties, images and comparisons edit and compare from them too). The open editors' by default.
   */
  pinnedKeys: () => string[] = () => this.openKeys();
  /**
   * Hands typing the editors have not recorded yet over to the drafts (set by the app): another tab's change of a draft
   * is compared with everything typed here.
   */
  flushTyping: (keys: string[]) => void = () => {};
  /** Opens the local history of a web resource (set by the app), for notifications that point there. */
  showHistory: ((key: string) => void) | null = null;
  /**
   * The most characters the caches of saved and published contents hold (base64 and text): beyond it, the contents
   * used least recently go (read again when needed). A search of every file can read hundreds of megabytes.
   */
  cacheBudget = 96 * 1024 * 1024;
  /** Contents used this recently stay whatever the budget: an operation (a search, a comparison) is reading them. */
  cacheGraceMs = 60_000;
  private saved = new Map<string, Content>();
  private published = new Map<string, Content>();
  /** When each cached content ("saved|<id>", "published|<id>") was last used. */
  private used = new Map<string, number>();
  private trimLater: ReturnType<typeof setTimeout> | 0 = 0;
  /** Saves and publishes run one after another: a second Ctrl+S waits for the first and then saves what is left. */
  private queue: Promise<unknown> = Promise.resolve();
  private reading = new Map<string, Promise<Content>>();
  /** Per key: the write of its draft waiting to run (a draft is written 400 ms after its last change). */
  private persist = new Map<string, ReturnType<typeof debounce<[Draft]>>>();
  /** Draft writes started and not finished. */
  private writes = new Set<Promise<unknown>>();
  /** Pending writes of features that keep unsaved work in this browser: run with the drafts' (see onFlush). */
  private flushers = new Set<() => unknown>();
  private polling: ReturnType<typeof setInterval> | 0 = 0;
  private channel: BroadcastChannel | null = null;
  /** Messages of other tabs that came before this tab's drafts were read (handled once they are). */
  private early: unknown[] | null = [];
  private disposed = false;
  /** This tab's part of the revisions of the drafts it changes (see onPeer). */
  private readonly tabId = Math.random().toString(36).slice(2, 10);
  private revs = 0;
  /**
   * Per key: the revision of its draft this tab and the other manager tabs last had in common (the last this tab
   * wrote or took from another tab), with that draft's updatedAt (0 for a removal).
   */
  private shared = new Map<string, { rev: string; at: number }>();
  /** Per key whose draft went away: the revision of that removal. */
  private gone = new Map<string, string>();
  /** Web resources saved or published in other tabs, read again together once their messages stop. */
  private peerIds = new Map<string, 'saved' | 'published'>();
  private peerRun: Promise<void> = Promise.resolve();
  private peerSoon = debounce(() => {
    this.peerRun = this.peerRun.then(() => this.followPeers()).catch((e) => this.log('warn', `Changes made in another manager tab could not be read (${explain(e)}).`));
  }, 1000);
  /** The keys of the drafts being written to the server right now (a save writes a few at a time). */
  private savingKeys = new Set<string>();
  /** Drafts of web resources found deleted on the server, already reported (once per session). */
  private toldGone = new Set<string>();
  /** The reading of the solutions running now (callers meanwhile share it). */
  private solutionsRead: Promise<Solution[]> | null = null;
  /** Whether the list was read with the hidden web resources (the filter shows them). */
  private listedHidden = false;
  /** The first-party prefixes of the current settings (worked out again when the settings change). */
  private firstParty: { from: AllSettings | null; list: string[] } = { from: null, list: [] };
  /**
   * Per web resource: changes others saved and nobody published that a save made here went over (store.OthersChange).
   * Kept in this browser too, so another tab, or the next session, warns about them before publishing.
   */
  private others: Record<string, store.OthersChange[]> = {};
  private othersWrite: Promise<unknown> = Promise.resolve();

  constructor(readonly conn: Conn) {
    this.http = conn.http;
    this.env = conn.key;
    this.http.onLog = (e) => this.logRequest(e);
    this.http.onSessionLost = (e) => {
      if (!this.sessionLost.value) {
        this.sessionLost.value = e.message;
        this.log('error', e.message);
      }
    };
  }

  // ------------------------------------------------------------------ start, stop

  /** Reads what this browser keeps for the environment, then the web resources and solutions. */
  /**
   * Restores this browser's state for the environment (settings, unsaved changes) and starts following the other
   * manager tabs; then start() reads the list. Quick: nothing is read from the server.
   */
  restore(): Promise<void> {
    return (this.restored ??= this.restoreNow());
  }

  private restored: Promise<void> | null = null;

  /** Restores (restore()), reads the list of web resources and the solutions, then checks for others' changes every minute. */
  async start(): Promise<void> {
    await this.restore();
    // The list read also reads the solutions.
    await Promise.all([this.refresh(), this.checkLockdown()]);
    this.polling = setInterval(() => {
      this.trimCache();
      if (document.visibilityState === 'visible' && !this.sessionLost.value) void this.checkForChanges(this.openKeys()).catch(() => undefined);
    }, 60_000);
  }

  private async restoreNow(): Promise<void> {
    this.settings.value = await store.loadSettings(this.env);
    const f = this.filter.value;
    this.filter.value = { ...f, hideMicrosoft: this.settings.value.hideMicrosoft, managed: this.settings.value.showManaged, hidden: this.settings.value.showHidden };
    // Showing hidden web resources reads the list again with them (and without them again when turned off); the
    // language filter needs the provisioned languages.
    this.filter.subscribe((x) => {
      if (this.disposed) return;
      // A refresh running now reads the list again as asked when it ends.
      if (x.hidden !== this.listedHidden && this.loadedAt.value && !this.refreshing) void this.refresh();
      if (x.provisionedOnly && !this.provisioned.value) void this.loadProvisioned();
    });
    this.others = await store.loadOthers(this.env);
    // Other tabs are listened to before the drafts are read: a change one of them writes meanwhile is not missed.
    try {
      this.channel = new BroadcastChannel(`wrm|${this.env}`);
      this.channel.onmessage = (m) => this.onPeer(m.data);
    } catch {
      /* no other tabs to tell */
    }
    const drafts = (await store.loadDrafts(this.env)).map((d) => ({ ...d, rev: storedRev(d) }));
    for (const d of drafts) this.shared.set(d.key, { rev: d.rev, at: d.updatedAt });
    this.drafts.value = new Map(drafts.map((d) => [d.key, d]));
    if (drafts.length) this.log('info', `${plural(drafts.length, 'unsaved change')} kept from the last session.`);
    const early = this.early || [];
    this.early = null;
    for (const m of early) this.onPeer(m);
    void store.persistStorage();
  }

  /** Whether something that must not be interrupted is running (a save, a publish, a delete). */
  busy(): boolean {
    return this.http.liveWrites > 0 || this.working.value.size > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    // Pending draft writes start now (and the other tabs hear of them) before the channel closes.
    void this.flushDrafts();
    this.disposed = true;
    if (this.polling) clearInterval(this.polling);
    if (this.trimLater) clearTimeout(this.trimLater);
    this.peerSoon.cancel();
    this.channel?.close();
    this.channel = null;
    this.http.onLog = null;
  }

  /**
   * Writes every draft change still waiting, and what features keep waiting (onFlush), now. The writes start before
   * this returns, so they are kept even when the frame or the page goes away right after (core/idb.ts); the promise
   * resolves when they are stored.
   */
  flushDrafts(): Promise<void> {
    const extra: unknown[] = [];
    for (const f of this.flushers)
      try {
        extra.push(f());
      } catch {
        /* one feature's failure doesn't keep the drafts from being written */
      }
    for (const p of this.persist.values()) p.flush();
    return Promise.all([...extra, ...this.writes]).then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Registers a feature's own pending writes of unsaved work (form script edits…): run by flushDrafts, when the manager
   * closes or the page goes away. Returns the function that unregisters it.
   */
  onFlush(fn: () => unknown): () => void {
    this.flushers.add(fn);
    return () => this.flushers.delete(fn);
  }

  // ------------------------------------------------------------------ output

  log(level: OutputLine['level'], text: string, channel: OutputLine['channel'] = 'Manager'): void {
    const lines = this.output.value.length >= MAX_OUTPUT ? this.output.value.slice(-MAX_OUTPUT + 200) : this.output.value.slice();
    lines.push({ at: Date.now(), level, channel, text });
    this.output.value = lines;
  }

  private logRequest(e: LogEntry): void {
    const what = e.label ? `${e.label} — ` : '';
    const status = e.status ? String(e.status) : 'failed';
    this.log(e.error && e.status !== 404 ? 'warn' : 'trace', `${e.method} ${decodeURIComponent(e.path).slice(0, 200)} → ${status} (${e.ms} ms)${e.attempt ? ` [retry ${e.attempt}]` : ''}${e.error ? ` ${e.error}` : ''} ${what ? `· ${e.label}` : ''}`.trim(), 'Dataverse');
  }

  /** Shows an error as a notification and in the Output panel. */
  fail(e: unknown, what: string): void {
    if (isAbort(e)) return;
    const text = explain(e);
    this.log('error', `${what}: ${text}`);
    if (e instanceof SessionError) return; // the session banner says it once
    this.ui.notify({ severity: 'error', message: `${what}: ${text}`, source: 'Dataverse' });
  }

  // ------------------------------------------------------------------ settings

  updateSettings(patch: Partial<AllSettings>): void {
    this.settings.value = store.cleanSettings({ ...this.settings.value, ...patch });
    void store.saveSettings(this.env, this.settings.value);
  }

  /** The prefixes "Hide Microsoft's web resources" hides: the built-in list, as the settings change it. */
  firstPartyPrefixes(): string[] {
    const s = this.settings.value;
    if (this.firstParty.from !== s) this.firstParty = { from: s, list: firstPartyPrefixes(s) };
    return this.firstParty.list;
  }

  /** Whether a name is of a first-party web resource (Microsoft's), with this environment's settings. */
  isFirstParty(name: string): boolean {
    return isMicrosoftName(name, this.firstPartyPrefixes());
  }

  /** Why nothing can be changed now ('' when changes are allowed). */
  readOnlyReason(): string {
    if (this.sessionLost.value) return this.sessionLost.value;
    if (this.settings.value.readOnly) return 'Read-only mode is on.';
    return this.lockReason.value;
  }

  private async checkLockdown(): Promise<void> {
    try {
      const r = await this.http.get(
        `systemusers(${this.conn.userId})/Microsoft.Dynamics.CRM.RetrieveUserSetOfPrivilegesByNames(PrivilegeNames=@p)?@p=${encodeURIComponent(JSON.stringify(['prvCreateWebResource', 'prvWriteWebResource']))}`,
        { label: 'Your privileges' },
      );
      const names = new Set(((r?.RolePrivileges as any[]) || []).map((p) => String(p.PrivilegeName).toLowerCase()));
      if (!names.has('prvwritewebresource')) this.lockReason.value = 'Your security roles don\'t allow changing web resources (privilege Write Web Resource).';
    } catch {
      // Older versions don't have the function: the server says so when a save is refused.
    }
  }

  // ------------------------------------------------------------------ reading

  get(id: string): WebResource | undefined {
    return this.resources.value.get(id);
  }

  byName(name: string): WebResource | undefined {
    const n = name.toLowerCase();
    for (const w of this.resources.value.values()) if (w.name.toLowerCase() === n) return w;
    return undefined;
  }

  /** Web resources read by name (named()): kept when the list is read again without them (hidden ones). */
  private namedIds = new Set<string>();

  /**
   * Reads the web resources of these names the list doesn't have (it is still being read, or they are hidden) and adds
   * them to it: a form's scripts open at once, without waiting for the list of every web resource.
   */
  async named(names: string[], withText: (name: string) => boolean = () => false): Promise<void> {
    const missing = [...new Set(names.filter((n) => n && !this.byName(n)).map((n) => n.toLowerCase()))];
    if (!missing.length) return;
    // Those `withText` (lower-case names) come with their latest saved text: opening one then needs no request.
    const texts = missing.filter(withText);
    const rest = missing.filter((n) => !withText(n));
    const contents = new Map<string, Content>();
    const lists = await Promise.all([texts.length ? wr.listWebResources(this.http, { names: texts, contents }) : [], rest.length ? wr.listWebResources(this.http, { names: rest }) : []]);
    if (this.disposed) return;
    for (const [id, c] of contents) if (!this.saved.has(id)) this.keep('saved', id, c);
    const found = lists.flat();
    if (!found.length) return;
    const map = new Map(this.resources.value);
    for (const w of found) {
      if (map.has(w.id)) continue;
      map.set(w.id, w);
      this.namedIds.add(w.id);
    }
    this.resources.value = map;
  }

  /** The name and type a key stands for (a web resource or a draft of a new one). */
  describe(key: string): { name: string; type: WrType; id?: string } | null {
    const w = this.get(key);
    if (w) return { name: w.name, type: w.type, id: w.id };
    const d = this.drafts.value.get(key);
    return d ? { name: d.name, type: d.type } : null;
  }

  /**
   * Reads the list of web resources again (drafts are kept; conflicts are looked for), and the solutions with it: a
   * solution made or re-versioned meanwhile is offered when one is chosen.
   */
  async refresh(): Promise<void> {
    this.loading.value = 'Loading web resources…';
    this.refreshing++;
    const solutions = this.loadSolutions();
    const hidden = this.filter.value.hidden;
    try {
      const list = await wr.listWebResources(this.http, { hidden });
      const map = new Map(list.map((w) => [w.id, w]));
      // Solutions already read for web resources are kept.
      for (const [id, w] of map) {
        const old = this.resources.value.get(id);
        if (old?.solutions) w.solutions = old.solutions;
      }
      for (const [id, old] of this.resources.value) {
        const w = map.get(id);
        // Read by name (named()) and not in the list: a hidden web resource a form loads stays.
        if (!w) {
          if (this.namedIds.has(id)) map.set(id, old);
        }
        // Saved here while the list was being read: the list has the version before.
        else if (rowVersion(old.version) > rowVersion(w.version)) map.set(id, old);
      }
      this.resources.value = map;
      this.listedHidden = hidden;
      this.loadError.value = '';
      this.loadedAt.value = Date.now();
      this.log('info', `${plural(list.length, 'web resource')} read${hidden ? `, ${list.filter((w) => w.isHidden).length} of them hidden` : ''} (${plural(list.filter((w) => w.unpublished).length, 'with saved changes', 'with saved changes')} not published).`);
      // Cached contents whose version changed are dropped (read again when needed).
      for (const [id, c] of this.saved) if (map.get(id)?.version !== c.version) this.saved.delete(id);
      this.contentTick.value++;
      this.forgetPublishedOthers();
      await this.recheckDrafts();
      if (this.scope.value.kind === 'solution') await this.loadScope(this.scope.value);
    } catch (e) {
      this.loadError.value = explain(e);
      this.fail(e, 'The web resources could not be read');
    } finally {
      this.loading.value = '';
      await solutions;
      this.refreshing--;
    }
    // The hidden web resources were turned on or off while the list was read: read it as asked now.
    if (this.filter.value.hidden !== this.listedHidden && this.loadedAt.value && !this.refreshing && !this.disposed) await this.refresh();
  }

  /** Refreshes running now. */
  private refreshing = 0;

  /**
   * Reads the solutions again and returns them (one read at a time: callers meanwhile share it). It runs with every
   * refresh, and the solution pickers call it when they open. When it fails, the list read before stays (and
   * solutionsProblem says why); a notification says so when there is no list at all.
   */
  loadSolutions(): Promise<Solution[]> {
    if (this.solutionsRead) return this.solutionsRead;
    const p = sol
      .listSolutions(this.http)
      .then(
        (list) => {
          this.solutions.value = list;
          this.solutionsProblem.value = '';
          return list;
        },
        (e) => {
          this.solutionsProblem.value = explain(e);
          if (!this.solutions.value.length) this.fail(e, 'The solutions could not be read');
          else this.log('warn', `The solutions could not be read again (${explain(e)}); the list read before is used.`);
          return this.solutions.value;
        },
      )
      .finally(() => (this.solutionsRead = null));
    this.solutionsRead = p;
    return p;
  }

  /**
   * The solution new web resources go in (targetSolution), with the solutions read again first when the list may be
   * out of date: never read, or without the default solution the settings name (made since the manager opened). Throws
   * when that default solution can't be looked for because the solutions can't be read: the new web resources would
   * silently go into no solution but the default one. Null when there is no target: the caller asks which one.
   */
  async targetSolutionNow(): Promise<Solution | null> {
    const scope = this.scope.value;
    if (scope.kind === 'solution' && !scope.solution.isManaged) return scope.solution;
    const want = this.settings.value.defaultSolution;
    if (!this.solutions.value.length || (want && !this.targetSolution())) await this.loadSolutions();
    const t = this.targetSolution();
    if (!t && want && this.solutionsProblem.value)
      throw new Error(`The solutions could not be read (${this.solutionsProblem.value}), so ${want}, the default solution for new web resources, can't be used. Nothing was created: try again in a moment.`);
    return t;
  }

  /** Reads the languages provisioned in the environment, for the Explorer's language filter (turned off when it fails). */
  loadProvisioned(): Promise<void> {
    this.provisionedRead ??= this.http
      .get('RetrieveProvisionedLanguages()', { label: 'Provisioned languages' })
      .then(
        (r) => {
          const codes = Array.isArray(r?.RetrieveProvisionedLanguages) ? (r.RetrieveProvisionedLanguages as unknown[]) : [];
          this.provisioned.value = new Set(codes.map(Number).filter((n) => Number.isInteger(n) && n > 0));
        },
        (e) => {
          this.fail(e, "The environment's languages could not be read, so web resources are not filtered by language");
          if (this.filter.value.provisionedOnly) this.filter.value = { ...this.filter.value, provisionedOnly: false };
        },
      )
      .finally(() => (this.provisionedRead = null));
    return this.provisionedRead;
  }

  private provisionedRead: Promise<void> | null = null;

  /** Shows only the web resources of a solution (or all). */
  async setScope(scope: Scope): Promise<void> {
    this.scopeTicket++;
    this.scope.value = scope;
    if (scope.kind === 'all') {
      this.scopeIds.value = null;
      return;
    }
    await this.loadScope(scope);
  }

  /** The latest setScope: a solution still being read when another scope was chosen doesn't replace it. */
  private scopeTicket = 0;

  private async loadScope(scope: Extract<Scope, { kind: 'solution' }>): Promise<void> {
    const ticket = this.scopeTicket;
    this.loading.value = `Loading ${scope.solution.friendlyName}…`;
    try {
      const ids = await sol.webResourcesOf(this.http, scope.solution.id);
      if (ticket === this.scopeTicket) this.scopeIds.value = ids;
    } catch (e) {
      this.fail(e, `The web resources of ${scope.solution.friendlyName} could not be read`);
    } finally {
      this.loading.value = '';
    }
  }

  /** Every web resource the Explorer shows now: scope and filter applied (new drafts included). */
  visible(): WebResource[] {
    const f = this.filter.value;
    const ids = this.scopeIds.value;
    const drafts = this.drafts.value;
    let re: RegExp | null = null;
    const m = /^\/(.+)\/([a-z]*)$/i.exec(f.text.trim());
    if (m)
      try {
        re = new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i');
      } catch {
        re = null;
      }
    const text = f.text.trim().toLowerCase();
    const firstParty = this.firstPartyPrefixes();
    const only = this.settings.value.onlyPrefixes;
    const languages = f.provisionedOnly ? this.provisioned.value : null;
    const out: WebResource[] = [];
    for (const w of this.resources.value.values()) {
      if (ids && !ids.has(w.id)) continue;
      if (w.isHidden && !f.hidden) continue;
      if (!f.managed && w.isManaged) continue;
      if (f.hideMicrosoft && isMicrosoftName(w.name, firstParty)) continue;
      if (only.length && !only.some((p) => w.name.toLowerCase().startsWith(p))) continue;
      if (languages && w.languageCode != null && !languages.has(w.languageCode)) continue;
      if (f.types.length && !f.types.includes(w.type)) continue;
      if (f.changedOnly && !w.unpublished && !drafts.has(w.id) && !this.conflicts.value.has(w.id)) continue;
      if (text && !(re ? re.test(w.name) || re.test(w.displayName) : w.name.toLowerCase().includes(text) || w.displayName.toLowerCase().includes(text))) continue;
      out.push(w);
    }
    return out;
  }

  /** The saved (or published) content of a web resource, read once and kept until its version changes. */
  content(id: string, which: 'saved' | 'published' = 'saved', force = false): Promise<Content> {
    const cache = which === 'saved' ? this.saved : this.published;
    const hit = cache.get(id);
    if (hit && !force) {
      this.used.set(`${which}|${id}`, Date.now());
      return Promise.resolve(hit);
    }
    const k = `${which}|${id}`;
    const running = this.reading.get(k);
    if (running && !force) return running;
    const w = this.get(id);
    const text = w ? isTextType(w.type) : true;
    const p = (which === 'saved' ? wr.getSaved(this.http, id, text) : wr.getPublished(this.http, id, text))
      .then((c) => {
        const before = cache.get(id);
        this.keep(which, id, c);
        if (!before || before.version !== c.version || before.b64 !== c.b64) this.contentTick.value++;
        return c;
      })
      .finally(() => this.reading.delete(k));
    this.reading.set(k, p);
    return p;
  }

  /**
   * Reads the saved content of many web resources at once (50 per request, 3 requests at a time), keeping it like
   * content() does: for searching their text. Web resources already read are not read again. Returns them by id.
   */
  async loadContents(ids: string[], progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Map<string, Content>> {
    const out = new Map<string, Content>();
    const todo: string[] = [];
    for (const id of ids) {
      const c = this.saved.get(id);
      if (c && this.get(id)?.version === c.version) {
        out.set(id, c);
        this.used.set(`saved|${id}`, Date.now());
      } else if (this.get(id)) todo.push(id);
    }
    let done = out.size;
    progress?.(done, ids.length);
    await this.readSaved(todo, signal, (n) => {
      done += n;
      progress?.(done, ids.length);
    }).then((rows) => rows.forEach((c, id) => out.set(id, c)));
    this.contentTick.value++;
    return out;
  }

  /** The saved versions of web resources read now with their content (50 per request, 3 at a time), and kept. */
  private async readSaved(ids: string[], signal?: AbortSignal, progress?: (n: number) => void): Promise<Map<string, Content>> {
    const out = new Map<string, Content>();
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
    await pool(chunks, 3, async (chunk) => {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const rows = await wr.savedVersionsWithContent(this.http, chunk, signal);
      for (const [id, c] of rows) {
        this.keep('saved', id, c);
        out.set(id, c);
      }
      progress?.(chunk.length);
    });
    return out;
  }

  /** The saved content already read, without a request (undefined when not read yet). */
  cached(id: string, which: 'saved' | 'published' = 'saved'): Content | undefined {
    const c = (which === 'saved' ? this.saved : this.published).get(id);
    if (c) this.used.set(`${which}|${id}`, Date.now());
    return c;
  }

  /** Keeps a content read (in the cache of its kind), as just used; the cache is trimmed soon when over its budget. */
  private keep(which: 'saved' | 'published', id: string, c: Content): void {
    (which === 'saved' ? this.saved : this.published).set(id, c);
    this.used.set(`${which}|${id}`, Date.now());
    if (!this.trimLater && !this.disposed) this.trimLater = setTimeout(() => ((this.trimLater = 0), this.trimCache()), 1000);
  }

  /**
   * Keeps the cached contents within cacheBudget: the least recently used go first. Never those of open editors, of
   * drafts, conflicts and saves (they are the versions edits start from), nor one used in the last cacheGraceMs (an
   * operation is reading it): those make the cache wait, and it is trimmed again later.
   */
  trimCache(): void {
    const size = (c: Content) => c.b64.length + (c.text?.length ?? 0);
    let total = 0;
    for (const c of this.saved.values()) total += size(c);
    for (const c of this.published.values()) total += size(c);
    if (total <= this.cacheBudget) return;
    const pinned = new Set<string>([...this.pinnedKeys(), ...this.working.value.keys(), ...this.conflicts.value.keys()]);
    for (const d of this.drafts.value.values()) if (d.id) pinned.add(d.id);
    const now = Date.now();
    const old: Array<{ which: 'saved' | 'published'; id: string; at: number; size: number }> = [];
    let waiting = false;
    for (const which of ['saved', 'published'] as const)
      for (const [id, c] of which === 'saved' ? this.saved : this.published) {
        if (pinned.has(id)) continue;
        const at = this.used.get(`${which}|${id}`) ?? 0;
        if (now - at < this.cacheGraceMs) waiting = true;
        else old.push({ which, id, at, size: size(c) });
      }
    old.sort((a, b) => a.at - b.at);
    for (const o of old) {
      if (total <= this.cacheBudget) break;
      (o.which === 'saved' ? this.saved : this.published).delete(o.id);
      this.used.delete(`${o.which}|${o.id}`);
      total -= o.size;
    }
    if (total > this.cacheBudget && waiting && !this.trimLater && !this.disposed) this.trimLater = setTimeout(() => ((this.trimLater = 0), this.trimCache()), this.cacheGraceMs);
  }

  // ------------------------------------------------------------------ drafts

  draft(key: string): Draft | undefined {
    return this.drafts.value.get(key);
  }

  isDirty(key: string): boolean {
    return this.drafts.value.has(key);
  }

  /** Records a change of a draft made in this tab (null: the draft goes away), kept in this browser 400 ms later. */
  private setDraft(d: Draft | null, key: string): void {
    const next = new Map(this.drafts.value);
    // Every change is a new revision: other manager tabs tell from it whether a change of theirs came after this one.
    if (d) {
      d = { ...d, rev: `${this.tabId}.${++this.revs}` };
      next.set(key, d);
      this.gone.delete(key);
    } else {
      next.delete(key);
      // A conflict lives as long as its draft: with the draft gone (saved, discarded, typed back to where it started,
      // removed in another tab) there is nothing left to resolve, and the file must not stay locked.
      this.clearConflict(key);
    }
    this.drafts.value = next;
    let p = this.persist.get(key);
    if (!p) {
      p = debounce((x: Draft) => this.write(key, x), 400);
      this.persist.set(key, p);
    }
    if (d) p(d);
    else {
      p.cancel();
      // Nothing to remove when the draft was never written (nor taken from another tab).
      if (this.shared.get(key)?.rev) this.write(key, null);
    }
  }

  /**
   * Writes a draft, or its removal, to this browser's storage now and tells the other manager tabs. The draft goes
   * with the message, so another tab never reads storage for it (where it could find the version before this one);
   * the write is started first, so a write that tab makes after hearing of it is stored after it.
   */
  private write(key: string, d: Draft | null): void {
    const parent = this.shared.get(key) ?? { rev: '', at: 0 };
    const rev = d?.rev || `${this.tabId}.${++this.revs}`;
    if (!d) this.gone.set(key, rev);
    this.shared.set(key, { rev, at: d?.updatedAt ?? 0 });
    const w = (d ? store.saveDraft(this.env, d) : store.deleteDraft(this.env, key)).catch(() => undefined);
    this.writes.add(w);
    void w.finally(() => this.writes.delete(w));
    // parentAt: when the user last changed the version this one was made from (see peerDraft).
    this.post({ kind: 'draft', key, draft: d, rev, parent: parent.rev, parentAt: parent.at });
  }

  /**
   * Another manager tab of this environment changed a draft. It is followed when it was made on top of what this tab
   * has; when both tabs changed it since they last agreed, both keep the same one (peerDecision) and the other goes to
   * the local history, with a notification: no typing is ever lost to the other tab.
   */
  private peerDraft(key: string, incoming: Draft | null, rev: string, parent: string, parentAt: number): void {
    try {
      this.flushTyping([key]);
    } catch {
      /* the editors' failure doesn't stop following the other tab */
    }
    const local = this.draft(key) ?? null;
    const mine = local?.rev ?? this.gone.get(key) ?? '';
    const shared = this.shared.get(key) ?? { rev: '', at: 0 };
    const how = peerDecision({ local, mine, shared: shared.rev, incoming, rev, parent });
    if (how === 'have') return;
    if (how === 'take') return this.adopt(key, incoming, rev);
    const name = (incoming || local)!.name;
    // A side whose change since the version both started from (`parentAt`: when the user last changed that one) is only
    // a new base, not typing (a refresh moved it up), has nothing to keep.
    const typed = (d: Draft | null) => !!d && d.updatedAt !== parentAt;
    // Made in this tab (not one it followed from a third tab).
    const own = (d: Draft | null) => !!d?.rev?.startsWith(this.tabId + '.');
    const history = this.showHistory ? [{ label: 'Open Local History', run: () => this.showHistory?.(key) }] : undefined;
    if (how === 'theirs') {
      if (typed(local)) {
        void this.keepVersion(local!, 'A change replaced by one made at the same time in another manager tab');
        if (own(local)) this.ui.notify({ severity: 'warning', message: `${name} was also changed in another manager tab at the same time. This tab now shows that change; yours is kept in the local history.`, actions: history });
        else this.log('warn', `${name}: two other manager tabs changed it at the same time; the earlier change is kept in the local history.`);
      } else if (!local && incoming) this.log('info', `${name}: a change made in another manager tab is unsaved here again.`);
      this.adopt(key, incoming, rev);
      return;
    }
    // This tab's draft stays. The other tab's change is kept in the local history, and this one is written again: theirs
    // may be the one stored now.
    if (typed(incoming)) {
      void this.keepVersion(incoming!, 'A change made in another manager tab, replaced by one made at the same time');
      this.ui.notify({
        severity: 'info',
        message: `${name} was also changed in another manager tab at the same time. ${own(local) ? "This tab's change is kept" : 'The later change is kept'}; the other one is in the local history.`,
        actions: history,
      });
    }
    if (!this.persist.get(key)?.pending()) this.write(key, local);
  }

  /** Takes another tab's revision of a draft as this tab's (it is stored already: not written again). */
  private adopt(key: string, d: Draft | null, rev: string): void {
    // A write of this tab's older version waiting to run would undo it.
    this.persist.get(key)?.cancel();
    const next = new Map(this.drafts.value);
    if (d) {
      next.set(key, { ...d, rev });
      this.gone.delete(key);
      // A conflict found here against a base the other tab no longer has (it resolved or rebased) is over.
      const c = this.conflicts.value.get(key);
      if (c && (c.base.version !== d.base?.version || c.base.hash !== d.base?.hash)) this.clearConflict(key);
    } else {
      next.delete(key);
      this.gone.set(key, rev);
      this.clearConflict(key);
      // Most often the other tab saved it: the saved version kept here is older, and an editor showing it would go back
      // to the old text until that save's message comes. Read again when shown (the editor keeps its text meanwhile).
      this.saved.delete(key);
    }
    this.shared.set(key, { rev, at: d?.updatedAt ?? 0 });
    this.drafts.value = next;
    this.contentTick.value++;
  }

  /** An older build of the manager in another tab sends only the key, and writes its draft 400 ms later: read then. */
  private peerDraftByKey(key: string): void {
    setTimeout(() => {
      void store.loadDraft(this.env, key).then((stored) => {
        if (this.disposed) return;
        const local = this.draft(key) ?? null;
        // This tab's own change waiting to be written is not replaced by one whose history is unknown.
        if ((local?.rev ?? this.gone.get(key) ?? '') !== (this.shared.get(key)?.rev ?? '')) return;
        const d = stored ? { ...stored, rev: storedRev(stored) } : null;
        if (!sameDraft(local, d)) this.adopt(key, d, d?.rev ?? `${this.tabId}.${++this.revs}`);
      });
    }, 700);
  }

  /** Keeps a version of a draft in the local history (a change replaced by another tab's). */
  private keepVersion(d: Draft, note: string): Promise<unknown> {
    const b64 = d.text !== undefined ? textToBase64(d.text, d.bom ?? false) : (d.b64 ?? d.base?.b64 ?? '');
    const props = propsText(d.props);
    return store
      .addHistory(this.env, { key: d.key, name: d.name, type: d.type, at: Date.now(), kind: 'snapshot', by: this.conn.userName, b64, note: props ? `${note} (properties: ${props})` : note }, Math.max(1, this.settings.value.historyPerFile))
      .catch(() => undefined);
  }

  private baseOf(id: string): Base {
    const c = this.saved.get(id);
    if (!c) throw new Error('The saved version must be read before it is edited.');
    return baseFrom(c);
  }

  /** The text an editor shows: the draft's, else the saved version's (undefined when not read yet). */
  textOf(key: string): string | undefined {
    const d = this.draft(key);
    if (d?.text !== undefined) return d.text;
    if (d?.b64 !== undefined) return base64ToText(d.b64).text;
    return this.saved.get(key)?.text;
  }

  /**
   * Records an edit of a text web resource. `shown` is the saved version the editor was showing when the edit was
   * made: a new draft starts from it (its base), whatever the cache holds by now — a list refresh may have read a newer
   * version meanwhile, and the conflict check must compare with what the user actually edited. Back to exactly the
   * base's text and properties, the draft goes away. `shownIsCurrent`: the editor keeps `shown` up to date also while a
   * draft changes only properties (it then always names the version the text was typed on).
   */
  editText(key: string, text: string, shown?: Content, shownIsCurrent = false): void {
    const d = this.draft(key);
    if (!d) {
      const w = this.get(key);
      if (!w) return;
      const from = shown ?? this.saved.get(key);
      if (!from) {
        // Never drop an edit silently: without a known base it can't be saved safely, so say so.
        this.log('error', `${w.name}: the edit could not be recorded because the version it was made on is unknown. Reopen the file.`);
        this.ui.notify({ severity: 'error', message: `${w.name}: reopen the file before editing it (its saved version is not loaded).` });
        return;
      }
      if (from.text === text) return;
      this.setDraft({ key, id: key, name: w.name, type: w.type, text, bom: from.bom, base: baseFrom(from), updatedAt: Date.now() }, key);
      return;
    }
    if (shownIsCurrent && shown && d.id && d.base && d.text === undefined && d.b64 === undefined && fingerprint(shown.b64) !== d.base.hash) {
      // A draft of properties only whose base a refresh moved to a newer content, while the editor still showed the
      // older text it was typed on: the typing is based on what it was typed on, and checked now, so the newer content
      // is a conflict instead of being written over by the old text plus the typing.
      const typed: Draft = { ...d, text, b64: undefined, bom: shown.bom, base: baseFrom(shown), updatedAt: Date.now() };
      this.setDraft(typed, key);
      void this.check(typed).catch(() => undefined);
      return;
    }
    const next: Draft = { ...d, text, b64: undefined, updatedAt: Date.now() };
    if (this.unchanged(next)) this.setDraft(null, key);
    else this.setDraft(next, key);
  }

  /** Replaces a web resource's bytes (an image, or any file uploaded over it). */
  editBytes(key: string, b64: string): void {
    const d = this.draft(key);
    const w = this.get(key);
    const base = d ? d.base : w ? this.baseOf(key) : null;
    const name = d?.name ?? w?.name;
    const type = d?.type ?? w?.type;
    if (!name || !type) return;
    const text = isTextType(type) ? base64ToText(b64).text : undefined;
    const next: Draft = { ...(d || { key, id: w?.id, name, type, base, updatedAt: 0 }), text, b64: text === undefined ? b64 : undefined, bom: text !== undefined ? base64ToText(b64).bom : d?.bom, updatedAt: Date.now() };
    // New bytes are a change when saving them changes the bytes: a byte order mark or an encoding only, too.
    if (this.unchanged(next, true)) this.setDraft(null, key);
    else this.setDraft(next, key);
  }

  /** Records a change of properties (display name, description, language, dependencies…). */
  editProps(key: string, patch: Partial<Props>): void {
    const d = this.draft(key);
    const w = this.get(key);
    if (!d && !w) return;
    const base = d ? d.base : this.baseOf(key);
    const next: Draft = d ? { ...d, props: { ...d.props, ...patch }, updatedAt: Date.now() } : { key, id: w!.id, name: w!.name, type: w!.type, props: { ...patch }, base, updatedAt: Date.now() };
    if (this.unchanged(next)) this.setDraft(null, key);
    else this.setDraft(next, key);
  }

  /** Drops changes of properties (all of them, or these), keeping a change of the content. */
  revertProps(key: string, which?: Array<keyof Props>): void {
    const d = this.draft(key);
    if (!d?.props) return;
    const props = which ? Object.fromEntries(Object.entries(d.props).filter(([k]) => !which.includes(k as keyof Props))) : undefined;
    const next: Draft = { ...d, props: props && Object.keys(props).length ? props : undefined, updatedAt: Date.now() };
    if (this.unchanged(next)) this.setDraft(null, key);
    else this.setDraft(next, key);
  }

  /**
   * A draft that changes nothing compared with its base. Text is compared as text and byte order mark (typing back
   * what was there is no change, whatever the file's encoding); `exactBytes` compares the bytes a save would write.
   */
  private unchanged(d: Draft, exactBytes = false): boolean {
    if (!d.base) return false; // a new web resource is always a change
    const base = base64ToText(d.base.b64);
    const contentSame =
      d.text !== undefined
        ? exactBytes
          ? textToBase64(d.text, d.bom ?? false) === d.base.b64
          : d.text === base.text && (d.bom ?? base.bom) === base.bom
        : d.b64 !== undefined
          ? d.b64 === d.base.b64
          : true;
    const propsSame = !d.props || sameProps(d.props, d.base.props, Object.keys(d.props) as Array<keyof Props>);
    return contentSame && propsSame;
  }

  /**
   * Throws local changes away (the editors show the saved version again). A draft waiting for its turn in a running
   * save can go (the save skips it); the one being written to the server at this moment can't: its write is on its way.
   */
  discard(keys: string[]): void {
    for (const k of keys) {
      if (this.savingKeys.has(k)) {
        this.ui.notify({
          severity: 'warning',
          message: `${this.describe(k)?.name ?? 'This file'} is being saved right now, so its change can't be discarded any more.`,
          detail: 'Once it is saved, the published version stays as it is until you publish.',
        });
        continue;
      }
      this.setDraft(null, k);
    }
    this.contentTick.value++;
  }

  /**
   * Starts a new web resource as a draft (created on the server when saved). Returns its key; throws when the name
   * can't be used.
   */
  createDraft(o: { name: string; type: WrType; text?: string; b64?: string; props?: Partial<Props>; solution?: string }): string {
    const solution = o.solution ?? this.targetSolution()?.uniqueName ?? '';
    const prefix = this.solutions.value.find((s) => s.uniqueName === solution)?.prefix || '';
    const problem = nameProblem(o.name, prefix) || (o.type === 12 ? resxProblem(o.name, o.props?.languageCode ?? null) : '');
    if (problem) throw new Error(problem);
    if (this.byName(o.name)) throw new Error(`${o.name} already exists.`);
    const key = newKey(o.name);
    if (this.drafts.value.has(key)) throw new Error(`${o.name} is already waiting to be created (see Source Control).`);
    // A file's bytes are kept exactly: its BOM is written back; Windows-1252 text is converted to UTF-8 (said once).
    const decoded = o.text === undefined && o.b64 !== undefined && isTextType(o.type) ? base64ToText(o.b64) : null;
    if (decoded?.encoding === 'windows-1252') this.log('warn', `${o.name} is not UTF-8 (read as Windows-1252): it will be saved as UTF-8.`);
    const text = o.text ?? decoded?.text;
    this.setDraft(
      {
        key,
        name: o.name,
        type: o.type,
        text,
        bom: decoded?.bom,
        b64: text === undefined ? (o.b64 ?? '') : undefined,
        props: { displayName: o.name.split('/').pop(), ...o.props },
        base: null,
        solution,
        updatedAt: Date.now(),
      },
      key,
    );
    // A source map or TypeScript source uploaded next to its script is a Script with its own extension on purpose.
    const note = o.type === 3 && isScriptCompanion(o.name) ? '' : extensionNote(o.name, o.type);
    if (note) this.log('warn', `${o.name}: ${note}`);
    return key;
  }

  /** The solution new web resources go in: the scope's (when unmanaged), else the default from the settings. */
  targetSolution(): Solution | null {
    const s = this.scope.value;
    if (s.kind === 'solution' && !s.solution.isManaged) return s.solution;
    return this.solutions.value.find((x) => x.uniqueName === this.settings.value.defaultSolution) || null;
  }

  // ------------------------------------------------------------------ conflicts

  private clearConflict(key: string): void {
    if (!this.conflicts.value.has(key)) return;
    const next = new Map(this.conflicts.value);
    next.delete(key);
    this.conflicts.value = next;
  }

  private addConflict(c: Conflict, at = Date.now()): void {
    const next = new Map(this.conflicts.value);
    next.set(c.key, c);
    this.conflicts.value = next;
    // Kept even when the local history is off, as a version kept before deleting is: "Keep mine" writes over theirs,
    // and the conflict editor says their version stays here.
    void store.addHistory(this.env, { key: c.key, name: c.name, type: this.get(c.id)?.type || 3, at, kind: 'theirs', by: c.theirs.modifiedBy, b64: c.theirs.b64 }, Math.max(1, this.settings.value.historyPerFile));
  }

  /**
   * Compares a draft's base with the server's saved version now. A change the draft doesn't touch moves the base up
   * (rebase); a change to something the draft changes too is a conflict. `now` is the server's version a save just read
   * (the save's own check). Without it, the check comes from a refresh, the poll or another tab, and leaves a draft
   * being saved alone: the save checks it itself, and its own write must not read as someone else's change.
   */
  private async check(d: Draft, now?: Content): Promise<Conflict | null> {
    if (!d.base || !d.id) return null;
    if (!now && this.working.value.has(d.key)) return null;
    const cur = now ?? (await this.content(d.id, 'saved', true));
    // Judged on the draft as it is now: the user may have typed, saved or discarded while the server was read. A draft
    // gone, or based on another version by now (a save settled it, another tab changed it), is not this check's to
    // judge (and must not come back).
    const latest = this.draft(d.key);
    if (!latest?.base || latest.base.version !== d.base.version || latest.base.hash !== d.base.hash) return null;
    if (!now && this.working.value.has(d.key)) return null;
    const base = latest.base;
    if (cur.version === base.version && fingerprint(cur.b64) === base.hash) return null;
    // The list shows who saved the newer version, and that it isn't published.
    this.patchResource(d.id, { modifiedOn: cur.modifiedOn, version: cur.version, modifiedBy: cur.modifiedBy, modifiedById: cur.modifiedById, unpublished: cur.state === 1 || this.get(d.id)?.unpublished });
    const contentChanged = fingerprint(cur.b64) !== base.hash;
    const touchesContent = latest.text !== undefined || latest.b64 !== undefined;
    const props = (Object.keys(latest.props || {}) as Array<keyof Props>).filter((k) => !sameProps(cur.props, base.props, [k]));
    if ((contentChanged && touchesContent) || props.length) {
      const c: Conflict = { key: latest.key, id: d.id, name: latest.name, theirs: cur, base, content: contentChanged && touchesContent, props, detectedAt: Date.now() };
      this.addConflict(c);
      return c;
    }
    // Nothing both sides changed: the draft now starts from the server's version.
    this.setDraft({ ...latest, base: baseFrom(cur) }, d.key);
    return null;
  }

  /** After the list is read: drafts whose web resource changed on the server are checked. */
  private async recheckDrafts(): Promise<void> {
    const missing: Draft[] = [];
    for (const d of this.drafts.value.values()) {
      if (!d.id || !d.base) continue;
      const w = this.get(d.id);
      if (!w) {
        if (!this.toldGone.has(d.key)) missing.push(d);
        continue;
      }
      if (w.version !== d.base.version)
        try {
          await this.check(d);
        } catch (e) {
          this.log('warn', `${d.name}: could not check for changes on the server (${explain(e)}).`);
        }
    }
    for (const d of await this.reallyGone(missing)) this.toldDeleted(d);
  }

  /**
   * The drafts whose web resource the server no longer has. Missing from the list is no proof (the list leaves hidden
   * web resources out): their ids are looked up (one request); when that fails, none is taken for deleted.
   */
  private async reallyGone(ds: Draft[]): Promise<Draft[]> {
    if (!ds.length) return [];
    try {
      const found = new Set((await wr.savedVersions(this.http, ds.map((d) => d.id!))).map((w) => w.id));
      return ds.filter((d) => !found.has(d.id!));
    } catch {
      return [];
    }
  }

  /** A draft whose web resource was deleted on the server: said once per session, with the way to create it again. */
  private toldDeleted(d: Draft): void {
    if (this.toldGone.has(d.key)) return;
    this.toldGone.add(d.key);
    this.log('warn', `${d.name} was deleted on the server; your unsaved change to it is kept. Saving it creates it again (you are asked first), or discard it.`);
    this.ui.notify({
      severity: 'warning',
      message: `${d.name} was deleted on the server. Your unsaved change to it is kept here.`,
      detail: 'Create it again from your change (a new web resource with the same name), or discard the change.',
      actions: [{ label: 'Create It Again', primary: true, run: () => void this.save([d.key], { recreate: true }) }],
    });
  }

  /**
   * A draft whose web resource was deleted on the server becomes the draft of a new web resource with the same name
   * and content (created when saved), in the unmanaged solution of its publisher prefix. Open editors follow it.
   * Returns its new key (null when it can't be done).
   */
  private recreate(key: string): string | null {
    const d = this.draft(key);
    if (!d?.id || this.get(d.id)) return null;
    const nk = newKey(d.name);
    if (this.drafts.value.has(nk)) return null;
    const kept = d.base ? base64ToText(d.base.b64) : null;
    const text = d.text ?? (d.b64 === undefined && kept && isTextType(d.type) ? kept.text : undefined);
    const prefix = (/^([A-Za-z0-9]+)_/.exec(d.name)?.[1] || '').toLowerCase();
    const target = this.targetSolution();
    const solution = target && target.prefix.toLowerCase() === prefix ? target.uniqueName : (this.solutions.value.find((s) => !s.isManaged && s.prefix.toLowerCase() === prefix)?.uniqueName ?? '');
    // Editors move to the new key first: with the old draft gone they would show the deleted version's text.
    this.rekeyed.emit({ from: key, to: nk });
    this.setDraft(
      {
        key: nk,
        name: d.name,
        type: d.type,
        text,
        bom: d.text !== undefined ? d.bom : kept?.bom,
        b64: text === undefined ? (d.b64 ?? d.base?.b64 ?? '') : undefined,
        props: { ...(d.base?.props || {}), ...(d.props || {}) },
        base: null,
        solution,
        updatedAt: Date.now(),
      },
      nk,
    );
    this.setDraft(null, key);
    this.log('info', `${d.name} is created again${solution ? ` in ${solution}` : ''} when saved.`);
    return nk;
  }

  /**
   * Resolves a conflict: 'mine' saves the draft over theirs (after confirmation); 'theirs' throws the draft away;
   * 'merged' keeps `text` as the new draft, based on their version, ready to save.
   */
  async resolve(key: string, how: 'mine' | 'theirs' | 'merged', text?: string): Promise<void> {
    const c = this.conflicts.value.get(key);
    const d = this.draft(key);
    if (!c || !d) return;
    const rebased: Draft = { ...d, base: { modifiedOn: c.theirs.modifiedOn, version: c.theirs.version, hash: fingerprint(c.theirs.b64), b64: c.theirs.b64, props: { ...c.theirs.props } } };
    if (how === 'theirs') {
      this.keep('saved', c.id, c.theirs);
      this.discard([key]);
      return;
    }
    if (how === 'merged' && text !== undefined) rebased.text = text;
    this.keep('saved', c.id, c.theirs);
    this.setDraft(rebased, key);
    this.clearConflict(key);
    this.contentTick.value++;
    if (how === 'mine') await this.save([key]);
  }

  // ------------------------------------------------------------------ saving

  private setWorking(keys: string[], what: string | null): void {
    const next = new Map(this.working.value);
    for (const k of keys) {
      if (what) next.set(k, what);
      else next.delete(k);
    }
    this.working.value = next;
  }

  /**
   * Marks a long write of a feature (forms saved, table icons) as running until the function returned is called:
   * the status bar shows it, and leaving the page or closing the manager asks first, as during a save.
   */
  track(key: string, what: string): () => void {
    this.setWorking([key], what);
    return () => this.setWorking([key], null);
  }

  /** Runs a write (delete, rename…) in turn with saves and publishes, so it never races a save of the same file. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(fn);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Saves drafts to the server (docs/ARCHITECTURE.md §4): each one checked against the server's version first, written
   * only if nobody changed what it changes, then read back to verify. Publishes the saved ones when `publish`: the
   * publish question comes first, so Cancel writes nothing. Runs after any save or publish already running (the drafts
   * are read when its turn comes). `recreate`: drafts of web resources deleted on the server are created again without
   * asking (the user just chose to).
   */
  save(keys: string[], o: { publish?: boolean; recreate?: boolean } = {}): Promise<SaveResult[]> {
    if (this.queueBusy) this.setWorking(keys.filter((k) => this.isDirty(k)), 'Waiting…');
    return this.serial(() => this.saveNow(keys, o));
  }

  private queueBusy = false;

  private async saveNow(keys: string[], o: { publish?: boolean; recreate?: boolean }): Promise<SaveResult[]> {
    this.queueBusy = true;
    try {
      return await this.saveDrafts(keys, o);
    } finally {
      this.queueBusy = false;
      // Keys that waited for this save and were not saved (discarded meanwhile, a conflict, a question cancelled) wait
      // no more: a key left "Waiting…" would keep the manager from closing.
      this.setWorking(
        keys.filter((k) => this.working.value.get(k) === 'Waiting…'),
        null,
      );
    }
  }

  private async saveDrafts(keys: string[], o: { publish?: boolean; recreate?: boolean }): Promise<SaveResult[]> {
    const reason = this.readOnlyReason();
    if (reason) {
      this.ui.notify({ severity: 'warning', message: `Nothing was saved. ${reason}` });
      return [];
    }
    let drafts = keys.map((k) => this.draft(k)).filter((d): d is Draft => !!d);
    // Web resources deleted on the server after their change started are created again only when the user says so
    // (a PATCH of the deleted one would fail on every save).
    const gone = await this.reallyGone(drafts.filter((d) => d.id && this.loadedAt.value && !this.get(d.id)));
    if (gone.length) {
      let again = !!o.recreate;
      if (!again) {
        const r = await this.ui.confirm({
          title: 'Create deleted web resources again?',
          message:
            gone.length === 1 ? `${gone[0].name} was deleted on the server after your change to it started.` : `${plural(gone.length, 'web resource')} were deleted on the server after your changes to them started.`,
          detail: `Saving creates ${gone.length === 1 ? 'it' : 'them'} again from your change, with the same name. Cancel keeps the change here, unsaved.`,
          type: 'warning',
          list: gone.length > 1 ? gone.map((d) => d.name) : undefined,
          buttons: [
            { label: 'Create Again', value: 'yes', primary: true },
            { label: 'Cancel', value: 'no' },
          ],
          cancelValue: 'no',
        });
        again = r.value === 'yes';
      }
      // They go into the solution new web resources go in: the list of solutions may be out of date.
      if (again)
        try {
          await this.targetSolutionNow();
        } catch (e) {
          this.ui.notify({ severity: 'error', message: explain(e) });
          again = false;
        }
      const made = new Map<string, Draft>();
      if (again)
        for (const d of gone) {
          const nk = this.recreate(d.key);
          const nd = nk ? this.draft(nk) : undefined;
          if (nd) made.set(d.key, nd);
          else this.ui.notify({ severity: 'warning', message: `${d.name} can't be created again: a new web resource of that name is already waiting to be created (see Source Control). Your change is kept.` });
        }
      drafts = drafts.flatMap((d) => (made.has(d.key) ? [made.get(d.key)!] : gone.includes(d) ? [] : [d]));
    }
    const conflicted = drafts.filter((d) => this.conflicts.value.has(d.key));
    if (conflicted.length)
      this.ui.notify({ severity: 'warning', message: `${plural(conflicted.length, 'web resource')} with a conflict ${conflicted.length === 1 ? 'is' : 'are'} not saved: resolve ${conflicted.length === 1 ? 'it' : 'them'} first (Compare and choose).` });
    const todo = drafts.filter((d) => !this.conflicts.value.has(d.key));
    if (!todo.length) return conflicted.map((d) => ({ key: d.key, name: d.name, ok: false, conflict: true }));
    // Write guards: content made empty, or cut to less than a quarter, is asked about first.
    const shrunk = todo.filter((d) => {
      if (!d.base || (d.text === undefined && d.b64 === undefined)) return false;
      const before = d.base.b64.length;
      const after = d.text !== undefined ? textToBase64(d.text).length : (d.b64 || '').length;
      return before > 400 && (after < 8 || after < before / 4);
    });
    if (shrunk.length) {
      const r = await this.ui.confirm({
        title: 'Save content that much smaller?',
        message: `${plural(shrunk.length, 'web resource')} would lose most of ${shrunk.length === 1 ? 'its' : 'their'} content.`,
        detail: 'The new content is empty or less than a quarter of what the server has. This is often an accident (a file emptied by mistake).',
        type: 'warning',
        list: shrunk.map((d) => d.name),
        buttons: [
          { label: 'Save anyway', value: 'save', danger: true },
          { label: 'Cancel', value: 'cancel' },
        ],
        cancelValue: 'cancel',
      });
      if (r.value !== 'save') return [];
    }
    // Save and publish: the publish question (someone else's saved changes, Production, the setting) comes before
    // anything is written, so Cancel means nothing was saved either.
    let live: Promise<LiveVersions> | undefined;
    if (o.publish) {
      const ids = todo.map((d) => d.id).filter((id): id is string => !!id && !!this.get(id));
      // What users have now, read while the checks and the save run (only a publish changes it): no wait added.
      live = this.liveVersions(ids);
      const read = await this.readForPublish(ids);
      if (!read) return [];
      if ((await this.askPublish(todo.map((d) => d.name), read, { saving: true })) === 'cancel') return [];
    }
    const names = new Map(todo.map((d) => [d.key, d.name]));
    const order = todo.map((d) => d.key);
    this.setWorking(order, 'Saving…');
    let started = 0;
    let results: SaveResult[];
    try {
      // A few at a time (each file still read, written and read back in turn): Save All of a hundred files is not three
      // hundred requests one after another.
      results = await pool(order, 3, async (k): Promise<SaveResult> => {
        // The draft as it is at its turn: discarded meanwhile, it is not written; typed into, the newer text is.
        const d = this.draft(k);
        try {
          if (!d) return { key: k, name: names.get(k)!, ok: false, skipped: 'discarded before its turn came' };
          if (this.conflicts.value.has(k)) return { key: k, name: d.name, ok: false, conflict: true };
          if (order.length > 1) this.setWorking([k], `Saving ${++started} of ${order.length}…`);
          this.savingKeys.add(k);
          try {
            return await this.saveOne(d);
          } finally {
            this.savingKeys.delete(k);
          }
        } finally {
          this.setWorking([k], null);
        }
      });
    } finally {
      this.setWorking(order, null);
    }
    // Other manager tabs read these again (one message for the whole save).
    const written = results.filter((r) => r.written && r.id).map((r) => r.id!);
    if (written.length) this.post({ kind: 'saved', ids: written });
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok && !r.skipped);
    if (ok.length) this.log('info', `Saved ${ok.map((r) => r.name).join(', ')}.`);
    for (const r of results) if (!r.ok && r.skipped) this.log('info', `${r.name} was not saved: ${r.skipped}.`);
    for (const r of bad) this.log(r.conflict ? 'warn' : 'error', `${r.name}: ${r.error || 'changed on the server by someone else; not saved'}`);
    // Failures are always said, also when a publish follows (the publish result names only what was published).
    if (bad.length) {
      const conflicts = bad.filter((r) => r.conflict).length;
      this.ui.notify({
        severity: conflicts === bad.length ? 'warning' : 'error',
        message: `${plural(bad.length, 'web resource')} not saved${conflicts ? `: ${conflicts} changed on the server meanwhile — Compare and choose shows both versions` : ''}.${o.publish ? ` ${bad.length === 1 ? 'It is' : 'They are'} not published either.` : ''}`,
        detail: bad.map((r) => `${r.name}: ${r.error || 'conflict'}`).join('\n'),
      });
    }
    for (const r of results) if (r.warning) this.ui.notify({ severity: 'warning', message: `${r.name}: ${r.warning}` });
    const savedText = () => (ok.length === 1 ? `Saved ${ok[0].name} (not published yet).` : `Saved ${plural(ok.length, 'web resource')} (not published yet).`);
    if (o.publish && ok.length) {
      const ids = [...new Set(ok.map((r) => r.id!).filter(Boolean))];
      // What was just saved is what gets published: right before publishing, the server is compared with it.
      const agreed = new Map<string, Content>();
      try {
        for (const id of ids) agreed.set(id, this.saved.get(id) ?? (await this.content(id, 'saved', true)));
      } catch (e) {
        this.fail(e, 'Could not check the web resources before publishing');
      }
      const published = agreed.size === ids.length && (await this.publishChecked(ids, agreed, true, live));
      // A save that went through stays said, when the publish was cancelled or failed.
      if (!published) this.ui.notify({ severity: 'info', message: savedText() });
    } else if (ok.length && !bad.length) this.ui.notify({ severity: 'info', message: savedText() });
    return [...results, ...conflicted.map((d) => ({ key: d.key, name: d.name, ok: false, conflict: true }))];
  }

  private async saveOne(d: Draft): Promise<SaveResult> {
    const res: SaveResult = { key: d.key, name: d.name, ok: false };
    let wrote = false;
    try {
      const b64 = d.text !== undefined ? textToBase64(d.text, d.bom ?? false) : d.b64;
      if (b64 !== undefined && b64.length > this.conn.maxUploadBytes)
        throw new Error(`The content is ${Math.round(b64.length / 1024)} KB as Dataverse counts it (Base64), more than this organization's limit of ${Math.round(this.conn.maxUploadBytes / 1024)} KB.`);
      if (!d.id) return await this.createOne(d, b64 ?? '', res);
      const w = this.get(d.id);
      if (w && w.isManaged && !w.isCustomizable) throw new Error('It belongs to a managed solution that doesn\'t allow changing it.');
      const base = d.base!;
      const changedProps = d.props ? (Object.keys(d.props) as Array<keyof Props>).filter((k) => !sameProps(d.props!, base.props, [k])) : [];
      const props: Partial<Props> = {};
      for (const k of changedProps) (props as any)[k] = d.props![k];
      const encodingNote = this.saved.get(d.id)?.encoding === 'windows-1252' && d.text !== undefined ? 'It was stored in Windows-1252, not UTF-8: it is saved as UTF-8 now.' : '';
      // The server's version is the draft's base when its ETag is the same, or when what the draft changes is
      // exactly as the base had it (a publish, or a change to other properties, changes the ETag only).
      const same = (row: any) => {
        if (row?.['@odata.etag'] && row['@odata.etag'] === base.version) return true;
        const cur = String(row?.content || '');
        if ((d.text !== undefined || d.b64 !== undefined) && fingerprint(cur) !== base.hash) return false;
        const curProps: Partial<Props> = { displayName: row.displayname || '', description: row.description || '', languageCode: row.languagecode ?? null, enabledForMobile: !!row.isenabledformobileclient, availableOffline: !!row.isavailableformobileoffline, dependencyXml: row.dependencyxml || '' };
        return sameProps(curProps, base.props, changedProps);
      };
      const content = d.text !== undefined || d.b64 !== undefined ? b64 : undefined;
      if (content === base.b64 && !changedProps.length) {
        this.setDraft(null, d.key);
        return { ...res, ok: true, id: d.id, skipped: 'No change.' };
      }
      let before: any;
      try {
        before = await wr.updateWebResource(this.http, d.id, { b64: content !== base.b64 ? content : undefined, props }, same, `Save ${d.name}`);
      } catch (e) {
        if (e instanceof ConflictError) {
          const c = await this.check(d, toContentLike(e.current, w ? isTextType(w.type) : true));
          return c ? { ...res, conflict: true } : { ...res, error: 'It changed while it was being saved: save it again.' };
        }
        throw e;
      }
      wrote = true;
      if (before?.content !== undefined)
        void store.addHistory(this.env, { key: d.id, name: d.name, type: d.type, at: Date.now() - 1, kind: 'before-save', by: before[`_modifiedby_value@OData.Community.Display.V1.FormattedValue`] || '', b64: String(before.content || '') }, this.settings.value.historyPerFile);
      // Saved over someone else's change that nobody published: the saved version still holds it, but names this user
      // as its writer from now on. Remembered, so publishing it says whose change goes live too.
      const beforeBy = guid(before?._modifiedby_value);
      if (Number(before?.componentstate) === 1 && beforeBy && beforeBy !== this.conn.userId)
        void this.rememberOthers(d.id, { by: String(before[`_modifiedby_value@OData.Community.Display.V1.FormattedValue`] || 'someone else'), byId: beforeBy, at: String(before.modifiedon || '') });
      // Verify: the saved version must now hold exactly what was sent.
      const now = await this.content(d.id, 'saved', true);
      this.patchResource(d.id, { modifiedOn: now.modifiedOn, version: now.version, modifiedBy: now.modifiedBy, modifiedById: now.modifiedById, unpublished: true, displayName: now.props.displayName, description: now.props.description, languageCode: now.props.languageCode });
      if (content !== undefined && now.b64 !== content) return this.overwritten(d, now, content, props, res);
      void store.addHistory(this.env, { key: d.id, name: d.name, type: d.type, at: Date.now(), kind: 'saved', by: this.conn.userName, b64: now.b64 }, this.settings.value.historyPerFile);
      this.settle(d, now);
      this.contentTick.value++;
      return { ...res, ok: true, id: d.id, warning: encodingNote || undefined, written: true };
    } catch (e) {
      return { ...res, id: d.id, error: explain(e), written: wrote };
    }
  }

  /**
   * The save went through, but the saved version read right after holds someone else's content: they saved right
   * after. What was sent is kept (in the local history, and as the draft, now based on it), and their version is a
   * conflict: the next save asks instead of writing over theirs.
   */
  private overwritten(d: Draft, now: Content, sent: string, props: Partial<Props>, res: SaveResult): SaveResult {
    const at = Date.now();
    void store.addHistory(this.env, { key: d.id!, name: d.name, type: d.type, at, kind: 'saved', by: this.conn.userName, b64: sent }, this.settings.value.historyPerFile);
    // The version sent has no ETag of its own any more: a base without one is compared by content.
    const base: Base = { modifiedOn: '', version: '', hash: fingerprint(sent), b64: sent, props: { ...d.base!.props, ...props } };
    const cur = this.draft(d.key) ?? d;
    this.setDraft({ ...cur, base }, d.key);
    const theirsProps = (Object.keys(cur.props || {}) as Array<keyof Props>).filter((k) => !sameProps(now.props, base.props, [k]));
    this.addConflict({ key: d.key, id: d.id!, name: d.name, theirs: now, base, content: true, props: theirsProps, detectedAt: at }, at + 1);
    this.contentTick.value++;
    return { ...res, id: d.id, conflict: true, written: true, error: `It was saved, but ${now.modifiedBy || 'someone else'} saved a different version right after: Compare and choose shows both versions.` };
  }

  private async createOne(d: Draft, b64: string, res: SaveResult): Promise<SaveResult> {
    const solution = d.solution ?? '';
    // A solution made after the list was read: its publisher prefix is checked too.
    if (solution && !this.solutions.value.some((s) => s.uniqueName === solution)) await this.loadSolutions();
    const prefix = this.solutions.value.find((s) => s.uniqueName === solution)?.prefix || '';
    const problem = nameProblem(d.name, prefix);
    if (problem) throw new Error(problem);
    const taken = await wr.idOfName(this.http, d.name);
    if (taken) throw new Error(`A web resource named ${taken.name} already exists.`);
    let id: string;
    try {
      id = await wr.createWebResource(this.http, { name: d.name, type: d.type, b64, props: d.props || {}, solution });
    } catch (e) {
      // The answer may have been lost after the create ran: look before reporting a failure. Only then: a create
      // Dataverse refused (the name taken meanwhile by someone else) must not take their web resource for this one.
      if (!mayHaveRun(e)) throw e;
      const found = await wr.idOfName(this.http, d.name).catch(() => null);
      if (!found) throw e;
      // It is this one only when it holds exactly what was sent, written by this user.
      const c = await this.content(found.id, 'saved', true).catch(() => null);
      if (!c || c.b64 !== b64 || (c.modifiedById && c.modifiedById !== this.conn.userId))
        throw new Error(`${c?.modifiedBy || 'Someone else'} created a web resource named ${found.name} at the same time. Your new file is kept here, unsaved: rename it, or compare it with theirs.`);
      id = found.id;
    }
    const now = await this.content(id, 'saved', true);
    const list = await wr.savedVersions(this.http, [id]);
    const next = new Map(this.resources.value);
    for (const w of list) next.set(w.id, { ...w, unpublished: false, publishedOn: w.modifiedOn, publishedBy: w.modifiedBy, solutions: solution ? [solution] : [] });
    this.resources.value = next;
    if (this.scope.value.kind === 'solution' && this.scope.value.solution.uniqueName === solution) this.scopeIds.value = new Set([...(this.scopeIds.value || []), id]);
    void store.addHistory(this.env, { key: id, name: d.name, type: d.type, at: Date.now(), kind: 'saved', by: this.conn.userName, b64: now.b64 }, this.settings.value.historyPerFile);
    this.settle(d, now, id, id);
    // Open editors and tabs follow the web resource to its id.
    this.rekeyed.emit({ from: d.key, to: id });
    this.contentTick.value++;
    return { ...res, ok: true, id, written: true, warning: now.b64 !== b64 ? 'The content read back differs from what was sent.' : undefined };
  }

  /**
   * After a save: the draft that was saved goes away — unless the user typed more while it was being saved; that newer
   * edit stays a draft, now based on the version just saved (and under the web resource's id when it was just created).
   */
  private settle(saved: Draft, now: Content, key = saved.key, id = saved.id): void {
    // Typing of the last 250 ms was made on what was just saved: recorded now, it stays a draft based on that version
    // (recorded later, it would start from the version before and look like someone else's change).
    try {
      this.flushTyping([saved.key]);
    } catch {
      /* the editors' failure doesn't stop the save */
    }
    const cur = this.draft(saved.key);
    if (!cur || cur.updatedAt === saved.updatedAt) {
      this.setDraft(null, saved.key);
      return;
    }
    if (key !== saved.key) this.setDraft(null, saved.key);
    const next: Draft = { ...cur, key, id, base: baseFrom(now) };
    if (this.unchanged(next)) this.setDraft(null, key);
    else this.setDraft(next, key);
  }

  private patchResource(id: string, patch: Partial<WebResource>): void {
    const w = this.get(id);
    if (!w) return;
    const next = new Map(this.resources.value);
    next.set(id, { ...w, ...patch });
    this.resources.value = next;
  }

  /** Tells the other manager tabs of this environment (nothing when the manager is closing). */
  private post(m: unknown): void {
    if (this.disposed) return;
    try {
      this.channel?.postMessage(m);
    } catch {
      /* the channel is closed */
    }
  }

  // ------------------------------------------------------------------ publishing

  /**
   * Publishes web resources (their saved versions). Asks first in Production (or when the setting says so), and lists
   * saved changes made by someone else that publishing would make live too. A version saved while the question is open
   * is not published unseen; afterwards, the published version is read back and compared.
   */
  publish(ids: string[]): Promise<boolean> {
    return this.serial(() => this.publishNow(ids));
  }

  private async publishNow(ids: string[]): Promise<boolean> {
    const reason = this.readOnlyReason();
    if (reason) {
      this.ui.notify({ severity: 'warning', message: `Nothing was published. ${reason}` });
      return false;
    }
    ids = [...new Set(ids)].filter((id) => this.get(id));
    if (!ids.length) return false;
    const live = this.liveVersions(ids);
    const read = await this.readForPublish(ids);
    if (!read) return false;
    const asked = await this.askPublish(
      ids.map((id) => this.get(id)!.name),
      read,
      { unsaved: ids.filter((id) => this.isDirty(id)).length },
    );
    if (asked === 'cancel') return false;
    // Without a question there was no time for a change to slip in: what was just read is published.
    return this.publishChecked(ids, read, asked === 'asked', live);
  }

  /** The published versions of web resources (what users have), for the history: never fails (empty when unread). */
  private liveVersions(ids: string[]): Promise<LiveVersions> {
    return wr.publishedContents(this.http, ids).catch(() => new Map() as LiveVersions);
  }

  /**
   * The saved version of each web resource as it is now (null when they could not be read: said so). Which version each
   * one is, is read for all of them at once (40 per request); the content only of versions not read already (50 per
   * request): publishing everything saved must not read a hundred files one after another before it can ask.
   */
  private async readForPublish(ids: string[]): Promise<Map<string, Content> | null> {
    const out = new Map<string, Content>();
    if (!ids.length) return out;
    try {
      this.loading.value = ids.length === 1 ? 'Checking before publishing…' : `Checking ${plural(ids.length, 'web resource')} before publishing…`;
      const now = new Map((await wr.savedVersions(this.http, ids)).map((w) => [w.id, w.version]));
      const todo: string[] = [];
      for (const id of ids) {
        const c = this.saved.get(id);
        if (c && now.has(id) && c.version === now.get(id)) {
          out.set(id, c);
          this.used.set(`saved|${id}`, Date.now());
        } else todo.push(id);
      }
      for (const [id, c] of await this.readSaved(todo)) out.set(id, c);
      if (todo.length) this.contentTick.value++;
      const gone = ids.filter((id) => !out.has(id));
      if (gone.length) throw new Error(`${gone.map((id) => this.get(id)?.name ?? id).join(', ')} ${gone.length === 1 ? 'was' : 'were'} deleted on the server meanwhile.`);
      return out;
    } catch (e) {
      this.fail(e, 'Could not check the web resources before publishing');
      return null;
    } finally {
      this.loading.value = '';
    }
  }

  /**
   * The publish question, when one is needed: in Production always, when the settings say so, when someone else's
   * saved changes would go live too (listed from `read`, and from the changes of others a save made here went over),
   * when some have unsaved changes here (not part of it), or when versions were saved again after an earlier question
   * (`changed`). 'none' when no question was needed.
   */
  private async askPublish(names: string[], read: Map<string, Content>, o: { saving?: boolean; unsaved?: number; changed?: string[] } = {}): Promise<'asked' | 'none' | 'cancel'> {
    const others: string[] = [];
    const nameOf = (id: string) => this.get(id)?.name ?? id;
    const when = (at: string) => (at ? new Date(at).toLocaleString() : '');
    for (const [id, c] of read) if (c.state === 1 && c.modifiedById && c.modifiedById !== this.conn.userId) others.push(`${nameOf(id)} — saved by ${c.modifiedBy || 'someone else'} ${when(c.modifiedOn)}`.trim());
    // Dataverse names only the last writer of a saved version: someone else's change a save made here went over is in
    // it all the same, until it is published.
    const kept = await this.othersNow();
    for (const [id, c] of read) {
      if (c.state !== 1) continue; // published since: nothing of theirs waits in it
      for (const x of kept[id] ?? []) if (x.byId !== this.conn.userId && x.byId !== c.modifiedById) others.push(`${nameOf(id)} — saved by ${x.by} ${when(x.at)}, under your later save`.replace(/ +,/, ','));
    }
    const prod = this.conn.envType === 'Production';
    const unsaved = o.unsaved ?? 0;
    const changed = o.changed ?? [];
    if (!others.length && !unsaved && !prod && !this.settings.value.confirmPublish && !changed.length) return 'none';
    const verb = o.saving ? 'Save and publish' : 'Publish';
    const r = await this.ui.confirm({
      title: prod ? `${verb} in Production (${this.conn.orgName})?` : `${verb}?`,
      message: `${verb} ${names.length === 1 ? names[0] : plural(names.length, 'web resource')}? Every user of ${this.conn.orgName} gets ${names.length === 1 ? 'it' : 'them'} at once.`,
      detail: [
        changed.length ? `Saved again since you were asked (this is what gets published now):\n${changed.join('\n')}` : '',
        others.length ? `Publishing also makes live these changes saved by someone else:\n${others.join('\n')}` : '',
        unsaved ? `${plural(unsaved, 'web resource')} also ${unsaved === 1 ? 'has' : 'have'} unsaved changes here; those are not part of what gets published.` : '',
        o.saving ? 'Nothing is saved before you choose.' : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      type: others.length || prod || changed.length ? 'warning' : 'question',
      list: names,
      buttons: [
        { label: verb, value: 'publish', primary: true },
        { label: 'Cancel', value: 'cancel' },
      ],
      cancelValue: 'cancel',
    });
    return r.value === 'publish' ? 'asked' : 'cancel';
  }

  /**
   * Publishes the saved versions in `agreed` (what the question showed, or what was just saved). With `recheck`, the
   * server's saved versions are compared with them right before publishing (their ETags, 40 per request): one saved
   * again meanwhile is never published unseen — the question comes again, naming it. Afterwards the published version
   * is read back and must be what was agreed (verified publish).
   */
  private async publishChecked(ids: string[], agreed: Map<string, Content>, recheck: boolean, livePromise: Promise<LiveVersions> = this.liveVersions(ids)): Promise<boolean> {
    const expected = new Map(agreed);
    const names = () => ids.map((id) => this.get(id)?.name ?? id);
    for (let round = 0; recheck; round++) {
      if (round > 4) {
        this.ui.notify({ severity: 'warning', message: `Nothing was published: ${names().join(', ')} kept changing on the server. Try again in a moment.` });
        return false;
      }
      let rows: WebResource[];
      try {
        rows = await wr.savedVersions(this.http, ids);
      } catch (e) {
        this.fail(e, 'Could not check the web resources before publishing');
        return false;
      }
      const now = new Map(rows.map((w) => [w.id, w.version]));
      const moved = ids.filter((id) => now.get(id) !== expected.get(id)?.version);
      if (!moved.length) break;
      const fresh = await this.readForPublish(moved);
      if (!fresh) return false;
      // A new ETag alone (a publish of the same version) changes nothing that gets published.
      const changed = moved.filter((id) => {
        const a = expected.get(id);
        const b = fresh.get(id)!;
        return !a || fingerprint(a.b64) !== fingerprint(b.b64) || !sameProps(a.props, b.props, Object.keys(b.props) as Array<keyof Props>);
      });
      for (const [id, c] of fresh) expected.set(id, c);
      if (!changed.length) continue;
      if (round >= 2) {
        this.ui.notify({ severity: 'warning', message: `Nothing was published: ${changed.map((id) => this.get(id)?.name ?? id).join(', ')} kept being saved by someone else. Try again in a moment.` });
        return false;
      }
      const lines = changed.map((id) => {
        const c = fresh.get(id)!;
        return `${this.get(id)?.name ?? id} — saved by ${c.modifiedBy || 'someone else'} ${c.modifiedOn ? new Date(c.modifiedOn).toLocaleString() : ''}`.trim();
      });
      if ((await this.askPublish(names(), expected, { changed: lines })) === 'cancel') return false;
    }
    this.setWorking(ids, 'Publishing…');
    const note = this.ui.notify({ severity: 'info', message: `Publishing ${plural(ids.length, 'web resource')}…`, progress: true, sticky: true });
    // What users have until now goes to the local history: a publish can be undone (restore it, then publish it).
    const startedAt = Date.now();
    const live = await livePromise;
    try {
      await wr.publishWebResources(this.http, ids);
      // Nothing of anyone else's waits unpublished in them any more.
      void this.forgetOthers(ids);
      // Verified publish: the published content must be what was agreed. The latest saved versions are read 50 per
      // request: right after a publish they are the published ones, unless someone saved again meanwhile (a saved
      // version not published): its published version is read on its own then.
      const latest = await this.readSaved(ids);
      const bad: string[] = [];
      for (const id of ids) {
        const s = latest.get(id);
        const again = s?.state === 1;
        const p = s && !again ? s : await this.content(id, 'published', true);
        if (p.b64 !== expected.get(id)?.b64) bad.push(this.get(id)!.name);
        const w = this.get(id)!;
        const was = live.get(id);
        if (was && was.b64 !== p.b64) void store.addHistory(this.env, { key: id, name: w.name, type: w.type, at: startedAt, kind: 'before-publish', by: was.by, b64: was.b64 }, this.settings.value.historyPerFile);
        void store.addHistory(this.env, { key: id, name: w.name, type: w.type, at: Date.now(), kind: 'published', by: this.conn.userName, b64: p.b64 }, this.settings.value.historyPerFile);
        if (again) this.patchResource(id, { unpublished: true, publishedOn: p.modifiedOn, publishedBy: p.modifiedBy, version: s!.version, modifiedOn: s!.modifiedOn, modifiedBy: s!.modifiedBy, modifiedById: s!.modifiedById });
        else {
          this.patchResource(id, { unpublished: false, publishedOn: p.modifiedOn, publishedBy: p.modifiedBy, version: p.version, modifiedOn: p.modifiedOn });
          // What is live now is the latest saved version too: the cache takes it whole (never one version's ETag with
          // another version's content), so the editors show what users get, and the next save compares with it.
          this.keep('saved', id, p);
          this.keep('published', id, p);
        }
      }
      this.contentTick.value++;
      note.close();
      if (bad.length) this.ui.notify({ severity: 'warning', message: `Published, but ${bad.join(', ')} ${bad.length === 1 ? 'reads' : 'read'} back different from what was saved: someone may have saved meanwhile. The editor shows what is live now.` });
      else
        this.ui.notify({
          severity: 'info',
          message: ids.length === 1 ? `Published ${this.get(ids[0])!.name}.` : `Published ${plural(ids.length, 'web resource')}.`,
          detail: 'Users get the new version when their page reloads.',
          actions: [
            ...(this.reloadPage ? [{ label: 'Reload the Dynamics page', run: () => this.reloadPage?.() }] : []),
            // To undo it: the version live before is in the history.
            ...(this.showHistory && ids.length === 1 ? [{ label: 'History…', run: () => this.showHistory?.(ids[0]) }] : []),
          ],
        });
      this.log('info', `Published ${ids.map((id) => this.get(id)!.name).join(', ')}.`);
      this.post({ kind: 'published', ids });
      return true;
    } catch (e) {
      note.close();
      this.fail(e, 'Publishing failed');
      return false;
    } finally {
      this.setWorking(ids, null);
    }
  }

  // ------------------------------------------------------------------ others' changes saved over

  /**
   * Changes a record of others' changes saved over (store.OthersChange), here and in this browser's storage (where the
   * other manager tabs and the next session find it), one change at a time.
   */
  private changeOthers(fn: (m: Record<string, store.OthersChange[]>) => boolean): Promise<void> {
    fn(this.others);
    const run = this.othersWrite
      .then(async () => {
        if (storageProblem()) return;
        const stored = await store.loadOthers(this.env);
        if (fn(stored)) await store.saveOthers(this.env, stored);
      })
      .catch(() => undefined);
    this.othersWrite = run;
    return run;
  }

  /** Remembers that a save made here went over someone else's unpublished change of a web resource. */
  private rememberOthers(id: string, c: store.OthersChange): Promise<void> {
    return this.changeOthers((m) => {
      m[id] = [...(m[id] || []).filter((x) => x.byId !== c.byId), c];
      return true;
    });
  }

  /** Forgets the changes of others saved over in these web resources (published, or thrown away). */
  private forgetOthers(ids: string[]): Promise<void> {
    return this.changeOthers((m) => {
      let changed = false;
      for (const id of ids)
        if (m[id]) {
          delete m[id];
          changed = true;
        }
      return changed;
    });
  }

  /** After the list is read: what was published since (in another tab, or by someone else) holds nothing unpublished. */
  private forgetPublishedOthers(): void {
    const done = Object.keys(this.others).filter((id) => this.get(id) && !this.get(id)!.unpublished);
    if (done.length) void this.forgetOthers(done);
  }

  /** The changes of others saved over, as this browser keeps them now (another tab may have added or published some). */
  private async othersNow(): Promise<Record<string, store.OthersChange[]>> {
    await this.othersWrite;
    if (storageProblem()) return this.others;
    this.others = await store.loadOthers(this.env);
    return this.others;
  }

  /** Throws away the saved, unpublished change on the server (the published version is saved back and published). */
  revertSaved(id: string): Promise<void> {
    return this.serial(() => this.revertSavedNow(id));
  }

  private async revertSavedNow(id: string): Promise<void> {
    const w = this.get(id);
    if (!w) return;
    const reason = this.readOnlyReason();
    if (reason) return void this.ui.notify({ severity: 'warning', message: reason });
    const c = await this.content(id, 'saved', true);
    const r = await this.ui.confirm({
      title: 'Discard the saved change?',
      message: `Throw away the change to ${w.name} that was saved and not published${c.modifiedBy ? ` (saved by ${c.modifiedBy})` : ''}?`,
      detail: 'The published version is saved over it. The discarded version is kept in this browser\'s local history.',
      type: 'warning',
      buttons: [
        { label: 'Discard saved change', value: 'yes', danger: true },
        { label: 'Cancel', value: 'no' },
      ],
      cancelValue: 'no',
    });
    if (r.value !== 'yes') return;
    this.setWorking([id], 'Discarding…');
    try {
      await store.addHistory(this.env, { key: id, name: w.name, type: w.type, at: Date.now(), kind: 'snapshot', by: c.modifiedBy, b64: c.b64, note: 'Saved change discarded' }, this.settings.value.historyPerFile);
      await wr.revertToPublished(this.http, id, w.name, c.version);
      // Their change was thrown away with it.
      void this.forgetOthers([id]);
      const p = await this.content(id, 'published', true);
      await this.content(id, 'saved', true);
      this.patchResource(id, { unpublished: false, version: p.version, modifiedOn: p.modifiedOn, publishedOn: p.modifiedOn });
      this.post({ kind: 'published', ids: [id] });
      this.ui.notify({ severity: 'info', message: `The saved change of ${w.name} was discarded.` });
    } catch (e) {
      this.fail(e, `The saved change of ${w.name} could not be discarded`);
    } finally {
      this.setWorking([id], null);
    }
  }

  // ------------------------------------------------------------------ the list of changes (Source Control)

  changes(): Change[] {
    const out: Change[] = [];
    const conflicts = this.conflicts.value;
    for (const c of conflicts.values()) {
      const d = this.draft(c.key);
      out.push({ key: c.key, kind: 'conflict', name: c.name, type: d?.type || this.get(c.id)?.type || 3, id: c.id, content: c.content, props: c.props.length > 0, by: c.theirs.modifiedBy, at: c.theirs.modifiedOn });
    }
    for (const d of this.drafts.value.values()) {
      if (conflicts.has(d.key)) continue;
      out.push({ key: d.key, kind: d.base ? 'modified' : 'added', name: d.name, type: d.type, id: d.id, content: d.text !== undefined || d.b64 !== undefined, props: !!d.props && Object.keys(d.props).length > 0 });
    }
    for (const w of this.resources.value.values())
      if (w.unpublished) out.push({ key: w.id, kind: 'unpublished', name: w.name, type: w.type, id: w.id, content: true, props: false, by: w.modifiedById !== this.conn.userId ? w.modifiedBy : undefined, at: w.modifiedOn });
    return out;
  }

  // ------------------------------------------------------------------ other changes on the server

  /**
   * Looks for changes others saved to the web resources that are open or have drafts: an open web resource without
   * a draft shows the new version (the editor follows); one with a draft is checked for a conflict.
   */
  async checkForChanges(openIds: string[] = []): Promise<void> {
    const ids = [...new Set([...openIds, ...[...this.drafts.value.values()].map((d) => d.id).filter((x): x is string => !!x)])].filter((id) => this.get(id));
    if (!ids.length) return;
    const now = await wr.savedVersions(this.http, ids);
    for (const w of now) {
      const known = this.get(w.id);
      if (!known || known.version === w.version) continue;
      this.patchResource(w.id, { modifiedOn: w.modifiedOn, version: w.version, modifiedBy: w.modifiedBy, modifiedById: w.modifiedById, unpublished: w.unpublished || known.unpublished });
      const d = this.draft(w.id);
      if (d) {
        const c = await this.check(d);
        if (c) this.ui.notify({ severity: 'warning', message: `${w.name} was changed on the server by ${c.theirs.modifiedBy || 'someone else'} while you were editing it.`, detail: 'Your change is kept. Compare and choose shows both versions.' });
      } else if (this.saved.has(w.id)) {
        await this.content(w.id, 'saved', true);
        if (w.modifiedById !== this.conn.userId) this.ui.notify({ severity: 'info', message: `${w.name} was changed on the server by ${w.modifiedBy || 'someone else'}; the editor shows the new version.` });
      }
    }
  }

  /** A message of another manager tab of this environment: it changed a draft, or saved or published. */
  private onPeer(m: any): void {
    if (this.disposed || !m || typeof m !== 'object') return;
    if (this.early) {
      this.early.push(m);
      return;
    }
    if (m.kind === 'draft' && typeof m.key === 'string' && m.key) {
      if (!('draft' in m)) return this.peerDraftByKey(m.key);
      const d = m.draft;
      if (d !== null && !(store.isDraft(d) && d.key === m.key && typeof d.updatedAt === 'number' && (d.base === null || typeof d.base?.hash === 'string'))) return;
      this.peerDraft(m.key, d, typeof m.rev === 'string' ? m.rev : '', typeof m.parent === 'string' ? m.parent : '', typeof m.parentAt === 'number' ? m.parentAt : -1);
    } else if (m.kind === 'saved' || m.kind === 'published') {
      // One message per save or publish (older builds: one per file). Messages are gathered, then those web resources
      // are read again once, when they stop: a Save All of hundreds of files there is not hundreds of reads here.
      const ids: unknown[] = Array.isArray(m.ids) ? m.ids : [m.id];
      for (const id of ids) if (typeof id === 'string' && isGuid(id)) this.peerIds.set(id, m.kind === 'published' || this.peerIds.get(id) === 'published' ? 'published' : 'saved');
      if (this.peerIds.size) this.peerSoon();
    }
  }

  /**
   * Follows saves and publishes made in other manager tabs: only those web resources are read again (40 per request),
   * cached contents of changed ones are dropped (open editors read them again), and drafts of them are checked. The
   * whole list is read again only for one this tab doesn't know (created there).
   */
  private async followPeers(): Promise<void> {
    if (this.disposed || !this.peerIds.size) return;
    const batch = new Map(this.peerIds);
    this.peerIds.clear();
    const ids = [...batch.keys()];
    if (!this.loadedAt.value) return; // the list is being read for the first time: it has them
    if (ids.some((id) => !this.get(id))) return this.refresh();
    const rows = await wr.savedVersions(this.http, ids);
    let changed = false;
    for (const w of rows) {
      const old = this.get(w.id);
      if (!old) continue;
      const published = batch.get(w.id) === 'published';
      if (old.version === w.version && !published) continue;
      this.patchResource(w.id, {
        ...w,
        solutions: old.solutions,
        publishedOn: w.unpublished ? old.publishedOn : w.modifiedOn,
        publishedBy: w.unpublished ? old.publishedBy : w.modifiedBy,
      });
      if (this.saved.get(w.id)?.version !== w.version) this.saved.delete(w.id);
      if (published) this.published.delete(w.id);
      changed = true;
    }
    if (changed) this.contentTick.value++;
    for (const id of ids) {
      const d = this.draft(id);
      if (!d?.base || this.get(id)?.version === d.base.version) continue;
      try {
        const c = await this.check(d);
        if (c) this.ui.notify({ severity: 'warning', message: `${d.name} was changed on the server by ${c.theirs.modifiedBy || 'someone else'} while you were editing it.`, detail: 'Your change is kept. Compare and choose shows both versions.' });
      } catch (e) {
        this.log('warn', `${d.name}: could not check for changes on the server (${explain(e)}).`);
      }
    }
  }

  /** Keeps a version of a web resource in the local history (before a delete, a discard, a rename…). */
  async snapshot(key: string, o: { text?: string; b64?: string; note: string; kind?: store.HistoryKind }): Promise<void> {
    const d = this.describe(key);
    if (!d) return;
    const b64 = o.b64 ?? (o.text !== undefined ? textToBase64(o.text) : '');
    await store.addHistory(this.env, { key, name: d.name, type: d.type, at: Date.now(), kind: o.kind ?? 'snapshot', b64, note: o.note, by: this.conn.userName }, Math.max(1, this.settings.value.historyPerFile));
  }

  // ------------------------------------------------------------------ helpers for the UI

  /** The error of a failed operation as a sentence (Dataverse codes explained). */
  explain = explain;
  errorText = errorText;
}

/** A raw row read during a save, as Content (for the conflict view). */
function toContentLike(row: any, textType: boolean): Content {
  const b64 = String(row?.content || '');
  const d = textType ? base64ToText(b64) : null;
  return {
    b64,
    text: d?.text,
    bom: d?.bom,
    encoding: d?.encoding,
    eol: d?.eol,
    modifiedOn: String(row?.modifiedon || ''),
    version: String(row?.['@odata.etag'] || row?.versionnumber || ''),
    modifiedBy: String(row?.['_modifiedby_value@OData.Community.Display.V1.FormattedValue'] || ''),
    modifiedById: String(row?._modifiedby_value || '').toLowerCase(),
    etag: String(row?.['@odata.etag'] || ''),
    state: Number(row?.componentstate) || 0,
    props: {
      displayName: String(row?.displayname || ''),
      description: String(row?.description || ''),
      languageCode: row?.languagecode == null ? null : Number(row.languagecode),
      enabledForMobile: !!row?.isenabledformobileclient,
      availableOffline: !!row?.isavailableformobileoffline,
      dependencyXml: String(row?.dependencyxml || ''),
    },
  };
}

export { TYPES };

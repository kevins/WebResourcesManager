// The manager's screen, kept to what editing a form's scripts needs: the list of scripts (those of the form the
// Dynamics page shows, else those of a solution, or all of them), the one being edited, and its actions: Compare,
// Discard, Save, Save & Publish. Everything that keeps work safe stays underneath (model/workspace.ts): every save
// checks that nobody saved the file meanwhile, drafts are kept in the browser, publishing is verified.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Signal } from '../core/emitter';
import { guid, isGuid, isLogicalName, q } from '../core/http';
import { rememberTheme } from '../core/theme';
import { ago, base64ToText, decodeText, download, fingerprint, plural } from '../core/util';
import { FORM_TYPES, formsUsing, getFormXml, listForms, type FormXml } from '../dataverse/forms';
import { parseForm } from '../dataverse/formxml';
import type { Solution, WebResource } from '../model/model';
import { clearHistory, historyEntry, historyList, loadValue, saveValue, type HistoryKind, type HistoryMeta } from '../model/store';
import type { WrType } from '../model/types';
import type { Workspace } from '../model/workspace';
import { listenKeys, registerCommands, setCommandErrorHandler } from './commands';
import { editorDef, setCtx, type AppContext } from './context';
import type { monaco } from '../editor/monaco';
import { EditorHost, type Side } from './editorhost';
import { parseDependencies } from './editors/dependencyxml';
import { useSignal } from './hooks';
import { FileIcon } from './icons';
import { Button, Icon, Layers, Sash, SearchInput, VirtualList, confirmDialog, inputBox, modalOpen, notify, quickPick, showMenu, type QuickItem } from './widgets';
import './editors/conflict';
import './workbench.css';
import './simple.css';

/** A script the form loads: one of its libraries, or a web resource a library lists as its dependency (`via`). */
export interface FormScript {
  name: string;
  via?: string;
}

/** Where the list of scripts comes from. */
export type Source = { kind: 'form'; formId: string; name: string; table: string; scripts: FormScript[] } | { kind: 'solution'; solution: Solution } | { kind: 'all' };

/** What is remembered of a choice of solution or all (a form is taken from the page each time). */
type Remembered = { kind: 'solution'; uniqueName: string } | { kind: 'all' };

/** Scripts, or every type the editor can open as text. */
const SCRIPTS: WrType[] = [3];
const TEXT: WrType[] = [3, 1, 2, 4, 9, 11, 12];

/** A row of the list: a web resource, a library of the form that is no web resource here, or a group's title. */
type Row = { key: string; w: WebResource | null; name: string; via?: string; title?: string; isNew?: boolean };

const fileOf = (name: string) => name.split('/').pop() || name;
const folderOf = (name: string) => name.slice(0, Math.max(0, name.length - fileOf(name).length));
const byName = (a: WebResource, b: WebResource) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** The table and form the Dynamics page shows (empty when it shows no record). */
function pageForm(ws: Workspace): { formId: string; table: string } {
  return pageFormOf(ws.conn.xrm);
}

/** The table and form a page's client API (Xrm) shows (empty when it shows no record). */
export function pageFormOf(x: any): { formId: string; table: string } {
  try {
    const input = x?.Utility?.getPageContext?.()?.input;
    if (input?.pageType !== 'entityrecord') return { formId: '', table: '' };
    // The form shown first: the page's input names it only when it was opened with that form.
    const id = guid(String(x?.Page?.ui?.formSelector?.getCurrentItem?.()?.getId?.() || input.formId || ''));
    const table = String(input.entityName || '');
    return { formId: isGuid(id) ? id : '', table: isLogicalName(table) ? table : '' };
  } catch {
    // A page without the client API (the maker portal), or another version of it.
    return { formId: '', table: '' };
  }
}

/** The manager's window over the page: moved by its title bar, maximized to fill the page, or restored. */
export interface FrameControls {
  maximized: Signal<boolean>;
  toggleMaximized(): void;
  /** The pointer went down on the title bar at (x, y) of the manager's own window, moved there, went up. */
  dragStart(x: number, y: number): void;
  dragTo(x: number, y: number): void;
  dragEnd(): void;
}

export interface WindowControls {
  minimize(): void;
  close(): boolean;
  frame?: FrameControls;
}

export class App {
  readonly host: EditorHost;
  readonly source = new Signal<Source | null>(null);
  /** What the list is waiting for ('' when nothing). */
  readonly busy = new Signal('');
  /** The key of the file being edited ('' when none). */
  readonly active = new Signal('');
  readonly view = new Signal<'edit' | 'compare' | 'conflict' | 'history'>('edit');
  readonly filter = new Signal('');
  readonly scriptsOnly = new Signal(true);
  readonly width = new Signal(300);
  /** Files being saved or published from this screen (the buttons wait, and say so). */
  readonly saving = new Signal<ReadonlyMap<string, string>>(new Map());
  /** Files opened in this session: checked for others' changes, and their saved versions kept in the cache. */
  readonly opened = new Set<string>();
  /** The editor takes the keyboard when the next file is shown (not when the list's arrow keys walk through it). */
  focusNext = false;
  /** The form the page showed when the user chose a solution or all instead: showing the manager again there keeps it. */
  private chosenOn = '';
  /** The latest choice of what to list: one still being read when another is made doesn't replace it. */
  private ticket = 0;
  /** The page's form, read as soon as the manager opens (while the editor and the list load): useForm takes it. */
  private early: { formId: string; scripts: Promise<{ f: FormXml; scripts: FormScript[] }> } | null = null;
  ctx!: AppContext;

  constructor(
    readonly ws: Workspace,
    readonly win: WindowControls,
    /** The page's form, its read started as soon as the connection was verified (main.tsx). */
    earlyForm?: { formId: string; form: Promise<FormXml> } | null,
  ) {
    this.host = new EditorHost(ws);
    this.setFilter('', true);
    const p = pageForm(ws);
    if (p.formId) {
      // The form's scripts (their rows and texts) are read from now on, while the editor loads: they show at once.
      const form = earlyForm?.formId === p.formId ? earlyForm.form : getFormXml(ws.http, p.formId);
      const scripts = form.then((f) => this.scriptsOf(f));
      scripts.catch(() => undefined); // useForm reads it again, and says why when it fails
      this.early = { formId: p.formId, scripts };
    }
    // Opened on a record: its form's scripts are on their way; elsewhere the choice of last time is (init).
    this.busy.value = p.formId || p.table ? 'Reading the scripts of the form…' : 'Loading…';
  }

  /** A form and its scripts: those read at the start when it is that form (once), else read now. */
  private loadForm(formId: string): Promise<{ f: FormXml; scripts: FormScript[] }> {
    const e = this.early;
    this.early = null;
    const fresh = () => getFormXml(this.ws.http, formId).then((f) => this.scriptsOf(f));
    return e?.formId === formId ? e.scripts.catch(fresh) : fresh();
  }

  /**
   * A form's scripts: its libraries in load order, then what they depend on, read by name (not waiting for the list of
   * every web resource), with the texts of its first own scripts (opening one needs no request then).
   */
  private async scriptsOf(f: FormXml): Promise<{ f: FormXml; scripts: FormScript[] }> {
    const libraries = [...new Set(parseForm(f.xml).libraries.map((l) => l.name).filter(Boolean))];
    const scripts: FormScript[] = libraries.map((name) => ({ name }));
    const texts = new Set(libraries.filter((n) => !this.ws.isFirstParty(n)).slice(0, 8).map((n) => n.toLowerCase()));
    const withText = (n: string) => texts.has(n);
    await Promise.all([this.ws.named(libraries, withText).catch(() => undefined), this.addDependencies(scripts).catch(() => undefined)]);
    const deps = scripts.filter((s) => s.via).map((s) => s.name);
    if (deps.length) await this.ws.named(deps).catch(() => undefined);
    // A dependency that isn't a script (an HTML page, a .resx) doesn't run with the form.
    return { f, scripts: scripts.filter((s) => !s.via || (this.ws.byName(s.name)?.type ?? 3) === 3) };
  }

  /** Shows a file in the editor; `focus`: the editor takes the keyboard. */
  open(key: string, focus = true): void {
    if (!key || !this.ws.describe(key)) return;
    this.host.flush();
    this.opened.add(key);
    this.focusNext = focus;
    this.active.value = key;
    if (!this.ws.conflicts.value.has(key) || this.view.value !== 'conflict') this.view.value = 'edit';
  }

  setFilter(text: string, scriptsOnly: boolean): void {
    this.filter.value = text;
    this.scriptsOnly.value = scriptsOnly;
    // The workspace's own filter serves the solution and all lists (Microsoft's own web resources stay out of them).
    this.ws.filter.value = { ...this.ws.filter.value, text, types: scriptsOnly ? SCRIPTS : TEXT, managed: true, hideMicrosoft: true, changedOnly: false, hidden: false, provisionedOnly: false };
  }

  /**
   * The form the page shows. When the page doesn't name it (some pages give only the table): the table's only active
   * main form, else, when `ask`, the one the user picks ('' when none).
   */
  async formOfPage(ask: boolean): Promise<string> {
    const p = pageForm(this.ws);
    if (p.formId || !p.table) return p.formId;
    const forms = (await listForms(this.ws.http, p.table)).filter((f) => f.active);
    const main = forms.filter((f) => f.type === 2 || f.type === 12);
    if (main.length === 1) return main[0].id;
    return ask && forms.length ? this.chooseForm(p.table, forms) : '';
  }

  /** Asks which form of a table to list the scripts of. */
  async chooseForm(table: string, forms?: Array<{ id: string; name: string; type: number }>): Promise<string> {
    const list = forms ?? (await listForms(this.ws.http, table)).filter((f) => f.active);
    const id = (await quickPick({
      title: `Which form of ${table}?`,
      placeholder: 'The form whose scripts to list',
      items: list.map((f) => ({ label: f.name, description: FORM_TYPES[f.type] || 'form', icon: f.type === 7 ? 'add' : 'window', value: f.id })),
    })) as string | undefined;
    return id || '';
  }

  /**
   * The scripts of a form: its libraries in the order the form loads them, then the web resources they list as
   * dependencies (loaded with them). A file already open stays open when it is one of them; else the first script the
   * user can change opens.
   */
  async useForm(formId: string, quiet = false): Promise<void> {
    const t = ++this.ticket;
    if (!quiet) this.busy.value = 'Reading the scripts of the form…';
    try {
      const { f, scripts: listed } = await this.loadForm(formId);
      if (t !== this.ticket) return;
      this.source.value = { kind: 'form', formId, name: f.name, table: f.table, scripts: listed };
      this.chosenOn = '';
      await this.ws.setScope({ kind: 'all' });
      if (t !== this.ticket) return;
      const found = listed.map((s) => this.ws.byName(s.name)).filter((w): w is WebResource => !!w);
      if (found.some((w) => w.id === this.active.value)) return;
      const first = found.find((w) => !(w.isManaged && !w.isCustomizable) && !this.ws.isFirstParty(w.name)) || found[0];
      if (first) this.open(first.id);
      else this.active.value = '';
    } catch (e) {
      if (t === this.ticket) notify({ severity: 'error', message: `The scripts of this form could not be read: ${this.ws.explain(e)}`, actions: [{ label: 'Choose a solution…', run: () => void this.pick() }] });
    } finally {
      if (t === this.ticket) this.busy.value = '';
    }
  }

  /** Adds the web resources the scripts list as dependencies (and theirs), each after the libraries, with the one loading it. */
  private async addDependencies(scripts: FormScript[]): Promise<void> {
    const seen = new Set(scripts.map((s) => s.name.toLowerCase()));
    for (let wave = scripts.map((s) => s.name), depth = 0; wave.length && depth < 5; depth++) {
      const rows = await this.ws.http.all(`webresourceset/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=name,dependencyxml&$filter=${wave.map((n) => `name eq '${q(n)}'`).join(' or ')}`, { label: 'Dependencies of the form scripts' });
      const next: string[] = [];
      for (const r of rows)
        for (const d of parseDependencies(String(r.dependencyxml || '')).libraries) {
          if (!d.name || seen.has(d.name.toLowerCase())) continue;
          const w = this.ws.byName(d.name);
          if (w && w.type !== 3) continue;
          seen.add(d.name.toLowerCase());
          scripts.push({ name: d.name, via: String(r.name) });
          next.push(d.name);
        }
      wave = next;
    }
  }

  /** The list of every web resource being read at the start (init): a solution and all are shown once it is there. */
  private listed: Promise<void> = Promise.resolve();

  async useSolution(solution: Solution): Promise<void> {
    const t = ++this.ticket;
    this.busy.value = `Loading ${solution.friendlyName}…`;
    try {
      // Shown once its scripts are there: not an empty list for a moment ("No scripts here") while they are read.
      await Promise.all([this.ws.setScope({ kind: 'solution', solution }), this.listed]);
      if (t !== this.ticket) return;
      this.source.value = { kind: 'solution', solution };
      void saveValue(this.ws.env, 'simple-source', { kind: 'solution', uniqueName: solution.uniqueName } satisfies Remembered);
    } finally {
      if (t === this.ticket) this.busy.value = '';
    }
  }

  async useAll(): Promise<void> {
    const t = ++this.ticket;
    this.busy.value = this.ws.loadedAt.value ? '' : 'Loading web resources…';
    try {
      await Promise.all([this.ws.setScope({ kind: 'all' }), this.listed]);
      if (t !== this.ticket) return;
      this.source.value = { kind: 'all' };
      void saveValue(this.ws.env, 'simple-source', { kind: 'all' } satisfies Remembered);
    } finally {
      if (t === this.ticket) this.busy.value = '';
    }
  }

  /** A solution or all, chosen by the user: on a form, it stays when the manager is shown there again. */
  private chose(): void {
    this.chosenOn = pageForm(this.ws).formId;
  }

  /**
   * At start: the page's form, else the solution (or all) chosen last time, else nothing (the screen asks). `listed`:
   * the list of every web resource being read; a form's scripts don't wait for it, a solution and all do.
   */
  async init(listed: Promise<void> = Promise.resolve()): Promise<void> {
    this.listed = listed.catch(() => undefined);
    // Settings of earlier versions this screen has no way to change.
    const s = this.ws.settings.value;
    if (s.readOnly || s.minimap || s.onlyPrefixes.length) this.ws.updateSettings({ readOnly: false, minimap: false, onlyPrefixes: [] });
    const formId = await this.formOfPage(true).catch(() => '');
    if (formId) return this.useForm(formId);
    const t = this.ticket;
    const r = await loadValue<Remembered | null>(this.ws.env, 'simple-source', null, (v: any) => !!v && (v.kind === 'all' || (v.kind === 'solution' && typeof v.uniqueName === 'string')));
    if (t !== this.ticket) return;
    if (!r) return void (this.busy.value = '');
    this.busy.value = 'Loading web resources…';
    await listed.catch(() => undefined);
    // Something else was chosen meanwhile.
    if (t !== this.ticket) return;
    if (r.kind === 'all') return this.useAll();
    const sol = this.ws.solutions.value.find((x) => x.uniqueName === r.uniqueName);
    if (sol) return this.useSolution(sol);
    this.busy.value = '';
  }

  /**
   * The manager shown again (the bookmark, the floating button): on a form, that form's scripts, read again (a library
   * may have been added). A solution or all the user chose on that same form stays.
   */
  async shown(): Promise<void> {
    const formId = await this.formOfPage(false).catch(() => '');
    if (!formId || formId === this.chosenOn) return;
    const s = this.source.value;
    await this.useForm(formId, s?.kind === 'form' && s.formId === formId);
  }

  /** Asks what to list: the page's form (or another form of its table), a solution, or all. */
  async pick(): Promise<void> {
    const p = pageForm(this.ws);
    const items: QuickItem<() => Promise<void>>[] = [];
    if (p.formId || p.table)
      items.push({
        label: "This form's scripts",
        description: p.table,
        icon: 'symbol-event',
        value: async () => {
          const id = await this.formOfPage(true);
          if (id) await this.useForm(id);
        },
      });
    if (p.table)
      items.push({
        label: `Another form of ${p.table}…`,
        description: 'main, quick create',
        icon: 'window',
        value: async () => {
          const id = await this.chooseForm(p.table);
          if (id) await this.useForm(id);
        },
      });
    items.push({ label: 'All web resources', description: 'every script in the environment', icon: 'files', value: () => (this.chose(), this.useAll()) });
    const solutions = [...this.ws.solutions.value].sort((a, b) => Number(a.isManaged) - Number(b.isManaged) || a.friendlyName.localeCompare(b.friendlyName));
    if (solutions.length) items.push({ kind: 'separator', label: 'solutions', value: async () => {} });
    for (const s of solutions) items.push({ label: s.friendlyName, description: `${s.uniqueName} · ${s.version}${s.isManaged ? ' · managed' : ''}`, icon: s.isManaged ? 'lock' : 'package', value: () => (this.chose(), this.useSolution(s)) });
    items.push({ kind: 'separator', label: '', value: async () => {} }, { label: 'New script…', description: 'created in Dataverse when saved', icon: 'new-file', value: () => this.newScript() });
    const run = (await quickPick({ title: 'Show the scripts of', items, placeholder: 'Type to find a solution', matchOnDescription: true })) as (() => Promise<void>) | undefined;
    if (run) await run();
  }

  /** The version Compare shows on the left: chosen when Compare opens, and in it when both differ from yours. */
  readonly compareWith = new Signal<'saved' | 'published'>('saved');

  /**
   * What Compare shows for a file, as VS Code does: on the right the file itself (you keep editing it there, Save works
   * there too), on the left the saved version, or the published one (what users get) when Compare was opened on a
   * saved change not published yet, or when chosen. Null when nothing differs.
   */
  comparison(key: string): { left: Side; right: Side; leftLabel: string; rightLabel: string } | null {
    const dirty = this.ws.isDirty(key);
    const unpublished = !!this.ws.get(key)?.unpublished;
    if (!dirty && !unpublished) return null;
    // The saved version is the file itself once nothing is unsaved: the published one is what still differs.
    const left: Side = !dirty || (this.compareWith.value === 'published' && unpublished) ? 'published' : 'saved';
    return {
      left,
      right: 'draft',
      leftLabel: left === 'saved' ? 'Saved version (in Dataverse)' : 'Published version (what users get)',
      rightLabel: dirty ? 'Your changes (not saved)' : 'Saved version (not published yet)',
    };
  }

  /** Opens Compare on the file being edited: beside the saved version when it has unsaved changes, else the published one. */
  compare(): void {
    const key = this.active.value;
    if (!key || !this.comparison(key)) return;
    this.compareWith.value = this.ws.isDirty(key) ? 'saved' : 'published';
    this.view.value = 'compare';
  }

  private mark(key: string, what: string | null): void {
    const next = new Map(this.saving.value);
    if (what) next.set(key, what);
    else next.delete(key);
    this.saving.value = next;
  }

  /** Each file's save or publish running from this screen: a second one waits for it, then does what is left. */
  private inFlight = new Map<string, Promise<void>>();

  /** Saves the file being edited (and publishes it, `publish`); `refocus`: the editor gets the keyboard back after. */
  async save(publish: boolean, refocus = false): Promise<void> {
    const key = this.active.value;
    if (!key) return;
    await this.inTurn(key, async () => {
      // Typing of the last 250 ms isn't a draft yet: Ctrl+S right after it still saves it.
      this.host.flush([key]);
      const dirty = this.ws.isDirty(key);
      if (!dirty && !(publish && this.ws.get(key)?.unpublished)) return;
      this.mark(key, dirty ? (publish ? 'Saving and publishing…' : 'Saving…') : 'Publishing…');
      if (dirty) {
        const name = this.ws.describe(key)?.name ?? '';
        const r = await this.ws.save([key], { publish });
        if (r.some((x) => x.ok)) this.view.value = 'edit';
        // A new script, created: it goes on under its id.
        const made = key.startsWith('new:') && !this.ws.describe(key) ? this.ws.byName(name) : undefined;
        if (made && this.active.value === key) this.open(made.id);
      } else await this.ws.publish([key]);
    });
    if (refocus && this.view.value === 'edit') this.host.code?.focus();
  }

  /** Starts a new script: created in Dataverse when saved (in the solution listed, when one is). */
  async newScript(): Promise<void> {
    const s = this.source.value;
    const solution = s?.kind === 'solution' && !s.solution.isManaged ? s.solution : null;
    const current = this.ws.describe(this.active.value)?.name || '';
    const folder = current ? folderOf(current) : solution?.prefix ? `${solution.prefix}_/scripts/` : '';
    const name = await inputBox({
      title: 'New script',
      prompt: `Its name, with the folders (${solution ? `created in ${solution.friendlyName}` : 'created in the default solution'} when you save it)`,
      value: `${folder}new.js`,
      valueSelection: [folder.length, folder.length + 3],
      validate: (v) => (!v.trim() ? 'Type a name.' : this.ws.byName(v.trim()) ? `${v.trim()} already exists.` : ''),
    });
    if (!name?.trim()) return;
    try {
      this.open(this.ws.createDraft({ name: name.trim(), type: 3, text: '', solution: solution?.uniqueName }));
    } catch (e) {
      notify({ severity: 'error', message: this.ws.explain(e) });
    }
  }

  /** The ⋯ menu of the file bar: what the XrmToolBox plugin does besides editing, out of the way. */
  more(anchor: HTMLElement): void {
    const key = this.active.value;
    const d = this.ws.describe(key);
    if (!d) return;
    const locked = !!this.host.readOnlyReason(key);
    const fail = (what: string) => (e: unknown) => notify({ severity: 'error', message: `${what}: ${this.ws.explain(e)}` });
    // The published version, as the environment serves it.
    const url = `${this.ws.conn.origin}/WebResources/${d.name.split('/').map(encodeURIComponent).join('/')}`;
    showMenu({
      anchor,
      align: 'right',
      items: [
        { label: 'New script…', icon: 'new-file', run: () => void this.newScript() },
        { separator: true },
        { label: 'Format document', icon: 'list-flat', keybinding: 'shift+alt+f', disabled: locked, run: () => void this.host.format(key).catch(fail('Format')) },
        { label: 'Minify', icon: 'fold', disabled: locked, run: () => void this.host.minify(key).catch(fail('Minify')) },
        { separator: true },
        { label: 'Download', icon: 'desktop-download', run: () => void this.host.open(key).then((m) => download(fileOf(d.name), m.getValue(), 'text/plain;charset=utf-8'), fail('Download')) },
        { label: 'Replace with a file…', icon: 'folder-opened', disabled: locked, run: () => this.replaceFromFile(key) },
        { separator: true },
        { label: 'Copy name', icon: 'copy', run: () => void navigator.clipboard.writeText(d.name).then(() => notify({ severity: 'info', message: `Copied ${d.name}.` }), fail('Copy')) },
        { label: 'Open in a new tab', icon: 'link-external', disabled: !d.id, run: () => void window.open(url, '_blank', 'noopener') },
        { label: 'Forms that load it…', icon: 'references', disabled: !d.id, run: () => void this.formsLoading(d.name) },
      ],
    });
  }

  /** Puts a file's text in the editor, as unsaved changes (Compare shows what changed; Undo puts the text back). */
  private replaceFromFile(key: string): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.js,.mjs,.ts,.htm,.html,.css,.xml,.xsl,.xslt,.json,.svg,.resx,.txt';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) return void notify({ severity: 'error', message: `${file.name} is bigger than a web resource can be (5 MB).` });
      const model = await this.host.open(key);
      const before = model.getValue();
      this.host.setText(key, decodeText(new Uint8Array(await file.arrayBuffer())).text);
      notify({
        severity: 'info',
        message: `${file.name} is now the text of ${fileOf(this.ws.describe(key)?.name || key)}, as unsaved changes: Compare shows what changed.`,
        actions: [{ label: 'Undo', run: () => this.host.setText(key, before) }],
      });
    };
    input.click();
  }

  /** The forms whose latest saved (or published) XML loads a script. */
  private async formsLoading(name: string): Promise<void> {
    try {
      const r = await formsUsing(this.ws.http, name);
      await quickPick({
        title: `Forms that load ${fileOf(name)}${r.incomplete ? ' (published forms only)' : ''}`,
        placeholder: r.forms.length ? 'Type to filter' : 'No form loads it.',
        items: r.forms.map((f) => ({ label: f.name, description: `${f.table} · ${FORM_TYPES[f.type] || 'form'}`, icon: 'window', value: f.id })),
      });
    } catch (e) {
      notify({ severity: 'error', message: `The forms could not be searched: ${this.ws.explain(e)}` });
    }
  }

  /** Publishes the saved version only: typing not saved yet stays a draft (the Publish button). */
  async publishSaved(refocus = false): Promise<void> {
    const key = this.active.value;
    if (!key) return;
    await this.inTurn(key, async () => {
      if (!this.ws.get(key)?.unpublished) return;
      this.mark(key, 'Publishing…');
      await this.ws.publish([key]);
    });
    if (refocus && this.view.value === 'edit') this.host.code?.focus();
  }

  private async inTurn(key: string, fn: () => Promise<void>): Promise<void> {
    const before = this.inFlight.get(key);
    const run = (async () => {
      if (before) await before.catch(() => undefined);
      try {
        await fn();
      } finally {
        this.mark(key, null);
      }
    })();
    this.inFlight.set(key, run);
    try {
      await run;
    } finally {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    }
  }

  /** Saves the unsaved changes the list shows (and publishes them, `publish`). */
  async saveAll(keys: string[], publish: boolean): Promise<void> {
    this.host.flush();
    const todo = keys.filter((k) => this.ws.isDirty(k) && !this.saving.value.has(k));
    if (todo.length) await this.ws.save(todo, { publish });
  }

  async discard(): Promise<void> {
    const key = this.active.value;
    this.host.flush([key]);
    if (!key || !this.ws.isDirty(key) || this.saving.value.has(key)) return;
    const name = fileOf(this.ws.describe(key)?.name || key);
    const r = await confirmDialog({
      title: 'Discard your changes?',
      message: `Discard your unsaved changes to ${name}?`,
      detail: 'The editor goes back to the saved version.',
      type: 'warning',
      buttons: [
        { label: 'Discard', value: 'yes', danger: true },
        { label: 'Cancel', value: 'no', primary: true },
      ],
      cancelValue: 'no',
    });
    if (r.value !== 'yes') return;
    // A save may have run while the question was open: what it took is no longer a change to discard.
    if (this.saving.value.has(key) || this.ws.working.value.has(key) || !this.ws.isDirty(key))
      return void notify({ severity: 'info', message: `${name} was saved meanwhile, so nothing was discarded.` });
    const text = this.ws.textOf(key);
    if (text !== undefined) void this.ws.snapshot(key, { text, note: 'Discarded change' });
    this.ws.discard([key]);
    this.view.value = 'edit';
    if (this.active.value === key) this.host.code?.focus();
    // A discard by mistake is one click away from coming back (as unsaved changes again).
    if (text !== undefined)
      notify({
        severity: 'info',
        message: `Discarded your changes to ${name}.`,
        actions: [{ label: 'Undo', run: () => void this.host.open(key).then(() => this.host.setText(key, text)) }],
      });
  }

  /**
   * The scripts Go to Definition and Find All References look in besides the one being edited: the scripts opened, and
   * the form's own scripts (read now, the first time: Microsoft's are left out).
   */
  async scriptModels(): Promise<monaco.editor.ITextModel[]> {
    const keys = new Set(this.opened);
    const s = this.source.value;
    if (s?.kind === 'form')
      for (const x of s.scripts) {
        const w = this.ws.byName(x.name);
        if (w && w.type === 3 && !this.ws.isFirstParty(w.name)) keys.add(w.id);
      }
    const models = await Promise.all([...keys].map((k) => this.host.open(k).catch(() => null)));
    return models.filter((m): m is monaco.editor.ITextModel => !!m);
  }

  /** Go to Definition in another script: shows it, at that place. False when the address is no script of the manager. */
  openAt(uri: monaco.Uri, at: monaco.IRange): boolean {
    const key = this.host.keyOfUri(uri);
    if (!key) return false;
    if (key !== this.active.value || this.view.value !== 'edit') this.open(key);
    this.host.revealWhenShown(key, at);
    return true;
  }

  /** Shows the versions of a script this browser kept (each save and publish, what was there before them…). */
  history(key = this.active.value): void {
    if (!key || !this.ws.describe(key)) return;
    this.open(key, false);
    this.view.value = 'history';
  }

  /**
   * Puts a version kept in the history back into the editor, as unsaved changes: Save & Publish then makes it live
   * again (the way to undo a publish). What was unsaved before is kept in the history, and Undo brings it back.
   */
  async restore(key: string, m: HistoryMeta): Promise<void> {
    const e = await historyEntry(this.ws.env, m.id);
    if (!e) return void notify({ severity: 'warning', message: 'This version is no longer kept in this browser.' });
    const model = await this.host.open(key);
    this.host.flush([key]);
    const before = model.getValue();
    if (this.ws.isDirty(key)) await this.ws.snapshot(key, { text: before, note: 'Unsaved changes before restoring a version' });
    this.host.setText(key, base64ToText(e.b64).text);
    this.host.flush([key]);
    this.view.value = 'edit';
    if (this.active.value === key) this.host.code?.focus();
    notify({
      severity: 'info',
      message: `Restored the version of ${new Date(m.at).toLocaleString()} as unsaved changes: Save & Publish makes it live again.`,
      actions: [{ label: 'Undo', run: () => void this.host.open(key).then(() => this.host.setText(key, before)) }],
    });
  }

  /** Closes the manager; while a save or publish runs, as soon as it has finished. */
  close(): void {
    if (this.win.close()) return;
    notify({ severity: 'info', message: 'A save or publish is still running: the manager closes when it has finished.' });
    const off = this.ws.working.subscribe((m) => {
      if (m.size || this.saving.value.size) return;
      off();
      setTimeout(() => this.win.close(), 0);
    });
  }
}

/** Builds the screen's state and the context the editors (the conflict editor, IntelliSense) work with. */
export function createApp(ws: Workspace, win: WindowControls, earlyForm?: { formId: string; form: Promise<FormXml> } | null): App {
  const app = new App(ws, win, earlyForm);
  const { host } = app;
  ws.ui = { confirm: (o) => confirmDialog({ ...o, buttons: o.buttons }), notify: (o) => notify(o) };
  const tabs = new Signal<any[]>([]);
  const activeTab = new Signal('');
  app.active.subscribe((k) => (activeTab.value = k ? `wr:${k}` : ''));
  app.ctx = {
    ws,
    host,
    tabs,
    activeTab,
    revealKey: new Signal(''),
    openResource: (key) => app.open(key),
    openDiff: (key) => {
      app.open(key);
      app.compare();
    },
    openTab: (t) => {
      if (t.kind === 'conflict' && t.key) {
        app.open(t.key);
        app.view.value = 'conflict';
      }
    },
    closeTab: () => (app.view.value = 'edit'),
    showView: () => {},
    reveal: (key) => app.open(key),
    showPanel: () => {},
  };
  setCtx(app.ctx);
  ws.openKeys = () => [...app.opened];
  ws.showHistory = (key) => app.history(key);
  return app;
}

/** The commands the keys and the conflict editor run. */
function commands(app: App) {
  const { ws } = app;
  return [
    { id: 'wrm.save', title: 'Save', key: 'ctrl+s', inInputs: true, run: () => app.save(false) },
    { id: 'wrm.saveAndPublish', title: 'Save and Publish', key: 'ctrl+shift+s', inInputs: true, run: () => app.save(true) },
    // In Compare, as in VS Code's diff editor: the next and previous change.
    { id: 'wrm.nextChange', title: 'Next Change', key: 'alt+f5', inInputs: true, when: () => app.view.value === 'compare', run: () => app.host.diff?.goToDiff('next') },
    { id: 'wrm.previousChange', title: 'Previous Change', key: 'shift+alt+f5', inInputs: true, when: () => app.view.value === 'compare', run: () => app.host.diff?.goToDiff('previous') },
    // Used by the conflict editor.
    { id: 'wrm.saveKeys', title: 'Save', hidden: true, run: (a: unknown) => ws.save(Array.isArray(a) ? (a as string[]) : [app.active.value]) },
    {
      id: 'wrm.resolve',
      title: 'Resolve Conflict',
      hidden: true,
      run: async (a: any) => {
        await ws.resolve(a.key, a.how, a.text);
        if (!ws.conflicts.value.has(a.key)) app.view.value = 'edit';
      },
    },
  ];
}

/** The theme in effect: the setting's, or the system's when it follows it. */
const themeOf = (t: string) => (t === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t);

export function SimpleApp({ app }: { app: App }) {
  const { ws } = app;
  const width = useSignal(app.width);
  const lost = useSignal(ws.sessionLost);
  const theme = useSignal(ws.settings).theme;
  const start = useRef(0);

  // The screen follows the theme setting (the code editor does too: EditorHost).
  useEffect(() => {
    // Remembered at once too: the next start opens in this theme from its first moment (core/theme.ts).
    rememberTheme(window, theme);
    const apply = () => (document.documentElement.dataset.theme = themeOf(theme));
    apply();
    const mq = matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    setCommandErrorHandler((e, c) => notify({ severity: 'error', message: `${c.title}: ${ws.explain(e)}` }));
    const off = registerCommands(commands(app));
    const offKeys = listenKeys(window, () => modalOpen.value);
    return () => {
      off();
      offKeys();
    };
  }, []);

  return (
    <div class="sm" onContextMenu={(e) => (e.target as HTMLElement).closest('input,textarea,.monaco-editor') || e.preventDefault()}>
      <Header app={app} />
      {lost && (
        <div class="wb-banner error">
          <Icon name="debug-disconnect" />
          <span>{lost} Your unsaved changes are kept in this browser and come back when you open the manager again.</span>
        </div>
      )}
      <div class="sm-body">
        <div class="sm-side" style={{ width: `${width}px` }}>
          <Side app={app} />
          <div class="wb-sash-v">
            <Sash direction="vertical" onStart={() => (start.current = app.width.value)} onDrag={(dx) => (app.width.value = Math.max(200, Math.min(window.innerWidth - 360, start.current + dx)))} onReset={() => (app.width.value = 300)} />
          </div>
        </div>
        <Main app={app} />
      </div>
      <Layers />
    </div>
  );
}

const NOT_FRAMED = new Signal(false);

function Header({ app }: { app: App }) {
  const conn = app.ws.conn;
  const prod = conn.envType === 'Production';
  const light = themeOf(useSignal(app.ws.settings).theme) === 'light';
  const f = app.win.frame;
  const max = useSignal(f?.maximized ?? NOT_FRAMED);
  const onButton = (e: Event) => !!(e.target as HTMLElement).closest('button');
  // The title bar moves the window (a maximized one is restored as soon as it is dragged); a double-click maximizes it.
  const onPointerDown = (e: PointerEvent) => {
    if (!f || e.button !== 0 || onButton(e)) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    f.dragStart(e.clientX, e.clientY);
    const move = (m: PointerEvent) => f.dragTo(m.clientX, m.clientY);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      f.dragEnd();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <div class="sm-header" onPointerDown={onPointerDown} onDblClick={(e) => f && !onButton(e) && f.toggleMaximized()}>
      <Icon name="code" />
      <span class="sm-title">Web Resources</span>
      <span class="sm-env" title={`${conn.host} · signed in as ${conn.userName}`}>
        {conn.orgName}
      </span>
      {prod && <span class="sm-prod">PRODUCTION</span>}
      <span class="sm-spacer" />
      <button class="sm-win" title={light ? 'Dark theme' : 'Light theme'} aria-label={light ? 'Switch to the dark theme' : 'Switch to the light theme'} onClick={() => app.ws.updateSettings({ theme: light ? 'dark' : 'light' })}>
        <Icon name="color-mode" />
      </button>
      <button class="sm-win" title="Hide (click the bookmark or the floating button to come back)" aria-label="Hide" onClick={() => app.win.minimize()}>
        <Icon name="chrome-minimize" />
      </button>
      {f && (
        <button class="sm-win" title={max ? 'Restore the window' : 'Maximize: fill the page'} aria-label={max ? 'Restore' : 'Maximize'} onClick={() => f.toggleMaximized()}>
          <Icon name={max ? 'chrome-restore' : 'chrome-maximize'} />
        </button>
      )}
      <button class="sm-win" title="Close (unsaved changes stay in this browser)" aria-label="Close" onClick={() => app.close()}>
        <Icon name="chrome-close" />
      </button>
    </div>
  );
}

/** The list of scripts, under what it lists. */
function Side({ app }: { app: App }) {
  const { ws } = app;
  const source = useSignal(app.source);
  const busy = useSignal(app.busy);
  const loading = useSignal(ws.loading);
  const resources = useSignal(ws.resources);
  const scopeIds = useSignal(ws.scopeIds);
  const drafts = useSignal(ws.drafts);
  const conflicts = useSignal(ws.conflicts);
  const filter = useSignal(app.filter);
  const scriptsOnly = useSignal(app.scriptsOnly);
  const active = useSignal(app.active);
  const saving = useSignal(app.saving);
  useSignal(ws.filter);

  const rows: Row[] = useMemo(() => {
    if (!source) return [];
    const t = filter.trim().toLowerCase();
    let list: Row[];
    if (source.kind === 'form')
      list = source.scripts
        .filter((s) => !t || s.name.toLowerCase().includes(t))
        .map((s) => {
          const w = ws.byName(s.name) || null;
          return { key: w?.id || `missing:${s.name}`, w, name: s.name, via: s.via };
        });
    else
      list = ws
        .visible()
        .sort(byName)
        .map((w) => ({ key: w.id, w, name: w.name }));
    // Unsaved changes and conflicts of scripts the list doesn't hold are shown too: Save all saves them.
    const listed = new Set(list.map((r) => r.key));
    const others = [...new Set([...drafts.keys(), ...conflicts.keys()])]
      .filter((k) => !listed.has(k))
      .map((k) => ws.get(k))
      .filter((w): w is WebResource => !!w)
      .sort(byName);
    if (others.length) list = [...list, { key: 'title:others', w: null, name: '', title: 'Other unsaved changes' }, ...others.map((w) => ({ key: w.id, w, name: w.name }))];
    // New scripts (New script…), created in Dataverse when saved.
    const created = [...drafts.values()].filter((d) => d.key.startsWith('new:')).sort((a, b) => a.name.localeCompare(b.name));
    if (created.length) list = [...list, { key: 'title:new', w: null, name: '', title: 'New, created when saved' }, ...created.map((d) => ({ key: d.key, w: null, name: d.name, isNew: true }))];
    return list;
  }, [source, resources, scopeIds, filter, scriptsOnly, drafts, conflicts]);

  // Save all saves what the list shows: a change this screen can't show (a new web resource of an earlier version) waits.
  const listedDirty = rows.filter((r) => r.isNew || (r.w && drafts.has(r.w.id))).map((r) => r.key);
  const dirty = listedDirty.length;
  // What the list waits for. A form's list doesn't wait for the list of every web resource (read meanwhile), and a
  // save says what it does above the editor.
  const note = busy || (source?.kind !== 'form' && !saving.size ? loading : '');
  const label = !source ? (busy ? 'Loading…' : 'Choose what to show…') : source.kind === 'form' ? `${source.name} (${source.table} form)` : source.kind === 'solution' ? source.solution.friendlyName : 'All web resources';
  const icon = !source ? 'list-selection' : source.kind === 'form' ? 'symbol-event' : source.kind === 'solution' ? 'package' : 'files';
  const count = rows.filter((r) => !r.title && !r.key.startsWith('missing:')).length;

  return (
    <div class="sm-side-inner">
      <button class="sm-source" onClick={() => void app.pick()} title="Show the scripts of this form, of a solution, or all">
        <Icon name={icon} />
        <span>{label}</span>
        <Icon name="chevron-down" />
      </button>
      {source && (
        <div class="sm-filter">
          <SearchInput
            value={filter}
            onInput={(v) => app.setFilter(v, scriptsOnly)}
            placeholder={source.kind === 'form' ? 'Filter' : 'Filter by name'}
            ariaLabel="Filter the list"
            toggles={source.kind === 'form' ? [] : [{ icon: 'symbol-file', title: 'Only scripts (JavaScript). Off: HTML, CSS, XML… too', checked: scriptsOnly, onToggle: () => app.setFilter(filter, !scriptsOnly) }]}
          />
        </div>
      )}
      {note && <div class="sm-note">{note}</div>}
      {source && !note && !rows.length && (
        <div class="sm-note">{source.kind === 'form' ? (source.scripts.length ? 'No script matches the filter.' : 'This form loads no scripts.') : filter ? 'Nothing matches the filter.' : 'No scripts here.'}</div>
      )}
      <div class="sm-list">
        <VirtualList
          // Clearing the filter shows the whole list again with the script being edited in view.
          key={filter.trim() ? 'filtered' : 'all'}
          items={rows}
          rowHeight={24}
          keyOf={(r) => r.key}
          selected={active ? [active] : []}
          focused={active || undefined}
          // The arrow keys show each script, the keyboard staying in the list; a click or Enter edits it.
          onSelect={(keys) => keys[0] && !keys[0].startsWith('missing:') && !keys[0].startsWith('title:') && app.open(keys[0], false)}
          onActivate={(r) =>
            r.w || r.isNew
              ? app.open(r.w?.id ?? r.key, true)
              : !r.title && notify({ severity: 'info', message: `${r.name} is loaded by the form, but there is no web resource of that name to open here (a platform library, or one that doesn't exist).` })
          }
          activateOnClick
          multiple={false}
          typeAhead={(r) => fileOf(r.name)}
          scrollTo={active}
          ariaLabel="Scripts"
          render={(r) => (r.title ? <div class="sm-group">{r.title}</div> : <FileRow r={r} dirty={!!r.w && drafts.has(r.w.id)} conflict={!!r.w && conflicts.has(r.w.id)} />)}
        />
      </div>
      {source && (
        <div class="sm-foot">
          <span>{plural(count, source.kind === 'form' || scriptsOnly ? 'script' : 'web resource')}</span>
          {dirty > 0 && (
            <span class="sm-foot-dirty">
              {dirty} unsaved
              <button class="wb-link" title="Save every unsaved change listed" onClick={() => void app.saveAll(listedDirty, false)}>
                Save all
              </button>
              <button class="wb-link" title="Save every unsaved change listed, then publish them" onClick={() => void app.saveAll(listedDirty, true)}>
                & publish
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({ r, dirty, conflict }: { r: Row; dirty: boolean; conflict: boolean }) {
  if (r.isNew)
    return (
      <div class="sm-row dirty" title={`${r.name} — new: created in Dataverse when you save it`}>
        <FileIcon type={3} name={r.name} />
        <span class="sm-name">{fileOf(r.name)}</span>
        <span class="sm-folder">{folderOf(r.name)}</span>
        <span class="sm-mark dirty">new</span>
      </div>
    );
  if (!r.w)
    return (
      <div class="sm-row missing" title={`${r.name}: the form loads this library, but the list has no web resource of that name (a platform library, a hidden web resource, or one created since the manager opened)`}>
        <Icon name="circle-slash" />
        <span class="sm-name">{fileOf(r.name)}</span>
        <span class="sm-folder">{folderOf(r.name)}</span>
      </div>
    );
  const w = r.w;
  const tip = conflict ? 'Changed on the server while you edited it' : dirty ? 'Unsaved changes' : w.unpublished ? `Saved${w.modifiedBy ? ` by ${w.modifiedBy}` : ''}, not published` : '';
  return (
    <div class={`sm-row${dirty ? ' dirty' : ''}${conflict ? ' conflict' : ''}${r.via ? ' dep' : ''}`} title={`${w.name}${r.via ? ` — loaded with ${r.via}` : ''}${tip ? ` — ${tip}` : ''}`}>
      <FileIcon type={w.type} name={w.name} />
      <span class="sm-name">{fileOf(w.name)}</span>
      <span class="sm-folder">{r.via ? `with ${fileOf(r.via)}` : folderOf(w.name)}</span>
      {conflict ? <span class="sm-mark conflict">!</span> : dirty ? <span class="sm-mark dirty">●</span> : w.unpublished ? <span class="sm-mark unpub">not published</span> : null}
    </div>
  );
}

/** The file being edited: its name and state, the actions, and the editor (or the comparison). */
function Main({ app }: { app: App }) {
  const { ws } = app;
  const source = useSignal(app.source);
  const busy = useSignal(app.busy);
  const active = useSignal(app.active);
  const view = useSignal(app.view);
  useSignal(ws.drafts);
  useSignal(ws.resources);
  useSignal(ws.working);
  useSignal(app.saving);
  const conflicts = useSignal(ws.conflicts);
  const d = active ? ws.describe(active) : null;

  // A comparison with nothing to compare any more (saved, or discarded) goes back to the editor.
  useEffect(() => {
    if (view === 'compare' && active && !app.comparison(active)) app.view.value = 'edit';
    if (view === 'conflict' && active && !conflicts.has(active)) app.view.value = 'edit';
  });

  if (!d) {
    if (busy) return <div class="sm-main"><Empty text={busy} loading /></div>;
    // The choice waits for the list of web resources (its buttons say so).
    if (!source) return <div class="sm-main"><Start app={app} /></div>;
    if (source.kind === 'form' && !source.scripts.length) return <div class="sm-main"><Start app={app} text={`${source.name} loads no scripts. Choose a solution, or show them all, to edit others.`} /></div>;
    return <div class="sm-main"><Empty text="Pick a script on the left to edit it." /></div>;
  }
  return (
    <div class="sm-main">
      <FileBar app={app} />
      <div class="sm-editor">
        <CodeView app={app} show={view === 'edit'} />
        <DiffView app={app} show={view === 'compare'} />
        {view === 'history' && <HistoryView app={app} />}
        {view === 'conflict' && conflicts.has(active) && editorDef('conflict')?.component({ ctx: app.ctx, tab: { id: `conflict:${active}`, kind: 'conflict', key: active, title: fileOf(d.name), preview: false }, visible: true })}
      </div>
    </div>
  );
}

function Start({ app, text }: { app: App; text?: string }) {
  const loading = useSignal(app.ws.loading);
  return (
    <div class="sm-start">
      <Icon name="code" />
      <h2>{text ? 'No scripts on this form' : 'Which scripts do you want to edit?'}</h2>
      <p>{text || 'Open this from a form to load that form\'s scripts at once. Otherwise choose a solution, or show them all.'}</p>
      <div class="sm-start-buttons">
        <Button kind="primary" disabled={!!loading} onClick={() => void app.pick()}>
          Choose a solution…
        </Button>
        <Button kind="secondary" disabled={!!loading} onClick={() => void app.useAll()}>
          All web resources
        </Button>
      </div>
      {loading && <p class="sm-note">{loading}</p>}
    </div>
  );
}

/** The middle of the screen while nothing is shown; `loading`: what it waits for (before any script is shown). */
const Empty = ({ text, loading }: { text: string; loading?: boolean }) => (
  <div class="sm-start" aria-busy={loading ? 'true' : undefined}>
    <Icon name="code" />
    <p>{text}</p>
    {loading && <div class="sm-loading" role="progressbar" aria-label={text} />}
  </div>
);

function FileBar({ app }: { app: App }) {
  const { ws, host } = app;
  const key = app.active.value;
  const view = app.view.value;
  const d = ws.describe(key)!;
  const w = ws.get(key);
  const dirty = ws.isDirty(key);
  const conflict = ws.conflicts.value.get(key);
  const working = app.saving.value.get(key) || ws.working.value.get(key) || '';
  const locked = ws.readOnlyReason() || (w?.isManaged && !w.isCustomizable ? `${fileOf(d.name)} belongs to a managed solution that doesn't allow changing it.` : '');
  const cmp = app.comparison(key);
  const publishable = dirty || !!w?.unpublished;

  const state = working
    ? { cls: 'working', text: working }
    : conflict
      ? { cls: 'conflict', text: `Changed by ${conflict.theirs.modifiedBy || 'someone else'} ${ago(conflict.theirs.modifiedOn)} — nothing was overwritten` }
      : dirty
        ? { cls: 'dirty', text: '● Unsaved changes' }
        : w?.unpublished
          ? { cls: 'unpub', text: `Saved${w.modifiedBy && w.modifiedById !== ws.conn.userId ? ` by ${w.modifiedBy}` : ''} ${ago(w.modifiedOn)} · not published` }
          : w
            ? { cls: 'pub', text: `Published · ${ago(w.publishedOn || w.modifiedOn)}` }
            : { cls: 'pub', text: '' };

  return (
    <div class="sm-filebar">
      <div class="sm-file">
        <FileIcon type={d.type} name={d.name} />
        <span class="sm-file-name">{fileOf(d.name)}</span>
        <span class="sm-file-folder">{folderOf(d.name)}</span>
        {state.text && (
          <span class={`sm-state ${state.cls}`} title={state.text}>
            {state.text}
          </span>
        )}
        {locked && (
          <span class="sm-state locked" title={locked}>
            <Icon name="lock" /> Read-only
          </span>
        )}
      </div>
      <div class="sm-actions">
        {view === 'conflict' || view === 'history' ? (
          // The conflict editor and the history have their own choices (Take theirs, Keep mine, Save the merge; Restore).
          <Button kind="secondary" onClick={() => (app.view.value = 'edit')}>
            <Icon name="edit" /> Back to editing
          </Button>
        ) : (
          <>
            {conflict ? (
              <Button kind="primary" onClick={() => (app.view.value = 'conflict')}>
                Compare and choose
              </Button>
            ) : (
              <Button kind="secondary" disabled={!cmp && view !== 'compare'} title={view === 'compare' ? 'Back to the editor' : cmp ? (dirty ? 'Show the saved version beside your changes (you keep editing on the right)' : 'Show the published version beside the saved one (you can edit on the right)') : 'Nothing to compare: no unsaved or unpublished changes'} onClick={() => (view === 'compare' ? (app.view.value = 'edit') : app.compare())}>
                <Icon name={view === 'compare' ? 'edit' : 'git-compare'} /> {view === 'compare' ? 'Back to editing' : 'Compare'}
              </Button>
            )}
            <Button kind="secondary" title="The versions of this script kept in this browser: compare one, or restore it (to undo a save or a publish)" onClick={() => app.history()}>
              <Icon name="history" /> History
            </Button>
            <Button kind="secondary" disabled={!dirty || !!working} title={dirty ? 'Throw your unsaved changes away' : 'No unsaved changes'} onClick={() => void app.discard()}>
              Discard
            </Button>
            <Button kind={dirty ? 'primary' : 'secondary'} disabled={!dirty || !!working || !!locked || !!conflict} title={dirty ? 'Save to Dataverse, not published yet (Ctrl+S)' : 'No unsaved changes'} onClick={() => void app.save(false, true)}>
              <Icon name="save" /> Save
            </Button>
            <Button kind="secondary" disabled={!publishable || !!working || !!locked || !!conflict} title={dirty ? 'Save, then publish so users get it (Ctrl+Shift+S)' : w?.unpublished ? 'Publish the saved version so users get it' : 'Nothing to publish'} onClick={() => void (dirty || !w?.unpublished ? app.save(true, true) : app.publishSaved(true))}>
              <Icon name="cloud-upload" /> {dirty || !w?.unpublished ? 'Save & Publish' : 'Publish'}
            </Button>
            <button type="button" class="wg-button wg-button-secondary sm-more" title="More: new script, format, minify, download, replace with a file, copy the name, open, the forms that load it" aria-label="More actions" aria-haspopup="menu" onClick={(e) => app.more(e.currentTarget as HTMLElement)}>
              <Icon name="ellipsis" />
            </button>
          </>
        )}
      </div>
      {host.readOnlyReason(key) && !locked && !conflict && <div class="sm-hint">{host.readOnlyReason(key)}</div>}
    </div>
  );
}

/** The code editor, showing the active file. */
function CodeView({ app, show }: { app: App; show: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const key = app.active.value;
  // A conflict found while the file is shown makes it read-only at once (Compare and choose first).
  const conflicted = useSignal(app.ws.conflicts).has(key);
  useEffect(() => {
    if (el.current) app.host.mountCode(el.current);
  }, []);
  useLayoutEffect(() => app.host.showingEditor('code', show, key), [show, key]);
  useEffect(() => {
    if (!show || !key) return;
    setError('');
    // Until the new file is read, the editor shows nothing: typing never lands in the file shown before.
    if (app.host.code?.getModel() !== app.host.model(key)) {
      app.host.showingEditor('code', false);
      app.host.showingEditor('code', true, key);
      setReading(true);
    }
    let cancelled = false;
    app.host
      .show(key)
      .then(() => {
        if (cancelled) return;
        setReading(false);
        app.host.code?.layout();
        if (app.focusNext) app.host.code?.focus();
        app.focusNext = false;
      })
      .catch((e) => {
        if (cancelled) return;
        setReading(false);
        setError(app.ws.explain(e));
      });
    return () => {
      cancelled = true;
    };
  }, [show, key, conflicted]);
  return (
    <div class="wb-editor-slot" hidden={!show}>
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      {reading && !error && <div class="sm-reading">Reading the script…</div>}
      {error && (
        <div class="wb-empty-editor">
          <Icon name="error" />
          <span>{error}</span>
          <Button onClick={() => app.ws.content(key, 'saved', true).then(() => app.host.show(key)).then(() => setError(''), (e) => setError(app.ws.explain(e)))}>Try again</Button>
        </div>
      )}
    </div>
  );
}

/**
 * The comparison, as in VS Code: the saved (or published) version on the left, the file itself on the right, where
 * you keep editing (unless it is read-only), with the arrows to step through the changes and to revert one.
 */
function DiffView({ app, show }: { app: App; show: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  // A narrow window shows one column (removed lines red, added green): the labels then say so.
  const [inline, setInline] = useState(false);
  useSignal(app.compareWith);
  const key = app.active.value;
  const cmp = show && key ? app.comparison(key) : null;
  const readOnly = key ? app.host.readOnlyReason(key) : '';
  // Both the saved and the published version differ from yours: either can be on the left.
  const choose = !!cmp && app.ws.isDirty(key) && !!app.ws.get(key)?.unpublished;
  useLayoutEffect(() => app.host.showingEditor('diff', show), [show]);
  useEffect(() => {
    if (!show || !cmp || !el.current) return;
    app.host.mountDiff(el.current);
    setError('');
    let cancelled = false;
    Promise.all([app.host.versionModel(key, cmp.left), app.host.versionModel(key, cmp.right)])
      .then(([a, b]) => {
        if (cancelled) return;
        app.host.showDiff(a, b, !app.host.readOnlyReason(key));
        app.host.diff?.layout();
        setInline(app.host.diffInline());
      })
      .catch((e) => !cancelled && setError(app.ws.explain(e)));
    return () => {
      cancelled = true;
    };
  }, [show, key, cmp?.left, cmp?.right, !!readOnly]);
  useEffect(() => {
    const root = show ? el.current?.querySelector('.monaco-diff-editor') : null;
    if (!root) return;
    const check = () => setInline(app.host.diffInline());
    check();
    const mo = new MutationObserver(check);
    mo.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, [show, cmp?.left]);
  return (
    <div class="wb-editor-slot sm-diff" hidden={!show}>
      {cmp && (
        <div class="sm-diff-labels">
          {choose ? (
            <select class="sm-diff-with" aria-label="Compare with" value={cmp.left} onChange={(e) => (app.compareWith.value = (e.currentTarget as HTMLSelectElement).value as 'saved' | 'published')}>
              <option value="saved">Saved version (in Dataverse)</option>
              <option value="published">Published version (what users get)</option>
            </select>
          ) : (
            <span>{cmp.leftLabel}</span>
          )}
          {inline && <span class="sm-diff-inline">one column: removed lines in red, added in green</span>}
          <span class="sm-diff-right">
            {cmp.rightLabel}
            <span class="sm-diff-hint" title={readOnly || undefined}>
              {readOnly ? ' · read-only' : ' · you can edit here'}
            </span>
          </span>
          <span class="sm-diff-nav">
            <button class="sm-icon-button" title="Previous change (Shift+Alt+F5)" aria-label="Previous change" onClick={() => app.host.diff?.goToDiff('previous')}>
              <Icon name="arrow-up" />
            </button>
            <button class="sm-icon-button" title="Next change (Alt+F5)" aria-label="Next change" onClick={() => app.host.diff?.goToDiff('next')}>
              <Icon name="arrow-down" />
            </button>
          </span>
        </div>
      )}
      <div ref={el} class="sm-diff-editor" />
      {error && <div class="wb-empty-editor">{error}</div>}
    </div>
  );
}

/** What each kind of version kept in the history is, in this screen's words, and its icon. */
const VERSION: Record<HistoryKind, { label: string; icon: string }> = {
  saved: { label: 'Saved', icon: 'save' },
  published: { label: 'Published', icon: 'cloud-upload' },
  'before-save': { label: 'Before a save (the version it replaced)', icon: 'cloud' },
  'before-publish': { label: 'Live before a publish', icon: 'history' },
  'before-delete': { label: 'Before deleting', icon: 'trash' },
  theirs: { label: "Someone else's version (a conflict)", icon: 'account' },
  restored: { label: 'Restored', icon: 'discard' },
  opened: { label: 'Opened', icon: 'go-to-file' },
  pulled: { label: 'Read from the server', icon: 'cloud-download' },
  'local-file': { label: 'From a local file', icon: 'file' },
  snapshot: { label: 'Kept', icon: 'device-camera' },
};

/**
 * The history of the script being edited: the versions this browser kept (each save and publish, the version a save
 * or a publish replaced, changes discarded…), newest first. The one picked is compared with the file (which you can
 * keep editing on the right), and Restore puts it back as unsaved changes: Save & Publish then undoes a publish.
 */
function HistoryView({ app }: { app: App }) {
  const { ws, host } = app;
  const key = app.active.value;
  const el = useRef<HTMLDivElement>(null);
  const [list, setList] = useState<HistoryMeta[] | null>(null);
  const [picked, setPicked] = useState('');
  const [error, setError] = useState('');
  const readOnly = host.readOnlyReason(key);
  useSignal(ws.drafts);

  // The list, read again each time the history is shown (a save or a publish adds to it).
  useEffect(() => {
    let cancelled = false;
    setList(null);
    setPicked('');
    void historyList(ws.env, key).then(
      (l) => {
        if (cancelled) return;
        setList(l);
        // The newest version that isn't what is saved now: what a change replaced.
        const saved = ws.cached(key)?.b64;
        const now = saved === undefined ? '' : fingerprint(saved);
        setPicked((l.find((m) => m.hash !== now) ?? l[0])?.id ?? '');
      },
      (e) => !cancelled && setError(ws.explain(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [key]);

  const m = list?.find((x) => x.id === picked);
  useLayoutEffect(() => host.showingEditor('diff', !!m), [!!m]);
  useEffect(() => {
    if (!m || !el.current) return;
    host.mountDiff(el.current);
    setError('');
    let cancelled = false;
    void historyEntry(ws.env, m.id)
      .then((e) => {
        if (!e) throw new Error('This version is no longer kept in this browser.');
        return Promise.all([host.versionModel(key, 'version', e.b64), host.versionModel(key, 'draft')]);
      })
      .then(
        ([a, b]) => {
          if (cancelled) return;
          host.showDiff(a, b, !host.readOnlyReason(key));
          host.diff?.layout();
        },
        (e) => !cancelled && setError(ws.explain(e)),
      );
    return () => {
      cancelled = true;
      host.showingEditor('diff', false);
    };
  }, [m?.id, key]);

  const forget = async () => {
    const r = await confirmDialog({
      title: 'Delete the history of this script?',
      message: `Delete the ${plural(list?.length ?? 0, 'version')} of ${fileOf(ws.describe(key)?.name || key)} kept in this browser?`,
      detail: 'They are deleted from this browser only; the script in Dataverse doesn\'t change. This cannot be undone.',
      type: 'warning',
      buttons: [
        { label: 'Delete', value: 'yes', danger: true },
        { label: 'Cancel', value: 'no', primary: true },
      ],
      cancelValue: 'no',
    });
    if (r.value !== 'yes') return;
    await clearHistory(ws.env, key);
    setList([]);
    setPicked('');
  };

  return (
    <div class="sm-history">
      <div class="sm-history-list" role="listbox" aria-label="Versions kept in this browser">
        <div class="sm-history-title">Versions kept in this browser</div>
        {list === null && !error && <div class="sm-note">Reading the history…</div>}
        {list?.length === 0 && <div class="sm-note">No version kept yet. Each save and publish from this manager keeps one here, with the version it replaced.</div>}
        {list?.map((x) => {
          const v = VERSION[x.kind] ?? { label: x.kind, icon: 'circle-outline' };
          return (
            <button
              key={x.id}
              role="option"
              aria-selected={x.id === picked}
              class={`sm-version${x.id === picked ? ' picked' : ''}`}
              title={`${new Date(x.at).toLocaleString()}${x.by ? ` · ${x.by}` : ''}${x.note ? ` · ${x.note}` : ''}`}
              onClick={() => setPicked(x.id)}
            >
              <Icon name={v.icon} />
              <span class="sm-version-text">
                <span class="sm-version-label">{x.kind === 'snapshot' && x.note ? x.note : v.label}</span>
                <span class="sm-version-when">
                  {ago(x.at)}
                  {x.by ? ` · ${x.by}` : ''}
                </span>
              </span>
            </button>
          );
        })}
        {!!list?.length && (
          <div class="sm-history-foot">
            The last {ws.settings.value.historyPerFile} of each script are kept, in this browser only.{' '}
            <button class="wb-link" onClick={() => void forget()}>
              Delete them…
            </button>
          </div>
        )}
      </div>
      <div class="sm-history-main">
        {m && (
          <div class="sm-diff-labels">
            <span>
              {VERSION[m.kind]?.label ?? m.kind}, {new Date(m.at).toLocaleString()}
            </span>
            <span class="sm-diff-right">
              Your file
              <span class="sm-diff-hint">{readOnly ? ' · read-only' : ' · you can edit here'}</span>
            </span>
            <Button kind="primary" disabled={!!readOnly} title={readOnly || 'Put this version back in the editor as unsaved changes (then Save & Publish to make it live)'} onClick={() => void app.restore(key, m)}>
              <Icon name="discard" /> Restore this version
            </Button>
          </div>
        )}
        <div ref={el} class="sm-diff-editor" />
        {error && <div class="wb-empty-editor">{error}</div>}
      </div>
    </div>
  );
}

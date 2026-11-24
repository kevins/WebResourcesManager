// The Monaco side of the editor area: one code editor and one diff editor, reused for every tab (as VS Code does in
// an editor group), a text model per open web resource, and the link between a model and the workspace's drafts:
// typing becomes a draft (kept in IndexedDB), and a draft discarded or a newer saved version puts its text back in
// the model (as an edit, so Ctrl+Z still works). Also: change bars in the gutter against the version the draft
// started from, checking (lint) as you type, and the editor of the active tab, which the Edit and Go menus act on.

import { base64ToText, debounce, fingerprint } from '../core/util';
import { canFormat, canMinify, formatText, jsonError, keepLineEndings, languageOf, minifyText, normalizeEol } from '../editor/format';
import { lintHtml, lintScript, type Diagnostic } from '../editor/lint';
import { baseEditorOptions, modelFor, monaco, setEditorTheme, workersAllowed, wrUri } from '../editor/monaco';
import { xmlError } from '../editor/xmlformat';
import { setLintFixes } from '../editor/xrm';
import { gutterMarks } from '../model/diff';
import { TYPES, isTextType } from '../model/types';
import type { Content, Settings } from '../model/model';
import type { Workspace } from '../model/workspace';
import { closeQuickInput, quickInputOpen } from './widgets';

/** A version a diff shows: the saved or published one, a conflict's, the file itself (draft), one given by its content (version). */
export type Side = 'saved' | 'published' | 'base' | 'theirs' | 'draft' | 'version';

/**
 * A file this big (characters or lines) is checked only once typing has paused for longer, and shown without sticky
 * scroll and bracket pair colours, as VS Code shows big files: a check, and the outline sticky scroll reads, parse the
 * whole file again after every pause.
 */
const LARGE_CHARS = 512 * 1024;
const LARGE_LINES = 20_000;
const isLarge = (m: monaco.editor.ITextModel) => m.getValueLength() > LARGE_CHARS || m.getLineCount() > LARGE_LINES;

/**
 * Bracket pair colours of a model, off for a large one. It is the model's own option: Monaco's editor option of that
 * name is passed on to no model in the standalone editor, so setting it on an editor changes nothing.
 */
function colourBrackets(m: monaco.editor.ITextModel, on: boolean): void {
  if (m.getOptions().bracketPairColorizationOptions.enabled !== on) m.updateOptions({ bracketColorizationOptions: { enabled: on, independentColorPoolPerBracketType: false } });
}

/** Runs `fn` when the browser is idle (soon at the latest). */
const whenIdle = (fn: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => fn(), { timeout: 2000 }) : setTimeout(fn, 0));

/** Monaco actions that open Monaco's own quick input (they need the editor to have the focus). */
const QUICK_INPUT_ACTIONS = new Set(['editor.action.gotoLine', 'editor.action.quickOutline']);

/** Whether an editor is on screen: in the document, and not in a hidden editor slot or a tab in the background. */
const onScreen = (ed: { getContainerDomNode(): HTMLElement }) => {
  const n = ed.getContainerDomNode();
  return n.isConnected && !n.closest('[hidden]');
};

interface Entry {
  key: string;
  model: monaco.editor.ITextModel;
  /** The saved version the model shows when there is no draft (a draft started now starts from it). */
  shown?: Content;
  view: monaco.editor.ICodeEditorViewState | null;
  push: ReturnType<typeof debounce<[]>>;
  lint: { (): void; cancel(): void };
  decorations: string[];
  subs: monaco.IDisposable[];
  /** The version changes are compared with (the draft's base, else the version shown), decoded once. */
  base?: { b64: string; text: string };
  /** What the change bars were drawn for: they are drawn again only when the model or the draft's base changes. */
  marked?: { version: number; base: string | null };
  /** The draft and saved version the model was last brought in step with (sync() skips the file while they stay). */
  seen?: { draft: unknown; saved: unknown };
}

export class EditorHost {
  code: monaco.editor.IStandaloneCodeEditor | null = null;
  diff: monaco.editor.IStandaloneDiffEditor | null = null;
  private entries = new Map<string, Entry>();
  /** Read-only models of other versions made for comparisons. */
  private versions = new Set<monaco.editor.ITextModel>();
  private current = '';
  /** Set while the host writes into a model itself (not the user typing). */
  private writing = false;
  /** The last show(): an earlier one still reading its file must not put it in the editor over a later one. */
  private showing = 0;
  /** Which shared editor the editor area shows for the active tab (told by the editor area), with the code tab's key. */
  private front: { kind: 'code'; key: string } | { kind: 'diff' } | null = null;
  /** A feature's own text editor while its tab is in front (the conflict editor's right side). */
  private feature: monaco.editor.ICodeEditor | null = null;
  /** The last Go to Line / Go to Symbol run, with the editor whose quick input it opened. */
  private quick: { ed: monaco.editor.ICodeEditor; id: string } | null = null;
  /** The settings the models and editors were last given (only what changed is applied again). */
  private applied: Settings;
  private scheme = matchMedia('(prefers-color-scheme: light)');
  private onScheme = () => {
    if (this.ws.settings.value.theme === 'auto') this.applyTheme();
  };
  private offTick: () => void;
  private offSettings: () => void;
  private offDrafts: () => void;
  /** Called when the cursor or selection moves, or the file shown changes (the status bar's Ln/Col, indentation). */
  onCursor: (pos: { line: number; col: number; selected: number } | null) => void = () => {};

  private offRekey: () => void;

  constructor(private ws: Workspace) {
    this.applied = ws.settings.value;
    this.offRekey = ws.rekeyed.on(({ from, to }) => {
      const e = this.entries.get(from);
      if (!e) return;
      this.entries.delete(from);
      e.key = to;
      this.entries.set(to, e);
      if (this.current === from) this.current = to;
      if (this.front?.kind === 'code' && this.front.key === from) this.front = { kind: 'code', key: to };
    });
    this.offTick = ws.contentTick.subscribe(() => this.sync());
    this.offDrafts = ws.drafts.subscribe(() => this.sync());
    this.offSettings = ws.settings.subscribe(() => this.applySettings());
    // "Follow the System": the editors follow the system's light or dark mode as the workbench does.
    this.scheme.addEventListener('change', this.onScheme);
  }

  /** Creates the code editor inside `el` the first time; later calls move it there. */
  mountCode(el: HTMLElement): monaco.editor.IStandaloneCodeEditor {
    if (this.code) {
      const node = this.code.getContainerDomNode();
      if (node.parentElement !== el) el.appendChild(node);
      this.code.layout();
      return this.code;
    }
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;inset:0';
    // Monaco gives its colours to .monaco-component too: its context menu, drawn beside the editor, gets them then.
    holder.classList.add('monaco-component');
    el.appendChild(holder);
    this.code = monaco.editor.create(holder, { ...baseEditorOptions, model: null });
    this.code.onDidChangeCursorSelection(() => this.reportCursor());
    this.applySettings();
    return this.code;
  }

  mountDiff(el: HTMLElement): monaco.editor.IStandaloneDiffEditor {
    if (this.diff) {
      const node = this.diff.getContainerDomNode();
      if (node.parentElement !== el) el.appendChild(node);
      this.diff.layout();
      return this.diff;
    }
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;inset:0';
    // Monaco gives its colours to .monaco-component too: its context menu, drawn beside the editor, gets them then.
    holder.classList.add('monaco-component');
    el.appendChild(holder);
    this.diff = monaco.editor.createDiffEditor(holder, {
      ...baseEditorOptions,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 700,
      originalEditable: false,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      hideUnchangedRegions: { enabled: false },
    });
    this.applySettings();
    return this.diff;
  }

  /** Whether the diff editor shows the inline view now (it does below 700 pixels), not two sides. */
  diffInline(): boolean {
    const root = this.diff?.getContainerDomNode().querySelector('.monaco-diff-editor');
    return !!root && !root.classList.contains('side-by-side');
  }

  private applyTheme(): void {
    const t = this.ws.settings.value.theme;
    setEditorTheme(t === 'auto' ? (this.scheme.matches ? 'light' : 'dark') : t);
  }

  private applySettings(): void {
    const s = this.ws.settings.value;
    const was = this.applied;
    this.applied = s;
    this.applyTheme();
    const o = { fontSize: s.fontSize, minimap: { enabled: s.minimap }, wordWrap: s.wordWrap ? ('on' as const) : ('off' as const) };
    this.code?.updateOptions(o);
    this.diff?.updateOptions(o);
    // A file keeps the indentation detected when it opened: it is detected again only when the indentation settings
    // change, not when the theme or word wrap does (Format Document would re-indent the whole file with the setting's).
    const indent = s.tabSize !== was.tabSize || s.insertSpaces !== was.insertSpaces;
    const lint = s.lint !== was.lint || String(s.lintOff) !== String(was.lintOff) || String(s.lintOn) !== String(was.lintOn);
    for (const e of this.entries.values()) {
      if (indent) this.indent(e.model);
      if (lint) e.lint();
    }
  }

  /** The indentation settings, then the file's own when it has one (detected as VS Code does). */
  private indent(model: monaco.editor.ITextModel): void {
    const s = this.ws.settings.value;
    model.updateOptions({ tabSize: s.tabSize, insertSpaces: s.insertSpaces });
    if (s.insertSpaces) model.detectIndentation(s.insertSpaces, s.tabSize);
  }

  /** Waits until the editor can start its worker (or knows it can't): call before the first editor is created. */
  ready(): Promise<boolean> {
    return workersAllowed;
  }

  // ------------------------------------------------------------------ models

  has(key: string): boolean {
    return this.entries.has(key);
  }

  model(key: string): monaco.editor.ITextModel | null {
    return this.entries.get(key)?.model ?? null;
  }

  /** The file a model's address stands for ('' when none: a version a diff shows). */
  keyOfUri(uri: monaco.Uri): string {
    const s = uri.toString();
    for (const e of this.entries.values()) if (e.model.uri.toString() === s) return e.key;
    return '';
  }

  private reveal: { key: string; at: monaco.IRange } | null = null;

  /** Selects a place in a file as soon as the code editor shows it (at once when it does already): Go to Definition. */
  revealWhenShown(key: string, at: monaco.IRange): void {
    this.reveal = { key, at };
    if (this.current === key && this.front?.kind === 'code' && this.code?.getModel() === this.entries.get(key)?.model) this.applyReveal();
  }

  private applyReveal(): void {
    const r = this.reveal;
    const ed = this.code;
    if (!r || !ed || this.current !== r.key) return;
    this.reveal = null;
    ed.setSelection(r.at);
    ed.revealRangeInCenterIfOutsideViewport(r.at, monaco.editor.ScrollType.Smooth);
    ed.focus();
  }

  /** The text model of a web resource (or new draft), its saved version read first when needed. */
  async open(key: string): Promise<monaco.editor.ITextModel> {
    const found = this.entries.get(key);
    if (found) return found.model;
    const d = this.ws.describe(key);
    if (!d) throw new Error('This web resource no longer exists.');
    if (!isTextType(d.type)) throw new Error(`${TYPES[d.type].short} files are not text.`);
    const shown = d.id ? await this.ws.content(d.id) : undefined;
    const again = this.entries.get(key);
    if (again) return again.model;
    const text = this.ws.textOf(key) ?? '';
    const model = modelFor(wrUri(d.name), text, languageOf(d.type, d.name));
    this.indent(model);
    const lintSoon = debounce(() => this.lint(entry), 400);
    // A big file is checked once typing has paused for longer, when the browser is idle: a check parses all of it.
    const lintLate = debounce(() => whenIdle(() => this.lint(entry)), 1500);
    const entry: Entry = {
      key,
      model,
      shown,
      view: null,
      decorations: [],
      push: debounce(() => {
        // entry.key, not key: a new web resource's key changes when it is created.
        if (this.entries.get(entry.key) !== entry) return;
        this.ws.editText(entry.key, this.draftText(entry), entry.shown);
        this.gutter(entry);
      }, 250),
      lint: Object.assign(() => (isLarge(model) ? lintLate() : lintSoon()), {
        cancel: () => {
          lintSoon.cancel();
          lintLate.cancel();
        },
      }),
      subs: [],
    };
    entry.subs.push(
      model.onDidChangeContent(() => {
        if (this.writing) return;
        entry.push();
        entry.lint();
      }),
      // The status bar shows the indentation: it changes with the file's options (Indent Using Spaces…).
      model.onDidChangeOptions(() => {
        if (this.code?.getModel() === model) this.reportCursor();
      }),
    );
    this.entries.set(key, entry);
    entry.lint();
    this.gutter(entry);
    return model;
  }

  /**
   * The model's text as its draft keeps it: with the line endings of the version it started from. The editor holds a
   * file with one kind of line ending; a file that mixes them would otherwise have all of them rewritten (format.ts).
   */
  private draftText(e: Entry): string {
    const text = e.model.getValue();
    const base = this.baseText(e);
    return base ? keepLineEndings(base, text, e.model.getEOL() === '\r\n' ? '\r\n' : '\n') : text;
  }

  /**
   * The text of the version a file's changes are compared with: its draft's base ('' for a new web resource), or the
   * version shown when there is no draft (null when none is read). Decoded once per version, not on every keystroke.
   */
  private baseText(e: Entry): string | null {
    const d = this.ws.draft(e.key);
    const b64 = d ? d.base?.b64 : e.shown?.b64;
    if (b64 === undefined) return d ? '' : null;
    if (e.base?.b64 !== b64) e.base = { b64, text: !d && e.shown?.text !== undefined ? e.shown.text : base64ToText(b64).text };
    return e.base.text;
  }

  /** Shows a web resource's model in the code editor (keeping each model's scroll and cursor). */
  async show(key: string): Promise<void> {
    const ticket = ++this.showing;
    const model = await this.open(key);
    const ed = this.code;
    // Another file was asked for meanwhile (a quick switch of tabs): that one is shown, not this one. Nor is a file
    // whose tab was left while it was read: out of sight, the code editor holds no file (showingEditor).
    if (!ed || ticket !== this.showing || this.front?.kind !== 'code' || this.front.key !== key) return;
    const prev = this.entries.get(this.current);
    if (prev && ed.getModel() === prev.model) prev.view = ed.saveViewState();
    this.current = key;
    const reason = this.readOnlyReason(key);
    const large = isLarge(model);
    // Before the model is shown: a big file never has its outline read for sticky scroll, nor its bracket pairs coloured.
    ed.updateOptions({ readOnly: !!reason, readOnlyMessage: reason ? { value: reason } : undefined, stickyScroll: { enabled: !large } });
    colourBrackets(model, !large);
    if (ed.getModel() !== model) ed.setModel(model);
    const e = this.entries.get(key)!;
    if (e.view) ed.restoreViewState(e.view);
    this.gutter(e);
    this.applyReveal();
    // Ln/Col of this file, not of the one shown before (setting a model moves no cursor).
    this.reportCursor();
  }

  private reportCursor(): void {
    const ed = this.code;
    const m = ed?.getModel();
    const s = ed?.getSelection();
    this.onCursor(m && s ? { line: s.positionLineNumber, col: s.positionColumn, selected: m.getValueLengthInRange(s) } : null);
  }

  /** Why a web resource can't be edited here ('' when it can). */
  readOnlyReason(key: string): string {
    const w = this.ws.get(key);
    if (w?.isManaged && !w.isCustomizable) return `${w.name} belongs to a managed solution that doesn't allow changing it.`;
    if (this.ws.conflicts.value.has(key)) return 'This file has a conflict: Compare and choose first.';
    return '';
  }

  /**
   * Keeps models in step with the workspace: a draft gone (saved or discarded) or a newer saved version. It runs on
   * every change of any draft and every content read (a search reads hundreds), so a file whose draft and saved
   * version are the ones it was last brought in step with is skipped without looking at its text.
   */
  private sync(): void {
    for (const e of this.entries.values()) {
      if (e.push.pending()) continue; // the user is typing: their text wins
      const draft = this.ws.draft(e.key);
      const saved = this.ws.cached(e.key);
      if (e.seen && e.seen.draft === draft && e.seen.saved === saved) continue;
      if (!draft && !saved && this.ws.get(e.key)) {
        // The cached version was dropped (a newer one exists): read it; this runs again when it arrives.
        void this.ws.content(e.key).catch(() => undefined);
        continue;
      }
      e.seen = { draft, saved };
      if (!draft && saved) e.shown = saved;
      const want = this.ws.textOf(e.key);
      if (want !== undefined && !this.holds(e.model, want)) this.replace(e, want);
      this.gutter(e);
    }
  }

  /** Whether a model shows this text (it holds one kind of line ending: a file that mixes them still matches). */
  private holds(m: monaco.editor.ITextModel, text: string): boolean {
    const v = m.getValue();
    return v === text || v === normalizeEol(text, m.getEOL());
  }

  private replace(e: Entry, text: string): void {
    this.writing = true;
    try {
      e.model.pushEditOperations([], [{ range: e.model.getFullModelRange(), text }], () => null);
      e.model.pushStackElement();
    } finally {
      this.writing = false;
    }
    e.lint();
  }

  /** Puts text into a model as the user's own edit (format, minify, restore from history, merge result). */
  setText(key: string, text: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.model.pushEditOperations([], [{ range: e.model.getFullModelRange(), text }], () => null);
    e.model.pushStackElement();
  }

  /** Closes a web resource's model (an unsaved change stays a draft in the workspace). */
  close(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.push.flush();
    e.lint.cancel();
    for (const s of e.subs) s.dispose();
    if (this.code?.getModel() === e.model) this.code.setModel(null);
    // A comparison still showing this model lets go of it first (Close All with a comparison open).
    const shown = this.diff?.getModel();
    if (shown && (shown.original === e.model || shown.modified === e.model)) this.diff!.setModel(null);
    e.model.dispose();
    this.entries.delete(key);
    const p = new Map(this.ws.problems.value);
    p.delete(key);
    this.ws.problems.value = p;
  }

  /** Saves pending typing into the workspace now (before saving to the server). */
  flush(keys?: string[]): void {
    for (const e of this.entries.values()) if (!keys || keys.includes(e.key)) e.push.flush();
  }

  // ------------------------------------------------------------------ comparisons

  /** A read-only model of another version of a web resource, for the diff editor. */
  async versionModel(key: string, side: Side, b64?: string): Promise<monaco.editor.ITextModel> {
    const d = this.ws.describe(key);
    if (!d) throw new Error('This web resource no longer exists.');
    if (side === 'draft') return this.open(key);
    let text = '';
    if (b64 !== undefined) text = base64ToText(b64).text;
    else if (side === 'saved' || side === 'published') {
      if (!d.id) text = '';
      else text = (await this.ws.content(d.id, side)).text ?? '';
    } else if (side === 'base') text = base64ToText(this.ws.draft(key)?.base?.b64 || '').text;
    else if (side === 'theirs') text = this.ws.conflicts.value.get(key)?.theirs.text ?? '';
    // A version given by its content is named by it: two versions of the same length are still two models.
    const m = modelFor(wrUri(d.name, side + (b64 !== undefined ? `-${fingerprint(b64)}` : '')), text, languageOf(d.type, d.name));
    this.versions.add(m);
    return m;
  }

  /** Shows two versions side by side; `editable` lets the right side be edited (it is then the draft's model). */
  showDiff(original: monaco.editor.ITextModel, modified: monaco.editor.ITextModel, editable: boolean): void {
    if (!this.diff) return;
    // Before the models are shown, as in show(): no sticky scroll nor bracket pair colours for a big file.
    this.diff.updateOptions({ readOnly: !editable, originalEditable: false, stickyScroll: { enabled: !isLarge(original) && !isLarge(modified) } });
    for (const m of [original, modified]) colourBrackets(m, !isLarge(m));
    this.diff.setModel({ original, modified });
    // Versions no longer shown are released (shown again, they are read again from the cache or the tab).
    for (const m of this.versions)
      if (m !== original && m !== modified) {
        this.versions.delete(m);
        if (!m.isDisposed()) m.dispose();
      }
    for (const e of this.entries.values()) if (e.model === modified) this.gutter(e);
  }

  // ------------------------------------------------------------------ the editor of the active tab

  /**
   * Called by the editor area when it shows or hides the code editor (with the key of the file the tab shows) or the
   * diff editor: what the Edit and Go menus act on.
   */
  showingEditor(kind: 'code' | 'diff', on: boolean, key = ''): void {
    if (on) this.front = kind === 'code' ? { kind, key } : { kind };
    else if (this.front?.kind === kind) this.front = null;
    // Out of sight, the code editor holds no file: a command that still reaches it (Monaco's Undo falls back to the
    // last editor it used) has nothing to change. Its scroll and cursor are kept and given back by show().
    const ed = this.code;
    if (kind === 'code' && !on && ed?.getModel()) {
      const e = this.entries.get(this.current);
      if (e && ed.getModel() === e.model) e.view = ed.saveViewState();
      ed.setModel(null);
    }
  }

  /**
   * A feature's own text editor (the conflict editor's right side) while its tab is in front; returns the function
   * that forgets it again (call it when the tab is hidden or closed).
   */
  setFeatureEditor(ed: monaco.editor.ICodeEditor): () => void {
    this.feature = ed;
    return () => {
      if (this.feature === ed) this.feature = null;
    };
  }

  /**
   * The text editor of the active tab: the code editor showing the active tab's file, the side of the comparison that
   * has the focus (else its right side), or a feature's own editor; null when the active tab has none (Settings,
   * Welcome, forms, images) or its file is still being read. Editor commands act on it, never on an editor out of
   * sight: the shared code editor keeps the last file it showed while another tab is in front.
   */
  activeTextEditor(): monaco.editor.ICodeEditor | null {
    const f = this.front;
    if (f?.kind === 'code') {
      const ed = this.code;
      const e = this.entries.get(f.key);
      return ed && e && ed.getModel() === e.model && onScreen(ed) ? ed : null;
    }
    if (f?.kind === 'diff') {
      const d = this.diff;
      if (!d || !onScreen(d)) return null;
      const left = d.getOriginalEditor();
      const right = d.getModifiedEditor();
      if (!right.getModel()) return null;
      return left.hasTextFocus() ? left : right;
    }
    const x = this.feature;
    return x && x.getModel() && onScreen(x) ? x : null;
  }

  /**
   * Runs one of Monaco's editor actions (or commands, such as 'undo') on the editor of the active tab, with the focus
   * in it: Go to Line and Go to Symbol open Monaco's quick input, which needs it. Nothing runs when the active tab has
   * no text editor.
   */
  runAction(id: string): void {
    const ed = this.activeTextEditor();
    if (!ed) return;
    // Asked again while its quick input is open with the focus (quick open's ':' asks once more for each character
    // typed): it stays as it is, with what was typed.
    if (QUICK_INPUT_ACTIONS.has(id) && this.quick?.ed === ed && this.quick.id === id && ed.getContainerDomNode().querySelector('.quick-input-widget')?.contains(document.activeElement)) return;
    // Monaco's quick input takes the place of the manager's, as in VS Code: quick open's ':' hands over to Go to Line.
    if (QUICK_INPUT_ACTIONS.has(id) && quickInputOpen.value) closeQuickInput();
    ed.focus();
    const a = ed.getAction(id);
    if (a) void a.run().catch((err: unknown) => this.ws.log('warn', `${a.label}: ${(err as Error)?.message ?? String(err)}`));
    else ed.trigger('menu', id, null);
    if (QUICK_INPUT_ACTIONS.has(id)) this.quick = { ed, id };
  }

  /** Monaco's own actions of the editor of the active tab, for the command palette. */
  actions(): Array<{ id: string; label: string; key?: string }> {
    return (this.activeTextEditor()?.getSupportedActions() || []).map((a) => ({ id: a.id, label: a.label }));
  }

  // ------------------------------------------------------------------ format, minify

  async format(key: string): Promise<void> {
    const e = this.entries.get(key) || { model: await this.open(key) };
    const lang = e.model.getLanguageId();
    if (!canFormat(lang)) throw new Error(`Formatting isn't available for ${lang}.`);
    const o = e.model.getOptions();
    const eol = e.model.getEOL() === '\r\n' ? '\r\n' : '\n';
    let out: string;
    try {
      out = formatText(lang, e.model.getValue(), { tabSize: o.tabSize, insertSpaces: o.insertSpaces, eol });
    } catch (err) {
      throw new Error(`The file could not be formatted: ${(err as Error).message}`);
    }
    if (out !== e.model.getValue()) this.setText(key, out);
  }

  async minify(key: string): Promise<void> {
    const e = this.entries.get(key) || { model: await this.open(key) };
    const lang = e.model.getLanguageId();
    if (!canMinify(lang)) throw new Error('Minify works on JavaScript, CSS, XML and JSON.');
    let out: string;
    try {
      out = minifyText(lang, e.model.getValue());
    } catch (err) {
      throw new Error(`The file could not be minified: ${(err as Error).message}`);
    }
    this.setText(key, out);
  }

  // ------------------------------------------------------------------ checks and gutter

  private lint(e: Entry): void {
    if (e.model.isDisposed()) return;
    const s = this.ws.settings.value;
    const lang = e.model.getLanguageId();
    const text = e.model.getValue();
    let diags: Diagnostic[] = [];
    if (s.lint) {
      const opts = { off: s.lintOff, on: s.lintOn };
      if (lang === 'javascript') diags = lintScript(text, opts);
      else if (lang === 'html') diags = lintHtml(text, opts);
      else if ((lang === 'xml' || lang === 'json') && text.trim()) {
        const x = lang === 'xml' ? xmlError(text) : jsonError(text);
        if (x) diags = [{ severity: 'error', rule: lang, message: x.message, startLine: x.line, startCol: x.column, endLine: x.line, endCol: x.column + 1 }];
      }
    }
    // Only what breaks the file is underlined (syntax errors, a removed endpoint): advice such as Xrm.Page being
    // deprecated (it still works) would underline most older scripts everywhere.
    diags = diags.filter((d) => d.severity === 'error');
    const sev = (s: Diagnostic['severity']) => (s === 'error' ? monaco.MarkerSeverity.Error : s === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info);
    monaco.editor.setModelMarkers(
      e.model,
      'wrm',
      diags.map((d) => ({ severity: sev(d.severity), message: d.message, code: d.rule, source: 'wrm', startLineNumber: d.startLine, startColumn: d.startCol, endLineNumber: d.endLine, endColumn: d.endCol })),
    );
    setLintFixes(
      e.model,
      diags.filter((d) => d.fix).map((d) => ({ range: { startLineNumber: d.startLine, startColumn: d.startCol, endLineNumber: d.endLine, endColumn: d.endCol }, title: d.fix!.title, text: d.fix!.text })),
    );
    const p = new Map(this.ws.problems.value);
    if (diags.length) p.set(e.key, diags);
    else p.delete(e.key);
    this.ws.problems.value = p;
  }

  /**
   * VS Code's change bars: lines added, changed and removed compared with the version the draft started from. Drawn
   * for files an editor shows (the others when they are shown), and again only when the text or the base changed.
   */
  private gutter(e: Entry): void {
    if (e.model.isDisposed()) return;
    if (!monaco.editor.getEditors().some((ed) => ed.getModel() === e.model)) return;
    const d = this.ws.draft(e.key);
    const stamp = { version: e.model.getVersionId(), base: d ? (d.base?.b64 ?? '') : null };
    if (e.marked && e.marked.version === stamp.version && e.marked.base === stamp.base) return;
    e.marked = stamp;
    const baseText = d ? (this.baseText(e) ?? '') : null;
    const marks = baseText === null ? { added: [], modified: [], deleted: [] } : gutterMarks(baseText, e.model.getValue());
    const deco: monaco.editor.IModelDeltaDecoration[] = [
      ...marks.added.map(([a, b]) => ({ range: new monaco.Range(a, 1, b, 1), options: { isWholeLine: true, linesDecorationsClassName: 'wrm-gutter-added', overviewRuler: { color: '#487e02', position: monaco.editor.OverviewRulerLane.Left } } })),
      ...marks.modified.map(([a, b]) => ({ range: new monaco.Range(a, 1, b, 1), options: { isWholeLine: true, linesDecorationsClassName: 'wrm-gutter-modified', overviewRuler: { color: '#1b81a8', position: monaco.editor.OverviewRulerLane.Left } } })),
      ...marks.deleted.map((l) => ({ range: new monaco.Range(l, 1, l, 1), options: { linesDecorationsClassName: 'wrm-gutter-deleted', overviewRuler: { color: '#f14c4c', position: monaco.editor.OverviewRulerLane.Left } } })),
    ];
    e.decorations = e.model.deltaDecorations(e.decorations, deco);
  }

  dispose(): void {
    this.offRekey();
    this.offTick();
    this.offSettings();
    this.offDrafts();
    this.scheme.removeEventListener('change', this.onScheme);
    for (const k of [...this.entries.keys()]) this.close(k);
    this.code?.dispose();
    this.diff?.dispose();
  }
}

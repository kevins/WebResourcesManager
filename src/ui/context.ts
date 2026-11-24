// What every view and editor of the workbench gets: the workspace, the editor host, and the workbench's own actions
// (open a tab, compare two versions, show a view, reveal a file…). Views and editors are registered by id
// (registerView / registerEditor) so features live in their own files and the workbench only lays them out.

import type { ComponentChildren } from 'preact';
import { Signal } from '../core/emitter';
import type { EditorTab } from '../model/model';
import type { Workspace } from '../model/workspace';
import type { EditorHost, Side } from './editorhost';

export interface OpenOptions {
  /** Open as the preview tab (italic, replaced by the next preview) instead of a kept tab. */
  preview?: boolean;
  /** Don't move the focus into the editor. */
  preserveFocus?: boolean;
  /** Put the cursor here (1-based). */
  line?: number;
  col?: number;
}

export interface AppContext {
  ws: Workspace;
  host: EditorHost;
  /** Opens (or shows) a web resource or a new draft by key. */
  openResource(key: string, o?: OpenOptions): void;
  /** Opens a comparison of two versions of a web resource. The right side 'draft' is editable. */
  openDiff(key: string, left: Side | { b64: string; label: string }, right: Side | { b64: string; label: string }, o?: { title?: string; preview?: boolean }): void;
  /** Opens any kind of editor tab (forms, unused, settings…). A tab with the same id is shown instead. */
  openTab(tab: Omit<EditorTab, 'preview'> & { preview?: boolean }): void;
  closeTab(id: string): void;
  /** Shows a side bar view by id ('explorer', 'search', 'scm', 'forms', 'refs', 'local', 'history'). */
  showView(id: string): void;
  /** Selects a web resource in the Explorer (expanding its folders). */
  reveal(key: string): void;
  /** Shows the bottom panel on a tab ('problems', 'output'). */
  showPanel(tab: 'problems' | 'output'): void;
  /** The tabs open now and the active one (for views that follow the editor). */
  tabs: Signal<EditorTab[]>;
  activeTab: Signal<string>;
  /** The key the Explorer should reveal next (set by reveal()). */
  revealKey: Signal<string>;
}

export interface ViewProps {
  ctx: AppContext;
}

export interface EditorProps {
  ctx: AppContext;
  tab: EditorTab;
  /** False while another tab is shown (the component stays mounted to keep its state). */
  visible: boolean;
}

export interface ViewDef {
  id: string;
  title: string;
  /** Codicon name for the activity bar. */
  icon: string;
  /** Key binding that shows it (shown in the tooltip). */
  key?: string;
  order: number;
  component: (p: ViewProps) => ComponentChildren;
  /** A number on the activity bar icon (Source Control's changes), 0 for none. */
  badge?: (ctx: AppContext) => number;
}

export interface EditorDef {
  kind: EditorTab['kind'];
  component: (p: EditorProps) => ComponentChildren;
  /** Codicon of the tab when it isn't a file. */
  icon?: string;
  /** Keep the component mounted while its tab is in the background (forms, unused: costly state). */
  keepAlive?: boolean;
}

const views = new Map<string, ViewDef>();
const editors = new Map<string, EditorDef>();
/** Bumped when views or editors are registered (the workbench re-renders its activity bar). */
export const registry = new Signal(0);

export function registerView(v: ViewDef): void {
  views.set(v.id, v);
  registry.value++;
}

export function registerEditor(e: EditorDef): void {
  editors.set(e.kind, e);
  registry.value++;
}

export const viewDefs = () => [...views.values()].sort((a, b) => a.order - b.order);
export const viewDef = (id: string) => views.get(id);
export const editorDef = (kind: string) => editors.get(kind);

let current: AppContext | null = null;
/** The running workbench's context (for commands registered by feature modules). */
export function getCtx(): AppContext {
  if (!current) throw new Error('The workbench is not running.');
  return current;
}
export function setCtx(c: AppContext | null): void {
  current = c;
}

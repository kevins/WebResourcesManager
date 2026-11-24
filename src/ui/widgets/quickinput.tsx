// VS Code's quick input, at the top centre of the window: quickPick() (choose one or several items, filtered as you
// type) and inputBox() (type a value, checked as you type). One at a time: opening another replaces the open one,
// whose promise then resolves undefined, as it does on Escape or a click outside.
//
// Filtering is VS Code's fuzzy matching (fuzzy.ts): every space-separated piece of the filter must match the label
// (or the description / detail when asked), label matches and prefix matches rank first, matched characters are
// highlighted, and items keep their groups (the separators) while filtering. Among equally good matches the more
// compact match, then the shorter label wins, as in VS Code's quick open. A command palette matches the starts of
// words instead (matchWords), ranks the command's own name (nameStart) and remembers what was run (history).

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Signal } from '../../core/emitter';
import { useSignal } from '../hooks';
import { contiguousMatch, fuzzyScore, toRanges, wordMatch } from './fuzzy';
import { Highlight } from './highlight';
import { Badge, Button, ProgressBar } from './inputs';
import { KeybindingLabel } from './keybinding';
import { cx, focusedElement, restoreFocus, safeRun, uid } from './util';

export type QuickItem<T> = {
  label: string;
  /**
   * Where the item's own name starts in the label, after a prefix that groups it: a command's category ("File: Save"
   * → 6). The filter ranks the name: "save" puts File: Save before "Dataverse: Publish All Saved Changes", as VS
   * Code's command palette does; the prefix still matches ("file save").
   */
  nameStart?: number;
  /** The item in the pick's history (QuickPickOptions.history); the label when not given. */
  id?: string;
  description?: string;
  /** A second line under the label. */
  detail?: string;
  /** Codicon name. */
  icon?: string;
  value: T;
  /** Checked at the start (canPickMany); otherwise the item that has the focus at the start. */
  picked?: boolean;
  /** Shown even when it doesn't match the filter. */
  alwaysShow?: boolean;
  /** A separator: starts a group; its label is shown on the right of the group's first row. */
  kind?: 'separator';
  /** A binding as commands use it ('ctrl+s'), shown as key caps on the right. */
  keybinding?: string;
  /** Icon buttons shown on the right of the row while it is hovered or focused. */
  buttons?: Array<{ icon: string; title: string; run: (item: QuickItem<T>) => void }>;
};

export interface QuickPickOptions<T> {
  items: QuickItem<T>[] | ((filter: string, signal: AbortSignal) => Promise<QuickItem<T>[]> | QuickItem<T>[]);
  placeholder?: string;
  title?: string;
  value?: string;
  canPickMany?: boolean;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  /**
   * True (default): the items are filtered and highlighted here; a function given as `items` is called once.
   * False: `items(filter)` filters itself and is called again each time the filter changes (the previous call's
   * signal is aborted); the items are shown in the order given.
   */
  filter?: boolean;
  /** While filtering, rank the matches of every group together and hide the separators (quick open's groups). */
  flatFilter?: boolean;
  /**
   * Match as VS Code's command palette does: the starts of words ("fa" finds Fold All) or a run of letters, never
   * letters scattered inside words. The whole name typed ranks first, then names that start with what is typed,
   * then the other matches.
   */
  matchWords?: boolean;
  /**
   * Remembers the items picked here, under this name, for as long as the manager is open: before anything is typed
   * the recently used ones come first, and the more recently used of two equally good matches ranks first.
   */
  history?: string;
  onValueChange?: (v: string) => void;
}

export interface InputBoxOptions {
  title?: string;
  /** What to type, shown under the box. */
  prompt?: string;
  value?: string;
  placeholder?: string;
  /** The selected part of the value at the start ([start, end)); all of it by default. */
  valueSelection?: [number, number];
  /** '' when the value is fine, else the message shown under the box (the value can't be accepted then). */
  validate?: (v: string) => string | Promise<string>;
  password?: boolean;
}

/** A separator item for quickPick's items: starts a group named `label` ('' for a plain line). */
export function quickSeparator<T>(label = ''): QuickItem<T> {
  return { kind: 'separator', label, value: undefined as T };
}

interface PickRequest {
  kind: 'pick';
  id: number;
  o: QuickPickOptions<unknown>;
  done: (v: unknown) => void;
}
interface InputRequest {
  kind: 'input';
  id: number;
  o: InputBoxOptions;
  done: (v: unknown) => void;
}
type Request = PickRequest | InputRequest;

const current = new Signal<Request | null>(null);
/** True while a quick pick or input box is open. */
export const quickInputOpen = new Signal<boolean>(false);
let restoreTo: HTMLElement | null = null;
let widgetEl: HTMLElement | null = null;
let seq = 0;
/** The items picked in each quick pick that keeps a history (QuickPickOptions.history), by id or label, newest last. */
const histories = new Map<string, string[]>();

/** Notes that `item` was picked in the quick pick whose history is `name`. */
export function rememberPick(name: string, item: QuickItem<unknown>): void {
  const key = item.id ?? item.label;
  const list = (histories.get(name) ?? []).filter((k) => k !== key);
  list.push(key);
  // As many as VS Code's command palette keeps.
  histories.set(name, list.slice(-50));
}

/** 0 for an item never picked in that quick pick, otherwise higher the more recently it was picked. */
const recency = (name: string, item: QuickItem<unknown>): number => (histories.get(name)?.indexOf(item.id ?? item.label) ?? -1) + 1;

function open(r: Request): void {
  const prev = current.value;
  // The one replaced answers undefined, as if cancelled; the focus goes back to where it was before the first.
  if (prev) prev.done(undefined);
  else restoreTo = focusedElement();
  current.value = r;
  quickInputOpen.value = true;
}

function finish(r: Request, v: unknown): void {
  if (current.value !== r) return;
  current.value = null;
  quickInputOpen.value = false;
  const back = restoreTo;
  restoreTo = null;
  // The focus goes back before the caller's code runs (the promise resolves after this), so it can move it on.
  restoreFocus(back, widgetEl);
  r.done(v);
}

export function quickPick<T>(o: QuickPickOptions<T> & { canPickMany: true }): Promise<T[] | undefined>;
export function quickPick<T>(o: QuickPickOptions<T> & { canPickMany?: false }): Promise<T | undefined>;
export function quickPick<T>(o: QuickPickOptions<T>): Promise<T | T[] | undefined>;
export function quickPick<T>(o: QuickPickOptions<T>): Promise<T | T[] | undefined> {
  return new Promise((resolve) => open({ kind: 'pick', id: ++seq, o: o as unknown as QuickPickOptions<unknown>, done: resolve as (v: unknown) => void }));
}

export function inputBox(o: InputBoxOptions): Promise<string | undefined> {
  return new Promise((resolve) => open({ kind: 'input', id: ++seq, o, done: resolve as (v: unknown) => void }));
}

/** Closes the open quick pick or input box; its promise resolves undefined. */
export function closeQuickInput(): void {
  const r = current.value;
  if (r) finish(r, undefined);
}

/** Renders the open quick input; mounted once by <Layers/>. */
export function QuickInputLayer() {
  const r = useSignal(current);
  if (!r) return null;
  return r.kind === 'pick' ? <QuickPickView key={r.id} r={r} /> : <InputBoxView key={r.id} r={r} />;
}

function Frame({ r, title, empty, children }: { r: Request; title?: string; empty?: boolean; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    widgetEl = ref.current;
    return () => {
      if (widgetEl === ref.current) widgetEl = null;
    };
  }, []);
  useLayoutEffect(() => {
    // A click anywhere else cancels, as in VS Code.
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) finish(r, undefined);
    };
    document.addEventListener('mousedown', down, true);
    return () => document.removeEventListener('mousedown', down, true);
  }, []);
  return (
    <div ref={ref} class={cx('wg-quick', empty && 'no-list')} role="dialog" aria-label={title}>
      {title && <div class="wg-quick-title">{title}</div>}
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ quick pick

interface Row {
  item: QuickItem<unknown>;
  /** The group label, on the first row of a group. */
  sep?: string;
  /** The line over the first row of a group (not over the very first row). */
  border: boolean;
  label?: Array<[number, number]>;
  desc?: Array<[number, number]>;
  detail?: Array<[number, number]>;
  top: number;
  height: number;
}

const ROW = 22;
const ROW_DETAIL = 44;
/** VS Code shows at most 20 rows before the list scrolls. */
const MAX_LIST = 20 * ROW;

interface ItemMatch {
  /**
   * Ranked first. Fuzzy matching: 1 when the whole label or name was typed (VS Code's identity match). With
   * matchWords: 4 the whole name, 3 the start of the name, 2 starts of words, 1 a run of letters inside a word, 0 the
   * description or the detail.
   */
  tier: number;
  /** The fuzzy score, higher first (0 with matchWords). */
  score: number;
  /** 1 when the pieces typed are found in the label in the order typed ("publish all": Publish All…), else 0. */
  order: number;
  /** Characters from the first matched one to the last, added up over the pieces: smaller is a more compact match. */
  span: number;
  label?: Array<[number, number]>;
  desc?: Array<[number, number]>;
  detail?: Array<[number, number]>;
}

/** Where the item's own name starts in its label. */
const nameStartOf = (item: QuickItem<unknown>) => Math.max(0, Math.min(item.nameStart ?? 0, item.label.length));
const squash = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function matchItem(item: QuickItem<unknown>, query: string, o: QuickPickOptions<unknown>): ItemMatch | null {
  const words = !!o.matchWords;
  const start = nameStartOf(item);
  const name = item.label.slice(start);
  let score = 0;
  let span = 0;
  let lowest = 2;
  // Where each piece's match starts in the label (-1: it matched elsewhere).
  const starts: number[] = [];
  const lab: number[] = [];
  const des: number[] = [];
  const det: number[] = [];
  const take = (into: number[], positions: number[], offset: number) => {
    starts.push(into === lab && positions.length ? positions[0] + offset : -1);
    if (!positions.length) return;
    for (const p of positions) into.push(p + offset);
    span += positions[positions.length - 1] - positions[0] + 1;
  };
  // A description or a detail matches as the label does.
  const other = (piece: string, text: string | undefined): { positions: number[]; score: number } | null => {
    if (!text) return null;
    if (!words) return fuzzyScore(piece, text);
    const p = wordMatch(piece, text) ?? contiguousMatch(piece, text);
    return p ? { positions: p, score: 0 } : null;
  };
  for (const piece of query.split(/\s+/).filter(Boolean)) {
    if (words) {
      // Words of the name, then words of the whole label (its prefix, a category), then a run of letters in either.
      const w = wordMatch(piece, name);
      const wl = w || !start ? null : wordMatch(piece, item.label);
      if (w || wl) {
        take(lab, (w ?? wl)!, w ? start : 0);
        continue;
      }
      const c = contiguousMatch(piece, name);
      const cl = c || !start ? null : contiguousMatch(piece, item.label);
      if (c || cl) {
        take(lab, (c ?? cl)!, c ? start : 0);
        lowest = Math.min(lowest, 1);
        continue;
      }
    } else {
      const n = fuzzyScore(piece, name);
      const l = n ?? (start ? fuzzyScore(piece, item.label) : null);
      if (l) {
        // As in VS Code's quick open: a label match ranks above any description match, a prefix match above other
        // label matches, and among prefix matches the shorter name wins ("window.ts" before "windowActions.ts").
        const prefix = !!n && name.toLowerCase().startsWith(piece.toLowerCase());
        score += (prefix ? (1 << 17) + Math.round((piece.length / name.length) * 100) : 1 << 16) + l.score;
        take(lab, l.positions, n ? start : 0);
        continue;
      }
    }
    const d = o.matchOnDescription ? other(piece, item.description) : null;
    if (d) {
      score += d.score;
      take(des, d.positions, 0);
      lowest = 0;
      continue;
    }
    const t = o.matchOnDetail ? other(piece, item.detail) : null;
    if (t) {
      score += t.score;
      take(det, t.positions, 0);
      lowest = 0;
      continue;
    }
    return null;
  }
  const whole = squash(query);
  const typedAll = whole === squash(name) || whole === squash(item.label);
  const typedStart = squash(name).startsWith(whole) || squash(item.label).startsWith(whole);
  const tier = words ? (typedAll ? 4 : typedStart ? 3 : lowest) : typedAll ? 1 : 0;
  const order = starts.every((s, i) => s >= 0 && (i === 0 || s > starts[i - 1])) ? 1 : 0;
  const ranges = (p: number[]) => (p.length ? toRanges([...new Set(p)].sort((a, b) => a - b)) : undefined);
  return { tier, score: words ? 0 : score, order, span, label: ranges(lab), desc: ranges(des), detail: ranges(det) };
}

/** The rows of the list for the filter `value` (exported for the unit tests). */
export function buildRows(items: QuickItem<unknown>[], value: string, o: QuickPickOptions<unknown>): Row[] {
  const q = value.trim();
  const filtering = !!q && o.filter !== false;
  const history = o.history && !o.canPickMany ? o.history : '';
  // `group`: the group the item was given in, which still counts when the groups are ranked together (flatFilter).
  type Entry = { item: QuickItem<unknown>; m?: ItemMatch; i: number; group: number; recent: number; len: number };
  const groups: Array<{ sep?: QuickItem<unknown>; entries: Entry[] }> = [{ entries: [] }];
  let group = 0;
  items.forEach((item, i) => {
    if (item.kind === 'separator') {
      group++;
      if (!(filtering && o.flatFilter)) groups.push({ sep: item, entries: [] });
      return;
    }
    const e: Entry = { item, i, group, recent: history ? recency(history, item) : 0, len: item.label.length - nameStartOf(item) };
    if (q) e.m = matchItem(item, q, o) ?? undefined;
    if (!filtering || e.m || item.alwaysShow) groups[groups.length - 1].entries.push(e);
  });
  // Nothing typed: what was picked recently comes first, the most recent at the top (VS Code's "recently used").
  if (!q && history && groups.length === 1) {
    const used = groups[0].entries.filter((e) => e.recent).sort((a, b) => b.recent - a.recent);
    if (used.length) groups.splice(0, 1, { sep: quickSeparator('recently used'), entries: used }, { sep: quickSeparator(), entries: groups[0].entries.filter((e) => !e.recent) });
  }
  // Better matches first; among equally good ones the earlier group (quick open's recently opened files), the words in
  // the order typed, then, as in VS Code's quick open, the more compact match and the shorter name. A command palette
  // puts the recently used first among equally good matches; otherwise that decides only between equals.
  const words = !!o.matchWords;
  const rank = (a: Entry, b: Entry): number => {
    if (!a.m || !b.m) return (a.m ? -1 : b.m ? 1 : 0) || a.i - b.i;
    return (
      b.m.tier - a.m.tier ||
      (words ? b.recent - a.recent : 0) ||
      b.m.score - a.m.score ||
      a.group - b.group ||
      b.m.order - a.m.order ||
      a.m.span - b.m.span ||
      a.len - b.len ||
      b.recent - a.recent ||
      a.i - b.i
    );
  };
  const rows: Row[] = [];
  let top = 0;
  for (const g of groups) {
    if (!g.entries.length) continue;
    if (filtering) g.entries.sort(rank);
    g.entries.forEach((e, k) => {
      const height = e.item.detail ? ROW_DETAIL : ROW;
      rows.push({
        item: e.item,
        sep: k === 0 ? g.sep?.label || undefined : undefined,
        border: k === 0 && !!g.sep && rows.length > 0,
        label: e.m?.label,
        desc: e.m?.desc,
        detail: e.m?.detail,
        top,
        height,
      });
      top += height;
    });
  }
  return rows;
}

function QuickPickView({ r }: { r: PickRequest }) {
  const o = r.o;
  const many = !!o.canPickMany;
  const filterOn = o.filter !== false;
  const listId = useMemo(() => uid('quick'), []);
  const [value, setValue] = useState(o.value ?? '');
  const [items, setItems] = useState<QuickItem<unknown>[]>(() => (Array.isArray(o.items) ? o.items : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pickedOf = (list: QuickItem<unknown>[]) => new Set(list.filter((i) => i.picked && i.kind !== 'separator').map((i) => i.value));
  const [checked, setChecked] = useState<Set<unknown>>(() => (Array.isArray(o.items) ? pickedOf(o.items) : new Set()));
  const loads = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: MAX_LIST });

  useLayoutEffect(() => {
    const el = inputRef.current!;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Items from a function: once (filtered here), or for each filter (filter: false) with the previous call aborted.
  // A layout effect, so items given at once (or the progress bar) are there in the first frame.
  useLayoutEffect(() => {
    const fn = o.items;
    if (Array.isArray(fn) || (filterOn && loads.current > 0)) return;
    const my = ++loads.current;
    const ctl = new AbortController();
    const apply = (list: QuickItem<unknown>[]) => {
      if (ctl.signal.aborted) return;
      setItems(list);
      setBusy(false);
      setError('');
      if (my === 1 && many) setChecked(pickedOf(list));
    };
    const fail = (e: unknown) => {
      if (ctl.signal.aborted || (e as Error)?.name === 'AbortError') return;
      console.error('[web resources manager]', e);
      setBusy(false);
      setError(`The list could not be loaded. ${(e as Error)?.message ?? String(e)}`);
    };
    const run = () => {
      try {
        const res = fn(value, ctl.signal);
        if (Array.isArray(res)) apply(res);
        else {
          setBusy(true);
          res.then(apply, fail);
        }
      } catch (e) {
        fail(e);
      }
    };
    // While the user types, a request waits for a short pause.
    let t: ReturnType<typeof setTimeout> | undefined;
    if (my === 1) run();
    else t = setTimeout(run, 80);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [filterOn ? '' : value]);

  const rows = useMemo(() => buildRows(items, value, o), [items, value]);
  const defaultActive = (rs: Row[]) => {
    if (!rs.length) return -1;
    if (!many && !value.trim()) {
      const p = rs.findIndex((x) => x.item.picked);
      if (p >= 0) return p;
    }
    return 0;
  };
  // The focus resets to the first row whenever the rows change (a new filter, items loaded).
  const [act, setAct] = useState<{ rows: Row[]; i: number }>(() => ({ rows, i: defaultActive(rows) }));
  const active = act.rows === rows ? Math.min(act.i, rows.length - 1) : defaultActive(rows);
  const total = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0;

  useLayoutEffect(() => {
    const el = listRef.current!;
    const update = () => setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const reveal = (i: number) => {
    const el = listRef.current;
    const row = rows[i];
    if (!el || !row) return;
    if (row.top < el.scrollTop) el.scrollTop = row.top;
    else if (row.top + row.height > el.scrollTop + el.clientHeight) el.scrollTop = row.top + row.height - el.clientHeight;
    else return;
    // Render the rows now in view at once, not when the scroll event comes (a frame later).
    setView({ top: el.scrollTop, height: el.clientHeight });
  };
  // New rows start at the top, with their focused row in view.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (act.rows !== rows && el.scrollTop !== 0) {
      el.scrollTop = 0;
      setView({ top: 0, height: el.clientHeight });
    }
    reveal(active);
  }, [rows]);

  const move = (i: number, wrap: boolean) => {
    const n = rows.length;
    if (!n) return;
    const next = wrap ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    setAct({ rows, i: next });
    reveal(next);
  };
  const page = () => Math.max(1, Math.floor((listRef.current?.clientHeight || MAX_LIST) / ROW) - 1);

  const toggle = (v: unknown) =>
    setChecked((prev) => {
      const s = new Set(prev);
      if (s.has(v)) s.delete(v);
      else s.add(v);
      return s;
    });
  const allChecked = rows.length > 0 && rows.every((x) => checked.has(x.item.value));
  const toggleAll = () =>
    setChecked((prev) => {
      const s = new Set(prev);
      for (const x of rows) {
        if (allChecked) s.delete(x.item.value);
        else s.add(x.item.value);
      }
      return s;
    });

  const pick = (item: QuickItem<unknown>) => {
    if (o.history) rememberPick(o.history, item);
    finish(r, item.value);
  };
  const accept = () => {
    if (many) {
      const values = items.filter((i) => i.kind !== 'separator' && checked.has(i.value)).map((i) => i.value);
      // Items checked in an earlier list (when the list is loaded for each filter) count too.
      for (const v of checked) if (!values.includes(v)) values.push(v);
      finish(r, values);
      return;
    }
    const row = rows[active];
    if (row) pick(row.item);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        move(active + 1, true);
        break;
      case 'ArrowUp':
        move(active - 1, true);
        break;
      case 'PageDown':
        move(active + page(), false);
        break;
      case 'PageUp':
        move(active - page(), false);
        break;
      case 'Enter':
        if (e.isComposing) return;
        accept();
        break;
      case 'Escape':
        finish(r, undefined);
        break;
      case ' ':
        // Space checks the focused item when there is nothing to type a space after; Ctrl+Space always does.
        if (!many || rows[active] === undefined || (!(e.ctrlKey || e.metaKey) && value !== '')) return;
        toggle(rows[active].item.value);
        break;
      case 'Tab':
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // Only the rows in view are in the document (a quick open over thousands of web resources stays fast).
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height <= view.top) lo = mid + 1;
    else hi = mid;
  }
  const shown: number[] = [];
  for (let i = Math.max(0, lo - 5); i < rows.length && rows[i].top < view.top + view.height + 5 * ROW; i++) shown.push(i);

  const renderRow = (i: number) => {
    const row = rows[i];
    const it = row.item;
    const isChecked = many && checked.has(it.value);
    return (
      <div
        key={`${i}|${it.label}`}
        id={`${listId}-${i}`}
        role="option"
        aria-selected={i === active}
        aria-checked={many ? isChecked : undefined}
        class={cx('wg-qrow', i === active && 'focused', row.border && 'group-start', it.detail && 'two-line')}
        style={{ top: row.top, height: row.height }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (many ? toggle(it.value) : pick(it))}
      >
        <div class="wg-qrow-entry">
          {many && (
            <span class={cx('wg-checkbox', 'wg-qrow-check', isChecked && 'checked')} aria-hidden="true">
              {isChecked && <i class="codicon codicon-check" />}
            </span>
          )}
          {it.icon && <i class={cx('codicon', `codicon-${it.icon}`, 'wg-qrow-icon')} aria-hidden="true" />}
          <div class="wg-qrow-rows">
            <div class="wg-qrow-line">
              <Highlight class="wg-qrow-label" text={it.label} ranges={row.label} />
              {it.description && <Highlight class="wg-qrow-desc" text={it.description} ranges={row.desc} />}
            </div>
            {it.detail && (
              <div class="wg-qrow-detail">
                <Highlight text={it.detail} ranges={row.detail} />
              </div>
            )}
          </div>
          {it.keybinding && <KeybindingLabel class="wg-qrow-kb" binding={it.keybinding} />}
          {row.sep && <span class="wg-qrow-sep">{row.sep}</span>}
          {it.buttons && it.buttons.length > 0 && (
            <div class="wg-qrow-buttons">
              {it.buttons.map((b) => (
                <button
                  type="button"
                  class="wg-action"
                  title={b.title}
                  aria-label={b.title}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    safeRun(() => b.run(it));
                  }}
                >
                  <i class={cx('codicon', `codicon-${b.icon}`)} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const empty = !rows.length;
  return (
    <Frame r={r} title={o.title} empty={empty && !busy && !error && !value.trim()}>
      <div class="wg-quick-header">
        {many && (
          <span
            class={cx('wg-checkbox', 'wg-quick-check-all', allChecked && 'checked')}
            role="checkbox"
            aria-checked={allChecked}
            aria-label="Toggle all checkboxes"
            title="Toggle all checkboxes"
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleAll}
          >
            {allChecked && <i class="codicon codicon-check" />}
          </span>
        )}
        <div class="wg-quick-filter">
          <div class="wg-inputbox wg-quick-box">
            <input
              ref={inputRef}
              class="wg-input"
              type="text"
              value={value}
              placeholder={o.placeholder}
              spellcheck={false}
              autocomplete="off"
              role="combobox"
              aria-expanded={!empty}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-label={o.placeholder || o.title || 'Type to narrow down results.'}
              aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              style={many ? { paddingRight: 90 } : undefined}
              onInput={(e) => {
                const v = e.currentTarget.value;
                setValue(v);
                safeRun(() => o.onValueChange?.(v));
              }}
              onKeyDown={onKeyDown}
            />
            {many && <Badge class="wg-quick-count" text={`${checked.size} Selected`} />}
          </div>
        </div>
        {many && (
          <Button kind="primary" class="wg-quick-ok" onClick={accept}>
            OK
          </Button>
        )}
      </div>
      {error && <div class="wg-quick-message error">{error}</div>}
      <ProgressBar active={busy} class="wg-quick-progress" />
      <div
        ref={listRef}
        id={listId}
        class={cx('wg-quick-list', 'wg-scroll', empty && 'empty')}
        role="listbox"
        aria-multiselectable={many || undefined}
        style={{ height: Math.min(total, MAX_LIST) }}
        onScroll={(e) => {
          const el = e.currentTarget;
          setView({ top: el.scrollTop, height: el.clientHeight });
        }}
      >
        <div class="wg-quick-rows" style={{ height: total }}>
          {shown.map(renderRow)}
        </div>
      </div>
      {empty && !busy && !error && value.trim() !== '' && <div class="wg-quick-empty">No matching results</div>}
    </Frame>
  );
}

// ------------------------------------------------------------------ input box

const INPUT_HINT = "Press 'Enter' to confirm your input or 'Escape' to cancel";

function InputBoxView({ r }: { r: InputRequest }) {
  const o = r.o;
  const [value, setValue] = useState(o.value ?? '');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const checks = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = inputRef.current!;
    el.focus();
    const [s, e] = o.valueSelection ?? [0, el.value.length];
    el.setSelectionRange(s, e);
  }, []);

  /** The validation message of v ('' when fine); shows it unless a newer check has started meanwhile. */
  const check = async (v: string): Promise<string> => {
    if (!o.validate) return '';
    const my = ++checks.current;
    let m: string;
    try {
      const res = o.validate(v);
      if (typeof res === 'string') m = res;
      else {
        setBusy(true);
        m = await res;
      }
    } catch (e) {
      console.error('[web resources manager]', e);
      m = `The value could not be checked. ${(e as Error)?.message ?? String(e)}`;
    }
    if (my === checks.current) {
      setMsg(m || '');
      setBusy(false);
    }
    return m || '';
  };

  // Checked before the frame is drawn, so a message for the initial value shows at once.
  useLayoutEffect(() => {
    void check(value);
  }, [value]);

  const accept = async () => {
    const v = value;
    if (await check(v)) return;
    // Typed on while the check ran: the new value's own check decides.
    if (inputRef.current && inputRef.current.value !== v) return;
    finish(r, v);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.isComposing) void accept();
    else if (e.key === 'Escape') finish(r, undefined);
    else if (e.key !== 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Frame r={r} title={o.title} empty>
      <div class="wg-quick-header">
        <div class="wg-quick-filter">
          <div class={cx('wg-inputbox', 'wg-quick-box', msg && 'error')}>
            <input
              ref={inputRef}
              class="wg-input"
              type={o.password ? 'password' : 'text'}
              value={value}
              placeholder={o.placeholder}
              spellcheck={false}
              autocomplete="off"
              aria-label={o.prompt || o.placeholder || o.title || 'Input'}
              aria-invalid={!!msg}
              onInput={(e) => setValue(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          <div class={cx('wg-quick-message', msg && 'error')} role={msg ? 'alert' : undefined}>
            {msg || (o.prompt ? `${o.prompt} (Press 'Enter' to confirm or 'Escape' to cancel)` : INPUT_HINT)}
          </div>
        </div>
      </div>
      <ProgressBar active={busy} class="wg-quick-progress" />
    </Frame>
  );
}

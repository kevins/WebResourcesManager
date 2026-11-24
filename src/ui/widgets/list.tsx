// A virtual list with VS Code's selection and keyboard model, the base of the explorer, search results, problems and
// every other list or tree of the workbench. Only the rows in view (and a few around them) are in the document, so a
// list of 10,000 web resources scrolls as smoothly as one of 10.
//
// The list doesn't keep a selection of its own: the caller owns `selected` and `focused` and gets every change
// through onSelect, so the state lives where the rest of the view's state does.
//
// Keys (as in VS Code): Up/Down/Home/End/PageUp/PageDown move the focus and select the focused row; with Shift they
// extend the selection from the anchor; Ctrl+A selects all; Space selects the focused row (Ctrl+Space toggles it);
// Enter activates it; Escape clears the selection; Shift+F10 or the context-menu key opens the context menu;
// typing jumps to the next row whose label starts with what was typed (with `typeAhead`).
// Mouse: click selects (Ctrl/Cmd+click toggles, Shift+click selects a range), double click activates, a click on
// empty space clears the selection, right click focuses the row (selecting it unless it is already selected).

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { cx, ctrlKey, uid } from './util';

export interface RowState {
  focused: boolean;
  selected: boolean;
}

export interface VirtualListProps<T> {
  items: T[];
  /** Height of every row in pixels (22 for VS Code's lists and trees). */
  rowHeight: number;
  keyOf: (t: T) => string;
  render: (t: T, i: number, s: RowState) => ComponentChildren;
  /** Keys of the selected rows. */
  selected: string[];
  /** Key of the focused row (the one the keyboard acts on). */
  focused?: string;
  /** Every change of selection or focus; `focused` is '' when nothing has the focus any more. */
  onSelect: (keys: string[], focused: string, e: MouseEvent | KeyboardEvent) => void;
  /** Enter, double click (e.type 'dblclick'), and single click when activateOnClick. */
  onActivate?: (t: T, e: MouseEvent | KeyboardEvent) => void;
  activateOnClick?: boolean;
  /**
   * Right click (or Shift+F10) on a row, or on empty space (null). Called after onSelect has focused the row (and
   * selected it, when it wasn't selected already).
   */
  onContextMenu?: (t: T | null, e: MouseEvent) => void;
  /**
   * Called first for every key pressed on the list (Left/Right are left to it: expanding and collapsing a tree);
   * return true when handled: the list then ignores the key and stops it (preventDefault, stopPropagation).
   */
  onKeyDown?: (e: KeyboardEvent, focused: T | null) => boolean;
  /** The text type-ahead matches (the row's label). Without it, typing does nothing. */
  typeAhead?: (t: T) => string;
  /** Key of a row to bring into view (centred when it is out of view), each time it changes or first appears. */
  scrollTo?: string;
  ariaLabel: string;
  /** Shown when there are no items. */
  empty?: ComponentChildren;
  /** Extra classes; 'wg-guides-hover' shows a tree's indent guides only while the pointer is over it (VS Code's default). */
  class?: string;
  /** 'tree' for trees (rows are treeitems), 'listbox' (default) for lists. */
  role?: 'tree' | 'listbox';
  /** Aria details of a row: its level and expanded state in a tree, a spoken label. */
  rowAria?: (t: T) => { level?: number; expanded?: boolean; label?: string };
  /** False allows only one selected row (Shift/Ctrl clicks act like plain clicks, Ctrl+A does nothing). */
  multiple?: boolean;
}

/** Rows rendered above and below the visible ones, so fast scrolling doesn't show empty space. */
const OVERSCAN = 8;
/** Typed characters within this many milliseconds make one type-ahead word. */
const TYPE_AHEAD_MS = 800;

export function VirtualList<T>(p: VirtualListProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  const anchor = useRef('');
  const typed = useRef({ text: '', time: 0 });
  const revealed = useRef<string | undefined>(undefined);
  const id = useMemo(() => uid('list'), []);
  const keyOf = useRef(p.keyOf);
  keyOf.current = p.keyOf;
  const multiple = p.multiple !== false;
  const { items, rowHeight: h } = p;
  const n = items.length;

  const index = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((t, i) => m.set(keyOf.current(t), i));
    return m;
  }, [items]);
  const sel = useMemo(() => new Set(p.selected), [p.selected]);
  const fi = p.focused ? (index.get(p.focused) ?? -1) : -1;

  // Follow the size of the viewport (the list fills whatever its parent gives it).
  useLayoutEffect(() => {
    const el = ref.current!;
    const update = () => setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A shorter list may have moved the scroll position.
  useLayoutEffect(() => {
    const el = ref.current!;
    if (el.scrollTop !== view.top) setView({ top: el.scrollTop, height: el.clientHeight });
  }, [n]);

  const reveal = (i: number, centre = false) => {
    const el = ref.current;
    if (!el || i < 0) return;
    const top = i * h;
    const bottom = top + h;
    const vh = el.clientHeight;
    if (top >= el.scrollTop && bottom <= el.scrollTop + vh) return;
    if (centre) el.scrollTop = Math.max(0, top - (vh - h) / 2);
    else if (top < el.scrollTop) el.scrollTop = top;
    else el.scrollTop = bottom - vh;
    // Render the rows now in view at once, not when the scroll event comes (a frame later).
    setView({ top: el.scrollTop, height: vh });
  };

  // Reveal `scrollTo` when it changes, or when its row appears (a folder above it was just expanded).
  const scrollIndex = p.scrollTo ? (index.get(p.scrollTo) ?? -1) : -1;
  useLayoutEffect(() => {
    if (!p.scrollTo) revealed.current = undefined;
    else if (scrollIndex >= 0 && revealed.current !== p.scrollTo) {
      revealed.current = p.scrollTo;
      reveal(scrollIndex, true);
    }
  }, [p.scrollTo, scrollIndex]);

  const keyAt = (i: number) => keyOf.current(items[i]);
  const range = (a: number, b: number) => {
    const out: string[] = [];
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(keyAt(i));
    return out;
  };
  const anchorIndex = (fallback: number) => {
    const a = index.get(anchor.current);
    if (a !== undefined) return a;
    const i = fi >= 0 ? fi : fallback;
    anchor.current = keyAt(i);
    return i;
  };

  /** Focuses row i; selects it, or the range from the anchor with Shift. */
  const moveTo = (i: number, e: KeyboardEvent, extend: boolean) => {
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    const key = keyAt(i);
    if (extend && multiple) p.onSelect(range(anchorIndex(i), i), key, e);
    else {
      anchor.current = key;
      p.onSelect([key], key, e);
    }
    reveal(i);
  };

  const typeAheadFind = (e: KeyboardEvent) => {
    const now = Date.now();
    const t = typed.current;
    const fresh = now - t.time > TYPE_AHEAD_MS;
    t.text = fresh ? e.key : t.text + e.key;
    t.time = now;
    const q = t.text.toLowerCase();
    // A new word starts from the row after the focused one, so typing the same letter again finds the next match.
    const start = fi < 0 ? 0 : fresh ? fi + 1 : fi;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (p.typeAhead!(items[i]).toLowerCase().startsWith(q)) {
        moveTo(i, e, false);
        return;
      }
    }
  };

  const contextMenuAtFocus = () => {
    const el = ref.current!;
    const row = fi >= 0 ? (el.querySelector(`[data-wg-row="${fi}"]`) as HTMLElement | null) : null;
    const r = (row ?? el).getBoundingClientRect();
    const e = new MouseEvent('contextmenu', { clientX: Math.round(r.left + Math.min(40, r.width / 2)), clientY: Math.round(row ? r.bottom : r.top + 4) });
    p.onContextMenu!(fi >= 0 ? items[fi] : null, e);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Keys typed into something inside a row (a rename box, a button) are that element's own.
    if (e.target !== ref.current) return;
    if (p.onKeyDown?.(e, fi >= 0 ? items[fi] : null)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const el = ref.current!;
    const mod = ctrlKey(e);
    const page = Math.max(1, Math.floor(el.clientHeight / h));
    switch (e.key) {
      case 'ArrowDown':
        if (e.altKey) return;
        moveTo(fi < 0 ? 0 : fi + 1, e, e.shiftKey);
        break;
      case 'ArrowUp':
        if (e.altKey) return;
        moveTo(fi < 0 ? 0 : fi - 1, e, e.shiftKey);
        break;
      case 'Home':
        moveTo(0, e, e.shiftKey);
        break;
      case 'End':
        moveTo(n - 1, e, e.shiftKey);
        break;
      case 'PageDown': {
        // First to the last row in view, then a page further, as VS Code does.
        const last = Math.min(n - 1, Math.floor((el.scrollTop + el.clientHeight) / h) - 1);
        moveTo(fi < last ? last : fi + page, e, e.shiftKey);
        break;
      }
      case 'PageUp': {
        const first = Math.min(n - 1, Math.ceil(el.scrollTop / h));
        moveTo(fi > first ? first : fi - page, e, e.shiftKey);
        break;
      }
      case 'Enter':
        if (fi < 0 || !p.onActivate) return;
        p.onActivate(items[fi], e);
        break;
      case ' ':
        if (fi < 0) return;
        if (mod && multiple) {
          const key = keyAt(fi);
          anchor.current = key;
          p.onSelect(sel.has(key) ? p.selected.filter((k) => k !== key) : [...p.selected, key], key, e);
        } else moveTo(fi, e, false);
        break;
      case 'Escape':
        if (!p.selected.length) return;
        p.onSelect([], p.focused ?? '', e);
        break;
      case 'F10':
        if (!e.shiftKey || !p.onContextMenu) return;
        contextMenuAtFocus();
        break;
      case 'ContextMenu':
        if (!p.onContextMenu) return;
        contextMenuAtFocus();
        break;
      default:
        if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
          if (!multiple || !n) return;
          p.onSelect(items.map((t) => keyOf.current(t)), p.focused || keyAt(0), e);
          break;
        }
        if (p.typeAhead && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          typeAheadFind(e);
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const rowOf = (e: Event): number => {
    const row = (e.target as HTMLElement).closest?.('[data-wg-row]') as HTMLElement | null;
    return row && ref.current?.contains(row) ? Number(row.dataset.wgRow) : -1;
  };

  const onClick = (e: MouseEvent) => {
    const i = rowOf(e);
    if (i < 0) {
      // A click on empty space clears the selection and the focus (so "New File" goes to the root, as in VS Code).
      const t = e.target as HTMLElement;
      if (t === ref.current || t.classList.contains('wg-list-rows')) p.onSelect([], '', e);
      return;
    }
    const key = keyAt(i);
    if (multiple && e.shiftKey) p.onSelect(range(anchorIndex(i), i), key, e);
    else if (multiple && ctrlKey(e)) {
      anchor.current = key;
      p.onSelect(sel.has(key) ? p.selected.filter((k) => k !== key) : [...p.selected, key], key, e);
    } else {
      anchor.current = key;
      p.onSelect([key], key, e);
      // The second click of a double click doesn't activate again; the double click itself does.
      if (p.activateOnClick && p.onActivate && e.detail <= 1) p.onActivate(items[i], e);
    }
  };

  const onDblClick = (e: MouseEvent) => {
    const i = rowOf(e);
    if (i >= 0 && p.onActivate && !e.shiftKey && !ctrlKey(e)) p.onActivate(items[i], e);
  };

  const onContextMenu = (e: MouseEvent) => {
    if (!p.onContextMenu) return;
    e.preventDefault();
    const i = rowOf(e);
    // The context-menu key fires the event on the list itself, without a button.
    if (i < 0 && e.target === ref.current && e.button !== 2 && fi >= 0) {
      contextMenuAtFocus();
      return;
    }
    if (i < 0) {
      p.onContextMenu(null, e);
      return;
    }
    const key = keyAt(i);
    if (!sel.has(key)) {
      anchor.current = key;
      p.onSelect([key], key, e);
    } else if (key !== p.focused) p.onSelect(p.selected, key, e);
    p.onContextMenu(items[i], e);
  };

  const first = Math.max(0, Math.floor(view.top / h) - OVERSCAN);
  const last = Math.min(n, Math.ceil((view.top + Math.max(view.height, h)) / h) + OVERSCAN);
  const rowRole = p.role === 'tree' ? 'treeitem' : 'option';
  const rows: ComponentChildren[] = [];
  for (let i = first; i < last; i++) {
    const t = items[i];
    const key = keyOf.current(t);
    const isSel = sel.has(key);
    const isFoc = i === fi;
    const aria = p.rowAria?.(t);
    rows.push(
      <div
        key={key}
        id={`${id}-${i}`}
        data-wg-row={i}
        role={rowRole}
        aria-selected={isSel}
        aria-level={aria?.level}
        aria-expanded={aria?.expanded}
        aria-label={aria?.label}
        aria-posinset={i + 1}
        aria-setsize={n}
        class={cx('wg-row', isSel && 'selected', isFoc && 'focused')}
        style={{ top: i * h, height: h, lineHeight: `${h}px` }}
      >
        {p.render(t, i, { focused: isFoc, selected: isSel })}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      class={cx('wg-list', 'wg-scroll', p.class)}
      tabIndex={0}
      role={p.role ?? 'listbox'}
      aria-label={p.ariaLabel}
      aria-multiselectable={multiple || undefined}
      aria-activedescendant={fi >= first && fi < last ? `${id}-${fi}` : undefined}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onDblClick={onDblClick}
      onContextMenu={onContextMenu}
      onScroll={(e) => {
        const el = e.currentTarget;
        setView({ top: el.scrollTop, height: el.clientHeight });
      }}
    >
      {/* The shadow VS Code draws under the top edge once the list is scrolled. */}
      <div class={cx('wg-list-shadow', view.top > 0 && 'on')} />
      <div class="wg-list-rows" style={{ height: n * h }}>
        {rows}
      </div>
      {n === 0 && p.empty != null && <div class="wg-list-empty">{p.empty}</div>}
    </div>
  );
}

// The context menu service: one menu (with its submenus) at a time, drawn by <Layers/>, looking and behaving like
// VS Code's menus. showMenu() opens it at a point (a right click) or under an element (a "..." button).
//
// Keys: Up/Down (Home/End, PageUp/PageDown) move between the enabled items, Enter or Space runs one, Right opens a
// submenu, Left or Escape closes it (Escape closes the whole menu at the top level), a letter moves to the next item
// starting with it. The menu closes on a mousedown outside it, Escape, window blur, resize and scroll, and gives
// the focus back to where it was.

import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Signal } from '../../core/emitter';
import { keyLabel } from '../commands';
import { useSignal } from '../hooks';
import { clamp, cx, focusedElement, restoreFocus, safeRun, uid } from './util';

export type MenuItem =
  | {
      label: string;
      /** Codicon shown in the left gutter (where the check mark goes). */
      icon?: string;
      /** A binding as commands use it ('ctrl+shift+p'), shown right-aligned. */
      keybinding?: string;
      run?: () => void;
      disabled?: boolean;
      checked?: boolean;
      submenu?: MenuItem[];
    }
  | { separator: true };

/** `selectFirst`: the first item is highlighted at once (a menu opened from the keyboard, as in VS Code). */
export type ShowMenuOptions = ({ x: number; y: number; items: MenuItem[] } | { anchor: HTMLElement; items: MenuItem[]; align?: 'left' | 'right' }) & { selectFirst?: boolean };

type Entry = Exclude<MenuItem, { separator: true }>;

const isSep = (m: MenuItem | undefined): m is { separator: true } => !!m && 'separator' in m && m.separator === true;
const enabled = (m: MenuItem | undefined): m is Entry => !!m && !isSep(m) && !m.disabled;

/** Drops empty submenus, and the separators that would end up first, last or twice in a row. */
function clean(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const m of items) {
    if (isSep(m)) {
      if (out.length && !isSep(out[out.length - 1])) out.push(m);
    } else if (m.submenu) {
      const sub = clean(m.submenu);
      if (sub.length) out.push({ ...m, submenu: sub });
    } else out.push(m);
  }
  while (out.length && isSep(out[out.length - 1])) out.pop();
  return out;
}

interface MenuRequest {
  id: number;
  items: MenuItem[];
  at: ShowMenuOptions;
  restore: HTMLElement | null;
}

const state = new Signal<MenuRequest | null>(null);
/** True while a context menu is open. */
export const menuOpen = new Signal<boolean>(false);
let seq = 0;
let hostEl: HTMLElement | null = null;
// A mousedown on the button that opened the menu closes it; the click that follows must not open it again.
let closedFrom: { anchor: HTMLElement | null; time: number } = { anchor: null, time: 0 };

export function showMenu(opts: ShowMenuOptions): void {
  const anchor = 'anchor' in opts ? opts.anchor : null;
  if (anchor && closedFrom.anchor === anchor && Date.now() - closedFrom.time < 500) {
    closedFrom = { anchor: null, time: 0 };
    return;
  }
  const items = clean(opts.items);
  const prev = state.value;
  if (!items.length) {
    if (prev) closeMenu();
    return;
  }
  state.value = { id: ++seq, items, at: opts, restore: prev ? prev.restore : focusedElement() };
  menuOpen.value = true;
}

export function closeMenu(): void {
  close(true);
}

function close(giveFocusBack: boolean): void {
  const s = state.value;
  if (!s) return;
  state.value = null;
  menuOpen.value = false;
  if (giveFocusBack) restoreFocus(s.restore, hostEl);
}

/** Margin kept between a menu and the edges of the window. */
const EDGE = 4;
/** Vertical padding of a menu: a submenu's first item lines up with the item that opened it. */
const PAD = 4;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Level {
  items: MenuItem[];
  /** The highlighted item, -1 for none. */
  active: number;
  /** Index of the item of the level below that opened this submenu. */
  parent: number;
  /** Where that item and its menu are, to place this submenu next to them. */
  origin?: { item: Rect; pane: Rect };
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

type Place = { left: number; top: number; maxHeight?: number };

/** Places a menu of size w × h: at the point or under the anchor, flipped to stay inside the window. */
function placeRoot(at: ShowMenuOptions, w: number, h: number): Place {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left: number;
  let top: number;
  if ('anchor' in at) {
    const r = at.anchor.getBoundingClientRect();
    left = at.align === 'right' ? r.right - w : r.left;
    top = r.bottom;
    if (top + h > vh - EDGE && r.top - h >= EDGE) top = r.top - h;
  } else {
    left = at.x;
    top = at.y;
    if (left + w > vw - EDGE) left = at.x - w;
    if (top + h > vh - EDGE) top = at.y - h;
  }
  return fit(left, top, w, h);
}

function placeSub(origin: { item: Rect; pane: Rect }, w: number, h: number): Place {
  const vw = window.innerWidth;
  let left = origin.pane.right;
  if (left + w > vw - EDGE) left = origin.pane.left - w;
  return fit(left, origin.item.top - PAD - 1, w, h);
}

function fit(left: number, top: number, w: number, h: number): Place {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxHeight = h > vh - 2 * EDGE ? vh - 2 * EDGE : undefined;
  return {
    left: clamp(left, EDGE, Math.max(EDGE, vw - w - EDGE)),
    top: clamp(top, EDGE, Math.max(EDGE, vh - (maxHeight ?? h) - EDGE)),
    maxHeight,
  };
}

/** The next enabled item from `from` in direction `dir`, wrapping around; -1 when there is none. */
function step(items: MenuItem[], from: number, dir: 1 | -1): number {
  const n = items.length;
  const start = from < 0 ? (dir > 0 ? -1 : n) : from;
  for (let k = 1; k <= n; k++) {
    const i = (((start + dir * k) % n) + n) % n;
    if (enabled(items[i])) return i;
  }
  return -1;
}

/** Renders the open menu; mounted once by <Layers/>. */
export function MenuLayer() {
  const req = useSignal(state);
  return req ? <MenuView key={req.id} req={req} /> : null;
}

function MenuView({ req }: { req: MenuRequest }) {
  const host = useRef<HTMLDivElement>(null);
  const [levels, setLevelsState] = useState<Level[]>([{ items: req.items, active: req.at.selectFirst ? step(req.items, -1, 1) : -1, parent: -1 }]);
  const [focusLevel, setFocusLevelState] = useState(0);
  const levelsRef = useRef(levels);
  const focusRef = useRef(focusLevel);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useMemo(() => uid('menu'), []);

  // The handlers read the latest state from refs: hover timers fire after renders they didn't see.
  const setLevels = (ls: Level[]) => {
    levelsRef.current = ls;
    setLevelsState(ls);
  };
  const setFocusLevel = (k: number) => {
    focusRef.current = k;
    setFocusLevelState(k);
  };

  useLayoutEffect(() => {
    hostEl = host.current;
    host.current!.focus({ preventScroll: true });
    return () => {
      if (hostEl === host.current) hostEl = null;
    };
  }, []);

  // Listening starts as soon as the menu is in the document (a layout effect: no frame without it).
  useLayoutEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (host.current?.contains(t)) return;
      const anchor = 'anchor' in req.at ? req.at.anchor : null;
      closedFrom = { anchor: anchor && anchor.contains(t) ? anchor : null, time: Date.now() };
      closeMenu();
    };
    const scroll = (e: Event) => {
      if (!host.current?.contains(e.target as Node)) closeMenu();
    };
    // The window lost the focus (a click on the page around the manager's frame): the menu closes, and the focus
    // is not pulled back into the frame.
    const blur = () => close(false);
    document.addEventListener('mousedown', down, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', closeMenu);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', closeMenu);
    };
  }, []);

  /** Highlights item i of level k (and its ancestors), closing deeper submenus unless `keep`. */
  const highlight = (k: number, i: number, keep = false) => {
    const ls = levelsRef.current.slice(0, keep ? undefined : k + 1);
    ls[k] = { ...ls[k], active: i };
    for (let j = k; j > 0; j--) ls[j - 1] = { ...ls[j - 1], active: ls[j].parent };
    setLevels(ls);
  };

  const openSub = (k: number, i: number, focusFirst: boolean) => {
    const ls = levelsRef.current;
    const item = ls[k]?.items[i];
    if (!enabled(item) || !item.submenu) return;
    if (ls.length > k + 1 && ls[k + 1].parent === i) {
      // Already open (from hovering): just move into it.
      if (focusFirst) {
        const next = ls.slice();
        next[k + 1] = { ...next[k + 1], active: step(item.submenu, -1, 1) };
        setLevels(next);
        setFocusLevel(k + 1);
      }
      return;
    }
    const el = host.current?.querySelector(`[data-level="${k}"] [data-index="${i}"]`);
    const pane = el?.closest('.wg-menu');
    if (!el || !pane) return;
    const next = ls.slice(0, k + 1);
    next[k] = { ...next[k], active: i };
    next.push({ items: item.submenu, active: focusFirst ? step(item.submenu, -1, 1) : -1, parent: i, origin: { item: rectOf(el), pane: rectOf(pane) } });
    setLevels(next);
    if (focusFirst) setFocusLevel(k + 1);
  };

  const activate = (k: number, i: number, byKey: boolean) => {
    const item = levelsRef.current[k]?.items[i];
    if (!enabled(item)) return;
    clearTimeout(timer.current);
    if (item.submenu) {
      openSub(k, i, byKey);
      return;
    }
    // Close first, so the focus is back where it was before the action runs (it may open a dialog or an editor).
    closeMenu();
    safeRun(item.run);
  };

  const onHover = (k: number, i: number) => {
    clearTimeout(timer.current);
    const ls = levelsRef.current;
    const item = ls[k]?.items[i];
    setFocusLevel(k);
    const hasDeeper = ls.length > k + 1;
    const subOpenHere = hasDeeper && ls[k + 1].parent === i;
    // The highlight moves at once; an open submenu stays a moment, so the pointer can travel to it diagonally.
    highlight(k, enabled(item) ? i : -1, true);
    if (subOpenHere) return;
    if (enabled(item) && item.submenu) timer.current = setTimeout(() => openSub(k, i, false), 250);
    else if (hasDeeper) timer.current = setTimeout(() => setLevels(levelsRef.current.slice(0, k + 1)), 250);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const ls = levelsRef.current;
    const k = Math.min(focusRef.current, ls.length - 1);
    const lv = ls[k];
    clearTimeout(timer.current);
    switch (e.key) {
      case 'ArrowDown':
        highlight(k, step(lv.items, lv.active, 1));
        break;
      case 'ArrowUp':
        highlight(k, step(lv.items, lv.active, -1));
        break;
      case 'Home':
      case 'PageUp':
        highlight(k, step(lv.items, -1, 1));
        break;
      case 'End':
      case 'PageDown':
        highlight(k, step(lv.items, -1, -1));
        break;
      case 'ArrowRight':
        if (lv.active >= 0) openSub(k, lv.active, true);
        break;
      case 'ArrowLeft':
        if (k > 0) {
          setLevels(ls.slice(0, k));
          setFocusLevel(k - 1);
        }
        break;
      case 'Escape':
        if (k > 0) {
          setLevels(ls.slice(0, k));
          setFocusLevel(k - 1);
        } else closeMenu();
        break;
      case 'Enter':
      case ' ':
        if (lv.active >= 0) activate(k, lv.active, true);
        break;
      case 'Tab':
        // The focus stays in the menu.
        break;
      default: {
        if (e.key.length !== 1 || !/\S/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
        // A letter moves to the next enabled item whose label starts with it.
        const c = e.key.toLowerCase();
        const n = lv.items.length;
        for (let j = 1; j <= n; j++) {
          const i = (((lv.active < 0 ? -1 : lv.active) + j) % n + n) % n;
          const m = lv.items[i];
          if (enabled(m) && m.label.trim().toLowerCase().startsWith(c)) {
            highlight(k, i);
            break;
          }
        }
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const k = Math.min(focusLevel, levels.length - 1);
  const activeId = levels[k] && levels[k].active >= 0 ? `${id}-${k}-${levels[k].active}` : undefined;
  return (
    <div
      ref={host}
      class="wg-menu-host"
      tabIndex={-1}
      role="application"
      aria-activedescendant={activeId}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {levels.map((lv, level) => (
        <MenuPane
          key={`${level}:${lv.parent}`}
          id={id}
          level={level}
          lv={lv}
          place={(w, h) => (level === 0 || !lv.origin ? placeRoot(req.at, w, h) : placeSub(lv.origin, w, h))}
          onHover={onHover}
          onActivate={(lvl, i) => activate(lvl, i, false)}
          onEnter={() => {
            // The pointer reached this submenu: keep it open.
            if (level > 0) clearTimeout(timer.current);
          }}
          expanded={levels[level + 1]?.parent}
        />
      ))}
    </div>
  );
}

interface MenuPaneProps {
  id: string;
  level: number;
  lv: Level;
  place: (w: number, h: number) => Place;
  onHover: (level: number, i: number) => void;
  onActivate: (level: number, i: number) => void;
  onEnter: () => void;
  /** Index of the item whose submenu is open. */
  expanded?: number;
}

function MenuPane({ id, level, lv, place, onHover, onActivate, onEnter, expanded }: MenuPaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Place | null>(null);
  // Measure first (hidden), then place: the size decides on which side of the point the menu goes.
  useLayoutEffect(() => {
    const el = ref.current!;
    setPos(place(el.offsetWidth, el.offsetHeight));
  }, []);
  return (
    <div
      ref={ref}
      class="wg-menu wg-scroll"
      data-level={level}
      role="menu"
      style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : { left: 0, top: 0, visibility: 'hidden' }}
      onMouseEnter={onEnter}
    >
      {lv.items.map((m, i) =>
        isSep(m) ? (
          <div key={`s${i}`} class="wg-menu-sep" role="separator" />
        ) : (
          <div
            key={`i${i}`}
            id={`${id}-${level}-${i}`}
            data-index={i}
            role={m.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={m.checked}
            aria-disabled={m.disabled || undefined}
            aria-haspopup={m.submenu ? 'menu' : undefined}
            aria-expanded={m.submenu ? expanded === i : undefined}
            class={cx('wg-menu-item', i === lv.active && 'active', m.disabled && 'disabled', expanded === i && 'expanded')}
            onMouseEnter={() => onHover(level, i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onActivate(level, i)}
          >
            <span class="wg-menu-check" aria-hidden="true">
              {m.checked ? <i class="codicon codicon-check" /> : m.icon ? <i class={cx('codicon', `codicon-${m.icon}`)} /> : null}
            </span>
            <span class="wg-menu-label">{m.label}</span>
            {m.keybinding && <span class="wg-menu-key">{keyLabel(m.keybinding)}</span>}
            {m.submenu && <span class="wg-menu-sub codicon codicon-chevron-right" aria-hidden="true" />}
          </div>
        ),
      )}
    </div>
  );
}

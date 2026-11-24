// Bookmarklet entry point. It runs in the Dynamics tab itself (the page the bookmark was clicked on), checks where it
// is, keeps one manager per tab, and starts the manager in a window of its own over the page (moved by its title bar,
// resized by its edge, maximized to fill the page): an empty frame of the page's own origin, so the manager's requests
// carry the page's session exactly as the app's own do, while its styles, keyboard shortcuts and editor never mix with
// the page's.
//
// Clicking the bookmark again hides or shows the running manager (the same build), or replaces a manager of another
// build. A manager that is saving or publishing is never torn down: the click says to wait.

import { keyOf, where } from '../core/connect';
import { THEME_BACKGROUND, cachedTheme, resolveTheme } from '../core/theme';

/** The manager itself, as text (tools/build.mjs puts it here): it is run inside the frame, never on the page. */
declare const __APP__: string;
// __BUILD__ (env.d.ts) changes with every different build: a hash of the app's code.

/** What the page keeps of a running manager (window.__wrManager). Older builds must stay recognisable. */
interface Instance {
  key: string;
  build: string;
  starting: boolean;
  since: number;
  /** Shows the manager if hidden, hides it if shown; false when it was already torn down. */
  toggle?: () => boolean;
  show?: () => boolean;
  /** Tears the manager down; false (nothing done) while a save or publish runs. */
  destroy?: () => boolean;
}

/** What the frame's code gets from the page (window.__wrmHost inside the frame). */
export interface Host {
  page: Window;
  key: string;
  version: string;
  build: string;
  /** The app is ready: its callbacks for the bookmark's next clicks. */
  ready(app: { busy(): boolean; teardown(): void; shown?(): void }): void;
  /** Hides the manager (the page shows again); the bookmark or the floating button brings it back. */
  minimize(): void;
  /** Closes the manager; false when the app said it is busy. */
  close(): boolean;
  /** The floating button's text while minimized (e.g. "Web resources · 3 unsaved"). */
  pill(text: string): void;
  /** While true, leaving or reloading the page asks first (a save or publish is running). */
  guardUnload(on: boolean): void;
  /** The start failed: shows the message and removes the frame. */
  fail(message: string): void;
  /** The manager's window over the page: moved by its title bar, maximized (fills the page) or restored. */
  win: {
    maximized(): boolean;
    toggleMaximized(): void;
    /** The pointer went down on the title bar at (x, y) of the frame, moved there, went up. */
    dragStart(x: number, y: number): void;
    dragTo(x: number, y: number): void;
    dragEnd(): void;
    /** Told when the window is maximized or restored (a drag restores a maximized one). */
    onChange: ((maximized: boolean) => void) | null;
  };
}

declare global {
  interface Window {
    __wrManager?: Instance;
    __wrmHost?: Host;
  }
}

const STUCK_MS = 30000;
const Z = '2147483000';
/** The edge around the window that resizes it (on the page, outside the frame). */
const RING = 6;
const MIN_W = 560;
const MIN_H = 360;
/** Where the window was (and whether maximized), in the page's own storage. */
const WIN_KEY = 'wrm.window';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

void (() => {
  const page = window;
  const w = where(page);
  if (w.kind === 'none') return alert(w.why);
  const key = keyOf(page, w);

  const prev = page.__wrManager;
  if (prev) {
    if (prev.starting && Date.now() - (prev.since || 0) < STUCK_MS) return alert('Web Resources Manager is still starting. Wait a moment.');
    if (!prev.starting && prev.key === key && prev.build === __BUILD__ && prev.toggle)
      try {
        if (prev.toggle() !== false) return;
      } catch {
        /* a broken instance: replaced below */
      }
    let gone = true;
    try {
      gone = prev.destroy ? prev.destroy() !== false : true;
    } catch {
      /* it failed while tearing down; nothing more can be done for it */
    }
    if (!gone) return alert('Web Resources Manager is still saving or publishing. Wait until it has finished, then click the bookmark again.');
    if (page.__wrManager === prev) delete page.__wrManager;
  }
  page.document.getElementById('wrm-host')?.remove();
  page.document.getElementById('wrm-pill')?.remove();

  const inst: Instance = { key, build: __BUILD__, starting: true, since: Date.now() };
  page.__wrManager = inst;

  const doc = page.document;
  // The window opens in the theme it was last shown in (no dark flash before a light screen).
  const bg = THEME_BACKGROUND[resolveTheme(cachedTheme(page), page)];
  const hostEl = doc.createElement('div');
  hostEl.id = 'wrm-host';
  hostEl.setAttribute('style', `all:initial;position:fixed;left:0;top:0;width:100%;height:100%;z-index:${Z};display:block;box-sizing:border-box;background:transparent`);
  const frame = doc.createElement('iframe');
  frame.id = 'wrm-frame';
  frame.title = 'Web Resources Manager';
  frame.setAttribute('allow', 'clipboard-read; clipboard-write');
  frame.setAttribute('style', `all:initial;display:block;width:100%;height:100%;border:0;margin:0;padding:0;box-sizing:border-box;background:${bg}`);
  hostEl.appendChild(frame);
  (doc.body || doc.documentElement).appendChild(hostEl);

  // ---- the window: where it is on the page, moved by the manager's title bar, resized by its edge, maximized
  const fit = (r: Rect): Rect => {
    const W = page.innerWidth;
    const H = page.innerHeight;
    const w = Math.max(Math.min(MIN_W, W), Math.min(r.w, W));
    const h = Math.max(Math.min(MIN_H, H), Math.min(r.h, H));
    // The title bar stays on the page: it is what brings the window back.
    return { x: Math.min(Math.max(r.x, 120 - w), W - 120), y: Math.min(Math.max(r.y, 0), H - 40), w, h };
  };
  const centred = (): Rect => {
    const W = page.innerWidth;
    const H = page.innerHeight;
    const w = Math.min(W - 32, Math.max(MIN_W, Math.min(1400, Math.round(W * 0.8))));
    const h = Math.min(H - 32, Math.max(MIN_H, Math.min(950, Math.round(H * 0.85))));
    return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
  };
  let rect = centred();
  let max = false;
  try {
    const s = JSON.parse(page.localStorage.getItem(WIN_KEY) || 'null');
    if (s && [s.x, s.y, s.w, s.h].every((n) => typeof n === 'number' && isFinite(n))) {
      rect = { x: s.x, y: s.y, w: s.w, h: s.h };
      max = !!s.max;
    }
  } catch {
    /* the window opens centred */
  }
  const remember = () => {
    try {
      page.localStorage.setItem(WIN_KEY, JSON.stringify({ ...rect, max }));
    } catch {
      /* it opens centred next time */
    }
  };
  const layout = () => {
    const s = hostEl.style;
    const f = frame.style;
    if (max) {
      Object.assign(s, { left: '0px', top: '0px', width: '100%', height: '100%', padding: '0px' });
      Object.assign(f, { borderRadius: '0px', boxShadow: 'none' });
    } else {
      const r = fit(rect);
      Object.assign(s, { left: `${r.x - RING}px`, top: `${r.y - RING}px`, width: `${r.w + 2 * RING}px`, height: `${r.h + 2 * RING}px`, padding: `${RING}px` });
      Object.assign(f, { borderRadius: '8px', boxShadow: '0 0 0 1px rgba(0,0,0,.3), 0 12px 36px rgba(0,0,0,.45)' });
    }
  };
  layout();
  page.addEventListener('resize', layout);

  // Resizing: the pointer on the edge (the frame covers the rest of the window).
  let sizing: { edge: string; x: number; y: number; r: Rect } | null = null;
  const edgeAt = (e: PointerEvent): string => {
    if (max) return '';
    const b = hostEl.getBoundingClientRect();
    const x = e.clientX - b.left;
    const y = e.clientY - b.top;
    const c = RING + 14;
    return (y < c ? 'n' : y > b.height - c ? 's' : '') + (x < c ? 'w' : x > b.width - c ? 'e' : '');
  };
  hostEl.addEventListener('pointerdown', (e) => {
    const edge = e.button === 0 && e.target === hostEl ? edgeAt(e) : '';
    if (!edge) return;
    e.preventDefault();
    hostEl.setPointerCapture(e.pointerId);
    // The frame doesn't take the pointer while it passes over it.
    frame.style.pointerEvents = 'none';
    sizing = { edge, x: e.clientX, y: e.clientY, r: fit(rect) };
  });
  hostEl.addEventListener('pointermove', (e) => {
    if (!sizing) {
      const edge = edgeAt(e);
      hostEl.style.cursor = edge ? `${edge}-resize` : '';
      return;
    }
    const { edge, r: o } = sizing;
    const dx = e.clientX - sizing.x;
    const dy = e.clientY - sizing.y;
    const r = { ...o };
    if (edge.includes('e')) r.w = Math.max(MIN_W, o.w + dx);
    if (edge.includes('s')) r.h = Math.max(MIN_H, o.h + dy);
    if (edge.includes('w')) {
      r.w = Math.max(MIN_W, o.w - dx);
      r.x = o.x + o.w - r.w;
    }
    if (edge.includes('n')) {
      r.h = Math.max(MIN_H, o.h - dy);
      r.y = o.y + o.h - r.h;
    }
    rect = r;
    layout();
  });
  const endSizing = () => {
    if (!sizing) return;
    sizing = null;
    frame.style.pointerEvents = '';
    rect = fit(rect);
    remember();
  };
  hostEl.addEventListener('pointerup', endSizing);
  hostEl.addEventListener('pointercancel', endSizing);
  hostEl.addEventListener('lostpointercapture', endSizing);

  // Moving: the manager's title bar gives the pointer in the frame's coordinates (it keeps the pointer while it moves).
  let moving: { px: number; py: number; r: Rect } | null = null;
  const onPage = (x: number, y: number) => {
    const b = frame.getBoundingClientRect();
    return { px: b.left + x, py: b.top + y };
  };
  const win: Host['win'] = {
    maximized: () => max,
    toggleMaximized() {
      max = !max;
      layout();
      remember();
      win.onChange?.(max);
    },
    dragStart(x, y) {
      moving = { ...onPage(x, y), r: fit(rect) };
    },
    dragTo(x, y) {
      if (!moving) return;
      const p = onPage(x, y);
      if (max) {
        // Dragging a maximized window restores it, under the pointer where its title bar was grabbed.
        if (Math.abs(p.px - moving.px) + Math.abs(p.py - moving.py) < 6) return;
        const r = fit(rect);
        rect = { ...r, x: Math.round(p.px - (moving.px / Math.max(1, page.innerWidth)) * r.w), y: p.py - moving.py };
        max = false;
        layout();
        win.onChange?.(false);
        moving = { ...p, r: fit(rect) };
        return;
      }
      rect = fit({ ...moving.r, x: moving.r.x + p.px - moving.px, y: moving.r.y + p.py - moving.py });
      layout();
    },
    dragEnd() {
      if (!moving) return;
      moving = null;
      remember();
    },
    onChange: null,
  };

  const pillEl = doc.createElement('button');
  pillEl.id = 'wrm-pill';
  pillEl.type = 'button';
  pillEl.textContent = 'Web resources';
  pillEl.title = 'Show Web Resources Manager';
  pillEl.setAttribute(
    'style',
    `all:initial;position:fixed;right:16px;bottom:16px;z-index:${Z};display:none;cursor:pointer;font:600 12px/1 "Segoe UI",system-ui,sans-serif;` +
      'color:#fff;background:#007acc;border-radius:14px;padding:8px 14px;box-shadow:0 2px 8px rgba(0,0,0,.35)',
  );
  (doc.body || doc.documentElement).appendChild(pillEl);

  let app: { busy(): boolean; teardown(): void; shown?(): void } | null = null;
  let unloadGuard = false;
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!unloadGuard) return;
    e.preventDefault();
    e.returnValue = '';
  };
  page.addEventListener('beforeunload', onBeforeUnload);

  const visible = () => hostEl.style.display !== 'none';
  const show = (): boolean => {
    if (!hostEl.isConnected) return false;
    hostEl.style.display = 'block';
    pillEl.style.display = 'none';
    try {
      frame.contentWindow?.focus();
      app?.shown?.();
    } catch {
      /* focus is a nicety */
    }
    return true;
  };
  const minimize = () => {
    if (!hostEl.isConnected) return;
    hostEl.style.display = 'none';
    pillEl.style.display = 'block';
  };
  const remove = () => {
    page.removeEventListener('beforeunload', onBeforeUnload);
    page.removeEventListener('resize', layout);
    hostEl.remove();
    pillEl.remove();
    if (page.__wrManager === inst) delete page.__wrManager;
  };
  const destroy = (): boolean => {
    if (app) {
      try {
        if (app.busy()) return false;
      } catch {
        /* a broken app is torn down */
      }
      try {
        app.teardown();
      } catch {
        /* nothing more can be done for it */
      }
    }
    remove();
    return true;
  };
  pillEl.addEventListener('click', () => void show());
  inst.show = show;
  inst.toggle = () => (!hostEl.isConnected ? false : visible() ? (minimize(), true) : show());
  inst.destroy = destroy;

  const fw = frame.contentWindow as (Window & typeof globalThis) | null;
  const fdoc = frame.contentDocument;
  if (!fw || !fdoc) {
    remove();
    return alert('Web Resources Manager could not open its window on this page.');
  }
  fdoc.open();
  fdoc.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Web Resources Manager</title></head><body></body></html>');
  fdoc.close();

  const host: Host = {
    page,
    key,
    version: __VERSION__,
    build: __BUILD__,
    ready(a) {
      app = a;
      inst.starting = false;
      // The keys go to the manager from the start (the page had the focus when the bookmark was clicked).
      try {
        frame.contentWindow?.focus();
      } catch {
        /* focus is a nicety */
      }
    },
    minimize,
    close: () => destroy(),
    pill(text) {
      pillEl.textContent = text;
    },
    guardUnload(on) {
      unloadGuard = on;
    },
    fail(message) {
      remove();
      alert(message);
    },
    win,
  };
  fw.__wrmHost = host;

  // The app's text is named once only: tools/build.mjs puts it in that one place.
  const APP: string = __APP__;
  try {
    // Indirect eval in the frame's own realm: the manager's globals, styles and editor live in the frame.
    fw.eval(APP);
  } catch (e) {
    if ((e as Error)?.name !== 'EvalError') {
      remove();
      return alert('Web Resources Manager could not start: ' + ((e as Error)?.message || e));
    }
    // The page forbids eval: load the manager as a script from a blob: address instead.
    const s = fdoc.createElement('script');
    s.src = fw.URL.createObjectURL(new fw.Blob([APP], { type: 'text/javascript' }));
    s.onerror = () => host.fail('This page does not allow Web Resources Manager to run.');
    fdoc.head.appendChild(s);
  }
})();

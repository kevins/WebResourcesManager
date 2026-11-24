// Small helpers shared by the widgets: class names, the platform's modifier key, ids and giving the focus back.

/** Joins the class names that are set; falsy ones are skipped. */
export function cx(...names: Array<string | false | null | undefined | 0>): string {
  return names.filter(Boolean).join(' ');
}

const platform = typeof navigator === 'undefined' ? '' : navigator.platform || '';
export const isMac = /Mac|iPhone|iPad/.test(platform);
export const isLinux = /Linux/.test(platform) && !/Android/.test(navigator.userAgent || '');

/** Ctrl, or Cmd on macOS: the key that adds an item to a selection. */
export const ctrlKey = (e: MouseEvent | KeyboardEvent): boolean => (isMac ? e.metaKey : e.ctrlKey);

let seq = 0;
/** An id that is unique in the document, for aria attributes. */
export const uid = (prefix = 'wg'): string => `${prefix}-${++seq}`;

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The element that has the focus now, remembered so a pop-up can give it back when it closes. */
export function focusedElement(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  return a && a !== document.body && typeof a.focus === 'function' ? a : null;
}

/**
 * Gives the focus back to `el` when a pop-up closes, but only while the focus is still in the pop-up (or nowhere):
 * when the user has clicked somewhere else, that place keeps it.
 */
export function restoreFocus(el: HTMLElement | null, popup: Element | null): void {
  if (!el || !el.isConnected) return;
  const a = document.activeElement;
  if (!a || a === document.body || (popup && popup.contains(a))) el.focus({ preventScroll: true });
}

/** Runs a callback given by the caller of a widget; a thrown error is reported instead of breaking the widget. */
export function safeRun(fn: (() => unknown) | undefined): void {
  if (!fn) return;
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch((e) => console.error('[web resources manager]', e));
  } catch (e) {
    console.error('[web resources manager]', e);
  }
}

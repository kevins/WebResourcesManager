// Preact hooks over the manager's signals (core/emitter.ts).

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'preact/hooks';
import type { Signal } from '../core/emitter';

/** The signal's value, re-rendering the component when it changes. */
export function useSignal<T>(s: Signal<T>): T {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => s.subscribe(() => force(0)), [s]);
  return s.value;
}

/** A part of a signal's value, re-rendering only when that part changes (compared with Object.is). */
export function useSelect<T, R>(s: Signal<T>, pick: (v: T) => R): R {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const last = useRef<R>(pick(s.value));
  const pickRef = useRef(pick);
  pickRef.current = pick;
  last.current = pick(s.value);
  useLayoutEffect(
    () =>
      s.subscribe((v) => {
        const next = pickRef.current(v);
        if (!Object.is(next, last.current)) {
          last.current = next;
          force(0);
        }
      }),
    [s],
  );
  return last.current;
}

/** Re-renders every `ms` (relative times: "2 minutes ago"). */
export function useTick(ms: number): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(() => force(0), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** A value that follows `v` after it stopped changing for `ms`. */
export function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** Calls `fn` when a pointer goes down outside `ref` (closing menus and pop-ups). */
export function useOutside(ref: { current: HTMLElement | null }, fn: () => void, on = true): void {
  useEffect(() => {
    if (!on) return;
    const h = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) fn();
    };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [on, fn]);
}

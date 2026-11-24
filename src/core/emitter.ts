// A minimal observable value and event emitter: the manager's state is plain objects in signals, read by the UI with
// useSignal (ui/hooks.ts) and changed only through the services.

export type Listener<T> = (v: T) => void;

export class Emitter<T = void> {
  private ls = new Set<Listener<T>>();
  on(l: Listener<T>): () => void {
    this.ls.add(l);
    return () => this.ls.delete(l);
  }
  emit(v: T): void {
    for (const l of [...this.ls])
      try {
        l(v);
      } catch (e) {
        console.error('[web resources manager]', e);
      }
  }
  clear(): void {
    this.ls.clear();
  }
}

/** A value that tells its readers when it changes (compared with Object.is). */
export class Signal<T> {
  private ev = new Emitter<T>();
  constructor(private v: T) {}
  get value(): T {
    return this.v;
  }
  set value(v: T) {
    if (Object.is(v, this.v)) return;
    this.v = v;
    this.ev.emit(v);
  }
  /** Sets the value from the current one (`s.update((x) => ({ ...x, a: 1 }))`). */
  update(fn: (v: T) => T): void {
    this.value = fn(this.v);
  }
  subscribe(l: Listener<T>): () => void {
    return this.ev.on(l);
  }
}

/** A signal computed from others, recomputed when any of them changes. */
export function computed<T>(deps: Signal<any>[], fn: () => T): Signal<T> {
  const s = new Signal<T>(fn());
  for (const d of deps) d.subscribe(() => (s.value = fn()));
  return s;
}

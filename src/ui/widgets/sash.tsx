// The 4px drag handle between two parts of the workbench (side bar | editor, editor / panel), as VS Code's sash:
// it lights up in the focus colour when hovered for 300 ms and while dragged, and a double click resets the size.
//
// onDrag gets the distance from where the drag started (not from the previous move), so the caller sets
// size = sizeAtStart + delta (or − delta for a handle on the left or top edge) and clamping doesn't drift.
// The caller positions the sash (absolutely, in a positioned parent) with `class` or `style`.

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cx } from './util';

export interface SashProps {
  /** 'vertical': a vertical bar dragged left and right (ew-resize); 'horizontal': dragged up and down. */
  direction: 'vertical' | 'horizontal';
  onStart?: () => void;
  /** Pixels from the drag's starting point (right or down is positive). */
  onDrag: (delta: number) => void;
  onEnd?: () => void;
  /** Double click: back to the default size. */
  onReset?: () => void;
  class?: string;
  style?: JSX.CSSProperties;
}

const HOVER_DELAY_MS = 300;

export function Sash(p: SashProps) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drag = useRef<{ start: number; pointer: number } | null>(null);
  const props = useRef(p);
  props.current = p;
  const vertical = p.direction === 'vertical';
  const rootClass = vertical ? 'wg-sash-dragging-v' : 'wg-sash-dragging-h';

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      document.documentElement.classList.remove('wg-sash-dragging-v', 'wg-sash-dragging-h');
    },
    [],
  );

  const end = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    setActive(false);
    document.documentElement.classList.remove(rootClass);
    props.current.onEnd?.();
  };

  return (
    <div
      class={cx('wg-sash', p.direction, (hover || active) && 'hover', active && 'active', p.class)}
      style={p.style}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: vertical ? e.clientX : e.clientY, pointer: e.pointerId };
        setActive(true);
        // The whole window shows the resize cursor while dragging, and frames under the pointer don't take it.
        document.documentElement.classList.add(rootClass);
        props.current.onStart?.();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.pointer !== e.pointerId) return;
        props.current.onDrag((vertical ? e.clientX : e.clientY) - d.start);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onPointerEnter={() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setHover(true), HOVER_DELAY_MS);
      }}
      onPointerLeave={() => {
        clearTimeout(timer.current);
        setHover(false);
      }}
      onDblClick={() => props.current.onReset?.()}
    />
  );
}

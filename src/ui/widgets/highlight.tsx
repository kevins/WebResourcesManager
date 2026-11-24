// Text with some ranges shown as matches (bold, in the list highlight colour), as in VS Code's filtered lists.

import type { ComponentChildren } from 'preact';

export interface HighlightProps {
  text: string;
  /** [start, end) ranges of matched characters. */
  ranges?: Array<[number, number]>;
  class?: string;
}

export function Highlight({ text, ranges, class: cls }: HighlightProps) {
  if (!ranges || !ranges.length) return <span class={cls}>{text}</span>;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: ComponentChildren[] = [];
  let pos = 0;
  for (const [s0, e0] of sorted) {
    const s = Math.max(pos, s0);
    const e = Math.min(text.length, e0);
    if (e <= s) continue;
    if (s > pos) out.push(text.slice(pos, s));
    out.push(<span class="wg-hl">{text.slice(s, e)}</span>);
    pos = e;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return <span class={cls}>{out}</span>;
}

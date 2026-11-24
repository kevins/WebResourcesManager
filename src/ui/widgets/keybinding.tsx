// A key binding drawn as VS Code draws it in the command palette: one small key cap per key ("Ctrl" "+" "Shift" "+" "P").

import { keyLabel } from '../commands';
import { cx, isMac } from './util';

/** The key caps of one chord of a label made by keyLabel ("Ctrl+Shift+P", or "⌘⇧P" on macOS). */
function keysOf(chord: string): string[] {
  if (!isMac) return chord.split('+').filter(Boolean);
  const out: string[] = [];
  let rest = chord;
  while (rest && '⌘⇧⌥⌃'.includes(rest[0])) {
    out.push(rest[0]);
    rest = rest.slice(1);
  }
  if (rest) out.push(rest);
  return out;
}

export interface KeybindingLabelProps {
  /** A binding as commands use it ('ctrl+shift+p', 'ctrl+k ctrl+s'). */
  binding: string;
  class?: string;
}

export function KeybindingLabel({ binding, class: cls }: KeybindingLabelProps) {
  const chords = keyLabel(binding).split(' ').filter(Boolean);
  return (
    <span class={cx('wg-kb', cls)} aria-label={keyLabel(binding)}>
      {chords.map((c, ci) => (
        <>
          {ci > 0 && <span class="wg-kb-chord-sep" />}
          {keysOf(c).map((k, ki) => (
            <>
              {ki > 0 && !isMac && <span class="wg-kb-sep">+</span>}
              <kbd class="wg-kb-key">{k}</kbd>
            </>
          ))}
        </>
      ))}
    </span>
  );
}

// A codicon: the icon font of VS Code, which Monaco bundles. `name` is the codicon's name ("files", "chevron-right").

import { cx } from './util';

export interface IconProps {
  name: string;
  /** Tooltip and accessible name; without it the icon is decorative and hidden from screen readers. */
  title?: string;
  /** Turns the icon round and round (loading, sync). */
  spin?: boolean;
  class?: string;
}

export function Icon({ name, title, spin, class: cls }: IconProps) {
  return (
    <i
      class={cx('codicon', `codicon-${name}`, spin && 'codicon-modifier-spin wg-spin', cls)}
      title={title}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    />
  );
}

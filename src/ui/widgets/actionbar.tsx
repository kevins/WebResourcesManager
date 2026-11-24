// A row of icon buttons, like the actions in the title bar of a VS Code view or the inline actions of a tree row.

import { cx, safeRun } from './util';

export type Action = {
  id: string;
  /** Codicon name. */
  icon: string;
  /** Tooltip and accessible name; include the key binding when there is one ("Refresh (F5)"). */
  title: string;
  run: () => void;
  disabled?: boolean;
  /** A toggle that is on (shown pressed). */
  checked?: boolean;
  hidden?: boolean;
};

export interface ActionBarProps {
  actions: Action[];
  class?: string;
  /** False keeps the buttons out of the Tab order (inline actions of list rows, which the keyboard reaches otherwise). */
  tabbable?: boolean;
  ariaLabel?: string;
}

export function ActionBar({ actions, class: cls, tabbable = true, ariaLabel }: ActionBarProps) {
  const shown = actions.filter((a) => !a.hidden);
  if (!shown.length) return null;
  return (
    <div class={cx('wg-actionbar', cls)} role="toolbar" aria-label={ariaLabel}>
      {shown.map((a) => (
        <button
          key={a.id}
          type="button"
          class={cx('wg-action', a.checked && 'checked', a.disabled && 'disabled')}
          title={a.title}
          aria-label={a.title}
          aria-pressed={a.checked === undefined ? undefined : a.checked}
          aria-disabled={a.disabled || undefined}
          tabIndex={tabbable ? 0 : -1}
          // The button doesn't take the focus from the list or editor it acts on.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            // A click on an inline action must not also select or open the row it sits in.
            e.stopPropagation();
            if (!a.disabled) safeRun(a.run);
          }}
          onDblClick={(e) => e.stopPropagation()}
        >
          <i class={cx('codicon', `codicon-${a.icon}`)} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

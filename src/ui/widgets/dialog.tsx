// Modal dialogs like VS Code's own (custom) dialogs: centred over a dimmed window, an icon for the kind of message,
// the message in large type, details, an optional checkbox and list, and the buttons on the right in the platform's
// order (Windows: as given, with Cancel last; macOS and Linux: reversed, with Cancel just before the primary button).
// Enter answers with the primary button (or the focused one), Escape with cancelValue; the focus stays inside.
// One dialog at a time: a second one waits until the first is answered.

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Signal } from '../../core/emitter';
import { useSignal } from '../hooks';
import { Button, Checkbox } from './inputs';
import { cx, focusedElement, isLinux, isMac, restoreFocus, uid } from './util';

export interface DialogButton<T extends string> {
  label: string;
  value: T;
  /** The button Enter answers with (the first button when none is marked). */
  primary?: boolean;
  /** Drawn red: the answer deletes or overwrites something. */
  danger?: boolean;
}

export interface ConfirmDialogOptions<T extends string> {
  /** A short caption over the message. */
  title?: string;
  message: string;
  detail?: string | ComponentChildren;
  type?: 'info' | 'warning' | 'error' | 'question';
  buttons: Array<DialogButton<T>>;
  /** The answer for Escape and the close button. */
  cancelValue: T;
  checkbox?: { label: string; checked?: boolean };
  /** Names the answer affects, in a scrollable box. */
  list?: string[];
}

export interface DialogResult<T extends string> {
  value: T;
  /** The checkbox's state (false when there is none). */
  checked: boolean;
}

interface DialogRequest {
  id: number;
  o: ConfirmDialogOptions<string>;
  done: (r: DialogResult<string>) => void;
}

const queue = new Signal<DialogRequest[]>([]);
/** True while a dialog is open (the workbench's keys stand still meanwhile). */
export const modalOpen = new Signal<boolean>(false);
let restoreTo: HTMLElement | null = null;
let dialogEl: HTMLElement | null = null;
let seq = 0;

export function confirmDialog<T extends string>(o: ConfirmDialogOptions<T>): Promise<DialogResult<T>> {
  return new Promise((resolve) => {
    if (!queue.value.length) restoreTo = focusedElement();
    queue.value = [...queue.value, { id: ++seq, o, done: resolve as (r: DialogResult<string>) => void }];
    modalOpen.value = true;
  });
}

function answer(req: DialogRequest, value: string, checked: boolean): void {
  const q = queue.value;
  if (q[0] !== req) return;
  const rest = q.slice(1);
  queue.value = rest;
  if (!rest.length) {
    modalOpen.value = false;
    const back = restoreTo;
    restoreTo = null;
    restoreFocus(back, dialogEl);
  }
  req.done({ value, checked });
}

/** The buttons in the order VS Code shows them on this platform (dialog.ts, rearrangeButtons). */
function inPlatformOrder<B extends { value: string }>(buttons: B[], cancelValue: string): B[] {
  const list = buttons.slice();
  if (list.length < 2) return list;
  const ci = list.findIndex((b) => b.value === cancelValue);
  if (isMac || isLinux) {
    if (ci >= 0) list.splice(1, 0, list.splice(ci, 1)[0]);
    list.reverse();
  } else if (ci >= 0) list.push(list.splice(ci, 1)[0]);
  return list;
}

const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea, a[href]';
const focusables = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.offsetParent !== null || e === document.activeElement);

/** Renders the open dialog; mounted once by <Layers/>. */
export function DialogLayer() {
  const q = useSignal(queue);
  const req = q[0];
  return req ? <DialogView key={req.id} req={req} /> : null;
}

const ICONS = { info: 'info', warning: 'warning', error: 'error', question: 'question' } as const;

function DialogView({ req }: { req: DialogRequest }) {
  const o = req.o;
  const ref = useRef<HTMLDivElement>(null);
  const [checked, setChecked] = useState(!!o.checkbox?.checked);
  const checkedRef = useRef(checked);
  checkedRef.current = checked;
  const ids = useMemo(() => ({ message: uid('dialog'), detail: uid('dialog') }), []);
  const primary = o.buttons.find((b) => b.primary) ?? o.buttons[0];
  const type = o.type ?? 'info';
  const close = (v: string) => answer(req, v, checkedRef.current);

  useLayoutEffect(() => {
    dialogEl = ref.current;
    const btn = ref.current!.querySelector<HTMLElement>('.wg-dialog-primary');
    (btn ?? ref.current!).focus({ preventScroll: true });
    return () => {
      if (dialogEl === ref.current) dialogEl = null;
    };
  }, []);

  // The focus can't leave the dialog (a click elsewhere, a script focusing the editor): it is brought back. Not once
  // the dialog is answered, when the focus goes back to where it was before.
  useLayoutEffect(() => {
    const h = (e: FocusEvent) => {
      const el = ref.current;
      if (queue.value[0] !== req) return;
      if (el && !el.contains(e.target as Node)) (el.querySelector<HTMLElement>('.wg-dialog-primary') ?? el).focus({ preventScroll: true });
    };
    document.addEventListener('focusin', h, true);
    return () => document.removeEventListener('focusin', h, true);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close(o.cancelValue);
    else if (e.key === 'Enter') {
      // A focused button answers for itself (its click follows).
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      if (primary) close(primary.value);
    } else if (e.key === 'Tab') {
      const f = focusables(ref.current!);
      if (f.length) {
        const i = f.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i < 0 || i === f.length - 1 ? 0 : i + 1;
        f[next].focus();
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      class="wg-dialog-block"
      // Clicks on the dimmed window do nothing (and don't take the focus from the dialog).
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        ref={ref}
        class={cx('wg-dialog', `type-${type}`)}
        role={type === 'warning' || type === 'error' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={ids.message}
        aria-describedby={o.detail ? ids.detail : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div class="wg-dialog-toolbar">
          {o.title && <span class="wg-dialog-title">{o.title}</span>}
          <button type="button" class="wg-action" title="Close" aria-label="Close" onClick={() => close(o.cancelValue)}>
            <i class="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
        <div class="wg-dialog-message-row">
          <i class={cx('wg-dialog-icon', 'codicon', `codicon-${ICONS[type]}`)} aria-hidden="true" />
          <div class="wg-dialog-message-container">
            <div class="wg-dialog-message" id={ids.message}>
              {o.message}
            </div>
            {o.detail != null && o.detail !== '' && (
              <div class="wg-dialog-detail" id={ids.detail}>
                {o.detail}
              </div>
            )}
            {o.list && o.list.length > 0 && (
              <div class="wg-dialog-list wg-scroll" tabIndex={0} role="list" aria-label="Affected items">
                {o.list.map((s, i) => (
                  <div key={i} class="wg-dialog-list-item" role="listitem" title={s}>
                    {s}
                  </div>
                ))}
              </div>
            )}
            {o.checkbox && (
              <div class="wg-dialog-checkbox-row">
                <Checkbox checked={checked} onChange={setChecked} label={o.checkbox.label} />
              </div>
            )}
          </div>
        </div>
        <div class="wg-dialog-buttons-row">
          <div class="wg-dialog-buttons">
            {inPlatformOrder(o.buttons, o.cancelValue).map((b) => (
              <Button
                key={b.value}
                kind={b.danger ? 'danger' : b === primary ? 'primary' : 'secondary'}
                class={b === primary ? 'wg-dialog-primary' : undefined}
                onClick={() => close(b.value)}
              >
                {b.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

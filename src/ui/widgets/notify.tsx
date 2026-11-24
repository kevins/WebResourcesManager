// Notifications like VS Code's: toasts at the bottom right (at most 3; the newest at the bottom), and the
// notification centre listing all of them. Info toasts without actions hide after 10 seconds (not while the pointer
// or the focus is on them); warnings, errors, sticky ones and those with progress stay until closed. Every
// notification stays in the centre until it is closed or cleared. While the centre is open, no toasts are shown.

import { useState } from 'preact/hooks';
import { Signal } from '../../core/emitter';
import { useSignal } from '../hooks';
import { ActionBar } from './actionbar';
import { Button, ProgressBar } from './inputs';
import { cx, safeRun } from './util';

export type Severity = 'info' | 'warning' | 'error';

export interface NoteAction {
  label: string;
  run: () => void;
  /** Drawn as the primary button (the first action is, when none is marked). */
  primary?: boolean;
}

export interface NoteOptions {
  severity: Severity;
  message: string;
  /** More text, shown when the notification is expanded (the chevron). */
  detail?: string;
  /** Buttons; running one closes the notification. */
  actions?: NoteAction[];
  /** Never hides by itself. */
  sticky?: boolean;
  /** true: a running bar; a number: done percentage (0..100). */
  progress?: boolean | number;
  /** Who reports it ("Dataverse", "Publish"). */
  source?: string;
}

export interface Note extends NoteOptions {
  readonly id: number;
  /** When it was reported (ms since the epoch). */
  readonly time: number;
}

export interface NoteHandle {
  update(p: Partial<NoteOptions>): void;
  close(): void;
}

/** Every notification, newest first (for the notification centre). */
export const notifications = new Signal<Note[]>([]);
/** The notifications shown as toasts now, newest first. */
export const toasts = new Signal<Note[]>([]);
/** Whether the notification centre is open. */
export const showCenter = new Signal<boolean>(false);

const MAX_TOASTS = 3;
const HIDE_AFTER_MS = 10_000;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
/** Toasts under the pointer: they don't hide meanwhile. */
const held = new Set<number>();
let nextId = 0;

const busy = (n: NoteOptions) => n.progress === true || (typeof n.progress === 'number' && n.progress < 100);
const hidesByItself = (n: NoteOptions) => n.severity === 'info' && !n.actions?.length && !n.sticky && !busy(n);

function stopTimer(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
}

function hasFocus(id: number): boolean {
  const el = document.querySelector(`.wg-toasts [data-note="${id}"]`);
  return !!el && el.contains(document.activeElement);
}

function startTimer(n: Note): void {
  stopTimer(n.id);
  if (!hidesByItself(n)) return;
  timers.set(
    n.id,
    setTimeout(() => {
      timers.delete(n.id);
      const cur = toasts.value.find((t) => t.id === n.id);
      if (!cur) return;
      // Still being read: wait another round, as VS Code does.
      if (held.has(n.id) || hasFocus(n.id)) startTimer(cur);
      else hideToast(n.id);
    }, HIDE_AFTER_MS),
  );
}

function update(id: number, p: Partial<NoteOptions>): void {
  const cur = notifications.value.find((n) => n.id === id);
  if (!cur) return;
  const next: Note = { ...cur, ...p, id: cur.id, time: cur.time };
  notifications.value = notifications.value.map((n) => (n.id === id ? next : n));
  if (toasts.value.some((t) => t.id === id)) {
    toasts.value = toasts.value.map((t) => (t.id === id ? next : t));
    if (!hidesByItself(next)) stopTimer(id);
    else if (!timers.has(id)) startTimer(next);
  }
}

function close(id: number): void {
  stopTimer(id);
  held.delete(id);
  notifications.value = notifications.value.filter((n) => n.id !== id);
  toasts.value = toasts.value.filter((n) => n.id !== id);
}

/** Takes a toast off the screen; its notification stays in the centre. */
function hideToast(id: number): void {
  stopTimer(id);
  held.delete(id);
  toasts.value = toasts.value.filter((n) => n.id !== id);
}

/** Shows a notification; the handle updates it (progress, message) or closes it. */
export function notify(o: NoteOptions): NoteHandle {
  const note: Note = { ...o, id: ++nextId, time: Date.now() };
  notifications.value = [note, ...notifications.value];
  if (!showCenter.value) {
    const shown = [note, ...toasts.value];
    // Only the 3 newest are toasts; older ones are still in the centre.
    for (const old of shown.slice(MAX_TOASTS)) stopTimer(old.id);
    toasts.value = shown.slice(0, MAX_TOASTS);
    startTimer(note);
  }
  return { update: (p) => update(note.id, p), close: () => close(note.id) };
}

/** Closes every notification (the centre's Clear All). */
export function clearAll(): void {
  for (const id of [...timers.keys()]) stopTimer(id);
  held.clear();
  notifications.value = [];
  toasts.value = [];
}

// Opening the centre hides the toasts: their notifications are in it.
showCenter.subscribe((open) => {
  if (!open) return;
  for (const t of toasts.value) stopTimer(t.id);
  toasts.value = [];
});

const SEVERITY_LABEL: Record<Severity, string> = { info: 'Info', warning: 'Warning', error: 'Error' };

function NoteView({ note, toast }: { note: Note; toast?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const actions = note.actions ?? [];
  const marked = actions.some((a) => a.primary);
  const hold = (on: boolean) => {
    if (!toast) return;
    if (on) held.add(note.id);
    else held.delete(note.id);
  };
  return (
    <div
      class={cx('wg-note', `sev-${note.severity}`, expanded && 'expanded', toast && 'toast')}
      data-note={note.id}
      role={note.severity === 'error' ? 'alert' : 'status'}
      tabIndex={0}
      aria-label={`${SEVERITY_LABEL[note.severity]}: ${note.message}${note.source ? ` Source: ${note.source}.` : ''}`}
      onMouseEnter={() => hold(true)}
      onMouseLeave={() => hold(false)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // As in VS Code: Delete clears the notification, Escape only hides the toast.
        if (e.key === 'Delete') close(note.id);
        else if (e.key === 'Escape' && toast) hideToast(note.id);
        else if (note.detail && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) setExpanded(e.key === 'ArrowRight');
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div class="wg-note-main">
        <i class={cx('wg-note-icon', 'codicon', `codicon-${note.severity}`)} aria-hidden="true" />
        <div class="wg-note-message">{note.message}</div>
        <div class="wg-note-toolbar">
          {note.detail && (
            <button
              type="button"
              class="wg-action"
              title={expanded ? 'Collapse Notification' : 'Expand Notification'}
              aria-label={expanded ? 'Collapse Notification' : 'Expand Notification'}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              <i class={cx('codicon', expanded ? 'codicon-chevron-down' : 'codicon-chevron-up')} aria-hidden="true" />
            </button>
          )}
          <button type="button" class="wg-action" title="Clear Notification" aria-label="Clear Notification" onClick={() => close(note.id)}>
            <i class="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
      </div>
      {expanded && note.detail && <div class="wg-note-detail">{note.detail}</div>}
      {(note.source || actions.length > 0) && (
        <div class="wg-note-details-row">
          <div class="wg-note-source" title={note.source}>
            {note.source ? `Source: ${note.source}` : ''}
          </div>
          {actions.length > 0 && (
            <div class="wg-note-buttons">
              {actions.map((a, i) => (
                <Button
                  key={i}
                  kind={a.primary || (!marked && i === 0) ? 'primary' : 'secondary'}
                  onClick={() => {
                    close(note.id);
                    safeRun(a.run);
                  }}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
      {note.progress !== undefined && note.progress !== false && (
        <ProgressBar active class="wg-note-progress" value={typeof note.progress === 'number' ? note.progress : undefined} />
      )}
    </div>
  );
}

function NotificationCenter() {
  const all = useSignal(notifications);
  const hide = () => (showCenter.value = false);
  return (
    <div
      class="wg-notify-center"
      role="dialog"
      aria-label="Notifications"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        hide();
      }}
    >
      <div class="wg-notify-center-header">
        <span class="wg-notify-center-title">{all.length ? 'Notifications' : 'No New Notifications'}</span>
        <ActionBar
          class="wg-notify-center-actions"
          actions={[
            { id: 'clear', icon: 'clear-all', title: 'Clear All Notifications', run: clearAll, disabled: !all.length },
            { id: 'hide', icon: 'chevron-down', title: 'Hide Notifications', run: hide },
          ]}
        />
      </div>
      {all.length > 0 && (
        <div class="wg-notify-center-list wg-scroll">
          {all.map((n) => (
            <NoteView key={n.id} note={n} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Renders the toasts and the notification centre; mounted once by <Layers/>. */
export function NotificationsLayer() {
  const shown = useSignal(toasts);
  const center = useSignal(showCenter);
  if (center) return <NotificationCenter />;
  if (!shown.length) return null;
  return (
    <div class="wg-toasts" role="region" aria-label="Notifications">
      {shown.map((n) => (
        <div key={n.id} class="wg-toast">
          <NoteView note={n} toast />
        </div>
      ))}
    </div>
  );
}

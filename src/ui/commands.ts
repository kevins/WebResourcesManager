// Commands and keyboard shortcuts, as in VS Code: every action of the manager is a command with an id, a title and an
// optional key binding; the command palette (F1 / Ctrl+Shift+P), menus, buttons and keys all run commands by id.
// Keys are listened for on the manager's frame in the capture phase, so they work while the editor has the focus.
// Browser-reserved keys (Ctrl+W, Ctrl+F4, Ctrl+T, Ctrl+N, Ctrl+Tab) can't be taken by a page: their commands use VS
// Code's other keys (Alt+PageDown…, Ctrl+K W) or none (Close Editor: the tab's close button). A character typed with
// AltGr (which Windows reports as Ctrl+Alt) is never taken for a shortcut, so no command binds Ctrl+Alt+<letter>
// outside macOS: Save All is VS Code's Ctrl+K S there.
// Chords (Ctrl+K W) are the workbench's; the code editor has its own on the same first key (Ctrl+K Ctrl+C comments a
// line), so a chord the workbench doesn't bind is handed to the editor when its second key is typed there.

export interface Command {
  id: string;
  title: string;
  /** Palette group shown before the title ("File", "Publish", "View"…). */
  category?: string;
  /** e.g. 'ctrl+s', 'ctrl+shift+p', 'ctrl+k ctrl+s' (a chord). 'ctrl' is Cmd on macOS. */
  key?: string;
  /** Only shown in the palette and run by its key while this is true. */
  when?: () => boolean;
  /** Runs the command; a thrown error or rejected promise is shown as a notification. */
  run: (arg?: unknown) => unknown;
  /** Hidden from the palette (internal commands run by buttons and menus). */
  hidden?: boolean;
  /** The key also works while a text field (not the editor) has the focus; chords always do. */
  inInputs?: boolean;
}

/** A key as it was pressed, enough to press it again for the code editor. */
interface PressedKey {
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const commands = new Map<string, Command>();
let onError: (e: unknown, c: Command) => void = (e) => console.error(e);
let chordFirst = '';
/** The first key of the pending chord as it was pressed. */
let chordKey: PressedKey | null = null;
let chordTimer: ReturnType<typeof setTimeout> | 0 = 0;
let onChord: (pending: string, unbound?: string) => void = () => {};
/** True while a key is pressed again for the code editor: the listener lets it pass. */
let replaying = false;
let version = 0;

export function registerCommand(c: Command): () => void {
  commands.set(c.id, c);
  version++;
  return () => {
    if (commands.get(c.id) !== c) return;
    commands.delete(c.id);
    version++;
  };
}

export const registerCommands = (cs: Command[]) => {
  const offs = cs.map(registerCommand);
  return () => offs.forEach((f) => f());
};

export const getCommand = (id: string) => commands.get(id);

/** Every command the palette can show now. */
export const paletteCommands = () => [...commands.values()].filter((c) => !c.hidden && (!c.when || safeWhen(c)));

/** Every registered command, hidden ones and ones whose `when` is false now included (the list of shortcuts). */
export const allCommands = () => [...commands.values()];

/** Changes each time a command is registered or removed: a list built from the commands is current until then. */
export const commandsVersion = () => version;

function safeWhen(c: Command): boolean {
  try {
    return !c.when || c.when();
  } catch {
    return false;
  }
}

export async function runCommand(id: string, arg?: unknown): Promise<unknown> {
  const c = commands.get(id);
  if (!c) throw new Error(`Unknown command: ${id}`);
  if (!safeWhen(c)) return undefined;
  try {
    return await c.run(arg);
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') onError(e, c);
    return undefined;
  }
}

export function setCommandErrorHandler(h: (e: unknown, c: Command) => void): void {
  onError = h;
}

/**
 * Called with the first half of a chord while the second is awaited ('' when it ends), for the status bar. When the
 * chord typed is no command (outside the code editor, which answers its own), it ends with that chord as `unbound`
 * ('ctrl+k ctrl+s'): VS Code says "The key combination (Ctrl+K, Ctrl+S) is not a command."
 */
export function setChordListener(l: (pending: string, unbound?: string) => void): void {
  onChord = l;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');

/** Keys that only modify another: pressed on their own they are no shortcut and don't end a chord. */
const MODIFIERS = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'];

/** Keys named by their place on the keyboard rather than by what they type (as letters and digits are). */
const CODE_NAMES = new Map([
  ['Backquote', '`'],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/'],
  ['Backslash', '\\'],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
]);

/**
 * True when the key typed a character with AltGr: that is typing, not a shortcut. Windows reports AltGr as Ctrl+Alt
 * (and the left Ctrl+Alt types what AltGr types), so a Ctrl+Alt key that gave another character than the key's own (ś
 * for S on a Polish keyboard, ö for P on US International, { for 7 on a German one) or began one (a dead key) was
 * typed, as VS Code reads it. `own` is the key's own name ('' when its place doesn't name it). macOS has no AltGr: ⌥
 * types characters only without ⌘, and its bindings all hold ⌘.
 */
function typedWithAltGr(e: KeyboardEvent, own: string): boolean {
  if (isMac) return false;
  try {
    if (e.getModifierState?.('AltGraph')) return true;
  } catch {
    /* an event without modifier states */
  }
  if (!e.ctrlKey || !e.altKey || e.metaKey) return false;
  if (e.key === 'Dead') return true;
  return !!own && [...e.key].length === 1 && e.key.toLowerCase() !== own;
}

/**
 * The binding string of a key event, e.g. 'ctrl+shift+p' (Cmd counts as ctrl on macOS); '' for a modifier alone and
 * for a character typed with AltGr (which runs no command).
 */
export function eventKey(e: KeyboardEvent): string {
  // A browser's autofill sends keydown events without a key.
  const k = typeof e.key === 'string' ? e.key : '';
  if (!k || MODIFIERS.includes(k)) return '';
  // Letters and digits by their place: Ctrl+S is Ctrl+S on every keyboard layout (a Russian one types ы there).
  const code = e.code || '';
  const own = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit\d$/.test(code) ? code.slice(5) : (CODE_NAMES.get(code) ?? '');
  if (typedWithAltGr(e, own)) return '';
  let name = own || k.toLowerCase();
  if (name === ' ') name = 'space';
  if (name === 'arrowup') name = 'up';
  if (name === 'arrowdown') name = 'down';
  if (name === 'arrowleft') name = 'left';
  if (name === 'arrowright') name = 'right';
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  return [ctrl && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', isMac && e.ctrlKey && 'meta', name].filter(Boolean).join('+');
}

/** Shows a binding the way VS Code does: Ctrl+Shift+P, ⌘⇧P on macOS. */
export function keyLabel(binding?: string): string {
  if (!binding) return '';
  return binding
    .split(' ')
    .map((part) =>
      part
        .split('+')
        .map((p) => {
          if (isMac) return ({ ctrl: '⌘', shift: '⇧', alt: '⌥', meta: '⌃' } as Record<string, string>)[p] ?? cap(p);
          return ({ ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Meta' } as Record<string, string>)[p] ?? cap(p);
        })
        .join(isMac ? '' : '+'),
    )
    .join(' ');
}

const cap = (p: string) => (p.length === 1 ? p.toUpperCase() : p === 'pagedown' ? 'PageDown' : p === 'pageup' ? 'PageUp' : p === 'escape' ? 'Esc' : p[0].toUpperCase() + p.slice(1));

const inEditor = (t: EventTarget | null): boolean => !!(t as HTMLElement | null)?.closest?.('.monaco-editor');

function isTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  // The editor's own hidden textarea is not a "text field" here: global keys work in the editor.
  if (inEditor(el)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/**
 * Presses a key again on `target` (inside a code editor), for the editor's own key handling: Monaco listens on the
 * editor and reads the legacy keyCode, which a constructed event only has when it is set on it.
 */
function pressAgain(win: Window, target: EventTarget, k: PressedKey): void {
  const Ctor = (win as unknown as { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent ?? KeyboardEvent;
  const init = { key: k.key, code: k.code, keyCode: k.keyCode, ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, altKey: k.altKey, metaKey: k.metaKey, bubbles: true, cancelable: true, composed: true };
  const ev = new Ctor('keydown', init);
  if (ev.keyCode !== k.keyCode) Object.defineProperty(ev, 'keyCode', { get: () => k.keyCode });
  replaying = true;
  try {
    target.dispatchEvent(ev);
  } finally {
    replaying = false;
  }
}

/**
 * Listens for key bindings on `win` (the manager's frame). Returns the function that stops listening.
 * `blocked()` true (a modal dialog is open) lets every key through to the dialog.
 */
export function listenKeys(win: Window, blocked: () => boolean): () => void {
  const endChord = (unbound?: string) => {
    chordFirst = '';
    chordKey = null;
    if (chordTimer) clearTimeout(chordTimer);
    chordTimer = 0;
    onChord('', unbound);
  };
  const stop = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handler = (e: KeyboardEvent) => {
    if (replaying) return;
    if (blocked()) {
      // A dialog has the keyboard: a chord begun before it opened is over.
      if (chordFirst) endChord();
      return;
    }
    const key = e.isComposing ? '' : eventKey(e);
    if (!key) {
      // Typing (a character with AltGr, an input method's) ends a chord as any other key does, and is typed: Ctrl+C
      // a moment later is Copy again, not the second key of the chord.
      if (chordFirst && typeof e.key === 'string' && e.key && !MODIFIERS.includes(e.key)) endChord();
      return;
    }
    if (chordFirst) {
      const first = chordKey;
      const full = `${chordFirst} ${key}`;
      const c = [...commands.values()].find((x) => x.key === full && safeWhen(x));
      // Typed in the code editor, a chord no command has is the editor's (Ctrl+K Ctrl+C comments the line, Ctrl+K
      // Ctrl+0 folds everything…): the editor gets the first key now and this one after it, and runs what it binds to
      // them, or nothing, as VS Code does.
      const toEditor = !c && !!first && inEditor(e.target);
      // Elsewhere a shortcut that ends no chord is not run on its own (Ctrl+K Ctrl+S is not Save) nor left to the
      // browser; any other key does what it does without a chord (it types a letter in a text field).
      const unbound = !c && !toEditor && (e.ctrlKey || e.altKey || e.metaKey);
      endChord(unbound ? full : undefined);
      if (c) {
        stop(e);
        void runCommand(c.id);
        return;
      }
      if (toEditor) {
        pressAgain(win, e.target!, first!);
        return;
      }
      if (unbound) {
        stop(e);
        return;
      }
    }
    // The first key of a chord. It starts one in a text field too: Ctrl+K types nothing there.
    if ([...commands.values()].some((x) => x.key?.startsWith(key + ' ') && safeWhen(x))) {
      chordFirst = key;
      chordKey = { key: e.key, code: e.code, keyCode: e.keyCode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey };
      onChord(key);
      chordTimer = setTimeout(endChord, 3000);
      stop(e);
      return;
    }
    const inInput = isTextField(e.target);
    const c = [...commands.values()].find((x) => x.key === key && safeWhen(x) && (!inInput || x.inInputs));
    if (!c) return;
    stop(e);
    void runCommand(c.id);
  };
  win.addEventListener('keydown', handler, true);
  return () => {
    win.removeEventListener('keydown', handler, true);
    if (chordFirst) endChord();
  };
}

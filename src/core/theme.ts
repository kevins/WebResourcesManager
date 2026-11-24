// The theme the manager was last shown in, kept in the page's own storage (read at once, unlike the settings in
// IndexedDB): the window and the screen open in it from the first moment, never dark first and light a moment later.

export type ThemeName = 'dark' | 'light' | 'hc' | 'auto';

const KEY = 'wrm.theme';
const NAMES: ThemeName[] = ['dark', 'light', 'hc', 'auto'];

/** The theme remembered for this environment ('dark' when none). */
export function cachedTheme(win: Window): ThemeName {
  try {
    const t = win.localStorage.getItem(KEY) as ThemeName | null;
    return t && NAMES.includes(t) ? t : 'dark';
  } catch {
    return 'dark';
  }
}

export function rememberTheme(win: Window, t: ThemeName): void {
  try {
    if (win.localStorage.getItem(KEY) !== t) win.localStorage.setItem(KEY, t);
  } catch {
    /* storage blocked: the screen starts dark, then follows the settings */
  }
}

/** The theme in effect: 'auto' follows the system's. */
export const resolveTheme = (t: ThemeName, win: Window): Exclude<ThemeName, 'auto'> => (t === 'auto' ? (win.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t);

/** The editor's background in each theme (VS Code's Dark+, Light+, High Contrast). */
export const THEME_BACKGROUND: Record<Exclude<ThemeName, 'auto'>, string> = { dark: '#1e1e1e', light: '#ffffff', hc: '#000000' };

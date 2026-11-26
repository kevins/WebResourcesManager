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

/**
 * The screen's colours in each theme (VS Code's Dark+, Light+, High Contrast; ui/theme.css has them all): what the
 * bootstrap paints before the manager's stylesheet is there, so the window looks like the screen from its first moment.
 */
export const SHELL_COLORS: Record<Exclude<ThemeName, 'auto'>, { editor: string; sidebar: string; titlebar: string; title: string; muted: string; border: string; input: string; inputBorder: string; focus: string }> = {
  dark: { editor: '#1e1e1e', sidebar: '#252526', titlebar: '#3c3c3c', title: '#cccccc', muted: 'rgba(204,204,204,0.7)', border: 'rgba(128,128,128,0.35)', input: '#3c3c3c', inputBorder: 'transparent', focus: '#007fd4' },
  light: { editor: '#ffffff', sidebar: '#f3f3f3', titlebar: '#dddddd', title: '#333333', muted: 'rgba(97,97,97,0.85)', border: 'rgba(128,128,128,0.35)', input: '#ffffff', inputBorder: '#cecece', focus: '#0090f1' },
  hc: { editor: '#000000', sidebar: '#000000', titlebar: '#000000', title: '#ffffff', muted: '#ffffff', border: '#6fc3df', input: '#000000', inputBorder: '#6fc3df', focus: '#f38518' },
};

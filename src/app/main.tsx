// The manager, inside its frame (src/boot/bootstrap.ts runs this text there): connects to the environment of the
// page, restores this browser's workspace for it, and renders the screen (ui/simple.tsx): the scripts of the form the
// page shows, or of a solution, and the editor.

import { render } from 'preact';
import type { Host } from '../boot/bootstrap';
import { connect, where } from '../core/connect';
import { Signal } from '../core/emitter';
import { cachedTheme, resolveTheme } from '../core/theme';
import { plural } from '../core/util';
import { explain } from '../dataverse/common';
import { Workspace } from '../model/workspace';
import { registerIntelliSense } from '../editor/intellisense';
import { registerFormatting } from '../editor/formatprovider';
import { registerJsNavigation } from '../editor/jsnav';
import { monaco } from '../editor/monaco';
import '../ui/theme.css';
import { formXmlOf, getFormXml, type FormXml } from '../dataverse/forms';
import { pageFormOf } from '../core/pageform';
import { createApp, Shell, SimpleApp } from '../ui/simple';

declare global {
  interface Window {
    __wrmHost?: Host;
  }
}

function Splash({ text, error, onClose }: { text: string; error?: boolean; onClose?: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '18px', color: 'var(--fg)', background: 'var(--editor-bg)', font: '13px var(--font)' }}>
      <i class="codicon codicon-code" style={{ fontSize: '64px', opacity: 0.25 }} />
      <div style={{ maxWidth: '560px', textAlign: 'center', lineHeight: 1.6, color: error ? 'var(--error)' : 'var(--fg-muted)' }}>{text}</div>
      {!error && <div style={{ width: '220px', height: '2px', overflow: 'hidden', background: 'rgba(128,128,128,.2)' }}><div style={{ width: '40%', height: '100%', background: 'var(--focus)', animation: 'wrm-progress 1.2s linear infinite' }} /></div>}
      {onClose && (
        <button style={{ padding: '4px 14px', background: 'var(--button-bg)', color: 'var(--button-fg)', border: 0, borderRadius: '2px', cursor: 'pointer' }} onClick={onClose}>
          Close
        </button>
      )}
      <style>{'@keyframes wrm-progress{from{transform:translateX(-100%)}to{transform:translateX(250%)}}'}</style>
    </div>
  );
}

/** Loads the codicon font from the stylesheet's data: address when the page's policy blocked it (font-src). */
async function ensureIconFont(): Promise<void> {
  try {
    await document.fonts.ready;
    if (document.fonts.check('16px codicon')) return;
    const css = document.getElementById('wrm-css')?.textContent || '';
    const m = /font-family:\s*["']?codicon["']?[^}]*?src:\s*url\((["']?)(data:[^)"']+)\1\)/s.exec(css);
    if (!m) return;
    const bytes = Uint8Array.from(atob(m[2].slice(m[2].indexOf(',') + 1)), (c) => c.charCodeAt(0));
    const face = new FontFace('codicon', bytes);
    await face.load();
    document.fonts.add(face);
  } catch {
    /* icons stay blank; everything else works */
  }
}

async function start(): Promise<void> {
  const host = window.__wrmHost;
  // The theme it was last shown in, from the first moment (the settings, in IndexedDB, are read a moment later).
  const theme = cachedTheme(window);
  document.documentElement.dataset.theme = resolveTheme(theme, window);
  if (!host) {
    render(<Splash text="Web Resources Manager runs from its bookmark on a Dynamics 365 or Power Apps page." error />, document.body);
    return;
  }
  const w = where(host.page);
  // The screen's layout from now on, as the bootstrap painted it: connecting, then the form's scripts fill it in place.
  const hw = host.win;
  const shell = (text: string, error = false) =>
    render(
      <Shell
        env={host.page.location.host}
        text={text}
        error={error}
        maximized={!!hw?.maximized()}
        onMinimize={() => host.minimize()}
        onMaximize={hw ? () => (hw.toggleMaximized(), shell(text, error)) : undefined}
        onClose={() => host.close()}
      />,
      document.body,
    );
  document.getElementById('wrm-skel')?.remove();
  shell(`Connecting to ${host.page.location.host}…`);
  void ensureIconFont();
  let ws: Workspace;
  // The page's form is read as soon as the environment is known, beside the connection's own reads.
  let earlyForm: { formId: string; form: Promise<FormXml> } | null = null;
  try {
    const conn = await connect(host.page, w, {
      early: host.early,
      verified: (http, xrm, early) => {
        const id = pageFormOf(xrm).formId;
        if (!id) return;
        // Read by the bootstrap already, mostly (read again here if that read failed).
        const row = early?.form?.formId === id ? early.form.row : null;
        const form = row ? row.then((r) => (r ? formXmlOf(id, r) : getFormXml(http, id))) : getFormXml(http, id);
        form.catch(() => undefined); // read again by the screen, which says why when it fails
        earlyForm = { formId: id, form };
      },
    });
    host.early = null;
    ws = new Workspace(conn);
  } catch (e) {
    shell(`Web Resources Manager could not connect: ${explain(e)}`, true);
    host.ready({ busy: () => false, teardown: () => render(null, document.body) });
    return;
  }
  ws.settings.value = { ...ws.settings.value, theme };
  // The window over the page: its title bar (in the screen) moves and maximizes it.
  const maximized = new Signal(hw ? hw.maximized() : false);
  if (hw) hw.onChange = (m) => (maximized.value = m);
  const frame = hw ? { maximized, toggleMaximized: () => hw.toggleMaximized(), dragStart: (x: number, y: number) => hw.dragStart(x, y), dragTo: (x: number, y: number) => hw.dragTo(x, y), dragEnd: () => hw.dragEnd() } : undefined;
  // The page's form starts being read here (App), while the editor loads and the unsaved changes are restored.
  const app = createApp(ws, { minimize: () => host.minimize(), close: () => host.close(), frame }, earlyForm);
  await Promise.all([app.host.ready(), ws.restore()]);
  // IntelliSense follows the file being edited (its tables' columns).
  const intellisense = registerIntelliSense(ws, () => ws.describe(app.active.value)?.name || '');
  // F12, Shift+F12, F2 in scripts (across the form's scripts), Shift+Alt+F in every text file.
  const navigation = registerJsNavigation({ models: () => app.scriptModels() });
  const formatting = registerFormatting();
  // Go to Definition into another script shows it in the manager (the editor alone can't open a file).
  const opener = monaco.editor.registerEditorOpener({
    openCodeEditor: (_source, resource, at) => {
      if (!at) return app.openAt(resource, { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 });
      const range = 'startLineNumber' in at ? at : { startLineNumber: at.lineNumber, startColumn: at.column, endLineNumber: at.lineNumber, endColumn: at.column };
      return app.openAt(resource, range);
    },
  });
  render(<SimpleApp app={app} />, document.body);
  // Another manager tab's change of a draft is compared with everything typed here, also the last 250 ms.
  ws.flushTyping = (keys) => app.host.flush(keys);
  // The saved versions of the files opened stay in the content cache.
  ws.pinnedKeys = () => [...app.opened];
  let closed = false;
  /**
   * Keeps everything typed: the editors' last typing becomes a draft, and every draft write waiting (and the features'
   * own, see ws.onFlush) starts now. A write started here is kept even when the frame or the page is gone a moment
   * later (core/idb.ts); one started after that is lost.
   */
  const keepTyping = (): Promise<void> => {
    if (closed) return Promise.resolve();
    try {
      app.host.flush();
    } catch {
      /* a broken editor must not keep the drafts from being written */
    }
    return ws.flushDrafts();
  };
  // Leaving the page (reload, another address, closing the tab) or switching away right after typing keeps the edit.
  addEventListener('pagehide', () => void keepTyping());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void keepTyping();
  });
  host.ready({
    busy: () => ws.busy(),
    teardown: () => {
      // The frame is removed as soon as this returns: the typing and the draft writes go first, then the rest.
      const kept = keepTyping();
      closed = true;
      intellisense.dispose();
      navigation.dispose();
      formatting.dispose();
      opener.dispose();
      ws.dispose();
      app.host.dispose();
      render(null, document.body);
      return kept;
    },
    shown: () => {
      app.host.code?.layout();
      void ws.checkForChanges([...app.opened]).catch(() => undefined);
      // Shown again over another form: that form's scripts.
      void app.shown();
    },
  });
  // The floating button says how many changes wait, and leaving the page asks first while a write runs.
  const pill = () => {
    const n = ws.drafts.value.size;
    host.pill(n ? `Web resources · ${plural(n, 'unsaved change')}` : 'Web resources');
  };
  ws.drafts.subscribe(pill);
  pill();
  ws.working.subscribe((m) => host.guardUnload(m.size > 0));
  // After a publish: reload the page to try the change (drafts are written first; the manager reopens from the bookmark).
  ws.reloadPage = () => {
    void keepTyping();
    ws.dispose();
    host.page.location.reload();
  };
  // The list of every web resource is read meanwhile: a form's scripts don't wait for it.
  const listed = ws.start();
  await app.init(listed);
  await listed;
}

void start();

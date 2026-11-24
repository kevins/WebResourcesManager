// The conflict editor: someone saved a change to a web resource after your edit started from an older version.
// Nothing was overwritten. Their version is on the left, yours on the right (editable: merge by hand), with what each
// side changed from the common starting point one click away. Then: keep yours, take theirs, or save the merge.

import { useEffect, useRef, useState } from 'preact/hooks';
import { ago } from '../../core/util';
import { modelFor, monaco, wrUri } from '../../editor/monaco';
import type { Props } from '../../model/model';
import { TYPES, isTextType } from '../../model/types';
import { runCommand } from '../commands';
import { registerEditor, type EditorProps } from '../context';
import { useSignal } from '../hooks';
import { Button, Icon, confirmDialog, notify } from '../widgets';

const PROP_LABEL: Record<keyof Props, string> = { displayName: 'Display name', description: 'Description', languageCode: 'Language', enabledForMobile: 'Enabled for mobile', availableOffline: 'Available offline', dependencyXml: 'Dependencies' };

function Conflict({ ctx, tab, visible }: EditorProps) {
  const { ws, host } = ctx;
  const conflicts = useSignal(ws.conflicts);
  const c = conflicts.get(tab.key);
  const d = ws.draft(tab.key);
  const el = useRef<HTMLDivElement>(null);
  const diff = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [mode, setMode] = useState<'merge' | 'theirs' | 'mine'>('merge');
  const text = !!d && isTextType(d.type);

  useEffect(() => {
    if (!el.current || !text) return;
    // The manager's one diff editor (the editor host's), lent while the conflict is shown: one made here and disposed
    // after would leave Monaco's peek views and its command palette on its disposed services (Shift+F12 and F1 did
    // nothing after a conflict). Always two columns, even in a narrow window: merging needs their version beside yours.
    const d = host.mountDiff(el.current);
    d.updateOptions({ useInlineViewWhenSpaceIsLimited: false, originalEditable: false, ignoreTrimWhitespace: false });
    host.showingEditor('diff', true);
    diff.current = d;
    return () => {
      d.updateOptions({ useInlineViewWhenSpaceIsLimited: true });
      host.showingEditor('diff', false);
      diff.current = null;
    };
  }, [text]);

  useEffect(() => {
    if (!c || !d || !diff.current || !text) return;
    const lang = TYPES[d.type].language;
    const base = modelFor(wrUri(d.name, 'conflict-base'), new TextDecoder().decode(Uint8Array.from(atob(c.base.b64), (ch) => ch.charCodeAt(0))).replace(/^﻿/, ''), lang);
    const theirs = modelFor(wrUri(d.name, 'conflict-theirs'), c.theirs.text ?? '', lang);
    void host.open(tab.key).then((mine) => {
      if (!diff.current) return;
      if (mode === 'merge') diff.current.setModel({ original: theirs, modified: mine });
      else if (mode === 'theirs') diff.current.setModel({ original: base, modified: theirs });
      else diff.current.setModel({ original: base, modified: mine });
      diff.current.updateOptions({ readOnly: mode === 'theirs' });
    });
  }, [c, mode, visible]);

  if (!c || !d)
    return (
      <div class="wb-empty-editor">
        <Icon name="pass" />
        <span>No conflict is left for this file.</span>
        <Button onClick={() => ctx.closeTab(tab.id)}>Close</Button>
      </div>
    );

  const theirsBy = c.theirs.modifiedBy || 'Someone else';
  const keepMine = async () => {
    // The version the question names: one saved again while it is open must be seen first, never overwritten unseen.
    const asked = ws.conflicts.value.get(tab.key)?.theirs.version;
    const r = await confirmDialog({
      title: 'Keep your version?',
      message: `Save your version of ${d.name} over the one ${theirsBy} saved ${ago(c.theirs.modifiedOn)}?`,
      detail: 'Their change is replaced by yours. To keep some of it, copy it from the left into yours first, then Save the merge.',
      type: 'warning',
      buttons: [
        { label: 'Save mine over theirs', value: 'yes', danger: true },
        { label: 'Cancel', value: 'no' },
      ],
      cancelValue: 'no',
    });
    if (r.value !== 'yes') return;
    const still = ws.conflicts.value.get(tab.key);
    if (!still || still.theirs.version !== asked) {
      notify({ severity: 'warning', message: `${still?.theirs.modifiedBy || 'Someone'} saved ${d.name} again while you were deciding: nothing was overwritten. Compare the new version, then choose again.` });
      return;
    }
    await runCommand('wrm.resolve', { key: tab.key, how: 'mine' });
  };
  const takeTheirs = async () => {
    const r = await confirmDialog({
      title: 'Take their version?',
      message: `Throw your changes to ${d.name} away and continue from ${theirsBy}'s version?`,
      detail: 'Your changes are thrown away. To keep some of them, edit the right side instead and Save the merge.',
      type: 'question',
      buttons: [
        { label: 'Take theirs', value: 'yes', primary: true },
        { label: 'Cancel', value: 'no' },
      ],
      cancelValue: 'no',
    });
    if (r.value === 'yes') {
      const mine = ws.textOf(tab.key);
      if (mine !== undefined) await ws.snapshot(tab.key, { text: mine, note: 'Your version, before taking theirs' });
      await runCommand('wrm.resolve', { key: tab.key, how: 'theirs' });
    }
  };
  const saveMerged = async () => {
    host.flush([tab.key]);
    await runCommand('wrm.resolve', { key: tab.key, how: 'merged', text: host.model(tab.key)?.getValue() ?? ws.textOf(tab.key) });
    await runCommand('wrm.saveKeys', [tab.key]);
  };

  return (
    <div class="wb-page" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div class="wb-banner warning">
        <Icon name="warning" />
        <span>
          <b>{theirsBy}</b> saved a change to <b>{d.name}</b> {ago(c.theirs.modifiedOn)}, after your edit started. Nothing was overwritten.
          {c.content && mode === 'merge' && ' Left: their version. Right: yours — edit it to combine both, then save the merge.'}
        </span>
        <span class="wb-banner-actions">
          {text && (
            <>
              <Button kind={mode === 'merge' ? 'primary' : 'secondary'} onClick={() => setMode('merge')} title="Their version (left) and yours (right, editable)">
                Theirs ↔ yours
              </Button>
              <Button kind={mode === 'theirs' ? 'primary' : 'secondary'} onClick={() => setMode('theirs')} title="What they changed from the version you started from">
                Their changes
              </Button>
              <Button kind={mode === 'mine' ? 'primary' : 'secondary'} onClick={() => setMode('mine')} title="What you changed from the version you started from">
                Your changes
              </Button>
            </>
          )}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '8px', padding: '8px 16px', borderBottom: '1px solid var(--panel-border)', alignItems: 'center' }}>
        <span class="wb-muted" style={{ marginRight: 'auto' }}>
          Choose how to continue:
        </span>
        <Button onClick={() => void takeTheirs()}>Take theirs</Button>
        <Button kind="danger" onClick={() => void keepMine()}>
          Keep mine (save over theirs)
        </Button>
        {text && c.content && (
          <Button kind="primary" onClick={() => void saveMerged()} title="Saves the right side as it is now">
            Save the merge
          </Button>
        )}
      </div>
      {c.props.length > 0 && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--panel-border)' }}>
          <b>Properties both of you changed</b>
          <table class="wb-table" style={{ marginTop: '6px' }}>
            <thead>
              <tr>
                <th>Property</th>
                <th>Started from</th>
                <th>Theirs</th>
                <th>Yours</th>
              </tr>
            </thead>
            <tbody>
              {c.props.map((k) => (
                <tr key={k}>
                  <td>{PROP_LABEL[k]}</td>
                  <td class="wb-muted">{String(c.base.props[k] ?? '')}</td>
                  <td>{String(c.theirs.props[k] ?? '')}</td>
                  <td>{String(d.props?.[k] ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* monaco-component: Monaco's colours reach its right-click menu too. */}
      {text ? <div ref={el} class="monaco-component" style={{ flex: 1, position: 'relative' }} /> :<div class="wb-view-message">Both versions are files that can't be compared as text. Keep yours or take theirs.</div>}
    </div>
  );
}

registerEditor({ kind: 'conflict', icon: 'warning', component: (p) => <Conflict {...p} /> });

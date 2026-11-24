// File icons by web resource type, in the spirit of VS Code's Seti icons: a coloured glyph or letters per type.

import { TYPES, type WrType } from '../model/types';

const LETTERS: Partial<Record<WrType, string>> = { 3: 'JS', 2: '#', 1: '<>', 4: '<>', 9: 'XSL', 12: 'Rx', 8: 'XAP' };

export function FileIcon({ type, name }: { type: WrType | number; name?: string }) {
  const t = TYPES[type as WrType];
  if (!t) return <i class="codicon codicon-file wb-file-icon" />;
  const letters = LETTERS[t.type];
  const color = `var(${t.color})`;
  if (letters && !(name && /\.json$/i.test(name)))
    return (
      <span class="wb-letter-icon" style={{ color }} aria-hidden="true">
        {letters}
      </span>
    );
  return <i class={`codicon codicon-${t.icon} wb-file-icon`} style={{ color }} aria-hidden="true" />;
}

export function FolderIcon({ open }: { open: boolean }) {
  return <i class={`codicon codicon-${open ? 'folder-opened' : 'folder'} wb-file-icon`} style={{ color: 'var(--folder)' }} aria-hidden="true" />;
}

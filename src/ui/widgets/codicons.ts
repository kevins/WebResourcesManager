// The glyph of every codicon as CSS rules (.codicon-files:before { content: '\eaf0' }). Monaco's codicon stylesheet
// only has the font; the per-icon rules are written by its theme service, and only when the first editor is
// created. The workbench shows icons before that (nothing open yet), so the widgets write the same rules from
// Monaco's own codicon table. Identical rules from Monaco later on change nothing.

import { getCodiconFontCharacters } from 'monaco-editor/base/common/codiconsUtil';
// Registers every codicon of the table (and VS Code's derived names: dialog-error, menu-selection…).
import 'monaco-editor/base/common/codicons';

/** Adds the codicon glyph rules to the document once (<Layers/> calls it when it mounts). */
export function installCodiconStyles(doc: Document = document): void {
  if (doc.getElementById('wg-codicons')) return;
  const chars = getCodiconFontCharacters();
  const style = doc.createElement('style');
  style.id = 'wg-codicons';
  style.textContent = Object.keys(chars)
    .map((id) => `.codicon-${id}:before{content:'\\${chars[id].toString(16)}'}`)
    .join('\n');
  (doc.head || doc.documentElement).appendChild(style);
}

// Monaco's codicon table, which codicons.ts reads; these modules ship without types.

declare module 'monaco-editor/base/common/codiconsUtil' {
  /** Every registered codicon: its name and the character of its glyph in the codicon font. */
  export function getCodiconFontCharacters(): Record<string, number>;
}

declare module 'monaco-editor/base/common/codicons';

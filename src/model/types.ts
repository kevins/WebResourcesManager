// Web resource types (webresourcetype choices) and what the manager does with each: the editor language, the file
// extensions it is read from and written to, and whether its content is text.

export type WrType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface TypeInfo {
  type: WrType;
  /** Dataverse's own name for the type. */
  label: string;
  /** Short name for lists and the status bar. */
  short: string;
  /** Extensions, the usual one first. */
  ext: string[];
  /** The content is text the editor opens (else an image or a binary file). */
  text: boolean;
  /** Monaco language id for text types. */
  language: string;
  /** MIME type for previews and downloads. */
  mime: string;
  /** CSS variable of the file icon colour. */
  color: string;
  /** Codicon of the file icon. */
  icon: string;
}

export const TYPES: Record<WrType, TypeInfo> = {
  1: { type: 1, label: 'Webpage (HTML)', short: 'HTML', ext: ['html', 'htm'], text: true, language: 'html', mime: 'text/html', color: '--file-html', icon: 'code' },
  2: { type: 2, label: 'Style Sheet (CSS)', short: 'CSS', ext: ['css'], text: true, language: 'css', mime: 'text/css', color: '--file-css', icon: 'symbol-color' },
  3: { type: 3, label: 'Script (JScript)', short: 'JavaScript', ext: ['js'], text: true, language: 'javascript', mime: 'text/javascript', color: '--file-js', icon: 'symbol-method' },
  // Dataverse has no JSON type: a .json file becomes Data, as the plugin's Load from disk made it (xml stays the usual one).
  4: { type: 4, label: 'Data (XML)', short: 'XML', ext: ['xml', 'json'], text: true, language: 'xml', mime: 'text/xml', color: '--file-xml', icon: 'code' },
  5: { type: 5, label: 'PNG format', short: 'PNG', ext: ['png'], text: false, language: '', mime: 'image/png', color: '--file-img', icon: 'file-media' },
  6: { type: 6, label: 'JPG format', short: 'JPG', ext: ['jpg', 'jpeg'], text: false, language: '', mime: 'image/jpeg', color: '--file-img', icon: 'file-media' },
  7: { type: 7, label: 'GIF format', short: 'GIF', ext: ['gif'], text: false, language: '', mime: 'image/gif', color: '--file-img', icon: 'file-media' },
  8: { type: 8, label: 'Silverlight (XAP)', short: 'XAP', ext: ['xap'], text: false, language: '', mime: 'application/x-silverlight-app', color: '--file-xap', icon: 'file-binary' },
  9: { type: 9, label: 'Style Sheet (XSL)', short: 'XSL', ext: ['xsl', 'xslt'], text: true, language: 'xml', mime: 'text/xsl', color: '--file-xsl', icon: 'code' },
  10: { type: 10, label: 'ICO format', short: 'ICO', ext: ['ico'], text: false, language: '', mime: 'image/x-icon', color: '--file-img', icon: 'file-media' },
  11: { type: 11, label: 'Vector format (SVG)', short: 'SVG', ext: ['svg'], text: true, language: 'xml', mime: 'image/svg+xml', color: '--file-svg', icon: 'file-media' },
  12: { type: 12, label: 'String (RESX)', short: 'RESX', ext: ['resx'], text: true, language: 'xml', mime: 'text/xml', color: '--file-resx', icon: 'symbol-string' },
};

export const ALL_TYPES = Object.values(TYPES);

/** The type a file name's extension stands for, or null. */
export function typeOfName(name: string): WrType | null {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  for (const t of ALL_TYPES) if (t.ext.includes(ext)) return t.type;
  return null;
}

/**
 * Types a web resource with a name of this extension may also have, besides the one typeOfName gives: a .json file is
 * created as Data, but one kept as a script (often, as Dataverse has no JSON type) stays a script.
 */
const ALSO: Record<string, WrType[]> = { json: [3] };

/**
 * Whether a file of this name can hold a web resource of this type: its extension says that type, or one it may also
 * have, or nothing (no extension, or one of no type). Where the server has the web resource already, its type wins.
 */
export function nameFitsType(name: string, type: WrType): boolean {
  const t = typeOfName(name);
  if (t === null || t === type) return true;
  const ext = /\.([a-z0-9]+)$/i.exec(name)![1].toLowerCase();
  return ALSO[ext]?.includes(type) ?? false;
}

/**
 * A source map or a TypeScript source of a script ("app.js.map", "app.ts"): no web resource type by its extension, but
 * uploaded as a Script next to its script when the Local Folder is asked to (for debugging with source maps).
 */
export const isScriptCompanion = (name: string): boolean => /\.js\.map$/i.test(name) || (/\.ts$/i.test(name) && !/\.d\.ts$/i.test(name));

export const isImage = (t: WrType) => t === 5 || t === 6 || t === 7 || t === 10 || t === 11;
export const isTextType = (t: WrType) => TYPES[t]?.text ?? false;
export const typeInfo = (t: number): TypeInfo => TYPES[t as WrType] ?? { ...TYPES[4], type: t as WrType, label: `Type ${t}`, short: `Type ${t}`, text: false, language: '' };

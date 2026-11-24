// Web resource names: what Dataverse accepts, what the solution's publisher prefix requires, and how a name and a
// local file path map to each other.

import { TYPES, typeOfName, type WrType } from './types';

/** Letters, digits, underscores, hyphens, periods and forward slashes (Dataverse's rule for web resource names). */
const ALLOWED = /^[A-Za-z0-9_\-./]+$/;
export const MAX_NAME = 256;

/**
 * Why a name can't be used ('' when it can). `prefix` (e.g. "new") is the customization prefix of the publisher of the
 * solution the web resource is created in: the name must start with it and an underscore.
 */
export function nameProblem(name: string, prefix = ''): string {
  if (!name) return 'Enter a name.';
  if (name.length > MAX_NAME) return `A name can have at most ${MAX_NAME} characters (this one has ${name.length}).`;
  if (/\s/.test(name)) return 'A name can\'t contain spaces.';
  if (!ALLOWED.test(name)) {
    const bad = [...new Set(name.replace(/[A-Za-z0-9_\-./]/g, ''))].join(' ');
    return `A name can only contain letters, digits, underscores, hyphens, periods and forward slashes (not ${bad}).`;
  }
  if (name.includes('//')) return 'A name can\'t contain two forward slashes in a row (an empty folder).';
  if (name.startsWith('/') || name.endsWith('/')) return 'A name can\'t start or end with a forward slash.';
  if (name.split('/').some((s) => s === '.' || s === '..')) return 'A folder can\'t be named "." or "..".';
  if (name.endsWith('.')) return 'A name can\'t end with a period.';
  if (/\.(aspx|ascx|asmx|ashx)$/i.test(name)) return 'Dataverse doesn\'t allow names ending in .aspx, .ascx, .asmx or .ashx.';
  if (/\.(config|bin)$/i.test(name) || /(^|\/)[._]/.test(name.replace(/^[A-Za-z0-9]+_\//, ''))) return 'A file or folder name can\'t start with a period or an underscore, nor end in .config or .bin.';
  if (!/^[A-Za-z0-9]+_/.test(name)) return 'A name must start with a publisher\'s customization prefix and an underscore (for example new_).';
  if (prefix && !name.toLowerCase().startsWith(prefix.toLowerCase() + '_')) return `Names in this solution start with the publisher prefix "${prefix}_".`;
  return '';
}

/** RESX web resources need their language in the name ("strings.1033.resx") and the same language code set. */
export function resxProblem(name: string, languageCode: number | null): string {
  const m = /\.(\d{4,5})\.resx$/i.exec(name);
  if (!m) return 'A RESX name must end with its language code, for example "strings.1033.resx".';
  if (languageCode != null && Number(m[1]) !== languageCode) return `The name says language ${m[1]} but the language is set to ${languageCode}.`;
  return '';
}

/** A note (not an error) when the extension doesn't match the type ('' when it does or there is none). */
export function extensionNote(name: string, type: WrType): string {
  const t = typeOfName(name);
  if (t === null) return `The name has no extension: consider "${name}.${TYPES[type].ext[0]}" so browsers and tools know the file type.`;
  if (t !== type) return `The extension says ${TYPES[t].short}, but the type is ${TYPES[type].short}.`;
  return '';
}

/** The name of a web resource for a local file: the folder's root name plus the file's path in the folder. */
export function nameForPath(root: string, relPath: string): string {
  const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!root) return clean;
  return root.replace(/\/+$/, '') + '/' + clean;
}

/** The path of a web resource in a local folder mapped to `root` ('' when the name is outside it). */
export function pathForName(root: string, name: string): string {
  if (!root) return name;
  const r = root.replace(/\/+$/, '') + '/';
  return name.toLowerCase().startsWith(r.toLowerCase()) ? name.slice(r.length) : '';
}

/** The name with the folder part replaced: "new_/a/b.js" moved to "new_/c/" is "new_/c/b.js". */
export const moveName = (name: string, folder: string) => (folder ? folder.replace(/\/+$/, '') + '/' : '') + name.split('/').pop();

/** The last segment of a name. */
export const baseName = (name: string) => name.split('/').pop() || name;

/** The folder part of a name, with its trailing slash ('' at the top). */
export const folderOf = (name: string) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '');

/** A display name from a file name: "account_form.js" → "account_form.js" (Dataverse shows names as given). */
export const displayNameFor = (name: string) => baseName(name);

/** Another name in the same folder that doesn't exist yet: "a.js" → "a_copy.js", "a_copy2.js"… (names can't hold spaces). */
export function copyName(name: string, exists: (n: string) => boolean): string {
  const folder = folderOf(name);
  const base = baseName(name);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const n = `${folder}${stem}_copy${i === 1 ? '' : i}${ext}`;
    if (!exists(n)) return n;
  }
  return `${folder}${stem}_copy${Date.now()}${ext}`;
}

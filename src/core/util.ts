// Small helpers shared by every part of the manager: text and bytes, base64, hashing, timing.

/** The text of a web resource's content and how it was stored, so saving writes it back the same way. */
export interface Decoded {
  text: string;
  /** The content started with a UTF-8 byte order mark (kept on save). */
  bom: boolean;
  /** 'utf-8', or 'windows-1252' when the bytes were not valid UTF-8 (saving converts to UTF-8). */
  encoding: 'utf-8' | 'windows-1252';
  /** The text's line ending ('\r\n' when most lines end with one). */
  eol: '\n' | '\r\n';
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[]);
  return btoa(s);
}

/** Decodes a text web resource's bytes: UTF-8 (with or without BOM), else Windows-1252. */
export function decodeText(bytes: Uint8Array): Decoded {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  let text: string;
  let encoding: Decoded['encoding'] = 'utf-8';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    text = new TextDecoder('windows-1252').decode(body);
    encoding = 'windows-1252';
  }
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return { text, bom, encoding, eol: crlf > lf ? '\r\n' : '\n' };
}

/** Encodes text for a web resource's content: UTF-8, with a BOM when `bom`. */
export function encodeText(text: string, bom = false): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

export const textToBase64 = (text: string, bom = false) => bytesToBase64(encodeText(text, bom));
export const base64ToText = (b64: string) => decodeText(base64ToBytes(b64));

/** SHA-256 of bytes or text, as lower-case hex. */
export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A quick, synchronous fingerprint of a string (FNV-1a 53-bit), for change detection where a hash need not be secure. */
export function fingerprint(s: string): string {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { flush(): void; cancel(): void; pending(): boolean } {
  let t: ReturnType<typeof setTimeout> | 0 = 0;
  let last: A | null = null;
  const run = () => {
    t = 0;
    const a = last;
    last = null;
    if (a) fn(...a);
  };
  const d = (...a: A) => {
    last = a;
    if (t) clearTimeout(t);
    t = setTimeout(run, ms);
  };
  d.flush = () => {
    if (t) clearTimeout(t);
    run();
  };
  d.cancel = () => {
    if (t) clearTimeout(t);
    t = 0;
    last = null;
  };
  d.pending = () => !!t;
  return d;
}

/** Runs fn over the items, n at a time. The first error stops new items and is thrown when the running ones are done. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  let failed: unknown = null;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length && !failed) {
        const k = i++;
        try {
          out[k] = await fn(items[k], k);
        } catch (e) {
          failed = failed || e;
        }
      }
    }),
  );
  if (failed) throw failed;
  return out;
}

/** "3 web resources" / "1 web resource". */
export const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "just now", "5 minutes ago", "yesterday", else a date. */
export function ago(when: string | number | Date, now = Date.now()): string {
  const t = new Date(when).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return 'a minute ago';
  const m = Math.round(s / 60);
  if (m < 45) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString();
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e ?? 'Unknown error'));

/** Escapes text for HTML. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** A file download of bytes or text, started from the manager's frame. */
export function download(name: string, data: Uint8Array | string | Blob, type = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Where a <base> goes in an HTML page so its relative links resolve: right after <head> (not <header>), else after
 * the doctype and <html> start tag, where the parser puts the head.
 */
export function withBase(html: string, href: string): string {
  const base = `<base href="${href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + base + html.slice(head.index + head[0].length);
  const lead = /^\s*(?:<!doctype[^>]*>\s*)?(?:<html(?:\s[^>]*)?>)?/i.exec(html)?.[0] || '';
  return lead + base + html.slice(lead.length);
}

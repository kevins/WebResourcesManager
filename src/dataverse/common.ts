// Requests shared by the Dataverse modules: publishing, a concurrency-checked update, and Dataverse's error codes in
// words; and how long work on answers runs before the page gets its turn.

import { DvError, abortError, isLockError, type Http } from '../core/http';

/** The ETag of a row as Dataverse returned it ('' when none). Compared as text: versionnumber is a 64-bit number that
 * JavaScript rounds, so two versions can look equal as numbers. */
export const etagOf = (row: any): string => (row && typeof row['@odata.etag'] === 'string' ? row['@odata.etag'] : '');

/**
 * Resolves in a task of its own, after what the page has waiting (input, painting). A message, not a timer: the
 * browser slows timers down in a tab in the background (to one a second, later one a minute), which would stretch a
 * long run that pauses often into minutes.
 */
const nextTask = () =>
  new Promise<void>((resolve) => {
    if (typeof MessageChannel !== 'function') return void setTimeout(resolve, 0);
    const c = new MessageChannel();
    c.port1.onmessage = () => {
      c.port1.close();
      resolve();
    };
    c.port2.postMessage(null);
  });

/**
 * A pause point for long work on answers (decoding, indexing): `await turn()` gives the page its turn once the work
 * since the last one has run `ms`, so a big answer never freezes the manager. Throws an AbortError once `signal` aborts.
 */
export function turns(signal?: AbortSignal, ms = 30): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (signal?.aborted) throw abortError();
    if (performance.now() - since < ms) return;
    await nextTask();
    since = performance.now();
    if (signal?.aborted) throw abortError();
  };
}

/** Escapes text for XML (PublishXml parameters). */
export const xmlEsc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string);

/**
 * Publishes customizations (PublishXml). `inner` is the inside of <importexportxml>, e.g.
 * <webresources><webresource>{id}</webresource></webresources>. Sent again while another customization operation holds
 * the organization-wide lock (it did not run then); never sent twice otherwise. Can take minutes on a busy environment.
 */
export async function publishXml(http: Http, inner: string, label = 'Publish'): Promise<void> {
  await http.post('PublishXml', { ParameterXml: `<importexportxml>${inner}</importexportxml>` }, { lockRetry: true, label });
}

/** Publishes tables (their forms, views and ribbon) by logical name. */
export function publishTables(http: Http, tables: string[]): Promise<void> {
  const unique = [...new Set(tables.map((t) => t.toLowerCase()))];
  if (!unique.length) return Promise.resolve();
  return publishXml(http, `<entities>${unique.map((t) => `<entity>${xmlEsc(t)}</entity>`).join('')}</entities>`, `Publish ${unique.join(', ')}`);
}

/** The row changed on the server since the version the caller started from. */
export class ConflictError extends DvError {
  constructor(
    message: string,
    readonly current: any,
  ) {
    super(message, 412, 'conflict');
    this.name = 'ConflictError';
  }
}

/**
 * Updates a row only if it is still the version the caller's change was made on: `read()` gets the latest saved
 * version now, `same(row)` says whether it is that version. Dataverse's own check (If-Match with an ETag) isn't used:
 * it is unreliable for customizations like web resources and forms (ETags of the published row are refused while a
 * draft exists), so the check is the read just before the write. The PATCH carries If-Match: * so it can never
 * re-create a row deleted meanwhile (PATCH is an upsert otherwise). Returns the row the check read.
 */
export async function patchIfUnchanged(
  http: Http,
  path: string,
  body: Record<string, unknown>,
  read: () => Promise<any>,
  same: (row: any) => boolean,
  label: string,
): Promise<any> {
  const row = await read();
  if (!same(row)) throw new ConflictError('Someone else saved a change to it since you opened it.', row);
  await http.patch(path, body, { headers: { 'If-Match': '*' }, once: true, label });
  return row;
}

/** Dataverse error codes (lower case) the manager explains in words. */
const CODES: Record<string, string> = {
  '0x8004f01f': 'Other components use it (a form, the site map, a ribbon or another web resource): remove those uses first.',
  '0x80040227': 'Other components use it: remove those uses first.',
  '0x8004f013': 'It belongs to a managed solution: it goes away only when that solution is uninstalled.',
  '0x8004f00f': 'It was deleted meanwhile.',
  '0x8004f115': 'A web resource with this name already exists.',
  '0x8004f116': 'The name is empty.',
  '0x8004f117': 'The name contains a character Dataverse doesn\'t allow (only letters, digits, _, -, . and /).',
  '0x8004f118': 'The name must start with a publisher\'s customization prefix and an underscore (for example new_).',
  '0x8004f119': 'Web resource names can\'t end in .aspx, .ascx, .asmx or .ashx.',
  '0x8004f114': 'The content is larger than the organization allows (Maximum file size, in the email settings of the environment).',
  '0x8004f111': 'That is not a valid web resource type.',
  '0x80072042': 'This environment blocks unmanaged customizations: nothing can be changed here.',
  '0x8004f012': 'It is managed and its solution doesn\'t allow changing it.',
  '0x8004f014': 'It is managed and its solution doesn\'t allow changing it, so it can\'t be published.',
  '0x8004f015': 'It can\'t be added to a solution: its managed solution doesn\'t allow changing it.',
  '0x8004f024': 'A managed solution can\'t be changed.',
  '0x8004f000': 'Nothing can be removed from the default solution.',
  '0x80060882': 'It was changed by someone else since it was read.',
  '0x80040220': 'You don\'t have the security privileges for this.',
};

/** What went wrong, for a person: Dataverse's code in words when it is a known one, its own message otherwise. */
export function explain(e: unknown): string {
  if (e instanceof DvError) {
    if (isLockError(e)) return 'Another customization operation (a publish or a solution import) is running in this environment. Try again when it has finished.';
    const known = CODES[e.code.toLowerCase()];
    if (known) return known;
    if (e.status === 403) return `You don't have permission to do this. ${e.message}`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

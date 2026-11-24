// Web resources in Dataverse: list, read (saved and published versions), create, update with a concurrency check,
// delete, publish. Every read goes past every cache (core/http.ts), and every read of content asks for the latest
// SAVED version (RetrieveUnpublished): the plugin read the published one, so it showed old content after an
// unpublished save and could overwrite someone else's saved work.

import { DvError, abortError, guid, guidParam, isGuid, notOffered, q, type Http } from '../core/http';
import { base64ToText } from '../core/util';
import type { Content, Props, WebResource } from '../model/model';
import type { WrType } from '../model/types';
import { ConflictError, etagOf, patchIfUnchanged, publishXml, turns } from './common';

/** Columns of the list (no content: content is read when a file is opened). */
const LIST_COLUMNS = [
  'webresourceid',
  'name',
  'displayname',
  'description',
  'webresourcetype',
  'languagecode',
  'ismanaged',
  'iscustomizable',
  'canbedeleted',
  'ishidden',
  'isenabledformobileclient',
  'isavailableformobileoffline',
  'introducedversion',
  'createdon',
  'modifiedon',
  '_modifiedby_value',
  'versionnumber',
  'componentstate',
].join(',');

const CONTENT_COLUMNS = `${LIST_COLUMNS},content,dependencyxml`;
const FORMATTED = 'OData.Community.Display.V1.FormattedValue';

const bool = (v: any): boolean => (v && typeof v === 'object' ? v.Value !== false : v !== false && v != null);

/** A row of webresourceset as the manager's WebResource (publish state filled in by listWebResources). */
export function toWebResource(r: any): WebResource {
  return {
    id: guid(r.webresourceid),
    name: String(r.name || ''),
    displayName: String(r.displayname || ''),
    description: String(r.description || ''),
    type: Number(r.webresourcetype) as WrType,
    languageCode: r.languagecode == null ? null : Number(r.languagecode),
    isManaged: !!r.ismanaged,
    isCustomizable: r.iscustomizable == null ? true : bool(r.iscustomizable),
    canBeDeleted: r.canbedeleted == null ? true : bool(r.canbedeleted),
    isHidden: r.ishidden == null ? false : bool(r.ishidden),
    enabledForMobile: !!r.isenabledformobileclient,
    availableOffline: !!r.isavailableformobileoffline,
    introducedVersion: String(r.introducedversion || ''),
    createdOn: String(r.createdon || ''),
    modifiedOn: String(r.modifiedon || ''),
    modifiedBy: String(r[`_modifiedby_value@${FORMATTED}`] || ''),
    modifiedById: guid(r._modifiedby_value),
    version: etagOf(r) || String(r.versionnumber ?? ''),
    // A hint only (a row of the saved list in a draft state); listWebResources compares with the published list.
    unpublished: r.componentstate === 1,
    publishedOn: '',
    publishedBy: '',
  };
}

export interface ListOptions {
  /** Include hidden web resources (the platform's own libraries). */
  hidden?: boolean;
  /** Only the web resources of these names (hidden ones included): a form's scripts, without the whole list. */
  names?: string[];
  /** Their latest saved content too, read with them into this map (by id): opening one then needs no request. */
  contents?: Map<string, Content>;
  signal?: AbortSignal;
}

/**
 * Every web resource with its publish state: the latest saved versions (RetrieveUnpublishedMultiple) compared with the
 * published ones. A web resource whose saved version differs (another modifiedon or row version) has saved changes
 * that aren't published; one only in the saved list was created and never published.
 */
export async function listWebResources(http: Http, o: ListOptions = {}): Promise<WebResource[]> {
  if (!o.names) return listRows(http, o.hidden ? '' : '&$filter=ishidden/Value eq false', o);
  const out: WebResource[] = [];
  for (let i = 0; i < o.names.length; i += 25) {
    const part = o.names.slice(i, i + 25).filter(Boolean);
    if (part.length) out.push(...(await listRows(http, `&$filter=${part.map((n) => `name eq '${q(n)}'`).join(' or ')}`, o)));
  }
  return out;
}

async function listRows(http: Http, filter: string, o: ListOptions): Promise<WebResource[]> {
  const opts = { annotations: FORMATTED, maxPageSize: 5000, signal: o.signal };
  const [saved, published] = await Promise.all([
    http.all(`webresourceset/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=${o.contents ? CONTENT_COLUMNS : LIST_COLUMNS}${filter}`, { ...opts, label: 'Web resources (saved)' }).catch((e) => {
      // Without the function (older versions), the published list is all there is.
      if (e instanceof DvError && (e.status === 400 || e.status === 404 || e.status === 501)) return null;
      throw e;
    }),
    http.all(`webresourceset?$select=${LIST_COLUMNS}${filter}`, { ...opts, label: 'Web resources (published)' }),
  ]);
  const pub = new Map<string, any>(published.map((r) => [guid(r.webresourceid), r]));
  if (o.contents && saved) for (const r of saved) o.contents.set(guid(r.webresourceid), toContent(r, TEXT_TYPES.has(Number(r.webresourcetype))));
  const out: WebResource[] = [];
  for (const r of saved ?? published) {
    const w = toWebResource(r);
    const p = pub.get(w.id);
    if (p) {
      w.publishedOn = String(p.modifiedon || '');
      w.publishedBy = String(p[`_modifiedby_value@${FORMATTED}`] || '');
      // A pending draft: the saved row says so (componentstate 1), or its ETag isn't the published row's.
      w.unpublished = !!saved && (r.componentstate === 1 || (!!etagOf(r) && etagOf(r) !== etagOf(p)));
    } else {
      w.unpublished = !!saved;
    }
    out.push(w);
  }
  return out;
}

/** The published content of some web resources (what users have), 50 per request: the local history keeps it before a publish. */
export async function publishedContents(http: Http, ids: string[]): Promise<Map<string, { b64: string; by: string }>> {
  const out = new Map<string, { b64: string; by: string }>();
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50).filter((id) => isGuid(id));
    if (!part.length) continue;
    const rows = await http.all(`webresourceset?$select=webresourceid,content,_modifiedby_value&$filter=${part.map((id) => `webresourceid eq ${id}`).join(' or ')}`, { annotations: FORMATTED, label: 'Published versions' });
    for (const r of rows) out.set(guid(r.webresourceid), { b64: String(r.content || ''), by: String(r[`_modifiedby_value@${FORMATTED}`] || '') });
  }
  return out;
}

/**
 * The latest saved version of some web resources' list columns (to see who changed what since the list was read).
 * `strict`: only a version without RetrieveUnpublishedMultiple falls back to the published rows; any other failure is
 * thrown (a caller that must know the latest saved version can't take a published one for it).
 */
export async function savedVersions(http: Http, ids: string[], o: { strict?: boolean; signal?: AbortSignal } = {}): Promise<WebResource[]> {
  const out: WebResource[] = [];
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40).filter((id) => isGuid(id));
    if (!part.length) continue;
    const filter = part.map((id) => `webresourceid eq ${id}`).join(' or ');
    const rows = await http
      .all(`webresourceset/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=${LIST_COLUMNS}&$filter=${filter}`, { annotations: FORMATTED, signal: o.signal, label: 'Check for changes' })
      .catch((e) => {
        if (o.strict && !notOffered(e)) throw e;
        return http.all(`webresourceset?$select=${LIST_COLUMNS}&$filter=${filter}`, { annotations: FORMATTED, signal: o.signal, label: 'Check for changes' });
      });
    out.push(...rows.map(toWebResource));
  }
  return out;
}

// ---- reading many contents: answers of a bounded size

/**
 * Characters of content (Base64) one answer should hold at most. Fifty multi-megabyte scripts in one answer would be
 * a download of hundreds of megabytes parsed and decoded at once, freezing the manager meanwhile.
 */
export const ANSWER_BUDGET = 8 * 1024 * 1024;
/** The most ids one request names (the filter goes in the address). */
const MAX_IDS = 50;
/** Ids asked for together before any size is known: few, in case the first ones are big. */
const FIRST_IDS = 5;

/** What earlier reads of an environment taught about its contents' sizes. */
interface Sizes {
  /** Base64 length of each content read, by id. */
  known: Map<string, number>;
  /** How many contents of a size not known yet fit one answer, from the sizes seen so far. */
  per: number;
}
const sizesOf = new WeakMap<Http, Sizes>();

function sizes(http: Http): Sizes {
  let s = sizesOf.get(http);
  if (!s) sizesOf.set(http, (s = { known: new Map(), per: FIRST_IDS }));
  return s;
}

/** The ids of the next request: from `ids[from]` on, as many as are expected to fit one answer (at least one). */
function nextIds(s: Sizes, ids: string[], from: number): string[] {
  const guess = Math.floor(ANSWER_BUDGET / s.per);
  let chars = 0;
  let end = from;
  while (end < ids.length && end - from < MAX_IDS) {
    const c = s.known.get(ids[end]) ?? guess;
    if (end > from && chars + c > ANSWER_BUDGET) break;
    chars += c;
    end++;
  }
  return ids.slice(from, end);
}

/** Remembers the sizes of an answer's contents, and how many contents of an unknown size fit one answer now. */
function learn(s: Sizes, rows: any[]): void {
  let total = 0;
  let n = 0;
  for (const r of rows) {
    const id = guid(r.webresourceid);
    const len = String(r.content || '').length;
    if (!s.known.has(id)) {
      total += len;
      n++;
    }
    s.known.set(id, len);
  }
  if (n) s.per = Math.max(1, Math.min(MAX_IDS, Math.floor(ANSWER_BUDGET / Math.max(1024, total / n))));
}

/**
 * Reads the latest saved rows of web resources by id (RetrieveUnpublishedMultiple; the published rows on a version
 * without it), in requests whose answers stay near ANSWER_BUDGET: sizes read before are remembered, and how many ids
 * of an unknown size go in one request follows the sizes seen. `take` gets each answer's rows before the next request
 * is sent, so they can be worked on (and let go) one answer at a time.
 */
export async function readSavedRows(
  http: Http,
  ids: string[],
  select: string,
  take: (rows: any[]) => void | Promise<void>,
  o: { signal?: AbortSignal; label?: string; annotations?: string } = {},
): Promise<void> {
  const ok = [...new Set(ids.filter((id) => isGuid(id)))];
  const s = sizes(http);
  for (let i = 0; i < ok.length; ) {
    if (o.signal?.aborted) throw abortError();
    const part = nextIds(s, ok, i);
    i += part.length;
    const filter = part.map((id) => `webresourceid eq ${id}`).join(' or ');
    const opts = { annotations: o.annotations, signal: o.signal, label: o.label || `Read ${part.length} web resource${part.length === 1 ? '' : 's'}` };
    const rows = await http.all(`webresourceset/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=${select}&$filter=${filter}`, opts).catch((e) => {
      if (notOffered(e)) return http.all(`webresourceset?$select=${select}&$filter=${filter}`, opts);
      throw e;
    });
    learn(s, rows);
    await take(rows);
  }
}

/**
 * The latest saved content of some web resources, read in answers of a bounded size (readSavedRows) and decoded with
 * pauses, so a set of big scripts never freezes the manager.
 */
export async function savedVersionsWithContent(http: Http, ids: string[], signal?: AbortSignal): Promise<Map<string, Content>> {
  const out = new Map<string, Content>();
  const turn = turns(signal);
  await readSavedRows(
    http,
    ids,
    CONTENT_COLUMNS,
    async (rows) => {
      for (const r of rows) {
        out.set(guid(r.webresourceid), toContent(r, TEXT_TYPES.has(Number(r.webresourcetype))));
        await turn();
      }
    },
    { signal, annotations: FORMATTED },
  );
  return out;
}

const TEXT_TYPES = new Set([1, 2, 3, 4, 9, 11, 12]);

function toContent(r: any, textType: boolean): Content {
  const b64 = String(r.content || '');
  const c: Content = {
    b64,
    modifiedOn: String(r.modifiedon || ''),
    version: etagOf(r) || String(r.versionnumber ?? ''),
    modifiedBy: String(r[`_modifiedby_value@${FORMATTED}`] || ''),
    modifiedById: guid(r._modifiedby_value),
    etag: etagOf(r),
    state: Number(r.componentstate) || 0,
    props: {
      displayName: String(r.displayname || ''),
      description: String(r.description || ''),
      languageCode: r.languagecode == null ? null : Number(r.languagecode),
      enabledForMobile: !!r.isenabledformobileclient,
      availableOffline: !!r.isavailableformobileoffline,
      dependencyXml: String(r.dependencyxml || ''),
    },
  };
  if (textType) {
    const d = base64ToText(b64);
    c.text = d.text;
    c.bom = d.bom;
    c.encoding = d.encoding;
    c.eol = d.eol;
  }
  return c;
}

/** The raw row of the latest saved version (falls back to the published one on versions without RetrieveUnpublished). */
export async function readSavedRow(http: Http, id: string, signal?: AbortSignal): Promise<any> {
  if (!isGuid(id)) throw new Error('Not a web resource id.');
  try {
    return await http.get(`webresourceset(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=${CONTENT_COLUMNS}`, { annotations: FORMATTED, signal, label: 'Read saved version' });
  } catch (e) {
    if (e instanceof DvError && (e.status === 400 || e.status === 501)) return http.get(`webresourceset(${id})?$select=${CONTENT_COLUMNS}`, { annotations: FORMATTED, signal, label: 'Read' });
    throw e;
  }
}

/** The latest saved version's content and properties. */
export async function getSaved(http: Http, id: string, textType: boolean, signal?: AbortSignal): Promise<Content> {
  return toContent(await readSavedRow(http, id, signal), textType);
}

/** The published version's content and properties. */
export async function getPublished(http: Http, id: string, textType: boolean, signal?: AbortSignal): Promise<Content> {
  if (!isGuid(id)) throw new Error('Not a web resource id.');
  return toContent(await http.get(`webresourceset(${id})?$select=${CONTENT_COLUMNS}`, { annotations: FORMATTED, signal, label: 'Read published version' }), textType);
}

/** The id of the web resource with this name (Dataverse compares names without regard to case), or null. */
export async function idOfName(http: Http, name: string): Promise<{ id: string; name: string } | null> {
  const r = await http.get(`webresourceset?$select=webresourceid,name&$filter=name eq '${q(name)}'`, { label: `Look for ${name}` });
  const row = (r.value as any[])[0];
  if (row) return { id: guid(row.webresourceid), name: String(row.name) };
  // A web resource created and never published is only in the saved list.
  const u = await http.get(`webresourceset/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=webresourceid,name&$filter=name eq '${q(name)}'`).catch(() => ({ value: [] }));
  const urow = (u.value as any[])[0];
  return urow ? { id: guid(urow.webresourceid), name: String(urow.name) } : null;
}

/** Columns of a property change, as Dataverse names them. */
export function propColumns(p: Partial<Props>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.displayName !== undefined) out.displayname = p.displayName;
  if (p.description !== undefined) out.description = p.description;
  if (p.languageCode !== undefined) out.languagecode = p.languageCode;
  if (p.enabledForMobile !== undefined) out.isenabledformobileclient = p.enabledForMobile;
  if (p.availableOffline !== undefined) out.isavailableformobileoffline = p.availableOffline;
  if (p.dependencyXml !== undefined) out.dependencyxml = p.dependencyXml || null;
  return out;
}

export interface NewWebResource {
  name: string;
  type: WrType;
  b64: string;
  props: Partial<Props>;
  /** Unique name of the solution to create it in ('' = the default solution only). */
  solution?: string;
}

/**
 * Creates a web resource, in a solution when one is named (MSCRM.SolutionUniqueName: added as it is created).
 * Returns its id. Never sent twice: when the answer is lost, the caller looks the name up before trying again.
 */
export async function createWebResource(http: Http, w: NewWebResource): Promise<string> {
  const body = { name: w.name, webresourcetype: w.type, content: w.b64, displayname: w.props.displayName || w.name.split('/').pop(), ...propColumns({ ...w.props, displayName: undefined }) };
  const r = await http.post('webresourceset?$select=webresourceid,name', body, {
    headers: { Prefer: 'return=representation', ...(w.solution ? { 'MSCRM.SolutionUniqueName': w.solution } : {}) },
    once: true,
    label: `Create ${w.name}`,
  });
  const id = guid(r?.webresourceid);
  if (isGuid(id)) return id;
  const found = await idOfName(http, w.name);
  if (!found) throw new DvError(`Dataverse did not confirm that ${w.name} was created.`, 0, 'create');
  return found.id;
}

export interface Update {
  b64?: string;
  props?: Partial<Props>;
}

/**
 * Saves a change, only if the web resource is still the version `base` describes (ConflictError otherwise, with the
 * server's current row). `same(row)` decides; the PATCH carries If-Match with the ETag of the version just checked.
 * Returns the row the check read (the server's version before the save, for the local history).
 */
export async function updateWebResource(http: Http, id: string, u: Update, same: (row: any) => boolean, label: string): Promise<any> {
  const body: Record<string, unknown> = { ...propColumns(u.props || {}) };
  if (u.b64 !== undefined) body.content = u.b64;
  if (!Object.keys(body).length) return null;
  return patchIfUnchanged(http, `webresourceset(${id})`, body, () => readSavedRow(http, id), same, label);
}

/** Deletes a web resource (at once: no publish needed). */
export async function deleteWebResource(http: Http, id: string, name: string): Promise<void> {
  if (!isGuid(id)) throw new Error('Not a web resource id.');
  await http.del(`webresourceset(${id})`, { once: true, label: `Delete ${name}` });
}

/** Publishes web resources by id, in one PublishXml. */
export async function publishWebResources(http: Http, ids: string[], label?: string): Promise<void> {
  const ok = [...new Set(ids.filter(isGuid))];
  if (!ok.length) return;
  await publishXml(http, `<webresources>${ok.map((id) => `<webresource>{${id}}</webresource>`).join('')}</webresources>`, label || `Publish ${ok.length} web resource${ok.length === 1 ? '' : 's'}`);
}

/**
 * Throws away a web resource's saved, unpublished change: the published content and properties are saved over the
 * draft and published (Dataverse has no action to discard a draft). Checked like a save: refused if the draft changed
 * since `draftVersion` was read.
 */
export async function revertToPublished(http: Http, id: string, name: string, draftVersion: string): Promise<void> {
  const pub = await http.get(`webresourceset(${id})?$select=${CONTENT_COLUMNS}`, { label: `Read published ${name}` });
  const body = {
    content: pub.content || '',
    ...propColumns({
      displayName: pub.displayname || '',
      description: pub.description || '',
      languageCode: pub.languagecode ?? null,
      enabledForMobile: !!pub.isenabledformobileclient,
      availableOffline: !!pub.isavailableformobileoffline,
      dependencyXml: pub.dependencyxml || '',
    }),
  };
  await patchIfUnchanged(http, `webresourceset(${id})`, body, () => readSavedRow(http, id), (row) => etagOf(row) === draftVersion, `Discard saved change of ${name}`);
  await publishWebResources(http, [id], `Publish ${name}`);
}

/** What a renamed web resource is created with, from a row of the old one: its type, content and properties. */
function copyOf(row: any, newName: string): Record<string, unknown> {
  return {
    webresourcetype: row.webresourcetype,
    content: row.content || '',
    ...propColumns({
      displayName: row.displayname || newName.split('/').pop(),
      description: row.description || '',
      languageCode: row.languagecode ?? null,
      enabledForMobile: !!row.isenabledformobileclient,
      availableOffline: !!row.isavailableformobileoffline,
      dependencyXml: row.dependencyxml || '',
    }),
  };
}

/**
 * A rename was refused because the web resource's saved version isn't its published one (a saved change not published
 * yet, or never published): renaming would make that version live. Nothing was changed.
 */
export class UnpublishedChangeError extends DvError {
  constructor(
    message: string,
    /** Who saved the version not published ('' when Dataverse doesn't say). */
    readonly savedBy: string,
    /** When it was saved (ISO date, '' when not known). */
    readonly savedOn: string,
    /** It was never published: there is no published version to rename instead. */
    readonly neverPublished: boolean,
    /** The saved version found (its ETag): given back with the choice (RenameOptions.version). */
    readonly version = '',
  ) {
    super(message, 409, 'unpublished-change');
    this.name = 'UnpublishedChangeError';
  }
}

export interface RenameOptions {
  /**
   * Which version the renamed web resource gets when the saved version isn't the published one. 'saved' makes the
   * saved change live under the new name; 'published' leaves it out (it goes with the old web resource, so the caller
   * keeps a copy first). Without a choice, such a rename is refused with an UnpublishedChangeError.
   */
  from?: 'saved' | 'published';
  /**
   * The saved version the choice was made on (UnpublishedChangeError.version). When someone saved again since, the
   * rename is refused (ConflictError): a change the user wasn't told about is never made live or left behind.
   */
  version?: string;
}

/**
 * Renames a web resource in one transaction: the web resource under its new name (a new id) in the same solutions,
 * and the old one deleted; any failure leaves everything as it was. Refused when other components use the web
 * resource (their references would break) — Dataverse refuses the delete then anyway. References by relative path in
 * other web resources aren't tracked: the caller searches for them first.
 *
 * A created web resource is published at once, and the delete takes the old one's published version with it. So when
 * a saved change isn't published yet, the rename is refused unless `o.from` says which version to keep (and `o.version`
 * which saved version that choice was made on).
 */
export async function renameWebResource(http: Http, id: string, newName: string, solutions: string[], o: RenameOptions = {}): Promise<string> {
  if (!isGuid(id)) throw new Error('Not a web resource id.');
  const saved = await readSavedRow(http, id);
  const published = await http.get(`webresourceset(${id})?$select=${CONTENT_COLUMNS}`, { annotations: FORMATTED, label: 'Read published version' }).catch((e) => {
    if (e instanceof DvError && e.status === 404) return null;
    throw e;
  });
  const by = String(saved[`_modifiedby_value@${FORMATTED}`] || '');
  const on = String(saved.modifiedon || '');
  const when = on && !isNaN(Date.parse(on)) ? ` on ${new Date(on).toLocaleString()}` : '';
  // The choice was made on the saved version the user was told of: a version saved (or published) since is never made
  // live, or left behind, unseen.
  if (o.version !== undefined && etagOf(saved) !== o.version)
    throw new ConflictError(`${saved.name} was changed again (by ${by || 'someone'}${when}) after you chose which version to keep, so it was not renamed. Look at it again, then rename it.`, saved);
  const fromSaved = copyOf(saved, newName);
  const pending = !published || JSON.stringify(copyOf(published, newName)) !== JSON.stringify(fromSaved);
  if (pending && (!o.from || (o.from === 'published' && !published))) {
    throw new UnpublishedChangeError(
      published
        ? `${saved.name} has a saved change that isn't published yet (saved by ${by || 'someone'}${when}). A renamed web resource is published at once, so renaming it now would make that change live and delete the published version. Publish or discard that change first, then rename it.`
        : `${saved.name} has never been published. A renamed web resource is published at once, so renaming it would make its content live. Publish it first, then rename it.`,
      by,
      on,
      !published,
      etagOf(saved),
    );
  }
  const row = pending && o.from === 'published' ? published : saved;
  const newId = crypto.randomUUID().toLowerCase();
  const body = { webresourceid: newId, name: newName, ...(row === saved ? fromSaved : copyOf(row, newName)) };
  const [first, ...others] = solutions;
  await http.changeset(
    [
      { method: 'POST', url: 'webresourceset', body, headers: first ? { 'MSCRM.SolutionUniqueName': first } : {} },
      ...others.map((s) => ({ method: 'POST' as const, url: 'AddSolutionComponent', body: { ComponentId: newId, ComponentType: 61, SolutionUniqueName: s, AddRequiredComponents: false, DoNotIncludeSubcomponents: false } })),
      { method: 'DELETE', url: `webresourceset(${id})` },
    ],
    { label: `Rename ${saved.name} to ${newName}` },
  );
  return newId;
}

export interface Dependency {
  /** Component type of the dependent component (60 form, 61 web resource, 62 site map, 1 table, 48–55 ribbon…). */
  type: number;
  id: string;
  parentId: string;
  dependencyType: number;
}

/** Components that depend on a web resource and would block deleting it. */
export async function dependenciesForDelete(http: Http, id: string): Promise<Dependency[]> {
  const r = await http.get(http.fn('RetrieveDependenciesForDelete', { ObjectId: guidParam(id), ComponentType: 61 }), { label: 'Dependencies' });
  return toDependencies(r.value);
}

/** Every component that depends on a web resource (published dependencies). */
export async function dependents(http: Http, id: string): Promise<Dependency[]> {
  const r = await http.get(http.fn('RetrieveDependentComponents', { ObjectId: guidParam(id), ComponentType: 61 }), { label: 'Dependent components' });
  return toDependencies(r.value);
}

/** Components a web resource depends on (from its dependencyxml and the platform's own tracking). */
export async function requiredComponents(http: Http, id: string): Promise<Dependency[]> {
  const r = await http.get(http.fn('RetrieveRequiredComponents', { ObjectId: guidParam(id), ComponentType: 61 }), { label: 'Required components' });
  return (r.value as any[]).map((d) => ({ type: Number(d.requiredcomponenttype), id: guid(d.requiredcomponentobjectid), parentId: guid(d.requiredcomponentparentid), dependencyType: Number(d.dependencytype) }));
}

const toDependencies = (rows: any[]): Dependency[] =>
  (rows || []).map((d) => ({ type: Number(d.dependentcomponenttype), id: guid(d.dependentcomponentobjectid), parentId: guid(d.dependentcomponentparentid), dependencyType: Number(d.dependencytype) }));

export { ConflictError };

// What the manager keeps in this browser for one environment: settings, unsaved drafts, local history and the
// workspace (open editors, layout). Every value read back is checked, so a damaged or older entry falls back to its
// default instead of stopping the manager (the plugin's settings file caused 14 of its 107 issues).

import { idbDel, idbEntries, idbGet, idbPrefix, idbSet, idbTx, storageEstimate } from '../core/idb';
import { fingerprint } from '../core/util';
import { DEFAULT_EXPLORER_SETTINGS, DEFAULT_SETTINGS, type AllSettings, type Draft } from './model';
import type { WrType } from './types';

// ------------------------------------------------------------------ settings

/** Settings as stored, checked field by field against the defaults: wrong types and unknown fields are dropped. */
export function cleanSettings(raw: unknown): AllSettings {
  const defaults: AllSettings = { ...DEFAULT_SETTINGS, ...DEFAULT_EXPLORER_SETTINGS };
  const out: AllSettings = { ...defaults };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(defaults) as Array<keyof AllSettings>) {
    const d = defaults[k];
    const v = r[k];
    if (v === undefined) continue;
    if (Array.isArray(d)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) (out as any)[k] = v.slice(0, 200);
    } else if (typeof v === typeof d) (out as any)[k] = v;
  }
  if (!['dark', 'light', 'hc', 'auto'].includes(out.theme)) out.theme = DEFAULT_SETTINGS.theme;
  out.fontSize = Math.min(40, Math.max(8, Math.round(out.fontSize)));
  out.tabSize = Math.min(8, Math.max(1, Math.round(out.tabSize)));
  out.historyPerFile = Math.min(500, Math.max(0, Math.round(out.historyPerFile)));
  // Prefixes as compared: trimmed, lower case, each once.
  const prefixes = (l: string[]) => [...new Set(l.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  out.firstPartyOff = prefixes(out.firstPartyOff);
  out.firstPartyOn = prefixes(out.firstPartyOn);
  out.onlyPrefixes = prefixes(out.onlyPrefixes);
  return out;
}

export async function loadSettings(env: string): Promise<AllSettings> {
  return cleanSettings(await idbGet('kv', env + '|settings').catch(() => null));
}

export const saveSettings = (env: string, s: AllSettings) => idbSet('kv', env + '|settings', s);

/** Any value of the workspace (open editors, layout, expanded folders…), or `fallback` when missing or unreadable. */
export async function loadValue<T>(env: string, name: string, fallback: T, check: (v: unknown) => boolean = () => true): Promise<T> {
  try {
    const v = await idbGet<T>('kv', `${env}|${name}`);
    return v !== undefined && check(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export const saveValue = (env: string, name: string, v: unknown) => idbSet('kv', `${env}|${name}`, v);

// ------------------------------------------------------------------ drafts

/** A draft as stored or as another manager tab sent it: anything else is left alone. */
export const isDraft = (d: any): d is Draft =>
  !!d &&
  typeof d === 'object' &&
  typeof d.key === 'string' &&
  typeof d.name === 'string' &&
  typeof d.type === 'number' &&
  (d.text === undefined || typeof d.text === 'string') &&
  (d.b64 === undefined || typeof d.b64 === 'string') &&
  (d.base == null || (typeof d.base === 'object' && typeof d.base.b64 === 'string'));

export async function loadDrafts(env: string): Promise<Draft[]> {
  const rows = await idbEntries<Draft>('drafts', env + '|');
  return rows.map(([, d]) => d).filter(isDraft);
}

/** One draft as stored now (undefined when there is none). */
export async function loadDraft(env: string, key: string): Promise<Draft | undefined> {
  const d = await idbGet<Draft>('drafts', `${env}|${key}`).catch(() => undefined);
  return isDraft(d) ? d : undefined;
}

export const saveDraft = (env: string, d: Draft) => idbSet('drafts', `${env}|${d.key}`, d);
export const deleteDraft = (env: string, key: string) => idbDel('drafts', `${env}|${key}`);

// ------------------------------------------------------------------ local history

export type HistoryKind = 'opened' | 'saved' | 'published' | 'before-save' | 'before-publish' | 'before-delete' | 'theirs' | 'pulled' | 'restored' | 'local-file' | 'snapshot';

export interface HistoryEntry {
  /** Unique: "<key>|<time padded>". */
  id: string;
  /** The web resource's id (or draft key). */
  key: string;
  name: string;
  type: WrType;
  at: number;
  kind: HistoryKind;
  /** Who made this version on the server, when known. */
  by?: string;
  /** The content (base64 of the bytes, exactly). */
  b64: string;
  hash: string;
  size: number;
  note?: string;
}

const KIND_LABEL: Record<HistoryKind, string> = {
  opened: 'Opened',
  saved: 'Saved',
  published: 'Published',
  'before-save': 'Server version before saving',
  'before-publish': 'Live before publishing',
  'before-delete': 'Before deleting',
  theirs: "Someone else's version",
  pulled: 'Read from server',
  restored: 'Restored',
  'local-file': 'From a local file',
  snapshot: 'Snapshot',
};
export const historyKindLabel = (k: HistoryKind) => KIND_LABEL[k] ?? k;

/** A version without its content: what the lists show. */
export type HistoryMeta = Omit<HistoryEntry, 'b64'>;

const isEntry = (e: any): e is HistoryEntry => !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.b64 === 'string' && typeof e.at === 'number';
const isMeta = (e: any): e is HistoryMeta =>
  !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.key === 'string' && typeof e.name === 'string' && typeof e.at === 'number' && typeof e.hash === 'string';

// Each version is kept twice under the environment's key: whole ("<env>|<key>|<time>"), and as its description
// ("<env>|#|<key>|<time>"), written and deleted in the same transaction. Lists and the bookkeeping of a new version read
// the descriptions only: a file's versions can be megabytes each, and a save must not read them all.
const META = '#|';
const contentKey = (env: string, id: string) => `${env}|${id}`;
const metaKey = (env: string, id: string) => `${env}|${META}${id}`;

function metaOf(e: HistoryEntry): HistoryMeta {
  const m: HistoryMeta = { id: e.id, key: e.key, name: e.name, type: e.type, at: e.at, kind: e.kind, hash: e.hash, size: e.size };
  if (e.by !== undefined) m.by = e.by;
  if (e.note !== undefined) m.note = e.note;
  return m;
}

/**
 * The versions kept for one web resource (`key`), or for every one (''), newest first, without their content. A
 * version an older build kept without a description gets one now (its content is read this once); a description whose
 * version is gone (an older build deleted it) is dropped.
 */
export async function historyList(env: string, key = ''): Promise<HistoryMeta[]> {
  const contentPrefix = key ? `${env}|${key}|` : `${env}|`;
  const metaPrefix = `${env}|${META}${key ? key + '|' : ''}`;
  const r = await idbTx('history', 'readonly', (s) => ({ keys: s.getAllKeys(idbPrefix(contentPrefix)), metas: s.getAll(idbPrefix(metaPrefix)) }));
  if (!r) return [];
  const ids = new Set<string>();
  for (const k of r.value.keys.result) {
    const id = String(k).slice(env.length + 1);
    if (!id.startsWith(META)) ids.add(id);
  }
  const out: HistoryMeta[] = [];
  const orphans: string[] = [];
  for (const m of r.value.metas.result as unknown[]) {
    if (!isMeta(m)) continue;
    if (ids.delete(m.id)) out.push(m);
    else orphans.push(m.id);
  }
  if (ids.size) {
    const got = await idbTx('history', 'readonly', (s) => [...ids].map((id) => s.get(contentKey(env, id))));
    const found = (got?.value || []).map((q) => q.result).filter(isEntry).map(metaOf);
    out.push(...found);
    if (found.length) void idbTx('history', 'readwrite', (s) => found.forEach((m) => s.put(m, metaKey(env, m.id))));
  }
  if (orphans.length) void idbTx('history', 'readwrite', (s) => orphans.forEach((id) => s.delete(metaKey(env, id))));
  return out.sort((a, b) => b.at - a.at);
}

/** One version with its content (undefined when it is no longer kept). */
export async function historyEntry(env: string, id: string): Promise<HistoryEntry | undefined> {
  const e = await idbGet<HistoryEntry>('history', contentKey(env, id)).catch(() => undefined);
  return isEntry(e) ? e : undefined;
}

/** Every version of one web resource with its content, newest first (reads them all: for a few small ones). */
export async function historyOf(env: string, key: string): Promise<HistoryEntry[]> {
  const rows = await idbEntries<HistoryEntry>('history', `${env}|${key}|`);
  return rows
    .map(([, e]) => e)
    .filter(isEntry)
    .sort((a, b) => b.at - a.at);
}

/**
 * The versions a web resource keeps no longer when it keeps `keep`: the oldest beyond that number. Kept whatever their
 * number: the newest "before deleting" version and the newest of someone else's (a conflict), each the only copy left of
 * what the server no longer has (a deleted file; their version, once "keep mine" saved over it).
 */
export function prunable<M extends Pick<HistoryMeta, 'id' | 'at' | 'kind'>>(list: M[], keep: number): M[] {
  const sorted = list.slice().sort((a, b) => b.at - a.at);
  const kept = new Set<string>();
  for (const kind of ['before-delete', 'theirs'] as HistoryKind[]) {
    const newest = sorted.find((m) => m.kind === kind);
    if (newest) kept.add(newest.id);
  }
  return sorted.slice(Math.max(1, keep)).filter((m) => !kept.has(m.id));
}

/** Additions to the history of one web resource run one after another: each prunes what the one before kept. */
const adding = new Map<string, Promise<unknown>>();

/**
 * Adds a version to the local history, unless it is the same content as the newest entry. Keeps at most `keep`
 * entries per web resource (the oldest go first; see prunable). Returns the entry, or null when it was the same content
 * or could not be stored.
 */
export function addHistory(env: string, e: Omit<HistoryEntry, 'id' | 'hash' | 'size'>, keep: number): Promise<HistoryEntry | null> {
  if (keep <= 0) return Promise.resolve(null);
  const k = `${env}|${e.key}`;
  const run = (adding.get(k) ?? Promise.resolve()).then(() => addNow(env, e, keep));
  const tail = run.catch(() => undefined);
  adding.set(k, tail);
  void tail.then(() => adding.get(k) === tail && adding.delete(k));
  return run;
}

async function addNow(env: string, e: Omit<HistoryEntry, 'id' | 'hash' | 'size'>, keep: number): Promise<HistoryEntry | null> {
  const hash = fingerprint(e.b64);
  const list = await historyList(env, e.key);
  if (list[0]?.hash === hash && list[0].kind === e.kind) return null;
  // Two versions of the same moment never take each other's place.
  let at = e.at;
  const id = (t: number) => `${e.key}|${String(t).padStart(15, '0')}`;
  while (list.some((m) => m.id === id(at))) at++;
  const entry: HistoryEntry = { ...e, at, id: id(at), hash, size: Math.floor((e.b64.length * 3) / 4) };
  const stored = await idbTx('history', 'readwrite', (s) => {
    s.put(entry, contentKey(env, entry.id));
    s.put(metaOf(entry), metaKey(env, entry.id));
  });
  if (!stored) return null;
  const drop = prunable([metaOf(entry), ...list], keep);
  if (drop.length)
    await idbTx('history', 'readwrite', (s) => {
      for (const m of drop) {
        s.delete(contentKey(env, m.id));
        s.delete(metaKey(env, m.id));
      }
    });
  return entry;
}

/** Deletes one version. */
export const deleteHistory = (env: string, id: string) =>
  idbTx('history', 'readwrite', (s) => {
    s.delete(contentKey(env, id));
    s.delete(metaKey(env, id));
  }).then(() => undefined);

/** Deletes every version of one web resource (`key`), or of the environment (''). */
export const clearHistory = (env: string, key = '') =>
  idbTx('history', 'readwrite', (s) => {
    s.delete(idbPrefix(key ? `${env}|${key}|` : `${env}|`));
    if (key) s.delete(idbPrefix(`${env}|${META}${key}|`));
  }).then(() => undefined);

// ------------------------------------------------------------------ others' changes saved over

/**
 * A change someone else saved, not published, that a save of this user then went over: the saved version still holds
 * it (Dataverse keeps one saved version and names only its last writer), so publishing makes it live too.
 */
export interface OthersChange {
  by: string;
  byId: string;
  /** When they saved it (modifiedon of their version). */
  at: string;
}

const isOthers = (v: unknown): v is Record<string, OthersChange[]> =>
  !!v && typeof v === 'object' && Object.values(v).every((l) => Array.isArray(l) && l.every((c) => c && typeof c.by === 'string' && typeof c.byId === 'string' && typeof c.at === 'string'));

/** Per web resource id: the changes of others its saved version holds, until it is published. */
export const loadOthers = (env: string) => loadValue<Record<string, OthersChange[]>>(env, 'others-saved', {}, isOthers);
export const saveOthers = (env: string, v: Record<string, OthersChange[]>) => saveValue(env, 'others-saved', v);

/** Asks the browser to keep the manager's storage when it runs low on space (best effort). */
export async function persistStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export { storageEstimate };

// This browser's own storage for the manager (IndexedDB of the environment's origin): unsaved drafts, local history,
// settings, the workspace (open editors, layout) and local folder links. Nothing here ever leaves the browser.
// Every read and write tolerates a blocked or broken database (private windows, storage turned off): the manager then
// works as before, only without remembering anything, and says so once.

const DB = 'web-resources-manager';
const VERSION = 1;
export const STORES = ['kv', 'drafts', 'history', 'handles'] as const;
export type StoreName = (typeof STORES)[number];

let opening: Promise<IDBDatabase | null> | null = null;
/** The connection once open: writes then start at once, in the same task (see tx). */
let conn: IDBDatabase | null = null;
let broken = '';

/** Why storage is not available ('' when it is). */
export const storageProblem = () => broken;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB, VERSION);
    } catch (e) {
      broken = `This browser does not allow the manager to keep anything (${(e as Error)?.message || 'storage blocked'}).`;
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => {
      const db = req.result;
      const forget = () => {
        if (conn === db) conn = null;
        opening = null;
      };
      // Another tab with a newer build upgrades the database: this one lets go and opens again on its next use.
      db.onversionchange = () => {
        db.close();
        forget();
      };
      // The browser closed it (site data cleared): opened again on the next use.
      db.onclose = forget;
      conn = db;
      resolve(db);
    };
    req.onerror = () => {
      broken = `This browser does not allow the manager to keep anything (${req.error?.message || 'storage blocked'}).`;
      resolve(null);
    };
    req.onblocked = () => {
      broken = 'Another tab holds an older version of the manager open: close it to let this one keep drafts and history.';
      resolve(null);
    };
  });
  return opening;
}

/**
 * Runs one request in a transaction. With the database open, the transaction starts in the caller's own task (not a
 * step later), and a write is committed at once instead of when the task ends: the manager's frame is removed right
 * after it is closed, and the page may be leaving, and a write not committed by then is lost (a write started and
 * committed before is kept).
 */
function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | undefined): Promise<T | undefined> {
  return idbTx(store, mode, run).then((r) => r?.value?.result);
}

/**
 * Runs several requests in one transaction of a store: reads see one state of it, writes are stored all or none (and
 * committed at once, as in tx). `run` makes the requests and returns what the caller reads afterwards (the requests
 * themselves: their `result` is set once the transaction completed) as `value`. Null when the transaction failed.
 */
export function idbTx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => T): Promise<{ value: T } | null> {
  if (conn) return inTx(conn, store, mode, run);
  return open().then((db) => inTx(db, store, mode, run));
}

function inTx<T>(db: IDBDatabase | null, store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => T): Promise<{ value: T } | null> {
  return new Promise<{ value: T } | null>((resolve) => {
    if (!db) return resolve(null);
    let t: IDBTransaction;
    try {
      t = db.transaction(store, mode);
    } catch (e) {
      // A connection closed meanwhile (another tab upgraded the database): opened again for the next request.
      if (conn === db) {
        conn = null;
        opening = null;
      }
      broken = `Storage failed: ${(e as Error)?.message}`;
      return resolve(null);
    }
    let settled = false;
    const done = (v: { value: T } | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let out: T;
    t.oncomplete = () => done({ value: out });
    t.onerror = () => {
      broken = `Storage failed: ${t.error?.message || 'unknown error'}`;
      done(null);
    };
    t.onabort = () => {
      // QuotaExceededError lands here: the manager goes on without keeping this one.
      broken = `Storage failed: ${t.error?.message || 'the browser refused to keep more data'}`;
      done(null);
    };
    try {
      out = run(t.objectStore(store));
      if (mode === 'readwrite') (t as IDBTransaction & { commit?: () => void }).commit?.();
    } catch (e) {
      // A value that can't be stored (DataCloneError): nothing is written, and the transaction ends.
      broken = `Storage failed: ${(e as Error)?.message}`;
      try {
        t.abort();
      } catch {
        /* already ended */
      }
      done(null);
    }
  });
}

/** A key range of every key that starts with `prefix`. */
export const idbPrefix = (prefix: string) => IDBKeyRange.bound(prefix, prefix + '￿');

export const idbGet = <T = unknown>(store: StoreName, key: string) => tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
export const idbSet = (store: StoreName, key: string, value: unknown) => tx(store, 'readwrite', (s) => void s.put(value, key)).then(() => undefined);
export const idbDel = (store: StoreName, key: string) => tx(store, 'readwrite', (s) => void s.delete(key)).then(() => undefined);

/** Every [key, value] whose key starts with `prefix`. */
export async function idbEntries<T = unknown>(store: StoreName, prefix: string): Promise<Array<[string, T]>> {
  const range = idbPrefix(prefix);
  // Keys and values in one transaction: a write of another tab between two reads would pair them wrongly.
  const r = await idbTx(store, 'readonly', (s) => ({ keys: s.getAllKeys(range), values: s.getAll(range) as IDBRequest<T[]> }));
  const keys = r?.value.keys.result;
  const values = r?.value.values.result;
  if (!keys || !values || values.length !== keys.length) return [];
  return keys.map((k, i) => [String(k), values[i]] as [string, T]);
}

/** Deletes every key that starts with `prefix`. */
export const idbClear = (store: StoreName, prefix: string) => tx(store, 'readwrite', (s) => void s.delete(idbPrefix(prefix))).then(() => undefined);

/** How much this origin stores and may store, in bytes (estimates; 0 when unknown). */
export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  try {
    const e = await navigator.storage?.estimate?.();
    return { usage: e?.usage || 0, quota: e?.quota || 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

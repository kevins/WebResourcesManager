// Dataverse Web API client: same-origin fetch with the user's session cookie (or, on the maker portal, the portal's own
// access token for the environment), bounded concurrency, and retries that are safe for the request type.
// Follows the client of Dynamics Translator (src/core/http.ts) and the request guard of Unmanaged Layer Scanner.

export class DvError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = '',
    readonly url = '',
    /** The answer's x-ms-service-request-id ('' when none): what Microsoft support asks for. */
    readonly requestId = '',
    /** The request was a write (not a GET, not an idempotent POST). */
    readonly write = false,
    /** The seconds the answer's Retry-After asked to wait (0 when it named none). */
    readonly retryAfter = 0,
  ) {
    super(message);
    this.name = 'DvError';
  }
}

/** The signed-in session is gone (expired cookie, sign-in redirect, expired maker portal token). */
export class SessionError extends DvError {
  constructor(message: string, url = '') {
    super(message, 401, 'session', url);
    this.name = 'SessionError';
  }
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: unknown;
  /** Raw body (e.g. multipart $batch). When set, `body` is ignored. */
  raw?: string;
  signal?: AbortSignal;
  /** Annotations to request, e.g. 'OData.Community.Display.V1.FormattedValue' or '*'. */
  annotations?: string;
  /** Page size for collection GETs. */
  maxPageSize?: number;
  /** Return headers (and the status) too: `{ data, headers, status }`. */
  withHeaders?: boolean;
  /** Return the response body as text instead of parsing it as JSON (multipart $batch answers). */
  text?: boolean;
  /** A non-GET request that is safe to send twice (a $batch of reads, a function call): read slots and read retries. */
  idempotent?: boolean;
  /** A GET that changes something (RemoveActiveCustomizations): treated as a write, never sent twice. */
  unsafe?: boolean;
  /** Never sent again, not even when Dataverse turned it away unrun: its caller reads afresh before trying again. */
  once?: boolean;
  /**
   * A write that is safe to send again when Dataverse answers that another customization operation holds the lock
   * (PublishXml: "Cannot start another [PublishXml] because there is a previous [PublishAll] running").
   */
  lockRetry?: boolean;
  /** Ends a read with no full answer after this many ms (default 180 s); writes never time out (they may have run). */
  timeoutMs?: number;
  /** Short words for the Output log ('Save new_/app.js'); the method and address are logged anyway. */
  label?: string;
}

/** One request inside a $batch. */
export interface BatchPart {
  method: Method;
  /** Relative to the Web API root, or absolute. */
  url: string;
  headers?: Record<string, string>;
  /** JSON body (PATCH, POST, PUT). */
  body?: unknown;
}

/** The answer to one $batch part. */
export interface PartResult {
  ok: boolean;
  /** HTTP status of the part; 0 when the part's answer was missing or unreadable. */
  status: number;
  /** Parsed JSON body (null for none, e.g. 204). */
  data: any;
  error?: string;
  code?: string;
  /** Part headers, lower-cased names. */
  headers: Record<string, string>;
}

/** One finished request, for the Output panel. */
export interface LogEntry {
  at: number;
  method: Method;
  /** The address relative to the Web API root (absolute for any other). */
  path: string;
  status: number;
  ms: number;
  label?: string;
  error?: string;
  requestId?: string;
  attempt: number;
}

export interface HttpStats {
  requests: number;
  failures: number;
  ms: number;
}

/**
 * How requests are signed in. `session`: the page's own cookie (a page of the environment). `token`: a bearer token read
 * for every request (the maker portal's sign-in to the environment); null or '' when there is no usable token any more.
 */
export type Auth = { kind: 'session' } | { kind: 'token'; token: () => string | null; expired: string };

/** Counting semaphore. */
class Gate {
  private q: Array<() => void> = [];
  private n = 0;
  constructor(public max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.n >= this.max) await new Promise<void>((r) => this.q.push(r));
    this.n++;
    try {
      return await fn();
    } finally {
      this.n--;
      this.q.shift()?.();
    }
  }
  get busy(): number {
    return this.n + this.q.length;
  }
}

/** Waits `ms`; rejects with an AbortError when `signal` aborts first. */
export const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const stop = () => (clearTimeout(t), reject(abortError()));
    const t = setTimeout(() => (signal?.removeEventListener('abort', stop), resolve()), ms);
    signal?.addEventListener('abort', stop, { once: true });
  });

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const abortError = () => new DOMException('The operation was cancelled.', 'AbortError');
export const isAbort = (e: unknown) => (e instanceof DOMException || e instanceof Error) && (e as Error).name === 'AbortError';

/** Another customization operation (a publish, an import) holds the organization-wide lock: the request did not run. */
export const isLockError = (e: unknown): boolean =>
  e instanceof DvError &&
  (/^0x8004f06[1-7]$|^0x80071151$|^0x80090412$|^0x8004026c$|^0x8004ed47$/i.test(e.code) || /cannot start another|customizationlock|previous \[|is running/i.test(e.message));

/**
 * Dataverse turned the request away without running it: throttled (429, 503 with Retry-After) or the customization
 * lock is held. A write that got this is safe to send again.
 */
export const turnedAway = (e: unknown): boolean =>
  e instanceof DvError && (e.status === 429 || (e.status === 503 && (!e.write || e.retryAfter > 0)) || isLockError(e));

/** A write that failed may still have run: its answer was lost (network failure, gateway or server error). */
export const mayHaveRun = (e: unknown): boolean =>
  !isAbort(e) && !(e instanceof SessionError) && (!(e instanceof DvError) || ((e.status === 0 || e.status >= 500) && !turnedAway(e)));

/** A concurrency check failed: the row changed since the ETag sent with If-Match was read. */
export const isPreconditionFailed = (e: unknown): boolean => e instanceof DvError && e.status === 412;

export const isNotFound = (e: unknown): boolean => e instanceof DvError && e.status === 404;

/**
 * This version of Dataverse doesn't offer the request (an older one without RetrieveUnpublishedMultiple on that table,
 * for example): it answers 400, 404 or 501. Only then may a read fall back to something else; any other failure is
 * a failure, and is said so.
 */
export const notOffered = (e: unknown): boolean => e instanceof DvError && (e.status === 400 || e.status === 404 || e.status === 501);

export class Http {
  /** `https://<org>.crm.dynamics.com/api/data/v9.2/` (`https://<server>/<org>/api/data/v9.x/` on premises without IFD) */
  readonly api: string;
  readonly reads = new Gate(6);
  readonly writes = new Gate(2);
  readonly stats: HttpStats = { requests: 0, failures: 0, ms: 0 };
  /** Called for every finished attempt (the Output panel). */
  onLog: ((e: LogEntry) => void) | null = null;
  /** Called when the session is found expired (once per SessionError thrown). */
  onSessionLost: ((e: SessionError) => void) | null = null;
  /** Requests started and not finished (waiting for a slot, pausing or in flight). */
  live = 0;
  /** Writes started and not finished: closing the app or leaving the page while one runs is refused or warned about. */
  liveWrites = 0;

  constructor(
    readonly origin: string,
    readonly auth: Auth = { kind: 'session' },
    readonly version = '9.2',
  ) {
    this.origin = origin.replace(/\/+$/, '');
    this.api = `${this.origin}/api/data/v${version}/`;
  }

  get<T = any>(path: string, o: RequestOptions = {}): Promise<T> {
    return this.req<T>('GET', path, o);
  }
  post<T = any>(path: string, body?: unknown, o: RequestOptions = {}): Promise<T> {
    return this.req<T>('POST', path, { ...o, body });
  }
  patch<T = any>(path: string, body: unknown, o: RequestOptions = {}): Promise<T> {
    return this.req<T>('PATCH', path, { ...o, body });
  }
  put<T = any>(path: string, body: unknown, o: RequestOptions = {}): Promise<T> {
    return this.req<T>('PUT', path, { ...o, body });
  }
  del<T = any>(path: string, o: RequestOptions = {}): Promise<T> {
    return this.req<T>('DELETE', path, o);
  }

  /**
   * Follows @odata.nextLink and returns every row. Throws when an answer isn't a collection: one that can't be read
   * never reads as no rows.
   */
  async all<T = any>(path: string, o: RequestOptions = {}): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>([this.url(path)]);
    let next = path;
    for (let pages = 0; next; pages++) {
      if (pages > 5000) throw new DvError('Dataverse kept sending more pages than any list can have.', 0, 'pages', this.url(path));
      const url = next;
      const page: unknown = await this.get(url, o);
      const rows = isRecord(page) ? page.value : undefined;
      const link = isRecord(page) ? page['@odata.nextLink'] : undefined;
      next = link == null ? '' : this.nextLink(link, seen);
      if (!Array.isArray(rows) || (link != null && !next))
        throw new DvError('Dataverse sent an answer that could not be read (not a list of rows).', 0, 'unreadable', this.url(url));
      out.push(...(rows as T[]));
    }
    return out;
  }

  /** The address a nextLink names when it is this environment's, not followed before; '' otherwise. */
  private nextLink(link: unknown, seen: Set<string>): string {
    if (typeof link !== 'string' || !link) return '';
    const url = this.url(link);
    if (!this.mine(url) || seen.has(url)) return '';
    seen.add(url);
    return url;
  }

  /** The address of a path: relative to the Web API root, or absolute. */
  url(path: string): string {
    return /^https?:/i.test(path) ? path : this.api + path.replace(/^\/+/, '');
  }

  /**
   * True when `url` is this environment's Web API (the only place requests may go). The path is compared without case:
   * an on-premises server may write the organization in its own case in the links it sends (/test/ for /Test/).
   */
  mine(url: string): boolean {
    try {
      const u = new URL(url);
      const api = new URL(this.api);
      return u.origin === api.origin && u.pathname.toLowerCase().startsWith(api.pathname.toLowerCase()) && !u.pathname.includes('//');
    } catch {
      return false;
    }
  }

  /**
   * Sends `parts` as one multipart $batch (no changesets) with continue-on-error, returning one result per part in
   * order. Throws only when the batch as a whole failed.
   */
  async batch(parts: BatchPart[], o: { signal?: AbortSignal; idempotent?: boolean; label?: string } = {}): Promise<PartResult[]> {
    if (!parts.length) return [];
    const b = `batch_${crypto.randomUUID()}`;
    const r = await this.req<{ data: string; headers: Headers }>('POST', '$batch', {
      raw: buildBatch(this.api, b, parts),
      text: true,
      withHeaders: true,
      signal: o.signal,
      idempotent: o.idempotent,
      label: o.label,
      headers: { 'Content-Type': `multipart/mixed; boundary=${b}`, Prefer: 'odata.continue-on-error' },
    });
    const out = parseBatch(r.data, r.headers.get('Content-Type') || '').slice(0, parts.length);
    while (out.length < parts.length) out.push({ ok: false, status: 0, data: null, error: 'Dataverse sent no answer for this part of the request.', headers: {} });
    return out;
  }

  /**
   * Sends writes as one changeset: one transaction, all of them or none (Dataverse rolls back on the first failure).
   * No GET may be part of it. Throws the failing part's error; returns one result per part on success.
   */
  async changeset(parts: BatchPart[], o: { label?: string } = {}): Promise<PartResult[]> {
    if (!parts.length) return [];
    if (parts.some((p) => p.method === 'GET')) throw new DvError('A changeset can only hold writes.', 400, 'changeset');
    const b = `batch_${crypto.randomUUID()}`;
    const c = `changeset_${crypto.randomUUID()}`;
    const r = await this.req<{ data: string; headers: Headers; status: number }>('POST', '$batch', {
      raw: buildChangeset(this.api, b, c, parts),
      text: true,
      withHeaders: true,
      once: true,
      label: o.label,
      // The changeset stays all or nothing either way. With continue-on-error the batch answers 200 and the failing
      // request's own error (its code, for explain()) is a part of the answer; without it the whole batch answers 400
      // with that part inside a multipart body (toError reads it there too).
      headers: { 'Content-Type': `multipart/mixed; boundary=${b}`, Prefer: 'odata.continue-on-error' },
    });
    const out = parseBatch(r.data, r.headers.get('Content-Type') || '');
    const failed = out.find((p) => !p.ok);
    if (failed) throw new DvError(failed.error || 'The changes were not made.', failed.status, failed.code || '', '', '', true);
    if (out.length < parts.length) throw new DvError('Dataverse did not confirm every change.', 0, 'changeset', '', '', true);
    return out;
  }

  /**
   * Sends one request. Reads (GET, or `idempotent`) are retried on throttling, gateway errors and network failures.
   * Writes are retried only when Dataverse says it did not run them (429, 503 with Retry-After, or the customization
   * lock with `lockRetry`), so a write is never applied twice; a write sent `once` is not retried at all.
   *
   * Every request is sent with `cache: 'no-store'` and `x-ms-sw-skipcache: 1`, which the model-driven app's service
   * worker checks first and then leaves the request alone: no cached answer can ever stand in for the server's own
   * (a stale web resource would hide someone else's change from the concurrency check). `redirect: 'manual'`, so an
   * expired session's sign-in redirect reads as that, not as an HTML page where JSON was expected.
   */
  async req<T = any>(method: Method, path: string, o: RequestOptions = {}): Promise<T> {
    const url = this.url(path);
    if (!this.mine(url)) throw new DvError(`Blocked: ${url.slice(0, 120)} is not this environment's Web API.`, 0, 'blocked', url);
    const read = (method === 'GET' && !o.unsafe) || !!o.idempotent;
    const gate = read ? this.reads : this.writes;
    this.live++;
    if (!read) this.liveWrites++;
    try {
      return await gate.run(() => this.attempts<T>(method, url, read, o));
    } finally {
      this.live--;
      if (!read) this.liveWrites--;
    }
  }

  private async attempts<T>(method: Method, url: string, read: boolean, o: RequestOptions): Promise<T> {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      if (o.signal?.aborted) throw abortError();
      const prefer: string[] = [];
      if (o.annotations) prefer.push(`odata.include-annotations="${o.annotations}"`);
      if (o.maxPageSize) prefer.push(`odata.maxpagesize=${o.maxPageSize}`);
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        'x-ms-sw-skipcache': '1',
        // Documented way to never get a cached answer (304) from the Web API.
        ...(method === 'GET' ? { 'If-None-Match': 'null' } : {}),
        ...(prefer.length ? { Prefer: prefer.join(',') } : {}),
        ...(o.raw === undefined && o.body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        ...o.headers,
      };
      if (this.auth.kind === 'token') {
        const t = this.auth.token();
        if (!t) throw this.lost(new SessionError(this.auth.expired, url));
        headers.Authorization = 'Bearer ' + t;
      }
      // A read ends after its time limit (or with the caller's signal); a write is never ended early by a timer.
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      o.signal?.addEventListener('abort', onAbort, { once: true });
      let late = false;
      const timer = read ? setTimeout(() => ((late = true), ctl.abort()), o.timeoutMs ?? 180_000) : 0;
      const t0 = performance.now();
      let res: Response | null = null;
      let text = '';
      let netError: unknown = null;
      try {
        this.stats.requests++;
        res = await fetch(url, {
          method,
          headers,
          credentials: this.auth.kind === 'token' ? 'omit' : 'same-origin',
          cache: 'no-store',
          redirect: 'manual',
          body: o.raw !== undefined ? o.raw : o.body !== undefined ? JSON.stringify(o.body) : undefined,
          signal: ctl.signal,
        });
        text = res.status === 204 || res.type === 'opaqueredirect' ? '' : await res.text();
      } catch (e) {
        netError = e;
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
      }
      const ms = performance.now() - t0;
      this.stats.ms += ms;
      if (o.signal?.aborted) throw abortError();
      if (late) {
        this.log(method, url, 0, ms, o, attempt, 'no answer in time');
        throw new DvError(`Dataverse did not answer within ${Math.round((o.timeoutMs ?? 180_000) / 1000)} seconds.`, 408, 'timeout', url);
      }
      if (netError || !res) {
        this.stats.failures++;
        this.log(method, url, 0, ms, o, attempt, 'network error');
        // A failed write may or may not have reached the server, so only reads are sent again.
        if (read && attempt < 3) {
          await pause(500 * 2 ** attempt, o.signal);
          continue;
        }
        throw new DvError(`Could not reach Dataverse (${(netError as Error)?.message || 'network error'}).`, 0, 'network', url, '', !read);
      }
      const requestId = res.headers.get('x-ms-service-request-id') || '';
      if (res.type === 'opaqueredirect' || res.status === 401) {
        this.stats.failures++;
        this.log(method, url, res.status || 302, ms, o, attempt, 'signed out', requestId);
        // The maker portal may have renewed its token meanwhile: one more try with whatever it holds now.
        if (this.auth.kind === 'token' && !renewed) {
          renewed = true;
          attempt--;
          continue;
        }
        throw this.lost(new SessionError(this.auth.kind === 'token' ? this.auth.expired : 'Your Dynamics session has expired. Reload the page, sign in again, then click the bookmark.', url));
      }
      if (res.ok) {
        this.log(method, url, res.status, ms, o, attempt, '', requestId);
        let data: any = text;
        if (!o.text) {
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            // A sign-in page or a proxy's error page where JSON was expected.
            if (/^\s*</.test(text)) throw this.lost(new SessionError('Dataverse answered with a web page instead of data: your session has probably expired. Reload the page and sign in again.', url));
            throw new DvError('Dataverse sent an answer that could not be read.', res.status, 'unreadable', url, requestId, !read);
          }
        }
        if (o.withHeaders) return { data, headers: res.headers, status: res.status } as T;
        return data as T;
      }
      this.stats.failures++;
      const retryAfter = Number(res.headers.get('Retry-After')) || 0;
      const err = toError(res.status, text, url, requestId, !read, retryAfter, res.headers.get('Content-Type') || '');
      this.log(method, url, res.status, ms, o, attempt, err.message, requestId);
      const throttled = res.status === 429 || (res.status === 503 && retryAfter > 0);
      const lock = !read && o.lockRetry && isLockError(err);
      if (((throttled || lock) && !o.once && attempt < 6) || (read && [502, 503, 504].includes(res.status) && attempt < 4) || (read && res.status === 500 && attempt < 1)) {
        await pause(Math.min(60, retryAfter > 0 ? retryAfter : lock ? 5 * (attempt + 1) : 2 ** attempt) * 1000, o.signal);
        continue;
      }
      throw err;
    }
  }

  private lost(e: SessionError): SessionError {
    try {
      this.onSessionLost?.(e);
    } catch {
      /* a listener's failure is not the request's */
    }
    return e;
  }

  private log(method: Method, url: string, status: number, ms: number, o: RequestOptions, attempt: number, error = '', requestId = ''): void {
    if (!this.onLog) return;
    try {
      this.onLog({ at: Date.now(), method, path: url.startsWith(this.api) ? url.slice(this.api.length) : url, status, ms: Math.round(ms), label: o.label, error: error || undefined, requestId: requestId || undefined, attempt });
    } catch {
      /* logging never breaks a request */
    }
  }

  /**
   * Builds a function URL with parameter aliases, e.g.
   * fn('RetrieveDependenciesForDelete', { ObjectId: { guid }, ComponentType: 61 })
   */
  fn(name: string, params: Record<string, unknown> = {}, bound = ''): string {
    const keys = Object.keys(params);
    const sig = keys.map((k, i) => `${k}=@p${i}`).join(',');
    const qs = keys.map((k, i) => `@p${i}=${encodeURIComponent(literal(params[k]))}`).join('&');
    return `${bound ? bound + '/' : ''}${name}(${sig})${qs ? '?' + qs : ''}`;
  }
}

/** A GUID parameter value for Http.fn (written without quotes). */
export const guidParam = (id: string) => ({ __guid: id });

/** OData literal for a function parameter alias. */
function literal(v: unknown): string {
  if (isRecord(v) && typeof v.__guid === 'string') return v.__guid;
  if (typeof v === 'string') {
    if (/^Microsoft\.Dynamics\.CRM\.\w+'.*'$/.test(v)) return v; // enum literal already formatted
    return `'${v.replace(/'/g, "''")}'`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function toError(status: number, text: string, url: string, requestId: string, write: boolean, retryAfter: number, contentType = ''): DvError {
  let msg = '';
  let code = '';
  // A $batch that failed as a whole (a changeset sent without continue-on-error answers 400): the failing request's
  // own answer, with its code and message, is a part of the multipart body.
  const failed = /^\s*multipart\/mixed/i.test(contentType) ? failedPart(text, contentType) : null;
  if (failed) {
    msg = failed.error || '';
    code = failed.code || '';
    if (failed.status >= 400) status = failed.status;
  } else
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || '';
      code = j?.error?.code || '';
    } catch {
      msg = /^\s*</.test(text) ? '' : text.slice(0, 300);
    }
  if (status === 403 && !msg) msg = 'You do not have permission to do this.';
  if (status === 412 && !msg) msg = 'The row was changed by someone else since it was read.';
  if (status === 429 && !msg) msg = 'Dataverse is busy (too many requests). Try again in a minute.';
  if (status === 414 || (status === 404 && url.length > 8000)) msg = 'The request is too long for Dataverse.';
  return new DvError(msg || `Dataverse returned HTTP ${status}.`, status, code, url, requestId, write, retryAfter);
}

/** The first part of a multipart answer that failed, or null (none failed, or the body isn't a readable batch answer). */
function failedPart(text: string, contentType: string): PartResult | null {
  try {
    return parseBatch(text, contentType).find((p) => !p.ok) || null;
  } catch {
    return null;
  }
}

// ---- $batch ----

const NL = '\r\n';

/** JSON with every non-ASCII character escaped: a $batch part has no charset of its own. */
export const asciiJson = (v: unknown): string => JSON.stringify(v).replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/** Control characters: a line break in a part's request line or headers would start another header. */
const CTL = /[\x00-\x1f\x7f]/;

/** The multipart/mixed body of a $batch (no changesets: each part runs on its own, in order). */
export function buildBatch(api: string, boundary: string, parts: BatchPart[]): string {
  const abs = (u: string) => (/^https?:/i.test(u) ? u : api + u);
  for (const p of parts)
    if (CTL.test(p.url) || Object.entries(p.headers || {}).some(([k, v]) => CTL.test(k) || CTL.test(String(v))))
      throw new DvError('A request was not sent: it holds a control character where none can be.', 400, 'batch-part');
  return (
    parts
      .map((p) => {
        const head = [
          `${p.method} ${abs(p.url)} HTTP/1.1`,
          'Accept: application/json',
          ...(p.body !== undefined ? ['Content-Type: application/json'] : []),
          ...Object.entries(p.headers || {}).map(([k, v]) => `${k}: ${v}`),
        ];
        return `--${boundary}${NL}Content-Type: application/http${NL}Content-Transfer-Encoding: binary${NL}${NL}${head.join(NL)}${NL}${NL}${p.body !== undefined ? asciiJson(p.body) : ''}`;
      })
      .join(NL) + `${NL}--${boundary}--${NL}`
  );
}

/** The body of a $batch holding one changeset (parts numbered with Content-ID from 1). */
export function buildChangeset(api: string, batch: string, changeset: string, parts: BatchPart[]): string {
  const abs = (u: string) => (/^https?:/i.test(u) || u.startsWith('$') ? u : api + u);
  for (const p of parts)
    if (CTL.test(p.url) || Object.entries(p.headers || {}).some(([k, v]) => CTL.test(k) || CTL.test(String(v))))
      throw new DvError('A request was not sent: it holds a control character where none can be.', 400, 'batch-part');
  const inner = parts
    .map((p, i) => {
      const head = [
        `${p.method} ${abs(p.url)} HTTP/1.1`,
        'Accept: application/json',
        ...(p.body !== undefined ? ['Content-Type: application/json; type=entry'] : []),
        ...Object.entries(p.headers || {}).map(([k, v]) => `${k}: ${v}`),
      ];
      return `--${changeset}${NL}Content-Type: application/http${NL}Content-Transfer-Encoding: binary${NL}Content-ID: ${i + 1}${NL}${NL}${head.join(NL)}${NL}${NL}${p.body !== undefined ? asciiJson(p.body) : ''}`;
    })
    .join(NL);
  return `--${batch}${NL}Content-Type: multipart/mixed; boundary=${changeset}${NL}${NL}${inner}${NL}--${changeset}--${NL}--${batch}--${NL}`;
}

/** Splits a multipart/mixed $batch answer into one result per part (answers come in request order); a changeset's
 * answers (multipart inside the batch) are flattened into the same list. */
export function parseBatch(text: string, contentType: string): PartResult[] {
  const b = /boundary="?([^";\s]+)/i.exec(contentType)?.[1];
  if (!b) throw new DvError('Dataverse sent an unexpected answer to a batch request.', 0, 'batch');
  const out: PartResult[] = [];
  for (const seg of text.split('--' + b)) {
    const nested = /^\s*Content-Type:\s*multipart\/mixed;\s*boundary="?([^";\s]+)/im.exec(seg);
    if (nested && seg.indexOf(nested[0]) < seg.search(/HTTP\/\d/)) {
      out.push(...parseBatch(seg, `multipart/mixed; boundary=${nested[1]}`));
      continue;
    }
    const m = /^HTTP\/\d(?:\.\d)? (\d{3})[^\r\n]*$/m.exec(seg);
    if (!m) continue; // preamble and closing delimiter
    const rest = seg.slice(m.index + m[0].length);
    const j = rest.search(/\r?\n\r?\n/);
    const headers: Record<string, string> = {};
    for (const line of (j < 0 ? rest : rest.slice(0, j)).split(/\r?\n/)) {
      const k = line.indexOf(':');
      if (k > 0) headers[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim();
    }
    const raw = j < 0 ? '' : rest.slice(j).trim();
    const status = Number(m[1]);
    let data: any = null;
    try {
      if (raw) data = JSON.parse(raw);
    } catch {
      out.push({ ok: false, status: 0, data: null, error: 'Dataverse sent an unreadable answer.', headers });
      continue;
    }
    out.push(
      status < 300
        ? { ok: true, status, data, headers }
        : { ok: false, status, data, error: data?.error?.message || `Dataverse returned HTTP ${status}.`, code: data?.error?.code || '', headers },
    );
  }
  return out;
}

/** Removes braces and lower-cases a GUID. */
export const guid = (s: unknown): string => String(s ?? '').replace(/[{}]/g, '').toLowerCase();

/** A GUID as guid() returns it: what an id taken from the page or a file must be before it goes into a URL. */
export const isGuid = (s: string): boolean => /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(s);

/** A table's logical name: what a name from a file or the page must be before it goes into a URL. */
export const isLogicalName = (s: string): boolean => /^[a-z\d_]{1,128}$/.test(s);

/** Escapes a string for use inside an OData single-quoted literal. */
export const q = (s: string): string => s.replace(/'/g, "''");

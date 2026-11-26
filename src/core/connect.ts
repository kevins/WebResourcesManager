// Where the manager runs and how it talks to the environment.
//   - A page of the environment (https://<org>.crm.dynamics.com/main.aspx…, or any other of its pages): requests go to
//     the same origin with the page's own session cookie, exactly as the app's own requests do. On an on-premises
//     server reached without IFD the organization is the first part of the path (https://server/<org>/main.aspx), and
//     so it is in the Web API's address and in the key of this browser's drafts: the server answers an address without
//     it for the user's default organization, which may be another one.
//   - The maker portal (https://make.powerapps.com/environments/<id>/…): the portal keeps its own Dataverse sign-in (an
//     access token per environment) in this browser's local storage and renews it while the portal is used. The
//     manager borrows that token for this one environment only: it reads it for each request, sends it only to that
//     environment's address, and never stores, shows or exports it (as Unmanaged Layer Scanner does).

import { DvError, Http, guid, isGuid } from './http';
import { pageFormOf } from './pageform';

/** Host names of Dataverse environments in every cloud (commercial, GCC, GCC High, DoD, China). */
export const DATAVERSE_HOST = /\.(dynamics\.com|microsoftdynamics\.us|dynamics\.cn|appsplatform\.us|microsoftdynamics\.de)$/i;
/** Host names of the maker portal (commercial, preview, GCC, GCC High, DoD, China). */
export const MAKER_HOST = /^make\.(preview\.)?(gov\.|high\.)?powerapps\.(com|us|cn)$|^make\.apps\.appsplatform\.us$/i;

export interface Conn {
  http: Http;
  kind: 'env' | 'maker';
  /**
   * The environment's address, under which /api/data and /WebResources are: https://<org>.crm.dynamics.com, or
   * https://<server>/<org> on an on-premises server reached without IFD (the client URL).
   */
  origin: string;
  host: string;
  /** Short organization name, e.g. "contoso" (UrlName, else the first label of the host). */
  org: string;
  /** The environment's display name (FriendlyName), else `org`. */
  orgName: string;
  orgId: string;
  /** Power Platform environment id ('' if unknown): for maker portal links. */
  envId: string;
  /**
   * Production, Sandbox, Developer, Trial, Default, Teams… ('' when Dataverse doesn't say: older versions). While the
   * type could not be read (envTypeUnknown), 'Production': every Production guard holds until it is known.
   */
  envType: string;
  /**
   * The request for the environment's type failed (not answered without a type): the environment is treated as
   * Production, and the type is read again in the background. Shown as "type unknown" where the type is shown.
   */
  envTypeUnknown?: boolean;
  /** Called once a later read found the type (envType and envTypeUnknown have changed): views showing it update. */
  onEnvType?: (() => void) | null;
  /** Full Dataverse version, e.g. 9.2.25104.00184. */
  version: string;
  userId: string;
  userName: string;
  businessUnitId: string;
  baseLanguage: number;
  /** The largest file the organization accepts, in bytes (organization.maxuploadfilesize; web resource content too). */
  maxUploadBytes: number;
  /** The maker portal's address in this cloud, for links to solutions. */
  maker: string;
  /** What identifies this environment for the single-instance check and the local storage of drafts and history. */
  key: string;
  /** The page's Xrm now (null on pages without the client API: the maker portal, an apps list). */
  readonly xrm: any;
}

export type Where = { kind: 'env' } | { kind: 'maker'; envId: string } | { kind: 'none'; why: string };

/** Which kind of page `page` is. */
export function where(page: Window): Where {
  const host = page.location.hostname;
  if (MAKER_HOST.test(host)) {
    const envId = ((/\/environments\/([0-9a-z-]+)/i.exec(page.location.pathname) || [])[1] || '').toLowerCase();
    // The default environment's id is "Default-<tenant id>".
    if (!envId) return { kind: 'none', why: 'Open an environment in the maker portal (for example its Solutions page), then click the bookmark again.' };
    return { kind: 'maker', envId };
  }
  if (DATAVERSE_HOST.test(host) || findXrm(page)) return { kind: 'env' };
  return { kind: 'none', why: 'Open a page of your Dynamics 365 / Power Apps environment (https://<org>.crm.dynamics.com/…) or its Solutions page in the maker portal (make.powerapps.com), then click the bookmark again.' };
}

/**
 * The key of a page, before connecting (the single-instance check runs before any request): the host, with the
 * organization's path on an on-premises server reached without IFD (two organizations of one server keep their drafts,
 * history and settings apart).
 */
export function keyOf(page: Window, w: Where): string {
  return w.kind === 'maker' ? 'maker|' + w.envId : page.location.host.toLowerCase() + orgPathOf(page).toLowerCase();
}

/**
 * The organization's part of an environment page's address: '' online and with IFD (the host names the organization),
 * '/<org>' on an on-premises server reached without IFD. It is the path of the client API's client URL
 * (Xrm.Utility.getGlobalContext().getClientUrl(): https://server/<org>), taken only when that URL is on the page's own
 * origin and its path is plain names; '' otherwise (the organization reached is checked after WhoAmI anyway).
 */
export function orgPathOf(page: Window): string {
  let url: URL;
  try {
    url = new URL(String(findXrm(page)?.Utility?.getGlobalContext?.()?.getClientUrl?.() || ''));
  } catch {
    return '';
  }
  if (url.origin !== page.location.origin) return '';
  const path = url.pathname.replace(/\/+$/, '');
  return /^(\/[A-Za-z0-9_~-][A-Za-z0-9_.~-]*)*$/.test(path) ? path : '';
}

/** The organization the page belongs to, as its client API says ('' when it doesn't say). */
function pageOrgId(xrm: any): string {
  try {
    const id = guid(xrm?.Utility?.getGlobalContext?.()?.organizationSettings?.organizationId);
    return isGuid(id) ? id : '';
  } catch {
    return '';
  }
}

/**
 * Finds the Xrm object on the page or a same-origin frame of it (classic web client). A frame of another site can't be
 * looked into: it is skipped, never the end of the search.
 */
export function findXrm(page: Window): any {
  const w = page as any;
  try {
    if (w.Xrm?.Utility?.getGlobalContext) return w.Xrm;
  } catch {
    return null;
  }
  let frames: HTMLIFrameElement[] = [];
  try {
    frames = Array.from(page.document.querySelectorAll('iframe'));
  } catch {
    frames = [];
  }
  for (const f of frames)
    try {
      if (f.id === 'wrm-frame') continue;
      const x = (f.contentWindow as any)?.Xrm;
      if (x?.Utility?.getGlobalContext && f.style.visibility !== 'hidden') return x;
    } catch {
      /* a frame of another site */
    }
  return w.Xrm || null;
}

const TYPES: Record<string, string> = {
  Customer: 'Production',
  CustomerTest: 'Sandbox',
  CustomerFreeTest: 'Trial',
  CustomerPreview: 'Preview',
  Developer: 'Developer',
  Trial: 'Trial',
  Default: 'Default',
  Teams: 'Teams',
  Support: 'Support',
  EmailTrial: 'Trial',
  TestDrive: 'Trial',
};

/** The maker portal of the cloud a Dataverse host belongs to. */
export function makerFor(host: string): string {
  if (/\.microsoftdynamics\.us$/i.test(host)) return 'https://make.high.powerapps.us';
  if (/\.appsplatform\.us$/i.test(host)) return 'https://make.apps.appsplatform.us';
  if (/\.crm9\.dynamics\.com$/i.test(host)) return 'https://make.gov.powerapps.us';
  if (/\.dynamics\.cn$/i.test(host)) return 'https://make.powerapps.cn';
  return 'https://make.powerapps.com';
}

const CURRENT_ORG = "RetrieveCurrentOrganization(AccessType=Microsoft.Dynamics.CRM.EndpointAccessType'Default')";

/** The environment's type in words, from RetrieveCurrentOrganization's Detail ('' when it names none). */
const typeOf = (detail: any): string => TYPES[detail?.OrganizationType] ?? String(detail?.OrganizationType || '');

/**
 * The version has no RetrieveCurrentOrganization (404, or 501): it has no type to tell. Any other failure, a 400
 * included (the function is there and turned the request down), leaves the type unknown.
 */
const noTypeFunction = (e: unknown): boolean => e instanceof DvError && (e.status === 404 || e.status === 501);

/** When the environment's type could not be read at the start, it is read again this long after (ms), until it is. */
const TYPE_RETRIES = [30_000, 120_000, 600_000];

export interface ConnectOptions {
  /** Delays of the background reads of an environment type that could not be read (tests pass none). */
  typeRetries?: number[];
  /**
   * Called once the environment answering is known to be the page's (after WhoAmI), before the rest of the connection
   * is read: what the page shows can be read from then on, beside those reads.
   */
  verified?: (http: Http, xrm: any, early: Early | null) => void;
  /** The first reads, started by the bootstrap before the manager's code ran (startEarly): their answers are taken. */
  early?: Early | null;
}

/** The signed-in user, as the page's client API says ('' when it doesn't say). */
function pageUserId(xrm: any): string {
  try {
    const id = guid(xrm?.Utility?.getGlobalContext?.()?.userSettings?.userId);
    return isGuid(id) ? id : '';
  } catch {
    return '';
  }
}

/** The Web API version of an environment page: 9.0 and 9.1 servers don't have v9.2. */
function apiVersionOf(xrm: any): string {
  try {
    const m = /^(\d+)\.(\d+)/.exec(String(xrm?.Utility?.getGlobalContext?.()?.getVersion?.() || ''));
    if (m && Number(m[1]) === 9 && Number(m[2]) < 2) return `${m[1]}.${m[2]}`;
  } catch {
    /* the client API of another page type */
  }
  return '9.2';
}

/**
 * The connection's first reads, started by the bootstrap as the bookmark is clicked, while the manager's code (a few
 * megabytes) is still being run: WhoAmI, then (only once the environment answering is the page's own) its details, the
 * user, and the form the page shows. connect() and the screen take these answers instead of asking again; any that
 * failed (or a session that expired) is asked again the usual way. Reads only, sent as the Http client sends them.
 */
export interface Early {
  /** The Web API address they were read from (connect takes them only for the same). */
  api: string;
  /** WhoAmI's answer, null unless it came and is the page's organization. */
  who: Promise<any | null>;
  /** The environment's details, its organization's and the user's rows, read for the organization and user named. */
  details: Promise<{ orgId: string; userId: string; cur: any | null; org: any | null; user: any | null } | null>;
  /** The latest saved row of the page's form (formxml, name, objecttypecode, versionnumber). */
  form: { formId: string; row: Promise<any | null> } | null;
}

/** `net`: the window whose fetch sends them (the manager's frame, as the Http client's requests are sent). */
export function startEarly(page: Window, w: Where, net: Window & typeof globalThis): Early | null {
  if (w.kind !== 'env') return null;
  try {
    const xrm = findXrm(page);
    const api = `${page.location.origin}${orgPathOf(page)}/api/data/v${apiVersionOf(xrm)}/`;
    const get = (path: string): Promise<any | null> =>
      net
        .fetch(api + path, {
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'manual',
          headers: { Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0', 'x-ms-sw-skipcache': '1', 'If-None-Match': 'null' },
          signal: net.AbortSignal?.timeout?.(180_000),
        })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    const pageOrg = pageOrgId(xrm);
    const pageUser = pageUserId(xrm);
    const who = get('WhoAmI()')
      .then((x) => {
        const orgId = guid(x?.OrganizationId);
        return isGuid(guid(x?.UserId)) && isGuid(orgId) && (!pageOrg || pageOrg === orgId) ? x : null;
      })
      .catch(() => null);
    // Online the host is the organization's own, so the rest is asked at once, beside WhoAmI, for the user and the
    // organization the page names (connect takes the answers only when WhoAmI names the same). Elsewhere (on-premises,
    // where an address can answer for another organization) nothing else is asked before WhoAmI said it is the page's.
    const atOnce = DATAVERSE_HOST.test(page.location.hostname) && !!pageOrg && !!pageUser;
    const ids: Promise<{ orgId: string; userId: string } | null> = atOnce ? Promise.resolve({ orgId: pageOrg, userId: pageUser }) : who.then((x) => (x ? { orgId: guid(x.OrganizationId), userId: guid(x.UserId) } : null));
    const details = ids
      .then((i) =>
        i
          ? Promise.all([get(CURRENT_ORG), get(`organizations(${i.orgId})?$select=name,languagecode,maxuploadfilesize`), get(`systemusers(${i.userId})?$select=fullname,domainname`)]).then(([cur, org, user]) => ({ ...i, cur, org, user }))
          : null,
      )
      .catch(() => null);
    const formId = pageFormOf(xrm).formId;
    const form = formId ? { formId, row: ids.then((i) => (i ? get(`systemforms(${formId})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml,name,objecttypecode,versionnumber`) : null)).catch(() => null) } : null;
    return { api, who, details, form };
  } catch {
    return null;
  }
}

/** Connects to the environment of `page`: reads who the user is and what the organization is. */
export async function connect(page: Window, w: Where, o: ConnectOptions = {}): Promise<Conn> {
  if (w.kind === 'none') throw new Error(w.why);
  let seenXrm = findXrm(page);
  const xrmNow = () => (seenXrm = findXrm(page) ?? seenXrm);
  let http: Http;
  let kind: Conn['kind'];
  let envId = '';
  // '/<org>' on an on-premises server reached without IFD: the Web API is https://server/<org>/api/data/v9.x/.
  const orgPath = w.kind === 'env' ? orgPathOf(page) : '';
  if (w.kind === 'maker') {
    const m = await connectMaker(page, w.envId);
    http = m.http;
    kind = 'maker';
    envId = w.envId;
  } else {
    http = new Http(page.location.origin + orgPath, { kind: 'session' }, apiVersionOf(seenXrm));
    kind = 'env';
  }

  // The bootstrap's reads (startEarly) are taken when they went to this same address; a read of them that failed is
  // asked again here, so its failure is told as usual (an expired session, say).
  const early = kind === 'env' && o.early?.api === http.api ? o.early : null;
  const who = (early && (await early.who)) || (await http.get('WhoAmI()', { label: 'Who am I' }));
  const userId = guid(who.UserId);
  const orgId = guid(who.OrganizationId);
  if (!isGuid(userId) || !isGuid(orgId)) throw new DvError('Dataverse did not say who you are (WhoAmI).', 0, 'whoami');
  // The organization reached must be the page's: nothing is read or changed in another one (an on-premises server
  // answers an address without the organization for the user's default organization).
  const pageOrg = kind === 'env' ? pageOrgId(seenXrm) : '';
  if (pageOrg && pageOrg !== orgId)
    throw new DvError(
      `${http.origin} answered for a different organization from the one this page belongs to, so the manager stopped before reading or changing anything. Open the organization's own address (on an on-premises server: https://<server>/<organization>/main.aspx), then click the bookmark again.`,
      0,
      'org',
    );
  try {
    o.verified?.(http, seenXrm, early);
  } catch {
    /* the caller's early reads are a nicety */
  }
  // A version without the function has no type to tell. Any other failure leaves the type unknown, and an unknown type
  // is treated as Production: a failed read never skips a Production confirmation.
  let typeUnknown = false;
  const read = early ? await early.details : null;
  // Only answers for the user and organization WhoAmI named.
  const got = read && read.orgId === orgId && read.userId === userId ? read : null;
  const [cur, orgRow, user] = await Promise.all([
    got?.cur ??
      http.get(CURRENT_ORG, { label: 'Environment details' }).catch((e) => {
        typeUnknown = !noTypeFunction(e);
        return null;
      }),
    got?.org ?? http.get(`organizations(${orgId})?$select=name,languagecode,maxuploadfilesize`, { label: 'Organization settings' }).catch(() => null),
    got?.user ?? http.get(`systemusers(${userId})?$select=fullname,domainname`, { label: 'Your user' }).catch(() => null),
  ]);
  const detail = cur?.Detail || {};
  const host = new URL(http.origin).hostname.toLowerCase();
  const org = String(detail.UrlName || orgPath.split('/').pop() || host.split('.')[0]);
  envId = envId || guid(detail.EnvironmentId || cur?.EnvironmentId || '');
  const conn: Conn = {
    http,
    kind,
    origin: http.origin,
    host,
    org,
    orgName: String(detail.FriendlyName || orgRow?.name || org),
    orgId,
    envId,
    envType: typeUnknown ? 'Production' : typeOf(detail),
    envTypeUnknown: typeUnknown,
    onEnvType: null,
    version: String(detail.OrganizationVersion || seenXrm?.Utility?.getGlobalContext?.()?.getVersion?.() || ''),
    userId,
    userName: String(user?.fullname || user?.domainname || ''),
    businessUnitId: guid(who.BusinessUnitId),
    baseLanguage: Number(orgRow?.languagecode || 1033),
    maxUploadBytes: Number(orgRow?.maxuploadfilesize) > 0 ? Number(orgRow.maxuploadfilesize) : 5 * 1024 * 1024,
    maker: kind === 'maker' ? page.location.origin : makerFor(host),
    key: keyOf(page, w),
    get xrm() {
      return xrmNow();
    },
  };
  if (typeUnknown) readTypeLater(conn, o.typeRetries ?? TYPE_RETRIES);
  return conn;
}

/**
 * Reads the environment's type again after the first delay of `delays`, then after the next ones, until a read
 * answers. Until then the environment stays treated as Production.
 */
function readTypeLater(conn: Conn, delays: number[]): void {
  if (!delays.length) return;
  const known = (type: string, envId: string) => {
    conn.envType = type;
    conn.envTypeUnknown = false;
    conn.envId = conn.envId || envId;
    try {
      conn.onEnvType?.();
    } catch {
      /* a listener's failure is not the read's */
    }
  };
  setTimeout(() => {
    conn.http.get(CURRENT_ORG, { label: 'Environment details' }).then(
      (cur) => known(typeOf(cur?.Detail), guid(cur?.Detail?.EnvironmentId || cur?.EnvironmentId || '')),
      // A version without the function after all has no type to tell; any other failure: later again.
      (e) => (noTypeFunction(e) ? known('', '') : readTypeLater(conn, delays.slice(1))),
    );
  }, delays[0]);
}

// ------------------------------------------------------------------ sign-in on the maker portal

interface TokenEntry {
  secret: string;
  credentialType: string;
  homeAccountId: string;
  target: string;
  expiresOn: string;
}

function accessTokenEntries(page: Window): TokenEntry[] {
  const out: TokenEntry[] = [];
  let ls: Storage;
  try {
    ls = page.localStorage;
  } catch {
    return out;
  }
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i) || '';
    if (!/\|accesstoken\|/i.test(k)) continue;
    try {
      const e = JSON.parse(ls.getItem(k) || 'null');
      if (e && e.secret && String(e.credentialType).toLowerCase() === 'accesstoken') out.push(e);
    } catch {
      /* not an MSAL entry */
    }
  }
  return out;
}

const scopesOf = (e: TokenEntry) => String(e.target || '').toLowerCase().split(' ');
const forHost = (e: TokenEntry, host: string) => scopesOf(e).some((t) => t.startsWith(`https://${host}/`));

/** The token for a host, of one signed-in account (the one the environment was confirmed with), never another's. */
function makerToken(page: Window, host: string, account: string): { token: string; secondsLeft: number } | null {
  let best: TokenEntry | null = null;
  for (const e of accessTokenEntries(page)) if (String(e.homeAccountId) === account && forHost(e, host) && (!best || Number(e.expiresOn) > Number(best.expiresOn))) best = e;
  return best && { token: best.secret, secondsLeft: Number(best.expiresOn) - Math.floor(Date.now() / 1000) };
}

/**
 * The account the maker portal is using for a host: the only account with a token for it, or MSAL's active account.
 * Ambiguous when several accounts have one and none is marked active.
 */
function makerAccount(page: Window, host: string): { account: string; ambiguous: boolean } {
  const accounts = [...new Set(accessTokenEntries(page).filter((e) => forHost(e, host)).map((e) => String(e.homeAccountId)))];
  if (accounts.length <= 1) return { account: accounts[0] || '', ambiguous: false };
  try {
    const ls = page.localStorage;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i) || '';
      if (!/active-account/i.test(k)) continue;
      try {
        const a = JSON.parse(ls.getItem(k) || 'null');
        if (a && accounts.includes(String(a.homeAccountId))) return { account: String(a.homeAccountId), ambiguous: false };
      } catch {
        /* not an MSAL entry */
      }
    }
  } catch {
    /* storage blocked */
  }
  return { account: accounts[0], ambiguous: true };
}

const MAKER_EXPIRED = "The maker portal's sign-in to this environment has expired. Use the maker portal for a moment (or reload it), then try again.";

/**
 * The environment's Dataverse address on the maker portal: every address the portal holds a token for is asked for its
 * environment id, and only the one whose id is the id in the page address is used (the browser can hold tokens for
 * several environments).
 */
async function connectMaker(page: Window, envId: string): Promise<{ http: Http }> {
  const hosts = new Set<string>();
  for (const e of accessTokenEntries(page))
    for (const t of scopesOf(e)) {
      const m = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)\//.exec(t);
      if (m && DATAVERSE_HOST.test(m[1])) hosts.add(m[1]);
    }
  // The addresses this page called most recently first (the open environment's), so other environments are asked only
  // when needed.
  const last = new Map<string, number>();
  try {
    for (const r of page.performance.getEntriesByType('resource')) {
      try {
        const h = new URL(r.name).hostname.toLowerCase();
        last.set(h, Math.max(last.get(h) || 0, r.startTime + 1));
      } catch {
        /* not an address */
      }
    }
  } catch {
    /* no timing entries */
  }
  for (const host of [...hosts].sort((a, b) => (last.get(b) || 0) - (last.get(a) || 0))) {
    const { account, ambiguous } = makerAccount(page, host);
    const t = makerToken(page, host, account);
    if (!t || t.secondsLeft < 120) continue;
    try {
      const r = await fetch(`https://${host}/api/data/v9.2/RetrieveCurrentOrganization(AccessType=Microsoft.Dynamics.CRM.EndpointAccessType'Default')`, {
        credentials: 'omit',
        redirect: 'manual',
        cache: 'no-store',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + t.token },
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) continue;
      const d = (await r.json()).Detail;
      if (d && String(d.EnvironmentId).toLowerCase() === envId) {
        if (ambiguous)
          throw new Error('This browser holds the maker portal sign-in of more than one account for this environment, and the manager cannot tell which one you are using. Sign out of the other account (or use a separate browser profile), reload the page, then click the bookmark again.');
        const http = new Http(`https://${host}`, {
          kind: 'token',
          expired: MAKER_EXPIRED,
          token: () => {
            const now = makerToken(page, host, account);
            return now && now.secondsLeft > 30 ? now.token : null;
          },
        });
        return { http };
      }
    } catch (e) {
      if (e instanceof Error && /more than one account/.test(e.message)) throw e;
    }
  }
  throw new Error("The maker portal has no current sign-in to this environment's data. Wait until the Solutions list has loaded (or reload the page), then click the bookmark again.");
}

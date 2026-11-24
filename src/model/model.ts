// The manager's data model: web resources as the server has them, the local drafts made from them, and the states the
// Source Control view shows. Plain data only; the services in model/*.ts and dataverse/*.ts change it.

import type { WrType } from './types';

/** A web resource as Dataverse has it (its latest saved version: published, or saved and not published yet). */
export interface WebResource {
  id: string;
  /** Unique name, e.g. "new_/scripts/account.js". Can't change once created (renaming makes a copy). */
  name: string;
  displayName: string;
  description: string;
  type: WrType;
  /** Language of the web resource (languagecode), null when not set. */
  languageCode: number | null;
  isManaged: boolean;
  /** Managed property iscustomizable: false when its managed solution forbids changes. */
  isCustomizable: boolean;
  canBeDeleted: boolean;
  isHidden: boolean;
  enabledForMobile: boolean;
  availableOffline: boolean;
  introducedVersion: string;
  createdOn: string;
  modifiedOn: string;
  modifiedBy: string;
  modifiedById: string;
  /** Row version: changes with every saved change (the ETag's value). */
  version: string;
  /** Saved changes not published yet (the saved version differs from the published one). */
  unpublished: boolean;
  /** When the published version was last changed ('' when never published: a new web resource). */
  publishedOn: string;
  /** Who last changed the published version ('' when unknown). */
  publishedBy: string;
  /** Unique names of the solutions it is part of, when known (filled per solution scope; undefined = not read). */
  solutions?: string[];
}

/** Metadata the manager edits besides the content (what the Properties editor shows). */
export interface Props {
  displayName: string;
  description: string;
  languageCode: number | null;
  enabledForMobile: boolean;
  availableOffline: boolean;
  /** dependencyxml: the libraries and columns this web resource depends on ('' when none). */
  dependencyXml: string;
}

/** The server's content of a web resource, as read. */
export interface Content {
  /** Base64 of the bytes, exactly as Dataverse holds them. */
  b64: string;
  /** For text types: the decoded text and how it was stored. */
  text?: string;
  bom?: boolean;
  encoding?: 'utf-8' | 'windows-1252';
  eol?: '\n' | '\r\n';
  /** The version (row version, modifiedon) this content belongs to. */
  modifiedOn: string;
  /** The version's ETag (compared as text; '' when Dataverse sent none). */
  version: string;
  modifiedBy: string;
  modifiedById: string;
  /** The row's ETag as Dataverse sent it ('' when none). */
  etag: string;
  /** componentstate of the row read: 1 when it is a saved change not published yet. */
  state: number;
  props: Props;
}

/** What a draft started from: the server's version when the first edit was made. */
export interface Base {
  modifiedOn: string;
  version: string;
  /** Fingerprint of the server's content then (util.fingerprint of the base64). */
  hash: string;
  /** The server's content then, kept so the conflict view can show what changed on each side. */
  b64: string;
  props: Props;
}

/** A local, unsaved change: kept in this browser (IndexedDB) until saved or discarded. */
export interface Draft {
  /** The web resource's id, or "new:<name>" for one not created yet. */
  key: string;
  /** Present for an existing web resource. */
  id?: string;
  name: string;
  type: WrType;
  /** New text (text types), or new bytes as base64 (images and other binary types); undefined = content unchanged. */
  text?: string;
  b64?: string;
  bom?: boolean;
  /** Changed metadata; undefined = unchanged. */
  props?: Partial<Props>;
  /** null for a new web resource. */
  base: Base | null;
  /** The solution a new web resource is created in (unique name; '' = only the default solution). */
  solution?: string;
  /** When the user last changed it (a save compares it: typing during the save stays a draft). */
  updatedAt: number;
  /**
   * Which change of the draft this is: every change gets a new one. Other manager tabs of the environment compare them
   * to tell a change made on top of theirs from one made at the same time (Workspace.onPeer).
   */
  rev?: string;
}

export type ChangeKind = 'added' | 'modified' | 'conflict' | 'unpublished';

/** One row of the Source Control view. */
export interface Change {
  key: string;
  kind: ChangeKind;
  name: string;
  type: WrType;
  id?: string;
  /** What changed: content, properties, or both. */
  content: boolean;
  props: boolean;
  /** For conflicts and saved-not-published changes made by someone else: who and when. */
  by?: string;
  at?: string;
}

/** The server changed a web resource after the draft's base was read. */
export interface Conflict {
  key: string;
  id: string;
  name: string;
  /** The server's version now. */
  theirs: Content;
  base: Base;
  /** Which parts both sides changed. */
  content: boolean;
  props: (keyof Props)[];
  detectedAt: number;
}

export interface Solution {
  id: string;
  uniqueName: string;
  friendlyName: string;
  version: string;
  isManaged: boolean;
  publisherId: string;
  publisherName: string;
  /** The publisher's customization prefix, e.g. "new" (names of web resources made in this solution start "new_"). */
  prefix: string;
}

/** Which web resources the Explorer lists. */
export type Scope = { kind: 'all' } | { kind: 'solution'; solution: Solution };

export interface Filter {
  /** Text the name or display name contains (or a /regex/). */
  text: string;
  /** Types shown (empty = all). */
  types: WrType[];
  /** Show managed web resources. */
  managed: boolean;
  /** Hide Microsoft's and other first-party web resources (msdyn_, adx_, mspp_…). */
  hideMicrosoft: boolean;
  /** Only web resources with changes (drafts, conflicts, saved not published). */
  changedOnly: boolean;
  /** Show hidden web resources (the platform's own, ishidden): the list is read with them while this is on. */
  hidden: boolean;
  /** Only web resources without a language or in a language provisioned in the environment. */
  provisionedOnly: boolean;
}

/** An open editor tab. */
export interface EditorTab {
  /** Unique per tab: "wr:<key>", "diff:<key>:<left>:<right>", "conflict:<key>", "props:<key>", "welcome", "settings"… */
  id: string;
  kind: 'resource' | 'diff' | 'conflict' | 'props' | 'welcome' | 'settings' | 'forms' | 'unused' | 'refs' | 'image' | 'resx' | 'icons' | 'layers' | 'history' | 'local';
  /** The draft / web resource key the tab is about ('' for none). */
  key: string;
  title: string;
  /** Preview tab (italic title): replaced by the next file opened from a single click. */
  preview: boolean;
  pinned?: boolean;
  /** Kind-specific: for a diff, which versions are compared; for history, the entry; for forms, the table… */
  arg?: any;
}

export interface Settings {
  theme: 'dark' | 'light' | 'hc' | 'auto';
  fontSize: number;
  minimap: boolean;
  wordWrap: boolean;
  tabSize: number;
  insertSpaces: boolean;
  /** Format a script with js-beautify (or XML formatter) when saving. */
  formatOnSave: boolean;
  /** Publish right after saving (saves and publishes as one step). */
  publishOnSave: boolean;
  /** Confirm before publishing (always on in Production). The conflict check before saving can't be turned off. */
  confirmPublish: boolean;
  /** Hide Microsoft's and other first-party web resources (MICROSOFT_PREFIXES) in the Explorer. */
  hideMicrosoft: boolean;
  /** Show managed web resources in the Explorer. */
  showManaged: boolean;
  /** Check scripts as you type: syntax errors and the Dynamics rules (editor/lint.ts). */
  lint: boolean;
  /** Rules that are off (rule ids). */
  lintOff: string[];
  /** Rules that are off by default and turned on (rule ids). */
  lintOn: string[];
  /** Keep up to this many versions per web resource in local history. */
  historyPerFile: number;
  /** Add new web resources to this solution (unique name) when no solution is picked. */
  defaultSolution: string;
  /** Compact folders in the Explorer (a/b/c on one row). */
  compactFolders: boolean;
  /** Reopen the editors that were open the last time the manager ran in this environment. */
  restoreEditors: boolean;
  /** Read-only mode: nothing can be saved, published or deleted (for looking around in Production). */
  readOnly: boolean;
}

/**
 * Settings of what the Explorer lists, kept with the others (same storage, same export). They are a type of their own
 * because the Settings editor lists every key of Settings with its controls: these are changed from the Explorer.
 */
export interface ExplorerSettings {
  /** Show hidden web resources (the platform's own) in the Explorer and Search when the manager starts. */
  showHidden: boolean;
  /** First-party prefixes of MICROSOFT_PREFIXES that are not hidden here (a publisher of this environment uses one). */
  firstPartyOff: string[];
  /** More prefixes hidden with Microsoft's (another vendor's, say). */
  firstPartyOn: string[];
  /** When not empty, the Explorer and Search list only the names that start with one of these prefixes. */
  onlyPrefixes: string[];
}

export const DEFAULT_EXPLORER_SETTINGS: ExplorerSettings = { showHidden: false, firstPartyOff: [], firstPartyOn: [], onlyPrefixes: [] };

/** Every setting kept for an environment. */
export type AllSettings = Settings & ExplorerSettings;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  fontSize: 14,
  minimap: true,
  wordWrap: false,
  tabSize: 4,
  insertSpaces: true,
  formatOnSave: false,
  publishOnSave: false,
  confirmPublish: false,
  hideMicrosoft: true,
  showManaged: true,
  lint: true,
  lintOff: [],
  lintOn: [],
  historyPerFile: 30,
  defaultSolution: '',
  compactFolders: true,
  restoreEditors: true,
  readOnly: false,
};

/**
 * Prefixes of first-party web resources hidden by default (Microsoft, Portals, Field Service, Omnichannel…). Every
 * control (PCF) has a name that starts with "cc_", a customer's too: only Microsoft's own controls are first-party
 * ("cc_MscrmControls.", as the plugin's default list had it), so a publisher with the prefix "cc" keeps its files.
 */
export const MICROSOFT_PREFIXES = ['msdyn_', 'msdynce_', 'msdyncrm_', 'msdynmkt_', 'mscrm_', 'adx_', 'mspp_', 'msfp_', 'msft_', 'cc_mscrmcontrols.', 'msa_', 'msevtmgt_', 'msmkt_', 'mspcat_', 'ms_', 'msemr_', 'msnfp_', 'msvi_', 'msrex_', 'msdyusd_', 'uii_', 'msos_', 'mshh_', 'cdsl_', 'msftsec_', 'msdynsales_'];

/** A prefix as compared: lower case (names are compared without regard to case, as Dataverse does). */
const normPrefix = (p: string) => p.trim().toLowerCase();

/** The first-party prefixes with these settings: the built-in ones less those turned off, and those added. */
export function firstPartyPrefixes(s: Pick<ExplorerSettings, 'firstPartyOff' | 'firstPartyOn'>): string[] {
  const off = new Set(s.firstPartyOff.map(normPrefix));
  return [...new Set([...MICROSOFT_PREFIXES.filter((p) => !off.has(p)), ...s.firstPartyOn.map(normPrefix).filter(Boolean)])];
}

/** True when a web resource's name starts with a first-party prefix (case-insensitive): the built-in list, or `prefixes`. */
export const isMicrosoftName = (name: string, prefixes: readonly string[] = MICROSOFT_PREFIXES) => {
  const n = name.toLowerCase();
  return prefixes.some((p) => n.startsWith(p));
};

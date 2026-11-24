// Solutions: which exist, which web resources each holds, and adding web resources to one (errors reported per web
// resource: the plugin sent them in one ExecuteMultiple and never looked at the answers, so failures went unseen).

import { guid, isGuid, type BatchPart, type Http, type PartResult } from '../core/http';
import { pool } from '../core/util';
import type { Solution } from '../model/model';
import { explain } from './common';

/** The default solution's id is the same in every environment. */
export const DEFAULT_SOLUTION = 'fd140aaf-4df4-11dd-bd17-0019b9312238';
/** The "Active" solution (the unmanaged layer). */
export const ACTIVE_SOLUTION = 'fd140aae-4df4-11dd-bd17-0019b9312238';

/** Visible solutions with their publisher's prefix, unmanaged first, then by name. */
export async function listSolutions(http: Http): Promise<Solution[]> {
  const rows = await http.all(
    'solutions?$select=solutionid,uniquename,friendlyname,version,ismanaged,isvisible&$expand=publisherid($select=publisherid,friendlyname,customizationprefix)&$filter=isvisible eq true',
    { label: 'Solutions' },
  );
  return rows
    // The default solution holds everything ("All web resources" shows it); "Active" is internal.
    .filter((s) => ![ACTIVE_SOLUTION, DEFAULT_SOLUTION].includes(guid(s.solutionid)) && !['default', 'active'].includes(String(s.uniquename).toLowerCase()))
    .map((s) => ({
      id: guid(s.solutionid),
      uniqueName: String(s.uniquename || ''),
      friendlyName: String(s.friendlyname || s.uniquename || ''),
      version: String(s.version || ''),
      isManaged: !!s.ismanaged,
      publisherId: guid(s.publisherid?.publisherid),
      publisherName: String(s.publisherid?.friendlyname || ''),
      prefix: String(s.publisherid?.customizationprefix || ''),
    }))
    .sort((a, b) => Number(a.isManaged) - Number(b.isManaged) || a.friendlyName.localeCompare(b.friendlyName));
}

/** The ids of the web resources in a solution. */
export async function webResourcesOf(http: Http, solutionId: string): Promise<Set<string>> {
  if (!isGuid(solutionId)) throw new Error('Not a solution id.');
  const rows = await http.all(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${solutionId} and componenttype eq 61`, { label: 'Solution components' });
  return new Set(rows.map((r) => guid(r.objectid)));
}

/** The solutions a web resource is part of (ids). */
export async function solutionsOf(http: Http, id: string): Promise<string[]> {
  if (!isGuid(id)) return [];
  const rows = await http.all(`solutioncomponents?$select=_solutionid_value&$filter=objectid eq ${id} and componenttype eq 61`, { label: 'Solutions of a web resource' });
  return rows.map((r) => guid(r._solutionid_value));
}

export interface PerItem {
  id: string;
  ok: boolean;
  error?: string;
}

const results = (ids: string[], parts: PartResult[]): PerItem[] => ids.map((id, i) => ({ id, ok: !!parts[i]?.ok, error: parts[i]?.ok ? undefined : parts[i]?.error || 'No answer.' }));

/**
 * Requests per $batch. Dataverse refuses a batch of more than 1,000 requests, and recommends small ones sent a few at a
 * time: a large selection goes in batches of this many, two at a time.
 */
export const PER_BATCH = 100;

/** How far a long run has got (web resources done of all), for a progress notification. */
export type Progress = (done: number, total: number) => void;

/**
 * Sends one request per web resource, PER_BATCH to a $batch (each part on its own), and returns one result per web
 * resource in order. A batch that failed as a whole fails its own web resources only, as said in their results; when
 * every batch failed that way, nothing was done and its error is thrown.
 */
async function perItem(http: Http, ids: string[], part: (id: string) => BatchPart, label: string, progress?: Progress): Promise<PerItem[]> {
  const ok = ids.filter(isGuid);
  const chunks: string[][] = [];
  for (let i = 0; i < ok.length; i += PER_BATCH) chunks.push(ok.slice(i, i + PER_BATCH));
  const failures: unknown[] = [];
  let done = 0;
  const out = await pool(chunks, 2, async (chunk, k) => {
    let r: PerItem[];
    try {
      r = results(chunk, await http.batch(chunk.map(part), { label: chunks.length > 1 ? `${label} (${k + 1} of ${chunks.length})` : label }));
    } catch (e) {
      failures.push(e);
      r = chunk.map((id) => ({ id, ok: false, error: explain(e) }));
    }
    done += chunk.length;
    progress?.(done, ok.length);
    return r;
  });
  if (failures.length && failures.length === chunks.length) throw failures[0];
  return out.flat();
}

/** Adds web resources to an unmanaged solution, one AddSolutionComponent each (in $batches, each part on its own). */
export function addToSolution(http: Http, ids: string[], uniqueName: string, progress?: Progress): Promise<PerItem[]> {
  return perItem(
    http,
    ids,
    (id) => ({ method: 'POST', url: 'AddSolutionComponent', body: { ComponentId: id, ComponentType: 61, SolutionUniqueName: uniqueName, AddRequiredComponents: false, DoNotIncludeSubcomponents: false } }),
    `Add to ${uniqueName}`,
    progress,
  );
}

/** Removes web resources from a solution (they stay in the environment). */
export function removeFromSolution(http: Http, ids: string[], uniqueName: string, progress?: Progress): Promise<PerItem[]> {
  return perItem(
    http,
    ids,
    // The documented parameter is a solutioncomponent entity; Dataverse resolves the web resource's own id there.
    (id) => ({
      method: 'POST',
      url: 'RemoveSolutionComponent',
      body: { SolutionComponent: { '@odata.type': 'Microsoft.Dynamics.CRM.solutioncomponent', solutioncomponentid: id }, ComponentType: 61, SolutionUniqueName: uniqueName },
    }),
    `Remove from ${uniqueName}`,
    progress,
  );
}

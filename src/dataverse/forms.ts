// Tables, forms and home page grids, for registering scripts on them (dataverse/formxml.ts edits their XML).
// Forms and home page grids are always read in their latest saved version (RetrieveUnpublished): both are published
// with their table, and writing back the published XML would throw away changes saved in the form designer and not
// published yet (the plugin's behaviour). When that version can't be read, the read fails: the published one never
// stands in for it, neither to show nor to check before saving.

import { guid, isGuid, isLogicalName, q, type Http } from '../core/http';
import { etagOf, explain, patchIfUnchanged, publishTables } from './common';

export interface TableInfo {
  logicalName: string;
  displayName: string;
  isCustom: boolean;
  isCustomizable: boolean;
  /** Table icons (web resource names; '' when none). */
  iconVector: string;
  iconSmall: string;
  iconMedium: string;
  iconLarge: string;
  metadataId: string;
}

export interface FormInfo {
  id: string;
  name: string;
  table: string;
  /** systemform.type: 2 Main, 7 Quick Create, 12 Main - Interactive experience… */
  type: number;
  active: boolean;
  managed: boolean;
  customizable: boolean;
  description: string;
  /** The row version (versionnumber): a form has no modifiedon. */
  modifiedOn: string;
}

export const FORM_TYPES: Record<number, string> = { 2: 'Main', 6: 'Quick View', 7: 'Quick Create', 11: 'Card', 12: 'Main (interactive)' };
/** Form types that run form scripts. */
const SCRIPT_FORMS = [2, 7, 12];

const label = (l: any): string => l?.UserLocalizedLabel?.Label || l?.LocalizedLabels?.[0]?.Label || '';

/** Every table that has forms (not intersect tables), sorted by display name. */
export async function listTables(http: Http): Promise<TableInfo[]> {
  const r = await http.get(
    'EntityDefinitions?$select=LogicalName,DisplayName,IsCustomEntity,IsCustomizable,IsIntersect,IconVectorName,IconSmallName,IconMediumName,IconLargeName,MetadataId',
    { label: 'Tables' },
  );
  return (r.value as any[])
    .filter((e) => !e.IsIntersect)
    .map((e) => ({
      logicalName: String(e.LogicalName),
      displayName: label(e.DisplayName) || String(e.LogicalName),
      isCustom: !!e.IsCustomEntity,
      isCustomizable: e.IsCustomizable?.Value !== false,
      iconVector: e.IconVectorName || '',
      iconSmall: e.IconSmallName || '',
      iconMedium: e.IconMediumName || '',
      iconLarge: e.IconLargeName || '',
      metadataId: guid(e.MetadataId),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// systemform has no modifiedon (nor modifiedby): its row version (versionnumber) says when it changed.
const FORM_COLUMNS = 'formid,name,type,formactivationstate,objecttypecode,ismanaged,iscustomizable,description,versionnumber';

function toForm(f: any): FormInfo {
  return {
    id: guid(f.formid),
    name: String(f.name || ''),
    table: String(f.objecttypecode || ''),
    type: Number(f.type),
    active: f.formactivationstate !== 0,
    managed: !!f.ismanaged,
    customizable: f.iscustomizable?.Value !== false,
    description: String(f.description || ''),
    modifiedOn: String(f.versionnumber ?? ''),
  };
}

/**
 * The forms of a table that can run scripts (main, quick create, main interactive), in their latest saved version.
 * A failure is the caller's to show: the published list would miss the forms never published.
 */
export async function listForms(http: Http, table: string): Promise<FormInfo[]> {
  if (!isLogicalName(table)) throw new Error(`${table} is not a table name.`);
  const filter = `objecttypecode eq '${q(table)}' and (${SCRIPT_FORMS.map((t) => `type eq ${t}`).join(' or ')})`;
  const rows = await http.all(`systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=${FORM_COLUMNS}&$filter=${filter}`, { label: `Forms of ${table}` });
  return rows.map(toForm).sort((a, b) => a.type - b.type || a.name.localeCompare(b.name));
}

export interface FormXml {
  id: string;
  name: string;
  table: string;
  xml: string;
  /** The row version (versionnumber): a form has no modifiedon. */
  modifiedOn: string;
  etag: string;
}

/** A form's latest saved XML. */
export async function getFormXml(http: Http, id: string): Promise<FormXml> {
  if (!isGuid(guid(id))) throw new Error('Not a form id.');
  return formXmlOf(id, await readForm(http, guid(id)));
}

/** A form's row as readForm reads it (the bootstrap's early read of the page's form too: core/connect.ts startEarly). */
export function formXmlOf(id: string, r: any): FormXml {
  return { id: guid(id), name: String(r.name || ''), table: String(r.objecttypecode || ''), xml: String(r.formxml || ''), modifiedOn: String(r.versionnumber ?? ''), etag: etagOf(r) };
}

/**
 * A form's latest saved row: what edits start from, what the check before saving compares with, and what a save is
 * verified against. Only ever RetrieveUnpublished: the published row in its place would make the check compare the
 * published form with a base that is the published form too, and the save would wipe out a change saved in the form
 * designer and not published yet. An error goes to the caller: the form isn't shown, or isn't saved (its edits stay).
 */
function readForm(http: Http, id: string): Promise<any> {
  return http.get(`systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml,name,objecttypecode,versionnumber`, { label: 'Form XML' });
}

/**
 * Saves a form's XML, only if nobody saved the form since `base` was read (ConflictError otherwise). Doesn't publish:
 * call publishTables afterwards.
 */
export async function saveFormXml(http: Http, form: FormXml, xml: string): Promise<void> {
  await patchIfUnchanged(
    http,
    `systemforms(${form.id})`,
    { formxml: xml },
    () => readForm(http, form.id),
    (row) => String(row.versionnumber ?? '') === form.modifiedOn && String(row.formxml || '') === form.xml,
    `Save form ${form.name}`,
  );
}

export interface GridConfig {
  id: string;
  table: string;
  xml: string;
  modifiedOn: string;
}

/** The events XML of a grid row (a row that has none yet reads as the empty document). */
const gridXml = (row: any): string => String(row?.eventsxml || '<customControlDefaultConfig></customControlDefaultConfig>');

/**
 * The home page grid's events of a table (customcontroldefaultconfig), in their latest saved version, or null when the
 * table has none. Like forms, they are published with their table (RetrieveUnpublishedMultiple is bound to them): a
 * plain read gives the published events, and saving edits made on those would throw away events saved and not
 * published yet. No fallback to the published row either: a failure goes to the caller.
 */
export async function getGridConfig(http: Http, table: string): Promise<GridConfig | null> {
  if (!isLogicalName(table)) throw new Error(`${table} is not a table name.`);
  const rows = await http.all(
    `customcontroldefaultconfigs/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=customcontroldefaultconfigid,eventsxml,primaryentitytypecode,modifiedon&$filter=primaryentitytypecode eq '${q(table)}'`,
    { label: `Grid events of ${table}` },
  );
  const row = rows[0];
  if (!row) return null;
  return { id: guid(row.customcontroldefaultconfigid), table, xml: gridXml(row), modifiedOn: String(row.modifiedon || '') };
}

/**
 * Saves a grid's events, only if nobody saved them since `g` was read (ConflictError otherwise): the check reads the
 * latest saved version and compares its XML as well as its time (two saves in the same second have the same
 * modifiedon). Doesn't publish: call publishTables afterwards.
 */
export async function saveGridConfig(http: Http, g: GridConfig, xml: string): Promise<void> {
  if (!isGuid(guid(g.id))) throw new Error('Not a grid id.');
  const id = guid(g.id);
  await patchIfUnchanged(
    http,
    `customcontroldefaultconfigs(${id})`,
    { eventsxml: xml },
    () => http.get(`customcontroldefaultconfigs(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=eventsxml,modifiedon`, { label: `Grid events of ${g.table}` }),
    (row) => String(row.modifiedon || '') === g.modifiedOn && gridXml(row) === g.xml,
    `Save grid events of ${g.table}`,
  );
}

export interface FormUse {
  form: FormInfo;
  /** The form lists the library, and/or calls it from handlers. */
  library: boolean;
  handlers: number;
}

export interface FormsUsing {
  forms: FormInfo[];
  /**
   * Why the latest saved forms could not be searched ('' when they were): the list holds the published forms that use
   * the script, and may miss forms saved and not published yet.
   */
  incomplete: string;
}

/**
 * Forms that reference a web resource by name: as a library, a handler's library, or in a web resource / IFRAME
 * control. Searched in both the published and the latest saved forms. When the published forms can't be searched the
 * error is thrown, so that an empty list always means no form uses it; when only the latest saved ones can't, the
 * forms found come back with the reason (`incomplete`).
 */
export async function formsUsing(http: Http, name: string): Promise<FormsUsing> {
  const filter = `contains(formxml,'${q(name).replace(/[%_]/g, (c) => `[${c}]`)}')`;
  const sel = `$select=${FORM_COLUMNS}&$filter=${filter}`;
  const [pub, unpub] = await Promise.allSettled([
    http.all(`systemforms?${sel}`, { label: `Forms using ${name}` }),
    http.all(`systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?${sel}`, { label: `Unpublished forms using ${name}` }),
  ]);
  if (pub.status === 'rejected') throw pub.reason;
  const byId = new Map<string, FormInfo>();
  for (const f of [...pub.value, ...(unpub.status === 'fulfilled' ? unpub.value : [])]) byId.set(guid(f.formid), toForm(f));
  return {
    forms: [...byId.values()].sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name)),
    incomplete: unpub.status === 'rejected' ? explain(unpub.reason) : '',
  };
}

/** The forms formsUsing finds (for IntelliSense, which only needs their tables); its errors are thrown. */
export async function formsReferencing(http: Http, name: string): Promise<FormInfo[]> {
  return (await formsUsing(http, name)).forms;
}

export { publishTables };

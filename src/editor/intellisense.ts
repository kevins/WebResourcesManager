// Connects the Xrm IntelliSense (editor/xrm.ts) and the outline (editor/outline.ts) to the environment: the columns
// offered inside getAttribute("…") are those of the tables whose forms use the script being edited (or, for a script
// no form uses yet, the table of the Dynamics page the manager was opened on), and the tables are the environment's.

import { isLogicalName } from '../core/http';
import { formsReferencing, listTables } from '../dataverse/forms';
import type { Workspace } from '../model/workspace';
import type { monaco } from './monaco';
import { registerOutline } from './outline';
import { registerXrmLanguageFeatures, type FieldName, type TableName } from './xrm';

export function registerIntelliSense(ws: Workspace, activeName: () => string): monaco.IDisposable {
  const columns = new Map<string, Promise<FieldName[]>>();
  const tablesOfScript = new Map<string, Promise<string[]>>();
  let tables: Promise<TableName[]> | null = null;

  const columnsOf = (table: string): Promise<FieldName[]> => {
    let p = columns.get(table);
    if (!p) {
      p = ws.http
        .get(`EntityDefinitions(LogicalName='${table}')/Attributes?$select=LogicalName,DisplayName,AttributeType,AttributeOf`, { label: `Columns of ${table}` })
        .then((r) =>
          (r.value as any[])
            .filter((a) => !a.AttributeOf)
            .map((a) => ({ name: String(a.LogicalName), label: `${a.DisplayName?.UserLocalizedLabel?.Label || a.LogicalName} (${table})`, type: String(a.AttributeType || '') }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
        .catch(() => {
          columns.delete(table);
          return [] as FieldName[];
        });
      columns.set(table, p);
    }
    return p;
  };

  /** The tables a script is for: those of the forms that use it, else the page's own table. */
  const tablesFor = (name: string): Promise<string[]> => {
    let p = tablesOfScript.get(name);
    if (!p) {
      p = formsReferencing(ws.http, name)
        .then((forms) => [...new Set(forms.map((f) => f.table).filter(isLogicalName))])
        .catch(() => [] as string[])
        .then((list) => {
          if (list.length) return list;
          try {
            const page = String(ws.conn.xrm?.Utility?.getPageContext?.()?.input?.entityName || '');
            return isLogicalName(page) ? [page] : [];
          } catch {
            return [];
          }
        });
      tablesOfScript.set(name, p);
      // Forms change: ask again after five minutes.
      setTimeout(() => tablesOfScript.delete(name), 300_000);
    }
    return p;
  };

  const xrm = registerXrmLanguageFeatures({
    fields: async () => {
      const name = activeName();
      if (!name) return [];
      const list = await Promise.all((await tablesFor(name)).slice(0, 3).map(columnsOf));
      return list.flat();
    },
    tables: () => {
      if (!tables)
        tables = listTables(ws.http)
          .then((t) => t.map((x) => ({ name: x.logicalName, label: x.displayName })))
          .catch(() => {
            tables = null;
            return [];
          });
      return tables;
    },
  });
  const outline = registerOutline();
  return {
    dispose() {
      xrm.dispose();
      outline.dispose();
    },
  };
}

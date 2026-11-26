// Which record form the Dynamics page shows, from its client API (Xrm): read by the bootstrap (to start reading the
// form at once), by main.tsx and by the screen.

import { guid, isGuid, isLogicalName } from './http';

/** The table and form a page's client API (Xrm) shows (empty when it shows no record). */
export function pageFormOf(x: any): { formId: string; table: string } {
  try {
    const input = x?.Utility?.getPageContext?.()?.input;
    if (input?.pageType !== 'entityrecord') return { formId: '', table: '' };
    // The form shown first: the page's input names it only when it was opened with that form.
    const id = guid(String(x?.Page?.ui?.formSelector?.getCurrentItem?.()?.getId?.() || input.formId || ''));
    const table = String(input.entityName || '');
    return { formId: isGuid(id) ? id : '', table: isLogicalName(table) ? table : '' };
  } catch {
    // A page without the client API (the maker portal), or another version of it.
    return { formId: '', table: '' };
  }
}

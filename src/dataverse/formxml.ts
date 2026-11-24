// Script libraries and event handlers in form XML (systemform.formxml) and in a home page grid's events
// (customcontroldefaultconfig.eventsxml): read them all, and add, change, reorder or remove one, leaving everything
// else in the XML as it was. Pure functions on XML text (the browser's DOMParser; tests use xmldom).
//
// Where each handler lives (Microsoft's form XML schema, and forms saved by the form designer):
//   form OnLoad / OnSave                 /form/events/event[@name]                     (no attribute, no control)
//   column OnChange                      /form/events/event[@name='onchange'][@attribute='<column>']
//   tab TabStateChange                   /form/tabs/tab[@name]/events/event[@name='tabstatechange']
//   IFRAME OnReadyStateComplete          the cell of the control: cell/events/event[@name='onreadystatecomplete']
//   subgrid OnRecordSelect / OnChange…   /form/events/event[@control='<subgrid id>'] (OnChange with @attribute too)
//   home page grid events                /<root>/events/event[@control='Grids']
// The platform's own handlers are listed, never changed: those in <InternalHandlers> (Mscrm.Form_onload of a system
// form's library), and every handler of an event of a control that isn't a frame (a lookup's setadditionalparams). An
// event marked application="true" is the platform's, but the <Handlers> in it are ordinary handlers: Microsoft's own
// forms keep there the handlers solutions add (the Quote form's OnLoad). They are edited like any other, and a new
// handler of that event goes there too: a second <event> of the same name would run a function twice.

export type Scope =
  | { kind: 'form' }
  | { kind: 'attribute'; attribute: string }
  | { kind: 'tab'; tab: string }
  | { kind: 'control'; control: string }
  | { kind: 'grid'; control: string; attribute?: string }
  /** An event of a control in a cell that isn't an IFRAME or a web resource: the platform's only. `type`: "Lookup"… */
  | { kind: 'cell'; control: string; type: string };

export interface Handler {
  /** handlerUniqueId, as written in the XML. */
  id: string;
  /** Event name in lower case: onload, onsave, onchange, tabstatechange, onreadystatecomplete, onrecordselect… */
  event: string;
  scope: Scope;
  functionName: string;
  libraryName: string;
  enabled: boolean;
  passContext: boolean;
  /** Comma-separated parameters, as typed in the form designer ("" when none). */
  parameters: string;
  /** Column dependencies of the handler (OnSave "table column dependencies"). */
  dependencies: string[];
  /** The platform's own handler (<InternalHandlers>, or an event of a control that isn't a frame): read-only. */
  internal: boolean;
}

export interface Library {
  name: string;
  id: string;
}

export interface Targets {
  tabs: Array<{ name: string; id: string; label: string }>;
  /** Columns on the form (by datafieldname, once each), for OnChange. */
  attributes: Array<{ name: string; label: string }>;
  /** IFRAME and HTML web resource controls, for OnReadyStateComplete. */
  frames: Array<{ id: string; label: string; webResource: boolean }>;
  grids: Array<{ id: string; label: string }>;
}

export interface ParsedForm {
  libraries: Library[];
  handlers: Handler[];
  targets: Targets;
}

/** Events each kind of place supports, in the form designer's order (none of the user's on other controls in cells). */
export const EVENTS_FOR: Record<Scope['kind'], string[]> = {
  form: ['onload', 'onsave'],
  attribute: ['onchange'],
  tab: ['tabstatechange'],
  control: ['onreadystatecomplete'],
  grid: ['onrecordselect', 'onsave', 'onchange'],
  cell: [],
};

export const EVENT_LABEL: Record<string, string> = {
  onload: 'OnLoad',
  onsave: 'OnSave',
  onchange: 'OnChange',
  tabstatechange: 'TabStateChange',
  onreadystatecomplete: 'OnReadyStateComplete',
  onrecordselect: 'OnRecordSelect',
};

const CLASS_IFRAME = '{fd2a7985-3187-444e-908d-6624b21f69c0}';
const CLASS_WEBRESOURCE = '{9fdf5f91-88b1-47f4-ad53-c11efc01a01d}';
const CLASS_SUBGRID = '{e7a81278-8635-4d9e-8d4d-59480b391c5b}';
/** What the controls that have events of their own in a cell are, in words (other classes are "Control"). */
const CONTROL_TYPES: Record<string, string> = {
  '{270bd3db-d9af-4782-9025-509e298dec0a}': 'Lookup',
  '{cbfb742c-14e7-4a17-96bb-1a13f7f64aa2}': 'Lookup',
  '{f3015350-44a2-4aa0-97b5-00166532b5e9}': 'Lookup',
  [CLASS_SUBGRID]: 'Subgrid',
};
/** A form can hold at most 50 libraries, and an event at most 50 handlers (form XML schema). */
export const MAX_LIBRARIES = 50;
export const MAX_HANDLERS = 50;

export const newUniqueId = () => `{${crypto.randomUUID().toLowerCase()}}`;

const sameId = (a: string, b: string) => a.replace(/[{}]/g, '').toLowerCase() === b.replace(/[{}]/g, '').toLowerCase();
const lower = (s: string | null | undefined) => String(s ?? '').toLowerCase();

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err || !doc.documentElement) throw new Error(`The form XML could not be read: ${(err?.textContent || 'not well formed').split('\n')[0]}`);
  return doc;
}

const serialize = (doc: Document) => new XMLSerializer().serializeToString(doc);

/** Child elements of `el` with a tag name (case-sensitive, as the schema is). */
const kids = (el: Element, tag?: string): Element[] => {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (!tag || (n as Element).tagName === tag)) out.push(n as Element);
  return out;
};
const kid = (el: Element, tag: string) => kids(el, tag)[0] || null;
const all = (el: Element | Document, tag: string): Element[] => Array.from(el.getElementsByTagName(tag));

/** A label in the user's language, else the first one; '' when none. */
function labelOf(el: Element | null, lcid: number): string {
  if (!el) return '';
  const labels = kid(el, 'labels');
  if (!labels) return '';
  const ls = kids(labels, 'label');
  return (ls.find((l) => l.getAttribute('languagecode') === String(lcid)) || ls[0])?.getAttribute('description') || '';
}

/** An IFRAME or an HTML web resource: the only controls whose own events (OnReadyStateComplete) run the user's handlers. */
const isFrame = (control: Element | null) => {
  const classid = lower(control?.getAttribute('classid'));
  return classid === CLASS_IFRAME || classid === CLASS_WEBRESOURCE;
};

/** The place an <event> element belongs to. */
function scopeOf(ev: Element): Scope {
  const events = ev.parentNode as Element | null;
  const owner = events?.parentNode as Element | null;
  if (owner?.tagName === 'tab') return { kind: 'tab', tab: owner.getAttribute('name') || owner.getAttribute('id') || '' };
  if (owner?.tagName === 'cell') {
    const control = kid(owner, 'control');
    const id = control?.getAttribute('id') || '';
    // A lookup's setadditionalparams (system forms) is the platform's: it is no IFRAME, whatever its cell holds.
    return isFrame(control) ? { kind: 'control', control: id } : { kind: 'cell', control: id, type: CONTROL_TYPES[lower(control?.getAttribute('classid'))] || 'Control' };
  }
  const control = ev.getAttribute('control');
  const attribute = ev.getAttribute('attribute');
  if (control) return attribute ? { kind: 'grid', control, attribute } : { kind: 'grid', control };
  if (attribute) return { kind: 'attribute', attribute };
  return { kind: 'form' };
}

export function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'form':
      return true;
    case 'attribute':
      return lower(a.attribute) === lower((b as typeof a).attribute);
    case 'tab':
      return lower(a.tab) === lower((b as typeof a).tab);
    case 'control':
    case 'cell':
      return lower(a.control) === lower((b as typeof a).control);
    case 'grid':
      return lower(a.control) === lower((b as typeof a).control) && lower(a.attribute) === lower((b as typeof a).attribute);
  }
}

/** The platform's own handler element: in <InternalHandlers>, or on an event of a control that isn't a frame. */
function isPlatform(h: Element): boolean {
  const list = h.parentNode as Element | null;
  if (list?.tagName !== 'Handlers') return true;
  const ev = list.parentNode as Element | null;
  return ev?.tagName === 'event' && scopeOf(ev).kind === 'cell';
}

/** Reads every library, handler and place a handler can go of a form (or home page grid events XML). */
export function parseForm(xml: string, lcid = 1033): ParsedForm {
  const doc = parse(xml);
  const root = doc.documentElement;
  const libraries: Library[] = [];
  const fl = kid(root, 'formLibraries');
  if (fl) for (const l of kids(fl, 'Library')) libraries.push({ name: l.getAttribute('name') || '', id: l.getAttribute('libraryUniqueId') || '' });

  const handlers: Handler[] = [];
  for (const ev of all(doc, 'event')) {
    const event = lower(ev.getAttribute('name'));
    const scope = scopeOf(ev);
    // Whatever the event's application flag: its <Handlers> are ordinary ones (see the top of this file).
    const internal = scope.kind === 'cell';
    for (const listTag of ['Handlers', 'InternalHandlers']) {
      const list = kid(ev, listTag);
      if (!list) continue;
      for (const h of kids(list, 'Handler')) {
        const deps = kid(h, 'dependencies');
        handlers.push({
          id: h.getAttribute('handlerUniqueId') || '',
          event,
          scope,
          functionName: h.getAttribute('functionName') || '',
          libraryName: h.getAttribute('libraryName') || '',
          enabled: lower(h.getAttribute('enabled') ?? 'true') !== 'false',
          passContext: lower(h.getAttribute('passExecutionContext')) === 'true',
          parameters: h.getAttribute('parameters') || '',
          dependencies: deps ? kids(deps, 'dependency').map((d) => d.getAttribute('id') || '').filter(Boolean) : [],
          internal: internal || listTag === 'InternalHandlers',
        });
      }
    }
  }

  const targets: Targets = { tabs: [], attributes: [], frames: [], grids: [] };
  for (const t of all(doc, 'tab')) targets.tabs.push({ name: t.getAttribute('name') || '', id: t.getAttribute('id') || '', label: labelOf(t, lcid) || t.getAttribute('name') || '' });
  const seen = new Set<string>();
  for (const c of all(doc, 'control')) {
    const cell = c.parentNode as Element | null;
    const label = labelOf(cell?.tagName === 'cell' ? cell : null, lcid);
    const classid = lower(c.getAttribute('classid'));
    const id = c.getAttribute('id') || '';
    if (classid === CLASS_SUBGRID || lower(c.getAttribute('indicationOfSubgrid')) === 'true') targets.grids.push({ id, label: label || id });
    else if (classid === CLASS_IFRAME || classid === CLASS_WEBRESOURCE) targets.frames.push({ id, label: label || id, webResource: classid === CLASS_WEBRESOURCE });
    const field = c.getAttribute('datafieldname');
    if (field && !seen.has(lower(field))) {
      seen.add(lower(field));
      targets.attributes.push({ name: field, label: label || field });
    }
  }
  targets.attributes.sort((a, b) => a.label.localeCompare(b.label));
  return { libraries, handlers, targets };
}

function getOrAdd(parent: Element, tag: string): Element {
  const found = kid(parent, tag);
  if (found) return found;
  const el = parent.ownerDocument.createElement(tag);
  parent.appendChild(el);
  return el;
}

/** The <events> element a scope's events go in (created when missing). */
function eventsFor(doc: Document, scope: Scope): Element {
  const root = doc.documentElement;
  if (scope.kind === 'tab') {
    const tab = all(doc, 'tab').find((t) => lower(t.getAttribute('name')) === lower(scope.tab) || sameId(t.getAttribute('id') || '', scope.tab));
    if (!tab) throw new Error(`The form has no tab named ${scope.tab}.`);
    return getOrAdd(tab, 'events');
  }
  if (scope.kind === 'control') {
    const control = all(doc, 'control').find((c) => lower(c.getAttribute('id')) === lower(scope.control));
    const cell = control?.parentNode as Element | null;
    if (!control || cell?.tagName !== 'cell') throw new Error(`The form has no control ${scope.control}.`);
    // Any other control's event in its cell is the platform's: a handler written there would never run.
    if (!isFrame(control)) throw new Error(`${scope.control} is not an IFRAME or a web resource: only those run handlers of their own.`);
    return getOrAdd(cell, 'events');
  }
  if (scope.kind === 'cell') throw new Error(`The events of ${scope.control} are the platform's own.`);
  return getOrAdd(root, 'events');
}

/** The <event> elements of an event in a scope, among `events`'s children (usually one). */
const eventsNamed = (events: Element, scope: Scope, name: string) => kids(events, 'event').filter((e) => lower(e.getAttribute('name')) === name && sameScope(scopeOf(e), scope));

/**
 * The <event> element for an event in a scope: the one there already (the user's own first, else the platform's one of
 * that name, kept as it is: see the top of this file), else a new one.
 */
function eventFor(doc: Document, scope: Scope, name: string): Element {
  const events = eventsFor(doc, scope);
  const named = eventsNamed(events, scope, name);
  const found = named.find((e) => lower(e.getAttribute('application')) !== 'true') ?? named[0];
  if (found) return found;
  const e = doc.createElement('event');
  e.setAttribute('name', name);
  e.setAttribute('application', 'false');
  e.setAttribute('active', 'false');
  if (scope.kind === 'attribute') e.setAttribute('attribute', scope.attribute);
  if (scope.kind === 'grid') {
    e.setAttribute('relationship', '');
    e.setAttribute('control', scope.control);
    if (scope.attribute) e.setAttribute('attribute', scope.attribute);
  }
  events.appendChild(e);
  return e;
}

/** Adds a library to the form when it isn't there yet (names compare case-insensitively). */
export function addLibrary(xml: string, name: string): string {
  const doc = parse(xml);
  addLibraryTo(doc, name);
  return serialize(doc);
}

function addLibraryTo(doc: Document, name: string): void {
  const fl = getOrAdd(doc.documentElement, 'formLibraries');
  const libs = kids(fl, 'Library');
  if (libs.some((l) => lower(l.getAttribute('name')) === lower(name))) return;
  if (libs.length >= MAX_LIBRARIES) throw new Error(`A form can have at most ${MAX_LIBRARIES} libraries.`);
  const l = doc.createElement('Library');
  l.setAttribute('name', name);
  l.setAttribute('libraryUniqueId', newUniqueId());
  fl.appendChild(l);
}

/**
 * Removes a library. Refused while handlers call it, unless `withHandlers` (then those handlers go too). Always refused
 * when the platform's own handlers call it: that is a system form's own library (Account_main_system_library.js), which
 * is no web resource and which the form can't work without. Containers left empty are removed (the schema wants at least
 * one child in each).
 */
export function removeLibrary(xml: string, name: string, withHandlers = false): string {
  const doc = parse(xml);
  const users = all(doc, 'Handler').filter((h) => lower(h.getAttribute('libraryName')) === lower(name));
  if (users.some(isPlatform)) throw new Error(`The platform's own event handlers on this form call ${name}: it can't be removed.`);
  if (users.length && !withHandlers) throw new Error(`${users.length} event handler${users.length === 1 ? '' : 's'} on this form call ${name}: remove them first.`);
  for (const h of users) removeHandlerEl(h);
  const fl = kid(doc.documentElement, 'formLibraries');
  if (fl) {
    for (const l of kids(fl, 'Library')) if (lower(l.getAttribute('name')) === lower(name)) fl.removeChild(l);
    if (!kids(fl, 'Library').length) fl.parentNode?.removeChild(fl);
  }
  return serialize(doc);
}

export interface NewHandler {
  event: string;
  scope: Scope;
  functionName: string;
  libraryName: string;
  enabled?: boolean;
  passContext?: boolean;
  parameters?: string;
}

/** Function names: identifiers separated by periods (Contoso.Account.onLoad). */
export const FUNCTION_NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/** The changes that make a handler already on a form what was asked for (empty when it is that already). */
export type HandlerDiff = Partial<Pick<Handler, 'enabled' | 'passContext' | 'parameters'>>;

export interface AddedHandler {
  xml: string;
  /** The new handler's id, or the id of the one already there. */
  id: string;
  /** A handler calling the same function of the same library was on the event already: nothing was added. */
  existed: boolean;
  /**
   * When the one there has other settings than asked for (turned off, other parameters, the execution context passed or
   * not): what would make it so. It doesn't run as asked, so the caller says so rather than "it runs already".
   */
  differs?: HandlerDiff;
}

/** How a handler element differs from the one asked for. */
function diffOf(x: Element, h: NewHandler): HandlerDiff {
  const d: HandlerDiff = {};
  const enabled = h.enabled !== false;
  if ((lower(x.getAttribute('enabled') ?? 'true') !== 'false') !== enabled) d.enabled = enabled;
  const passContext = h.passContext !== false;
  if ((lower(x.getAttribute('passExecutionContext')) === 'true') !== passContext) d.passContext = passContext;
  const parameters = h.parameters ?? '';
  if ((x.getAttribute('parameters') || '') !== parameters) d.parameters = parameters;
  return d;
}

/** An event's <Handlers>, added ahead of the platform's <InternalHandlers> (the schema's order) when it has none. */
function handlersOf(ev: Element): Element {
  const found = kid(ev, 'Handlers');
  if (found) return found;
  const list = ev.ownerDocument.createElement('Handlers');
  ev.insertBefore(list, kid(ev, 'InternalHandlers'));
  return list;
}

/**
 * Adds a handler (and its library, when the form doesn't have it yet) at the end of its event's handlers. A handler
 * that calls the same function of the same library for the same event, in any <event> of that name there, is not added
 * twice: its id is returned, with how its settings differ from those asked for.
 */
export function addHandler(xml: string, h: NewHandler): AddedHandler {
  if (!FUNCTION_NAME.test(h.functionName)) throw new Error(`"${h.functionName}" is not a function name (letters, digits, _ and $, with periods between names).`);
  if (!h.libraryName) throw new Error('Choose the library that holds the function.');
  if (!EVENTS_FOR[h.scope.kind].includes(h.event)) throw new Error(`${EVENT_LABEL[h.event] || h.event} is not an event of this part of the form.`);
  const doc = parse(xml);
  const same = eventsNamed(eventsFor(doc, h.scope), h.scope, h.event)
    .flatMap((e) => {
      const list = kid(e, 'Handlers');
      return list ? kids(list, 'Handler') : [];
    })
    .filter((x) => x.getAttribute('functionName') === h.functionName && lower(x.getAttribute('libraryName')) === lower(h.libraryName));
  if (same.length) {
    // One that is just as asked for, else the first.
    const diffs = same.map((x) => diffOf(x, h));
    const i = Math.max(0, diffs.findIndex((d) => !Object.keys(d).length));
    return { xml, id: same[i].getAttribute('handlerUniqueId') || '', existed: true, ...(Object.keys(diffs[i]).length ? { differs: diffs[i] } : {}) };
  }
  const ev = eventFor(doc, h.scope, h.event);
  const list = handlersOf(ev);
  if (kids(list, 'Handler').length >= MAX_HANDLERS) throw new Error(`An event can have at most ${MAX_HANDLERS} handlers.`);
  addLibraryTo(doc, h.libraryName);
  const el = doc.createElement('Handler');
  const id = newUniqueId();
  el.setAttribute('functionName', h.functionName);
  el.setAttribute('libraryName', h.libraryName);
  el.setAttribute('handlerUniqueId', id);
  el.setAttribute('enabled', h.enabled === false ? 'false' : 'true');
  el.setAttribute('parameters', h.parameters ?? '');
  el.setAttribute('passExecutionContext', h.passContext === false ? 'false' : 'true');
  list.appendChild(el);
  return { xml: serialize(doc), id, existed: false };
}

function findHandler(doc: Document, id: string): Element {
  const h = all(doc, 'Handler').find((x) => sameId(x.getAttribute('handlerUniqueId') || '', id));
  if (!h) throw new Error('That event handler is no longer on the form (it was removed or the form changed).');
  if (isPlatform(h)) throw new Error("That handler is the platform's own and can't be changed.");
  return h;
}

/** Changes a handler's function, library, parameters or flags. */
export function updateHandler(xml: string, id: string, patch: Partial<Pick<Handler, 'functionName' | 'libraryName' | 'enabled' | 'passContext' | 'parameters'>>): string {
  const doc = parse(xml);
  const h = findHandler(doc, id);
  if (patch.functionName !== undefined) {
    if (!FUNCTION_NAME.test(patch.functionName)) throw new Error(`"${patch.functionName}" is not a function name.`);
    h.setAttribute('functionName', patch.functionName);
  }
  if (patch.libraryName !== undefined) {
    h.setAttribute('libraryName', patch.libraryName);
    addLibraryTo(doc, patch.libraryName);
  }
  if (patch.enabled !== undefined) h.setAttribute('enabled', patch.enabled ? 'true' : 'false');
  if (patch.passContext !== undefined) h.setAttribute('passExecutionContext', patch.passContext ? 'true' : 'false');
  if (patch.parameters !== undefined) h.setAttribute('parameters', patch.parameters);
  return serialize(doc);
}

function removeHandlerEl(h: Element): void {
  const list = h.parentNode as Element;
  list.removeChild(h);
  if (kids(list).length) return;
  // Handlers left empty: the event goes too (unless it holds other things), and an <events> left empty after it.
  const ev = list.parentNode as Element;
  ev.removeChild(list);
  if (kids(ev).length) return;
  const events = ev.parentNode as Element;
  events.removeChild(ev);
  if (!kids(events).length) events.parentNode?.removeChild(events);
}

/** Removes a handler (its library stays on the form). */
export function removeHandler(xml: string, id: string): string {
  const doc = parse(xml);
  removeHandlerEl(findHandler(doc, id));
  return serialize(doc);
}

/** Moves a handler up (-1) or down (+1) among its event's handlers: they run in that order. */
export function moveHandler(xml: string, id: string, delta: -1 | 1): string {
  const doc = parse(xml);
  const h = findHandler(doc, id);
  const list = h.parentNode as Element;
  const siblings = kids(list, 'Handler');
  const i = siblings.indexOf(h);
  const j = i + delta;
  if (j < 0 || j >= siblings.length) return xml;
  if (delta < 0) list.insertBefore(h, siblings[j]);
  else list.insertBefore(h, siblings[j].nextSibling);
  return serialize(doc);
}

/** Where a scope is, in words ("Form", "Column telephone1", "Tab general"…). */
export function scopeLabel(s: Scope, t?: Targets): string {
  switch (s.kind) {
    case 'form':
      return 'Form';
    case 'attribute': {
      const a = t?.attributes.find((x) => lower(x.name) === lower(s.attribute));
      return `Column ${a && a.label !== s.attribute ? `${a.label} (${s.attribute})` : s.attribute}`;
    }
    case 'tab': {
      const tab = t?.tabs.find((x) => lower(x.name) === lower(s.tab));
      return `Tab ${tab && tab.label !== s.tab ? `${tab.label} (${s.tab})` : s.tab}`;
    }
    case 'control': {
      const f = t?.frames.find((x) => lower(x.id) === lower(s.control));
      return `${f?.webResource ? 'Web resource' : 'IFRAME'} ${f && f.label !== s.control ? `${f.label} (${s.control})` : s.control}`;
    }
    case 'grid':
      return s.control === 'Grids' ? `Grid${s.attribute ? ` column ${s.attribute}` : ''}` : `Subgrid ${s.control}${s.attribute ? ` column ${s.attribute}` : ''}`;
    case 'cell': {
      // A field's control is named after its column: its label is the column's.
      const a = t?.attributes.find((x) => lower(x.name) === lower(s.control));
      return `${s.type} ${a && a.label !== s.control ? `${a.label} (${s.control})` : s.control}`;
    }
  }
}

/**
 * The libraries the platform's own handlers call, lower-cased: a system form's own library (no web resource), which
 * the form can't do without. They are listed, never removed or offered for a handler of the user's.
 */
export function platformLibraries(p: ParsedForm): Set<string> {
  return new Set(p.handlers.filter((h) => h.internal).map((h) => lower(h.libraryName)));
}

/** The names of the libraries a form references anywhere (libraries list and handlers), lower-cased. */
export function referencedLibraries(xml: string): Set<string> {
  const p = parseForm(xml);
  return new Set([...p.libraries.map((l) => lower(l.name)), ...p.handlers.map((h) => lower(h.libraryName))]);
}

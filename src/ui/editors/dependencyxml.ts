// A web resource's dependencies (webresource.dependencyxml): the web resources that load with it — mainly RESX string
// files and other scripts, which a form then loads first — and the table columns it needs (a form keeps them while
// it depends on them). Pure functions on the XML text (the browser's DOMParser; tests use xmldom). Everything the
// Properties editor doesn't edit stays exactly as it was: other component types, attributes it doesn't know, and the
// ids Dataverse gave each library.
//
//   <Dependencies>
//     <Dependency componentType="WebResource">
//       <Library name="new_/strings/app.1033.resx" displayName="app.1033.resx" languagecode="1033" description="" libraryUniqueId="{…}" />
//     </Dependency>
//     <Dependency componentType="Attribute">
//       <Attribute attributeId="{…}" attributeName="name" entityName="account" />
//     </Dependency>
//   </Dependencies>

/** Dataverse keeps at most this many characters of dependencyxml (a longer one is refused when saved). */
export const MAX_DEPENDENCY_XML = 5000;

export interface LibraryDependency {
  /** The web resource's unique name. */
  name: string;
  displayName: string;
  /** languagecode as written ('' when none). */
  languageCode: string;
  description: string;
  /** libraryUniqueId as written ('' for one added now: it gets a new id when the XML is written). */
  id: string;
}

export interface ColumnDependency {
  /** Logical name of the table (entityName). */
  table: string;
  /** Logical name of the column (attributeName). */
  column: string;
  /** attributeId: the column's MetadataId, in braces. */
  id: string;
}

export interface Dependencies {
  libraries: LibraryDependency[];
  columns: ColumnDependency[];
}

const WEB = 'webresource';
const COLUMN = 'attribute';

function parse(xml: string): Document {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch (e) {
    // xmldom throws where browsers return a <parsererror> document.
    throw new Error(`The dependencies can't be read: ${String((e as Error)?.message || e).split('\n')[0]}`);
  }
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err || !doc.documentElement) throw new Error(`The dependencies can't be read: ${(err?.textContent || 'the XML is not well formed').split('\n')[0]}`);
  if (doc.documentElement.tagName !== 'Dependencies') throw new Error(`The dependencies can't be read: the XML starts with <${doc.documentElement.tagName}>, not <Dependencies>.`);
  return doc;
}

/** Child elements of `el`, with a tag name when given (case-sensitive, as Dataverse writes them). */
function kids(el: Element, tag?: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (!tag || (n as Element).tagName === tag)) out.push(n as Element);
  return out;
}

const attr = (el: Element, name: string) => el.getAttribute(name) ?? '';
/** The <Dependency> elements of one component type (compared without regard to case). */
const groups = (root: Element, type: string) => kids(root, 'Dependency').filter((d) => attr(d, 'componentType').toLowerCase() === type);
const isBlank = (n: Node | null): n is Text => !!n && n.nodeType === 3 && !(n.nodeValue || '').trim();

export const newLibraryId = () => `{${crypto.randomUUID().toLowerCase()}}`;

/** Reads the libraries and columns of a dependencyxml ('' reads as none). Throws when the XML can't be read. */
export function parseDependencies(xml: string): Dependencies {
  const out: Dependencies = { libraries: [], columns: [] };
  if (!xml.trim()) return out;
  const root = parse(xml).documentElement;
  for (const g of groups(root, WEB))
    for (const l of kids(g, 'Library'))
      out.libraries.push({ name: attr(l, 'name'), displayName: attr(l, 'displayName'), languageCode: attr(l, 'languagecode'), description: attr(l, 'description'), id: attr(l, 'libraryUniqueId') });
  for (const g of groups(root, COLUMN)) for (const a of kids(g, 'Attribute')) out.columns.push({ table: attr(a, 'entityName'), column: attr(a, 'attributeName'), id: attr(a, 'attributeId') });
  return out;
}

/** Removes an element and the line break and indentation before it, so pretty-printed XML stays tidy. */
function remove(el: Element): void {
  const prev = el.previousSibling;
  if (isBlank(prev)) prev.parentNode?.removeChild(prev);
  el.parentNode?.removeChild(el);
}

/** Appends `el` after the last element of `parent`, with the same indentation as that one. */
function append(parent: Element, el: Element): void {
  const last = kids(parent).pop();
  if (!last) {
    parent.appendChild(el);
    return;
  }
  const next = last.nextSibling;
  const indent = last.previousSibling;
  if (isBlank(indent)) parent.insertBefore(parent.ownerDocument.createTextNode(indent.nodeValue || ''), next);
  parent.insertBefore(el, next);
}

interface Kind<T> {
  type: string;
  /** componentType of a new <Dependency> element. */
  typeName: string;
  tag: string;
  key: (t: T) => string;
  keyOf: (el: Element) => string;
  /** Attributes in the order they are written; the id attribute of an existing element is never changed. */
  attrs: (t: T) => Array<[string, string]>;
  idAttr: string;
}

/** Makes the elements of one kind match `wanted`: kept ones keep their ids and unknown attributes. */
function sync<T>(root: Element, k: Kind<T>, wanted: T[]): void {
  const doc = root.ownerDocument;
  const want = new Map<string, T>();
  for (const t of wanted) if (!want.has(k.key(t))) want.set(k.key(t), t);
  const kept = new Set<string>();
  for (const g of groups(root, k.type))
    for (const el of kids(g, k.tag)) {
      const key = k.keyOf(el);
      const t = want.get(key);
      // Gone from the list, or a second copy of one already kept.
      if (!t || kept.has(key)) {
        remove(el);
        continue;
      }
      kept.add(key);
      for (const [n, v] of k.attrs(t)) if (n !== k.idAttr && attr(el, n) !== v) el.setAttribute(n, v);
    }
  const added = [...want.entries()].filter(([key]) => !kept.has(key)).map(([, t]) => t);
  if (added.length) {
    let g = groups(root, k.type)[0];
    if (!g) {
      g = doc.createElement('Dependency');
      g.setAttribute('componentType', k.typeName);
      append(root, g);
    }
    for (const t of added) {
      const el = doc.createElement(k.tag);
      for (const [n, v] of k.attrs(t)) if (n !== k.idAttr || v) el.setAttribute(n, v);
      append(g, el);
    }
  }
  // A <Dependency> left without anything in it goes too.
  for (const g of groups(root, k.type)) if (!kids(g).length) remove(g);
}

const LIBRARY: Kind<LibraryDependency> = {
  type: WEB,
  typeName: 'WebResource',
  tag: 'Library',
  key: (l) => l.name.toLowerCase(),
  keyOf: (el) => attr(el, 'name').toLowerCase(),
  attrs: (l) => [
    ['name', l.name],
    ['displayName', l.displayName],
    ['languagecode', l.languageCode],
    ['description', l.description],
    ['libraryUniqueId', l.id || newLibraryId()],
  ],
  idAttr: 'libraryUniqueId',
};

const ATTRIBUTE: Kind<ColumnDependency> = {
  type: COLUMN,
  typeName: 'Attribute',
  tag: 'Attribute',
  key: (c) => `${c.table}.${c.column}`.toLowerCase(),
  keyOf: (el) => `${attr(el, 'entityName')}.${attr(el, 'attributeName')}`.toLowerCase(),
  attrs: (c) => [
    ['attributeId', c.id],
    ['attributeName', c.column],
    ['entityName', c.table],
  ],
  idAttr: 'attributeId',
};

/**
 * The dependencyxml with exactly these libraries and columns: the ones already there are kept as written (their ids
 * too), the others removed, new ones added with new ids. Elements and attributes of other kinds stay. Returns '' when
 * nothing is left (the column is then cleared). Throws when `xml` can't be read.
 */
export function writeDependencies(xml: string, deps: Dependencies): string {
  const doc = parse(xml.trim() ? xml : '<Dependencies />');
  const root = doc.documentElement;
  sync(root, LIBRARY, deps.libraries);
  sync(root, ATTRIBUTE, deps.columns);
  if (!kids(root).length) return '';
  return new XMLSerializer().serializeToString(doc);
}

/** Why a dependencyxml can't be saved ('' when it can). */
export function dependencyProblem(xml: string): string {
  if (xml.length > MAX_DEPENDENCY_XML) return `The dependencies take ${xml.length.toLocaleString()} characters; Dataverse keeps at most ${MAX_DEPENDENCY_XML.toLocaleString()}. Remove some before saving.`;
  return '';
}

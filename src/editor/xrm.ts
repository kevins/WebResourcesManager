// IntelliSense for the client API of model-driven apps in the script editor: members after a dot (Xrm.,
// formContext., executionContext.getEventArgs().), names of columns, controls and tables inside the quotes of
// getAttribute("..."), getControl("...") and the Xrm.WebApi calls, hovers, parameter hints, snippets, and the quick
// fixes of the manager's own rules (editor/lint.ts). This Monaco has no TypeScript worker (it doesn't fit in a
// bookmarklet), so all of it comes from the model of the API (editor/xrm-model.ts) and the resolver that reads the
// script's tokens (editor/xrm-resolve.ts). HTML web resources get the same inside their inline <script> blocks.

import { monaco } from './monaco';
import { GLOBAL, members, typeInfo, type Member, type Signature } from './xrm-model';
import { callAt, hoverAt, inCode, nameSlot, scriptView, typeAtDot, type NameSlot } from './xrm-resolve';

/** A column or control of the form the script is for, offered inside getAttribute("...") and getControl("..."). */
export interface FieldName {
  name: string;
  label: string;
  type?: string;
}

/** A table of the environment, offered inside the table argument of the Xrm.WebApi calls. */
export interface TableName {
  name: string;
  label: string;
}

export interface XrmFeatureOptions {
  /** The columns ('attribute') or controls ('control') to offer. Called while the user types: keep it cached. */
  fields?: (kind: 'attribute' | 'control') => Promise<FieldName[]>;
  /** The tables to offer. Called while the user types: keep it cached. */
  tables?: () => Promise<TableName[]>;
}

/** A quick fix of a lint marker: replace the marker's range with text. */
export interface LintFix {
  range: monaco.IRange;
  title: string;
  text: string;
}

const LANGUAGES = ['javascript', 'html'];
const CK = monaco.languages.CompletionItemKind;

// ------------------------------------------------------------------ the script of a model

interface Source {
  text: string;
  inScript: (offset: number) => boolean;
}
const sources = new WeakMap<monaco.editor.ITextModel, { key: string; src: Source }>();

/** The text the resolver reads: a script as it is; an HTML page with everything but its inline scripts blanked out. */
function sourceOf(model: monaco.editor.ITextModel): Source {
  const key = `${model.getLanguageId()}:${model.getVersionId()}`;
  const hit = sources.get(model);
  if (hit?.key === key) return hit.src;
  let src: Source;
  if (model.getLanguageId() === 'html') {
    const view = scriptView(model.getValue());
    src = { text: view.text, inScript: (o) => view.blocks.some(([s, e]) => s <= o && o <= e) };
  } else src = { text: model.getValue(), inScript: () => true };
  sources.set(model, { key, src });
  return src;
}

function rangeOf(model: monaco.editor.ITextModel, start: number, end: number): monaco.Range {
  const s = model.getPositionAt(start);
  const e = model.getPositionAt(end);
  return new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column);
}

// ------------------------------------------------------------------ docs

/** Text of the model in Markdown: characters Markdown would take for formatting are escaped. */
const md = (s: string) => s.replace(/[\\`*_<>[\]]/g, '\\$&');
const fence = (code: string) => '```ts\n' + code + '\n```';
const signatureText = (name: string, s: Signature) => `${name}(${s.params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ')}): ${s.returns}`;
const typeName = (id: string) => typeInfo(id)?.name ?? id;

/** The code line of a hover: every signature of a method, the type of a property. */
function headline(owner: string | undefined, m: Member): string {
  const prefix = owner && owner !== GLOBAL ? `${typeName(owner)}.` : '';
  if (m.kind === 'method') return m.sigs!.map((s) => `(method) ${prefix}${signatureText(m.name, s)}`).join('\n');
  if (m.kind === 'namespace') return `(namespace) ${prefix}${m.name}`;
  return `(property) ${prefix}${m.name}: ${typeName(m.type!)}`;
}

/** What a member does, why not to use it when deprecated, its parameters and its page on Microsoft Learn. */
function docOf(m: Member, withParams: boolean): string {
  const parts = [md(m.doc)];
  if (m.deprecated) parts.push(`**Deprecated:** ${md(m.deprecated)}`);
  if (withParams && m.sigs) {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const s of m.sigs)
      for (const p of s.params)
        if (p.doc && !seen.has(p.name)) {
          seen.add(p.name);
          lines.push(`- \`${p.name}\`: ${md(p.doc)}`);
        }
    if (lines.length) parts.push(lines.join('\n'));
  }
  parts.push(`[Microsoft Learn](${m.url})`);
  return parts.join('\n\n');
}

function detailOf(m: Member): string {
  if (m.kind === 'namespace') return `namespace ${typeName(m.type!)}`;
  if (m.kind === 'property') return typeName(m.type!);
  const [s, ...more] = m.sigs!;
  return signatureText(m.name, s) + (more.length ? ` (+${more.length} overload${more.length > 1 ? 's' : ''})` : '');
}

// ------------------------------------------------------------------ completions

function memberItems(type: string, range: monaco.IRange): monaco.languages.CompletionItem[] {
  return members(type).map((m) => ({
    label: m.name,
    kind: m.kind === 'namespace' ? CK.Module : m.kind === 'property' ? CK.Property : type === GLOBAL ? CK.Function : CK.Method,
    detail: detailOf(m),
    // Every overload, then what it does: the same as its hover.
    documentation: { value: fence(headline(type, m)) + '\n\n' + docOf(m, true) },
    insertText: m.name,
    range,
    // Deprecated members come after the others (and are struck through).
    sortText: (m.deprecated ? '1' : '0') + m.name,
    tags: m.deprecated ? [monaco.languages.CompletionItemTag.Deprecated] : [],
  }));
}

async function nameItems(
  opts: XrmFeatureOptions,
  slot: NameSlot,
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  token: monaco.CancellationToken,
): Promise<monaco.languages.CompletionList> {
  let names: FieldName[] = [];
  try {
    names = (slot.kind === 'table' ? await opts.tables?.() : await opts.fields?.(slot.kind)) ?? [];
  } catch (e) {
    // Without the names there is nothing to offer here; the editor goes on, and the reason is in the console.
    console.warn(`The ${slot.kind === 'table' ? 'tables' : slot.kind === 'attribute' ? 'columns' : 'controls'} to complete couldn't be read.`, e);
  }
  if (token.isCancellationRequested) return { suggestions: [] };
  const start = model.getPositionAt(slot.start);
  const end = model.getPositionAt(slot.end);
  // Typing inserts at the cursor; accepting with Tab (or Shift+Enter) replaces the whole name between the quotes.
  const range = {
    insert: new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column),
    replace: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
  };
  const kind = slot.kind === 'table' ? CK.Class : CK.Field;
  return {
    suggestions: names.map((f) => ({
      label: { label: f.name, description: f.label },
      kind,
      detail: f.type ? `${f.label} (${f.type})` : f.label,
      insertText: f.name,
      // The display name finds the logical name too.
      filterText: `${f.name} ${f.label}`,
      range,
    })),
  };
}

interface Snippet {
  label: string;
  detail: string;
  body: string[];
}

const ERROR_DIALOG = ['\tfunction (error) {', '\t\tXrm.Navigation.openErrorDialog({ message: error.message });', '\t}', ');'];

const JS_SNIPPETS: Snippet[] = [
  {
    label: 'formscript',
    detail: 'Form script in a namespace, with onLoad',
    body: [
      'var ${1:Contoso} = window.${1:Contoso} || {};',
      '',
      '(function () {',
      "\t'use strict';",
      '',
      '\t// Form OnLoad: register ${1:Contoso}.onLoad with "Pass execution context as first parameter".',
      '\tthis.onLoad = function (executionContext) {',
      '\t\tvar formContext = executionContext.getFormContext();',
      '\t\t$0',
      '\t};',
      '}).call(${1:Contoso});',
    ],
  },
  {
    label: 'onchange',
    detail: 'OnChange handler (in the namespace of formscript)',
    body: [
      'this.${1:onNameChange} = function (executionContext) {',
      '\tvar formContext = executionContext.getFormContext();',
      '\tvar ${2:value} = executionContext.getEventSource().getValue();',
      '\t$0',
      '};',
    ],
  },
  { label: 'formcontext', detail: 'The form context from the execution context', body: ['var formContext = executionContext.getFormContext();$0'] },
  {
    label: 'webapi-retrieve',
    detail: 'Xrm.WebApi.retrieveRecord',
    body: ["Xrm.WebApi.retrieveRecord('${1:account}', ${2:id}, '?\\$select=${3:name}').then(", '\tfunction (${4:record}) {', '\t\t$0', '\t},', ...ERROR_DIALOG],
  },
  {
    label: 'webapi-retrievemultiple',
    detail: 'Xrm.WebApi.retrieveMultipleRecords with $select and $filter',
    body: [
      "Xrm.WebApi.retrieveMultipleRecords('${1:account}', '?\\$select=${2:name}&\\$filter=${3:statecode eq 0}').then(",
      '\tfunction (result) {',
      '\t\tresult.entities.forEach(function (${4:record}) {',
      '\t\t\t$0',
      '\t\t});',
      '\t},',
      ...ERROR_DIALOG,
    ],
  },
  {
    label: 'webapi-create',
    detail: 'Xrm.WebApi.createRecord',
    body: ["Xrm.WebApi.createRecord('${1:account}', {", "\t${2:name}: ${3:'Contoso'}", '}).then(', '\tfunction (result) {', '\t\t// result.id is the ID of the new record.', '\t\t$0', '\t},', ...ERROR_DIALOG],
  },
  {
    label: 'webapi-update',
    detail: 'Xrm.WebApi.updateRecord',
    body: ["Xrm.WebApi.updateRecord('${1:account}', ${2:id}, {", "\t${3:name}: ${4:'Contoso'}", '}).then(', '\tfunction () {', '\t\t$0', '\t},', ...ERROR_DIALOG],
  },
  {
    label: 'webapi-delete',
    detail: 'Xrm.WebApi.deleteRecord',
    body: ["Xrm.WebApi.deleteRecord('${1:account}', ${2:id}).then(", '\tfunction () {', '\t\t$0', '\t},', ...ERROR_DIALOG],
  },
  {
    label: 'alertdialog',
    detail: 'Xrm.Navigation.openAlertDialog',
    body: ["Xrm.Navigation.openAlertDialog({ title: '${1:Title}', text: '${2:Message}' }).then(function () {", '\t$0', '});'],
  },
  {
    label: 'confirmdialog',
    detail: 'Xrm.Navigation.openConfirmDialog',
    body: ["Xrm.Navigation.openConfirmDialog({ title: '${1:Title}', text: '${2:Are you sure?}' }).then(function (result) {", '\tif (result.confirmed) {', '\t\t$0', '\t}', '});'],
  },
  {
    label: 'formnotification',
    detail: 'formContext.ui.setFormNotification',
    body: ["formContext.ui.setFormNotification('${1:Message}', '${2|INFO,WARNING,ERROR|}', '${3:notificationId}');$0"],
  },
  {
    label: 'lookup-presearch',
    detail: 'Filter a lookup: addPreSearch with addCustomFilter',
    body: [
      "formContext.getControl('${1:parentcustomerid}').addPreSearch(function () {",
      '\tvar filter = \'<filter type="and"><condition attribute="${2:statecode}" operator="eq" value="${3:0}" /></filter>\';',
      "\tformContext.getControl('${1:parentcustomerid}').addCustomFilter(filter, '${4:account}');",
      '});',
    ],
  },
];

/** The page of an HTML web resource, with ClientGlobalContext.js.aspx at the right depth for the page's name. */
function pageSnippet(model: monaco.editor.ITextModel): Snippet {
  // ClientGlobalContext.js.aspx is at the root of the web resources: one ../ for each / in the web resource's name.
  const name = model.uri.scheme === 'wr' ? model.uri.path.slice(1) : '';
  const up = '../'.repeat(name.split('/').length - 1);
  return {
    label: 'webresource',
    detail: 'HTML web resource page with ClientGlobalContext.js.aspx',
    body: [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '\t<meta charset="utf-8">',
      '\t<title>${1:Page}</title>',
      '\t<!-- GetGlobalContext() for this page. It does not bring Xrm. -->',
      `\t<script src="${up}ClientGlobalContext.js.aspx" type="text/javascript"></script>`,
      '</head>',
      '<body>',
      '\t$0',
      '\t<script>',
      '\t\tvar globalContext = GetGlobalContext();',
      '',
      '\t\t// On a form, Xrm and the form context come from the form script, as parent.Xrm is deprecated:',
      '\t\t//   formContext.getControl("WebResource_name").getContentWindow().then(function (w) { w.setClientApiContext(Xrm, formContext); });',
      '\t\tfunction setClientApiContext(xrm, formContext) {',
      '\t\t\twindow.Xrm = xrm;',
      '\t\t}',
      '\t</script>',
      '</body>',
      '</html>',
    ],
  };
}

/** A snippet's text as it is inserted with its defaults, for the documentation pane. */
const preview = (body: string) =>
  body
    .replace(/\$\{\d+\|([^,|}]*)[^}]*\}/g, '$1')
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\d+/g, '')
    .replace(/\\\$/g, '$')
    .replace(/\t/g, '    ');

function snippetItems(snippets: Snippet[], range: monaco.IRange, language: string): monaco.languages.CompletionItem[] {
  return snippets.map((s) => {
    const body = s.body.join('\n');
    return {
      label: s.label,
      kind: CK.Snippet,
      detail: s.detail,
      documentation: { value: '```' + language + '\n' + preview(body) + '\n```' },
      insertText: body,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      range,
      sortText: '2' + s.label,
    };
  });
}

function completionProvider(opts: XrmFeatureOptions): monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: ['.', '"', "'"],
    provideCompletionItems(model, position, context, token) {
      const src = sourceOf(model);
      const offset = model.getOffsetAt(position);
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      // Snippets are statements: offered where a line starts.
      const lineStart = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1).trim() === '';
      if (!src.inScript(offset)) return { suggestions: lineStart && model.getLanguageId() === 'html' ? snippetItems([pageSnippet(model)], range, 'html') : [] };
      const slot = nameSlot(src.text, offset);
      if (slot) return nameItems(opts, slot, model, position, token);
      const start = offset - (position.column - word.startColumn);
      if (src.text[start - 1] === '.') {
        const type = typeAtDot(src.text, start);
        return { suggestions: type ? memberItems(type, range) : [] };
      }
      // A quote typed outside a name, or a word in a string or a comment: nothing of the client API.
      if (context.triggerCharacter || !inCode(src.text, offset)) return { suggestions: [] };
      return { suggestions: [...memberItems(GLOBAL, range), ...(lineStart ? snippetItems(JS_SNIPPETS, range, 'js') : [])] };
    },
  };
}

// ------------------------------------------------------------------ hovers and parameter hints

const hoverProvider: monaco.languages.HoverProvider = {
  provideHover(model, position) {
    const src = sourceOf(model);
    const offset = model.getOffsetAt(position);
    if (!src.inScript(offset)) return null;
    const h = hoverAt(src.text, offset);
    if (!h) return null;
    const range = rangeOf(model, h.start, h.end);
    if (h.member) return { range, contents: [{ value: fence(headline(h.owner, h.member)) }, { value: docOf(h.member, true) }] };
    const t = typeInfo(h.type!);
    const contents = [{ value: fence(`(variable) ${h.name}: ${typeName(h.type!)}`) }];
    if (t) contents.push({ value: `${md(t.doc)}\n\n[Microsoft Learn](${t.url})` });
    return { range, contents };
  },
};

function signatureInfo(m: Member, s: Signature): monaco.languages.SignatureInformation {
  let label = `${m.name}(`;
  const parameters = s.params.map((p, i): monaco.languages.ParameterInformation => {
    if (i) label += ', ';
    const start = label.length;
    label += `${p.name}${p.optional ? '?' : ''}: ${p.type}`;
    return { label: [start, label.length], documentation: p.doc ? { value: md(p.doc) } : undefined };
  });
  label += `): ${s.returns}`;
  return { label, documentation: { value: docOf(m, false) }, parameters };
}

const signatureProvider: monaco.languages.SignatureHelpProvider = {
  signatureHelpTriggerCharacters: ['(', ','],
  signatureHelpRetriggerCharacters: [')'],
  provideSignatureHelp(model, position) {
    const src = sourceOf(model);
    const offset = model.getOffsetAt(position);
    if (!src.inScript(offset)) return null;
    const call = callAt(src.text, offset);
    if (!call) return null;
    return {
      value: { signatures: call.member.sigs!.map((s) => signatureInfo(call.member, s)), activeSignature: call.signature, activeParameter: call.parameter },
      dispose() {},
    };
  },
};

// ------------------------------------------------------------------ quick fixes of lint markers

const lintFixes = new WeakMap<monaco.editor.ITextModel, { version: number; fixes: LintFix[] }>();

/**
 * The fixes of the lint markers of a model (markers with source 'wrm'), computed from its current text. Each becomes
 * the quick fix (Ctrl+.) of the marker with the same range.
 */
export function setLintFixes(model: monaco.editor.ITextModel, fixes: Array<{ range: monaco.IRange; title: string; text: string }>): void {
  lintFixes.set(model, { version: model.getVersionId(), fixes });
}

const sameRange = (a: monaco.IRange, b: monaco.IRange) =>
  a.startLineNumber === b.startLineNumber && a.startColumn === b.startColumn && a.endLineNumber === b.endLineNumber && a.endColumn === b.endColumn;

const codeActionProvider: monaco.languages.CodeActionProvider = {
  provideCodeActions(model, _range, context) {
    const actions: monaco.languages.CodeAction[] = [];
    const entry = lintFixes.get(model);
    // A fix belongs to the text it was computed on: after an edit it waits for the next check, rather than replacing
    // a range that has moved. The edit carries that version too, so Monaco refuses it if the text changed meanwhile.
    if (entry && entry.version === model.getVersionId())
      for (const fix of entry.fixes) {
        const markers = context.markers.filter((m) => m.source === 'wrm' && sameRange(fix.range, m));
        if (!markers.length) continue;
        actions.push({
          title: fix.title,
          kind: 'quickfix',
          isPreferred: true,
          diagnostics: markers,
          edit: { edits: [{ resource: model.uri, versionId: entry.version, textEdit: { range: fix.range, text: fix.text } }] },
        });
      }
    return { actions, dispose() {} };
  },
};

// ------------------------------------------------------------------ registration

/**
 * Registers the client API IntelliSense for JavaScript and HTML models: completions (with the names `opts` gives
 * inside the quotes), hovers, parameter hints and the quick fixes set with setLintFixes. Dispose to remove it all.
 */
export function registerXrmLanguageFeatures(opts: XrmFeatureOptions = {}): monaco.IDisposable {
  const subs = [
    monaco.languages.registerCompletionItemProvider(LANGUAGES, completionProvider(opts)),
    monaco.languages.registerHoverProvider(LANGUAGES, hoverProvider),
    monaco.languages.registerSignatureHelpProvider(LANGUAGES, signatureProvider),
    monaco.languages.registerCodeActionProvider(LANGUAGES, codeActionProvider, { providedCodeActionKinds: ['quickfix'] }),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}

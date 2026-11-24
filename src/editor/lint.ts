// Checks scripts as they are edited: syntax errors (acorn, the parser the manager bundles in place of VS Code's
// TypeScript service) and rules for Dynamics 365 client scripts: deprecated client API, removed endpoints, patterns
// that block or break the model-driven app. Results become editor markers and the Problems panel's rows.
// HTML web resources are checked too: each inline <script> block, at its place in the file.

import { parse, type Node } from 'acorn';

export type Severity = 'error' | 'warning' | 'info';

export interface Fix {
  title: string;
  /** Replace the problem's range with this text. */
  text: string;
}

export interface Diagnostic {
  severity: Severity;
  message: string;
  /** Rule id ('syntax' for parse errors); rules can be turned off in the settings. */
  rule: string;
  /** 1-based lines and columns, end exclusive (Monaco's convention). */
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  fix?: Fix;
}

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  /** Off unless turned on in the settings (rules that are a matter of style). */
  defaultOff?: boolean;
}

export const RULES: Rule[] = [
  { id: 'syntax', title: 'Syntax errors', severity: 'error' },
  { id: 'module-syntax', title: 'import / export in a web resource (they load as classic scripts)', severity: 'error' },
  { id: 'xrm-page', title: 'Xrm.Page is deprecated: use the formContext from the execution context', severity: 'warning' },
  { id: 'parent-xrm', title: 'parent.Xrm from an HTML web resource is deprecated', severity: 'warning' },
  { id: 'deprecated-api', title: 'Deprecated client API methods', severity: 'warning' },
  { id: 'odata-v2', title: 'The 2011 OData endpoint (OrganizationData.svc) was removed', severity: 'error' },
  { id: 'soap', title: 'The 2011 SOAP endpoint is deprecated for web resources', severity: 'warning' },
  { id: 'sync-xhr', title: 'Synchronous requests block the app', severity: 'warning' },
  { id: 'debugger', title: 'debugger statement', severity: 'warning' },
  { id: 'eval', title: 'eval / new Function', severity: 'warning' },
  { id: 'alert', title: 'alert / confirm / prompt (use Xrm.Navigation dialogs)', severity: 'info' },
  { id: 'dom', title: 'DOM access in a form script is unsupported', severity: 'info' },
  { id: 'jquery', title: 'jQuery in a form script is unsupported', severity: 'info' },
  { id: 'console', title: 'console.log left in the script', severity: 'info', defaultOff: true },
  { id: 'globals', title: 'Functions in the global scope (use a namespace object)', severity: 'info', defaultOff: true },
];

const DEPRECATED: Array<[RegExp, string, string?]> = [
  [/(^|\.)getServerUrl$/, 'getServerUrl() is deprecated: use getClientUrl().', 'getClientUrl'],
  [/Xrm\.Utility\.alertDialog$/, 'Xrm.Utility.alertDialog is deprecated: use Xrm.Navigation.openAlertDialog.', 'Xrm.Navigation.openAlertDialog'],
  [/Xrm\.Utility\.confirmDialog$/, 'Xrm.Utility.confirmDialog is deprecated: use Xrm.Navigation.openConfirmDialog.', 'Xrm.Navigation.openConfirmDialog'],
  [/Xrm\.Utility\.openEntityForm$/, 'Xrm.Utility.openEntityForm is deprecated: use Xrm.Navigation.openForm.', 'Xrm.Navigation.openForm'],
  [/Xrm\.Utility\.openQuickCreate$/, 'Xrm.Utility.openQuickCreate is deprecated: use Xrm.Navigation.openForm with useQuickCreateForm.', 'Xrm.Navigation.openForm'],
  [/Xrm\.Utility\.openWebResource$/, 'Xrm.Utility.openWebResource is deprecated: use Xrm.Navigation.openWebResource.', 'Xrm.Navigation.openWebResource'],
  [/Xrm\.Utility\.isActivityType$/, 'Xrm.Utility.isActivityType is deprecated: use Xrm.Utility.getEntityMetadata (IsActivity).'],
  [/Xrm\.Mobile\.offline\b/, 'Xrm.Mobile.offline is deprecated: use Xrm.WebApi.offline.'],
  [/(^|\.)addOnKeyPress$/, 'addOnKeyPress is deprecated: use addOnChange.'],
  [/(^|\.)removeOnKeyPress$/, 'removeOnKeyPress is deprecated.'],
  [/(^|\.)fireOnKeyPress$/, 'fireOnKeyPress is deprecated.'],
  [/(^|\.)getUserRoles$/, 'getUserRoles() is deprecated: use globalContext.userSettings.roles.'],
  [/(^|\.)getUserId$/, 'getUserId() is deprecated: use globalContext.userSettings.userId.'],
  [/(^|\.)getUserName$/, 'getUserName() is deprecated: use globalContext.userSettings.userName.'],
  [/(^|\.)getUserLcid$/, 'getUserLcid() is deprecated: use globalContext.userSettings.languageId.'],
  [/(^|\.)getOrgUniqueName$/, 'getOrgUniqueName() is deprecated: use globalContext.organizationSettings.uniqueName.'],
  [/(^|\.)getOrgLcid$/, 'getOrgLcid() is deprecated: use globalContext.organizationSettings.languageId.'],
  [/(^|\.)getIsAutoSaveEnabled$/, 'getIsAutoSaveEnabled() is deprecated: use globalContext.organizationSettings.isAutoSaveEnabled.'],
  [/(^|\.)getTimeZoneOffsetMinutes$/, 'getTimeZoneOffsetMinutes() is deprecated: use globalContext.userSettings.getTimeZoneOffsetMinutes().'],
  [/(^|\.)getQueryStringParameters$/, 'getQueryStringParameters() is deprecated: read the form context or the page context instead.'],
  [/(^|\.)setDisplayState$/, 'setDisplayState is deprecated for navigation items: use setVisible.'],
];

// Deprecated context methods are only flagged on something that looks like a context, to spare other objects' methods.
const CONTEXT_ONLY = /^(getUserRoles|getUserId|getUserName|getUserLcid|getOrgUniqueName|getOrgLcid|getIsAutoSaveEnabled|getTimeZoneOffsetMinutes|getQueryStringParameters)$/;

interface Loc {
  line: number;
  column: number;
}
type AnyNode = Node & { loc: { start: Loc; end: Loc }; [k: string]: any };

/** The dotted text of a member chain ("Xrm.Page.getAttribute", "formContext.ui"); '?' where it isn't a plain name. */
function chain(n: AnyNode | null | undefined): string {
  if (!n) return '?';
  switch (n.type) {
    case 'Identifier':
      return n.name;
    case 'ThisExpression':
      return 'this';
    case 'MemberExpression':
      return `${chain(n.object)}.${n.computed ? (n.property.type === 'Literal' ? String(n.property.value) : '?') : n.property.name}`;
    case 'ChainExpression':
      return chain(n.expression);
    case 'CallExpression':
      return `${chain(n.callee)}()`;
    default:
      return '?';
  }
}

function walk(n: AnyNode, visit: (n: AnyNode, parent: AnyNode | null) => void, parent: AnyNode | null = null): void {
  visit(n, parent);
  for (const k in n) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    const v = (n as any)[k];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, n);
    } else if (v && typeof v.type === 'string') walk(v, visit, n);
  }
}

let lastParse: { code: string; ast?: WeakRef<Node>; error?: unknown } | null = null;

/**
 * acorn's syntax tree of a script, with locations (throws acorn's SyntaxError). The tree of the last text is kept while
 * memory allows, so the checks and the outline (Go to Symbol, sticky scroll) of the same text parse it once: in a big
 * script one parse costs hundreds of milliseconds.
 */
export function parseScript(code: string): Node {
  const last = lastParse;
  if (last && last.code === code) {
    if (last.error) throw last.error;
    const ast = last.ast?.deref();
    if (ast) return ast;
  }
  try {
    const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true });
    lastParse = { code, ast: new WeakRef(ast) };
    return ast;
  } catch (e) {
    lastParse = { code, error: e };
    throw e;
  }
}

/** Options for one check. */
export interface LintOptions {
  /** Rules turned off. */
  off?: string[];
  /** Rules turned on although off by default. */
  on?: string[];
}

const ruleOf = new Map(RULES.map((r) => [r.id, r]));

/** Checks one script. `lineOffset`/`colOffset` place it inside a larger file (an HTML page's <script> block). */
export function lintScript(code: string, o: LintOptions = {}, lineOffset = 0, colOffset = 0): Diagnostic[] {
  const out: Diagnostic[] = [];
  const enabled = (id: string) => {
    const r = ruleOf.get(id);
    if (!r) return false;
    if (o.off?.includes(id)) return false;
    return !r.defaultOff || !!o.on?.includes(id);
  };
  const place = (loc: { start: Loc; end: Loc }) => ({
    startLine: loc.start.line + lineOffset,
    startCol: loc.start.column + 1 + (loc.start.line === 1 ? colOffset : 0),
    endLine: loc.end.line + lineOffset,
    endCol: loc.end.column + 1 + (loc.end.line === 1 ? colOffset : 0),
  });
  const add = (rule: string, node: AnyNode, message: string, fix?: Fix) => {
    if (!enabled(rule)) return;
    out.push({ severity: ruleOf.get(rule)!.severity, rule, message, ...place(node.loc), fix });
  };

  let ast: AnyNode;
  try {
    ast = parseScript(code) as AnyNode;
  } catch (e) {
    const err = e as SyntaxError & { loc?: Loc; raisedAt?: number };
    const loc = err.loc || { line: 1, column: 0 };
    // A module's import/export: say what it is, not only that it is unexpected.
    const isModule = /'import' and 'export' may appear only with 'sourceType: module'/.test(err.message);
    if (isModule && !enabled('module-syntax')) return out;
    if (!isModule && !enabled('syntax')) return out;
    const message = isModule
      ? 'import and export can\'t be used: Dynamics 365 loads web resources as classic scripts, not modules. Bundle the script first.'
      : err.message.replace(/\s*\(\d+:\d+\)$/, '');
    const startLine = loc.line + lineOffset;
    const startCol = loc.column + 1 + (loc.line === 1 ? colOffset : 0);
    out.push({ severity: 'error', rule: isModule ? 'module-syntax' : 'syntax', message, startLine, startCol, endLine: startLine, endCol: startCol + 1 });
    return out;
  }

  // Looks like a form or ribbon script (rules about the DOM and jQuery apply only to those).
  const formScript = /\b(formContext|executionContext|getFormContext|Xrm\.Page|primaryControl)\b/.test(code);

  walk(ast, (n, parent) => {
    switch (n.type) {
      case 'DebuggerStatement':
        add('debugger', n, 'debugger statement: remove it before publishing (it stops the script for everyone with the developer tools open).', { title: 'Remove the debugger statement', text: '' });
        return;
      case 'MemberExpression': {
        const c = chain(n);
        if (/(^|\.)Xrm\.Page$/.test(c) && !n.computed) {
          add('xrm-page', n, 'Xrm.Page is deprecated: use the form context (executionContext.getFormContext()), passed to the handler with "Pass execution context as first parameter".', /^Xrm\.Page$/.test(c) ? { title: 'Replace Xrm.Page with formContext', text: 'formContext' } : undefined);
        }
        if (/^(window\.)?(parent|top|opener)\.Xrm$/.test(c) || /^window\.(parent|top)\.Xrm$/.test(c)) {
          add('parent-xrm', n, 'parent.Xrm is deprecated in HTML web resources: get the form context with getContentWindow() and pass it in (or use Xrm from ClientGlobalContext.js.aspx).');
        }
        if (/^Xrm\.Mobile\.offline$/.test(c)) add('deprecated-api', n, 'Xrm.Mobile.offline is deprecated: use Xrm.WebApi.offline.');
        if (formScript && /^(window\.)?document\.(getElementById|getElementsBy\w+|querySelector(All)?|forms|body)$/.test(c)) {
          add('dom', n, 'Reaching into the page with document.* from a form script is unsupported: the model-driven app\'s HTML changes without notice. Use the client API (formContext.ui, getControl) instead.');
        }
        return;
      }
      case 'CallExpression': {
        const callee = n.callee as AnyNode;
        const c = chain(callee);
        const name = callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : callee.type === 'Identifier' ? callee.name : '';
        for (const [re, msg, replacement] of DEPRECATED) {
          if (!msg || !re.test(c)) continue;
          if (CONTEXT_ONLY.test(name) && !/context|Context|getGlobalContext\(\)/.test(c)) continue;
          const target = callee.type === 'MemberExpression' && replacement && !replacement.includes('.') ? callee.property : callee;
          add('deprecated-api', target, msg, replacement ? { title: `Use ${replacement}`, text: replacement } : undefined);
          break;
        }
        if (/^(window\.)?(alert|confirm|prompt)$/.test(c)) add('alert', callee, `${name}() blocks the page and looks out of place in Dynamics: use Xrm.Navigation.openAlertDialog / openConfirmDialog.`);
        if (/^(window\.)?eval$/.test(c)) add('eval', callee, 'eval() runs text as code: hard to debug and unsafe with data from outside.');
        if (/^console\.(log|debug|info|trace|dir|table)$/.test(c)) add('console', callee, `${c}() left in the script.`);
        if (formScript && /^(\$|jQuery)$/.test(c)) add('jquery', callee, 'jQuery in form scripts is unsupported: it reaches into the page\'s HTML, which changes without notice.');
        // xhr.open(method, url, false)
        if (name === 'open' && n.arguments.length >= 3) {
          const a = n.arguments[2] as AnyNode;
          if (a.type === 'Literal' && a.value === false) add('sync-xhr', n, 'A synchronous XMLHttpRequest freezes the app until the server answers: make it asynchronous (or use Xrm.WebApi / fetch).');
        }
        // $.ajax({ async: false })
        if (/^(\$|jQuery)\.ajax$/.test(c))
          for (const arg of n.arguments as AnyNode[])
            if (arg.type === 'ObjectExpression')
              for (const p of arg.properties as AnyNode[])
                if (p.type === 'Property' && (p.key.name === 'async' || p.key.value === 'async') && p.value.type === 'Literal' && p.value.value === false)
                  add('sync-xhr', p, 'async: false freezes the app until the server answers.');
        return;
      }
      case 'NewExpression': {
        if (chain(n.callee) === 'Function') add('eval', n.callee, 'new Function() runs text as code: hard to debug and unsafe with data from outside.');
        return;
      }
      case 'Literal':
      case 'TemplateElement': {
        const s = n.type === 'Literal' ? (typeof n.value === 'string' ? n.value : '') : n.value?.cooked || '';
        if (/XRMServices\/2011\/OrganizationData\.svc/i.test(s)) add('odata-v2', n, 'The 2011 OData endpoint (OrganizationData.svc) was removed: use the Web API (/api/data/v9.2/) or Xrm.WebApi.');
        else if (/XRMServices\/2011\/Organization\.svc/i.test(s)) add('soap', n, 'The 2011 SOAP endpoint is deprecated for web resources: use the Web API (/api/data/v9.2/) or Xrm.WebApi.');
        return;
      }
      default:
        return;
    }
  });

  // Global functions and variables: one row per top-level declaration.
  if (enabled('globals'))
    for (const s of (ast.body as AnyNode[]) || []) {
      if (s.type === 'FunctionDeclaration' && s.id) add('globals', s.id, `${s.id.name} is a global function: another library on the same form may use the same name. Put your functions in a namespace object.`);
      if (s.type === 'VariableDeclaration' && s.kind === 'var')
        for (const d of s.declarations as AnyNode[]) if (d.id?.type === 'Identifier') add('globals', d.id, `${d.id.name} is a global variable: another library on the same form may use the same name.`);
    }
  return out;
}

/** Checks every inline <script> block of an HTML page (scripts with a src are skipped). */
export function lintHtml(html: string, o: LintOptions = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase() || '';
    if (type && !/javascript|ecmascript|^module$/.test(type)) continue; // templates, JSON
    const start = m.index + m[0].indexOf('>') + 1;
    const before = html.slice(0, start);
    const line = before.split('\n').length - 1;
    const col = start - (before.lastIndexOf('\n') + 1);
    out.push(...lintScript(m[2], type === 'module' ? { ...o, off: [...(o.off || []), 'module-syntax'] } : o, line, col));
  }
  return out;
}

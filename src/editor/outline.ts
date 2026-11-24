// The outline of a script (Go to Symbol, Ctrl+Shift+O; the breadcrumbs; sticky scroll): its functions, classes and
// methods, and the namespace objects web resources keep their handlers in, nested the way they are written:
//   var Contoso = window.Contoso || {};
//   Contoso.Account = { onLoad: function (executionContext) {...} };     Contoso > Account > onLoad
//   (function () { this.onSave = function () {...}; }).call(Contoso);   Contoso > onSave
// As in VS Code, a namespace whose members are assigned further down spans them all. Built from acorn's syntax tree;
// while the script doesn't parse (in the middle of an edit) the outline of the last version that did stays.

import { parse } from 'acorn';
import { monaco } from './monaco';

type Sym = monaco.languages.DocumentSymbol;
type SymbolKind = monaco.languages.SymbolKind;
interface Loc {
  line: number;
  column: number;
}
type N = { type: string; start: number; end: number; loc: { start: Loc; end: Loc }; [k: string]: any };

const K = monaco.languages.SymbolKind;
/** Symbols a namespace can grow out of: var Contoso; then Contoso.Account = {...}. */
const NAMESPACE_LIKE = new Set<SymbolKind>([K.Namespace, K.Module, K.Variable, K.Property, K.Constant]);
/** window.Contoso is the global Contoso. */
const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis']);

interface Scope {
  /** Where the symbols found here go. */
  out: Sym[];
  /** What `this` is: a namespace (Contoso.Account.f = function () { this... }), or a symbol (a constructor, a class). */
  thisPath?: string;
  thisSym?: Sym;
  /** Parameters standing for a namespace: (function (ns) { ns.f = ... })(Contoso.Account). */
  aliases: Map<string, string>;
  /** Inside a function that is a symbol of its own: what it assigns isn't a namespace. */
  local: boolean;
  /** The top level of the script, where plain variables are listed too (not those inside functions). */
  vars?: boolean;
  /** In the function of a module pattern (var Contoso = (function () { ...; return {...}; })()): the module and its path. */
  ret?: Sym;
  retPath?: string;
}

const range = (n: N): monaco.IRange => ({
  startLineNumber: n.loc.start.line,
  startColumn: n.loc.start.column + 1,
  endLineNumber: n.loc.end.line,
  endColumn: n.loc.end.column + 1,
});

const symbol = (name: string, kind: SymbolKind, whole: N, id: N, detail = ''): Sym => ({
  name,
  detail,
  kind,
  tags: [],
  range: range(whole),
  selectionRange: range(id),
  children: [],
});

const before = (a: monaco.IRange, b: monaco.IRange) => a.startLineNumber < b.startLineNumber || (a.startLineNumber === b.startLineNumber && a.startColumn < b.startColumn);
const after = (a: monaco.IRange, b: monaco.IRange) => a.endLineNumber > b.endLineNumber || (a.endLineNumber === b.endLineNumber && a.endColumn > b.endColumn);

function union(a: monaco.IRange, b: monaco.IRange): monaco.IRange {
  const s = before(b, a) ? b : a;
  const e = after(b, a) ? b : a;
  return { startLineNumber: s.startLineNumber, startColumn: s.startColumn, endLineNumber: e.endLineNumber, endColumn: e.endColumn };
}

const isFunction = (n: N | undefined) => n?.type === 'FunctionExpression' || n?.type === 'ArrowFunctionExpression';

function params(fn: N): string {
  const name = (p: N): string =>
    p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' ? name(p.left) : p.type === 'RestElement' ? '...' + name(p.argument) : '{...}';
  return `(${(fn.params as N[]).map(name).join(', ')})`;
}

function keyOf(key: N, computed: boolean): string | undefined {
  if (key.type === 'Identifier' && !computed) return key.name;
  if (key.type === 'PrivateIdentifier') return '#' + key.name;
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) return String(key.value);
  return undefined;
}

/** The names of a member chain of plain names (Contoso.Account.onLoad, this.x), or null. */
function pathOf(n: N): Array<{ name: string; node: N }> | null {
  const out: Array<{ name: string; node: N }> = [];
  let x = n;
  while (x.type === 'MemberExpression') {
    const name = keyOf(x.property, x.computed);
    if (name === undefined) return null;
    out.unshift({ name, node: x.property });
    x = x.object;
  }
  if (x.type === 'Identifier') out.unshift({ name: x.name, node: x });
  else if (x.type === 'ThisExpression') out.unshift({ name: 'this', node: x });
  else return null;
  return out;
}

/** The object literal of a namespace value: {...}, X || {...}, X || (X = {...}). */
function namespaceObject(v: N): N | undefined {
  if (v.type === 'ObjectExpression') return v;
  if (v.type === 'LogicalExpression' && (v.operator === '||' || v.operator === '??')) {
    const r = v.right;
    if (r.type === 'ObjectExpression') return r;
    if (r.type === 'AssignmentExpression' && r.right.type === 'ObjectExpression') return r.right;
  }
  return undefined;
}

/** The function of a module pattern: (function () {...})(), (() => {...})(), (function () {...}).call(x). */
function moduleFunction(v: N): N | undefined {
  if (v.type !== 'CallExpression') return undefined;
  const c = v.callee;
  if (isFunction(c)) return c;
  if (c.type === 'MemberExpression' && !c.computed && (c.property.name === 'call' || c.property.name === 'apply') && isFunction(c.object)) return c.object;
  return undefined;
}

const hasFunctions = (obj: N) => (obj.properties as N[]).some((p) => p.type === 'Property' && (isFunction(p.value) || p.kind !== 'init'));
const symbolValue = (v: N) => isFunction(v) || v.type === 'ClassExpression' || !!namespaceObject(v) || !!moduleFunction(v);
const shadow = (aliases: Map<string, string>, fnParams: N[]) => {
  const out = new Map(aliases);
  for (const p of fnParams) if (p.type === 'Identifier') out.delete(p.name);
  return out;
};

class Outliner {
  readonly root: Sym[] = [];
  /** The namespaces by dotted path, so that Contoso.Account.onLoad = ... lands in Contoso > Account. */
  private readonly paths = new Map<string, Sym>();

  statements(list: N[], scope: Scope): void {
    for (const s of list) this.visit(s, scope);
  }

  visit(n: N | null | undefined, scope: Scope): void {
    if (!n || typeof n.type !== 'string') return;
    switch (n.type) {
      case 'FunctionDeclaration':
        if (n.id) this.func(scope.out, n.id.name, K.Function, n, n.id, n, scope, undefined, scope.local ? undefined : n.id.name);
        else this.callback(n, scope);
        return;
      case 'ClassDeclaration':
        if (n.id) this.cls(scope.out, n.id.name, n, n.id, n, scope, scope.local ? undefined : n.id.name);
        return;
      case 'VariableDeclaration':
        for (const d of n.declarations as N[]) {
          if (d.id.type !== 'Identifier') this.visit(d.init, scope);
          else if (d.init) this.define(scope.out, d.id.name, scope.local ? undefined : d.id.name, d, d.id, d.init, scope, n.kind);
          else if (scope.vars && !scope.out.some((s) => s.name === d.id.name)) scope.out.push(symbol(d.id.name, K.Variable, d, d.id));
        }
        return;
      case 'AssignmentExpression':
        if (n.operator === '=' && this.assignment(n, scope)) return;
        break;
      case 'CallExpression':
        if (this.iife(n, scope)) return;
        break;
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        this.callback(n, scope);
        return;
      case 'ReturnStatement':
        // The object a module pattern returns: its members are the module's (those that refer to a function of the
        // module by name are listed already, as that function).
        if (scope.ret && n.argument?.type === 'ObjectExpression') {
          this.properties(n.argument, scope.ret, scope.retPath, scope, true);
          return;
        }
        break;
    }
    for (const k in n) {
      if (k === 'loc' || k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) this.visit(c, scope);
      else if (v && typeof v.type === 'string') this.visit(v, scope);
    }
  }

  private body(fn: N, scope: Scope): void {
    if (fn.body.type === 'BlockStatement') this.statements(fn.body.body, scope);
    else this.visit(fn.body, scope);
  }

  /** An anonymous function (a callback): no symbol, its functions go to the scope around it. */
  private callback(fn: N, scope: Scope): void {
    const arrow = fn.type === 'ArrowFunctionExpression';
    this.body(fn, {
      out: scope.out,
      thisPath: arrow ? scope.thisPath : undefined,
      thisSym: arrow ? scope.thisSym : undefined,
      aliases: shadow(scope.aliases, fn.params),
      local: scope.local,
    });
  }

  /**
   * A named function and what it contains. `thisPath`: the namespace it is a member of; `path`: its own dotted path,
   * so that members assigned to it later (Grid.prototype.refresh = ...) are listed in it.
   */
  private func(out: Sym[], name: string, kind: SymbolKind, whole: N, id: N, fn: N, scope: Scope, thisPath?: string, path?: string): Sym {
    const s = symbol(name, kind, whole, id, params(fn));
    out.push(s);
    if (path) this.paths.set(path, s);
    const arrow = fn.type === 'ArrowFunctionExpression';
    const self = thisPath ?? (arrow ? scope.thisPath : undefined);
    this.body(fn, {
      out: s.children!,
      thisPath: self,
      // In a function that is no namespace's member, this.x = function... makes a member of the function (a constructor).
      thisSym: self ? undefined : arrow ? scope.thisSym : s,
      aliases: shadow(scope.aliases, fn.params),
      local: true,
    });
    return s;
  }

  private cls(out: Sym[], name: string, whole: N, id: N, node: N, scope: Scope, path?: string): void {
    const c = symbol(name, K.Class, whole, id);
    out.push(c);
    if (path) this.paths.set(path, c);
    this.visit(node.superClass, scope);
    for (const m of node.body.body as N[]) {
      const key = m.key ? (keyOf(m.key, m.computed) ?? '[computed]') : '';
      if (m.type === 'MethodDefinition') {
        const kind = m.kind === 'constructor' ? K.Constructor : m.kind === 'get' || m.kind === 'set' ? K.Property : K.Method;
        if (kind === K.Property && c.children!.some((x) => x.name === key && x.kind === K.Property)) continue; // get and set of one property
        const s = symbol(key, kind, m, m.key, kind === K.Property ? '' : params(m.value));
        c.children!.push(s);
        this.body(m.value, { out: s.children!, thisSym: c, aliases: shadow(scope.aliases, m.value.params), local: true });
      } else if (m.type === 'PropertyDefinition') {
        if (isFunction(m.value)) this.func(c.children!, key, K.Method, m, m.key, m.value, { ...scope, thisSym: c });
        else {
          c.children!.push(symbol(key, K.Property, m, m.key));
          this.visit(m.value, { out: c.children!, thisSym: c, aliases: scope.aliases, local: true });
        }
      } else if (m.type === 'StaticBlock') this.statements(m.body, { out: c.children!, thisSym: c, aliases: scope.aliases, local: true });
    }
  }

  /** A namespace symbol: found by its path or its name, or new. */
  private ns(out: Sym[], name: string, path: string | undefined, whole: N, id: N, kind: SymbolKind): Sym {
    let s = (path && this.paths.get(path)) || out.find((x) => x.name === name && NAMESPACE_LIKE.has(x.kind));
    if (!s) {
      s = symbol(name, kind, whole, id);
      out.push(s);
    } else {
      // var Contoso; ... Contoso.Account = {...}: the variable turns out to be a namespace.
      if (kind === K.Namespace || kind === K.Module) s.kind = kind;
      s.range = union(s.range, range(whole));
    }
    if (path) this.paths.set(path, s);
    return s;
  }

  /** The symbol for name = value, in out. `path`: its dotted path when it can be a namespace. */
  private define(out: Sym[], name: string, path: string | undefined, whole: N, id: N, value: N, scope: Scope, how: string): void {
    const member = how === 'member';
    if (value.type === 'AssignmentExpression') {
      // a = b = function () {}: the inner assignment makes the symbol.
      this.visit(value, scope);
      return;
    }
    if (isFunction(value)) {
      this.func(out, name, member ? K.Method : K.Function, whole, id, value, scope, member && path ? path.slice(0, path.lastIndexOf('.')) || undefined : undefined, path);
      return;
    }
    if (value.type === 'ClassExpression') {
      this.cls(out, name, whole, id, value, scope, path);
      return;
    }
    const obj = namespaceObject(value);
    if (obj) {
      const kind = obj !== value || hasFunctions(obj) ? K.Namespace : member ? K.Property : how === 'const' ? K.Constant : K.Variable;
      if (obj !== value) this.visit(value.left, scope);
      this.properties(obj, this.ns(out, name, path, whole, id, kind), path, scope);
      return;
    }
    const mod = moduleFunction(value);
    if (mod) {
      const ns = this.ns(out, name, path, whole, id, K.Module);
      for (const a of value.arguments as N[]) this.visit(a, scope);
      this.body(mod, { out: ns.children!, aliases: shadow(scope.aliases, mod.params), local: false, ret: ns, retPath: path });
      return;
    }
    // A plain value: variables at the top level, fields of namespaces.
    if ((member || scope.vars) && !out.some((s) => s.name === name)) out.push(symbol(name, how === 'const' ? K.Constant : member ? K.Property : K.Variable, whole, id));
    this.visit(value, scope);
  }

  /** The members of an object literal, under parent. `reveal`: a module's returned object (skips names of functions). */
  private properties(obj: N, parent: Sym, path: string | undefined, scope: Scope, reveal = false): void {
    for (const p of obj.properties as N[]) {
      const key = p.type === 'Property' ? keyOf(p.key, p.computed) : undefined;
      if (key === undefined || (reveal && p.value.type === 'Identifier')) {
        this.visit(p.type === 'Property' ? p.value : p, scope);
        continue;
      }
      if (p.kind === 'get' || p.kind === 'set') {
        if (!parent.children!.some((c) => c.name === key)) parent.children!.push(symbol(key, K.Property, p, p.key));
        this.callback(p.value, scope);
        continue;
      }
      this.define(parent.children!, key, path ? `${path}.${key}` : undefined, p, p.key, p.value, { ...scope, thisPath: path, thisSym: path ? undefined : parent }, 'member');
    }
  }

  /** The namespace for a dotted path, making the missing ones (Contoso.Account.onLoad = ... with no Contoso yet). */
  private ensure(names: string[], nodes: N[], whole: N): Sym {
    let out = this.root;
    let s: Sym | undefined;
    for (let i = 0; i < names.length; i++) {
      const path = names.slice(0, i + 1).join('.');
      s = this.paths.get(path) ?? this.ns(out, names[i], path, whole, nodes[i] ?? whole, K.Namespace);
      out = s.children!;
    }
    return s!;
  }

  /** target = value. Returns false when it isn't a symbol (the caller then looks inside). */
  private assignment(n: N, scope: Scope): boolean {
    const segs = pathOf(n.left);
    if (!segs) return false;
    let names = segs.map((s) => s.name);
    let nodes = segs.map((s) => s.node);
    // Members of a prototype belong to the type: Contoso.Grid.prototype.refresh = ... is Contoso > Grid > refresh.
    for (let i = names.length - 2; i > 0; i--)
      if (names[i] === 'prototype') {
        names.splice(i, 1);
        nodes.splice(i, 1);
      }
    if (names.length > 1 && GLOBAL_OBJECTS.has(names[0])) {
      names = names.slice(1);
      nodes = nodes.slice(1);
    }
    const name = names[names.length - 1];
    const id = nodes[nodes.length - 1];
    const root = names[0];
    if (root === 'this' || scope.aliases.has(root)) {
      const base = root === 'this' ? scope.thisPath : scope.aliases.get(root);
      if (base) {
        // The namespace this (or the parameter) stands for; its part of the path has no node of its own here.
        const prefix = base.split('.');
        names = prefix.concat(names.slice(1));
        nodes = prefix.map(() => n.left as N).concat(nodes.slice(1));
      } else {
        if (root !== 'this' || names.length !== 2 || !symbolValue(n.right)) return false;
        this.define(scope.thisSym ? scope.thisSym.children! : scope.out, name, undefined, n, id, n.right, scope, 'member');
        return true;
      }
    }
    if (names.length === 1) {
      // name = value: a declaration without var (at the top level), or a function kept in a variable.
      if (!symbolValue(n.right) && scope.local) return false;
      this.define(scope.out, name, scope.local ? undefined : name, n, id, n.right, scope, 'var');
      return true;
    }
    const parentPath = names.slice(0, -1).join('.');
    const parent = this.paths.get(parentPath) ?? (scope.local ? undefined : this.ensure(names.slice(0, -1), nodes, n));
    if (parent) {
      // A variable that members are assigned to is a namespace (var Contoso; ... Contoso.onLoad = ...).
      if (parent.kind === K.Variable || parent.kind === K.Constant || parent.kind === K.Property) parent.kind = K.Namespace;
      // Contoso.onLoad = onLoad (what TypeScript writes for a namespace): the function goes into the namespace.
      const fn = n.right.type === 'Identifier' && n.right.name === name ? scope.out.findIndex((s) => s.name === name && s.kind === K.Function) : -1;
      if (fn >= 0 && !parent.children!.some((c) => c.name === name)) {
        const [s] = scope.out.splice(fn, 1);
        s.kind = K.Method;
        parent.children!.push(s);
        return true;
      }
      if (symbolValue(n.right) || !parent.children!.some((c) => c.name === name)) this.define(parent.children!, name, names.join('.'), n, id, n.right, scope, 'member');
      else this.visit(n.right, scope);
      return true;
    }
    // In a function, a function stored on some object (xhr.onreadystatechange = function ...): listed by its path.
    if (!isFunction(n.right)) return false;
    this.define(scope.out, names.join('.'), undefined, n, id, n.right, scope, 'member');
    return true;
  }

  /** The namespace a call argument stands for: Contoso.Account, window.Contoso = window.Contoso || {}, this. */
  private aliasOf(arg: N | undefined, scope: Scope): string | undefined {
    if (!arg) return undefined;
    if (arg.type === 'ThisExpression') return scope.thisPath;
    if (arg.type === 'AssignmentExpression' || arg.type === 'LogicalExpression') return this.aliasOf(arg.left, scope);
    const segs = pathOf(arg);
    if (!segs) return undefined;
    let names = segs.map((s) => s.name);
    if (names.length > 1 && GLOBAL_OBJECTS.has(names[0])) names = names.slice(1);
    if (names[0] === 'this') return scope.thisPath ? [scope.thisPath, ...names.slice(1)].join('.') : undefined;
    const alias = scope.aliases.get(names[0]);
    return alias ? [alias, ...names.slice(1)].join('.') : names.join('.');
  }

  /** (function (ns) {...})(Contoso), (function () {...}).call(Contoso): the function's symbols are the scope's. */
  private iife(n: N, scope: Scope): boolean {
    let fn = n.callee;
    let args: N[] = n.arguments;
    let thisArg: N | undefined;
    if (fn.type === 'MemberExpression' && !fn.computed && (fn.property.name === 'call' || fn.property.name === 'apply') && isFunction(fn.object)) {
      thisArg = args[0];
      args = fn.property.name === 'call' ? args.slice(1) : [];
      fn = fn.object;
    }
    if (!isFunction(fn)) return false;
    // The arguments run first: (function (ns) {...})(window.Contoso = window.Contoso || {}) defines Contoso.
    for (const a of n.arguments as N[]) this.visit(a, scope);
    const aliases = shadow(scope.aliases, fn.params);
    (fn.params as N[]).forEach((p, i) => {
      const path = p.type === 'Identifier' ? this.aliasOf(args[i], scope) : undefined;
      if (path) aliases.set(p.name, path);
    });
    const arrow = fn.type === 'ArrowFunctionExpression';
    const thisPath = thisArg ? this.aliasOf(thisArg, scope) : arrow ? scope.thisPath : undefined;
    this.body(fn, { out: scope.out, thisPath, thisSym: thisPath ? undefined : scope.thisSym, aliases, local: scope.local });
    return true;
  }
}

/** Children in the order of the text, and each symbol spanning its children (members assigned further down). */
function tidy(list: Sym[]): void {
  for (const s of list) {
    if (!s.children?.length) continue;
    tidy(s.children);
    for (const c of s.children) s.range = union(s.range, c.range);
  }
  list.sort((a, b) => (before(a.range, b.range) ? -1 : before(b.range, a.range) ? 1 : 0));
}

function outline(ast: N): Sym[] {
  const o = new Outliner();
  o.statements(ast.body, { out: o.root, aliases: new Map(), local: false, vars: true });
  tidy(o.root);
  return o.root;
}

const lastGood = new WeakMap<monaco.editor.ITextModel, { version: number; symbols: Sym[] }>();

/**
 * The outline of a JavaScript model; in the middle of an edit (it doesn't parse), the outline of the last version that
 * did. Kept per version: Go to Symbol and Go to Definition (editor/jsnav.ts) parse a text once.
 */
export function outlineOf(model: monaco.editor.ITextModel): Sym[] {
  const last = lastGood.get(model);
  const version = model.getVersionId();
  if (last?.version === version) return last.symbols;
  let ast: N;
  try {
    ast = parse(model.getValue(), { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true, allowReturnOutsideFunction: true }) as unknown as N;
  } catch {
    return last?.symbols ?? [];
  }
  const symbols = outline(ast);
  lastGood.set(model, { version, symbols });
  return symbols;
}

/** Registers the outline of JavaScript models. */
export function registerOutline(): monaco.IDisposable {
  return monaco.languages.registerDocumentSymbolProvider('javascript', {
    displayName: 'Web resource outline',
    provideDocumentSymbols: (model) => outlineOf(model),
  });
}

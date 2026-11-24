// The scopes and names of a script, from acorn's syntax tree, for Go to Definition, Find All References and Rename
// Symbol (editor/jsnav.ts gives them to the editor). Pure: text in, offsets out.
//  - A local name (a variable, a parameter, a function inside a function) is resolved through its scopes to its
//    declaration; var and function declarations belong to their whole function, let, const and class to their block.
//  - A global name (declared at the top of a script, or never declared) and a dotted path that starts with one
//    (Contoso.Account.onLoad; window.Contoso is Contoso) have a key that is that name or path: the same in every
//    script of the page. A path that starts with a local variable is keyed by that variable (#12.onLoad).
//  - Definitions of a path: assignments (Contoso.Account.onSave = …), the keys of an object literal assigned to it
//    (Contoso.Account = { onLoad: … }, also X || {…}), and those of the object a module pattern returns
//    (Contoso.Account = (function () { …; return { onLoad: onLoad }; })(), which leads to function onLoad).

import { parse } from 'acorn';

type Loc = { line: number; column: number };
export type N = { type: string; start: number; end: number; loc: { start: Loc; end: Loc }; [k: string]: any };

export interface Scope {
  parent: Scope | null;
  /** A function's scope (or the script's): where var and function declarations go. */
  fn: boolean;
  program: boolean;
  decls: Map<string, Decl>;
}

export interface Decl {
  uid: number;
  name: string;
  id: N;
  /** Declared at the top of the script: a global, shared with the page's other scripts. */
  global: boolean;
}

/** An identifier: the name in a declaration, or a use of a name (decl null: a global, never declared here). */
export interface Use {
  id: N;
  decl: Decl | null;
  declaration: boolean;
  /** `{ name }`: a renamed local becomes `{ name: newName }`. */
  shorthand: boolean;
}

/**
 * The last name of a dotted path (the `onLoad` of Contoso.Account.onLoad). Its key is the path for a global one, and
 * names the local variable it starts with otherwise (`#12.onLoad`): only that variable's members match it.
 */
export interface PathUse {
  id: N;
  key: string;
  /** Where it gets its value: an assignment, an object literal's key. */
  def: boolean;
  /** Where Go to Definition leads, when not to the name itself: return { onLoad: onLoad } leads to function onLoad. */
  at?: N;
}

export interface Analysis {
  uses: Use[];
  paths: PathUse[];
}

const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis']);
/** Bigger scripts aren't analysed (a parse would take seconds). */
export const MAX_LENGTH = 3_000_000;

const isNode = (v: unknown): v is N => !!v && typeof (v as N).type === 'string';

class Analyser {
  private uid = 0;
  readonly uses: Use[] = [];
  private readonly useOf = new Map<N, Use>();
  private readonly pending: Array<{ id: N; scope: Scope; shorthand: boolean }> = [];
  /** Member expressions, and the object literals assigned to a path: given their keys once the names are resolved. */
  private readonly members: Array<{ n: N; def: boolean }> = [];
  private readonly objects: Array<{ target: N; obj: N }> = [];

  run(ast: N): Analysis {
    const program: Scope = { parent: null, fn: true, program: true, decls: new Map() };
    this.hoist(ast.body, program, program);
    for (const s of ast.body) this.walk(s, program);
    for (const p of this.pending) this.resolve(p.id, p.scope, p.shorthand);
    const paths: PathUse[] = [];
    for (const { n, def } of this.members) {
      const key = this.keyOf(n);
      if (key) paths.push({ id: n.property, key, def });
    }
    for (const { target, obj } of this.objects) {
      const base = target.type === 'Identifier' ? this.nameKey(target) : this.keyOf(target);
      if (base) this.objectPaths(obj, base, paths);
    }
    this.uses.sort((a, b) => a.id.start - b.id.start);
    paths.sort((a, b) => a.id.start - b.id.start);
    return { uses: this.uses, paths };
  }

  // ---- declarations

  private declare(id: N, scope: Scope): void {
    if (id.type !== 'Identifier') return;
    let d = scope.decls.get(id.name);
    if (!d) {
      d = { uid: ++this.uid, name: id.name, id, global: scope.program };
      scope.decls.set(id.name, d);
    }
    const u: Use = { id, decl: d, declaration: true, shorthand: false };
    this.uses.push(u);
    this.useOf.set(id, u);
  }

  /** The names a pattern declares (var {a, b: [c]} = …); default values are walked as expressions. */
  private pattern(p: N | null, target: Scope, scope: Scope): void {
    if (!p) return;
    switch (p.type) {
      case 'Identifier':
        this.declare(p, target);
        break;
      case 'ObjectPattern':
        for (const prop of p.properties as N[]) {
          if (prop.type === 'RestElement') this.pattern(prop.argument, target, scope);
          else {
            if (prop.computed) this.walk(prop.key, scope);
            this.pattern(prop.value, target, scope);
            this.markShorthand(prop);
          }
        }
        break;
      case 'ArrayPattern':
        for (const e of p.elements as Array<N | null>) this.pattern(e, target, scope);
        break;
      case 'AssignmentPattern':
        this.pattern(p.left, target, scope);
        this.walk(p.right, scope);
        break;
      case 'RestElement':
        this.pattern(p.argument, target, scope);
        break;
    }
  }

  /** { name } and { name = 1 } in a pattern: the name is the property's too (renamed, it becomes { name: newName }). */
  private markShorthand(prop: N): void {
    if (!prop.shorthand) return;
    const id = prop.value.type === 'AssignmentPattern' ? prop.value.left : prop.value;
    const u = id?.type === 'Identifier' ? this.useOf.get(id) : undefined;
    if (u) u.shorthand = true;
  }

  /** var declarations belong to the whole function (or script), wherever they are written. */
  private hoist(body: N[], fnScope: Scope, block: Scope): void {
    for (const s of body) this.hoistIn(s, fnScope, block, true);
  }

  private hoistIn(n: N | null | undefined, fnScope: Scope, block: Scope, top: boolean): void {
    if (!isNode(n)) return;
    switch (n.type) {
      case 'FunctionDeclaration':
        // One in a nested block belongs to that block (declared when it is walked).
        if (top && n.id) this.declare(n.id, block);
        return;
      case 'VariableDeclaration':
        if (n.kind === 'var') for (const d of n.declarations as N[]) this.patternNames(d.id, (id) => this.declare(id, fnScope));
        else if (top) for (const d of n.declarations as N[]) this.patternNames(d.id, (id) => this.declare(id, block));
        return;
      case 'ClassDeclaration':
        if (top && n.id) this.declare(n.id, block);
        return;
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassExpression':
      case 'ClassBody':
        return;
      default:
        for (const k in n) {
          if (k === 'loc') continue;
          const v = n[k];
          if (Array.isArray(v)) for (const x of v) this.hoistIn(x, fnScope, block, false);
          else if (isNode(v)) this.hoistIn(v, fnScope, block, false);
        }
    }
  }

  private patternNames(p: N | null, f: (id: N) => void): void {
    if (!p) return;
    if (p.type === 'Identifier') f(p);
    else if (p.type === 'ObjectPattern') for (const prop of p.properties as N[]) this.patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, f);
    else if (p.type === 'ArrayPattern') for (const e of p.elements as Array<N | null>) this.patternNames(e, f);
    else if (p.type === 'AssignmentPattern') this.patternNames(p.left, f);
    else if (p.type === 'RestElement') this.patternNames(p.argument, f);
  }

  /** let, const and class in a block (var and functions were hoisted already). */
  private blockDecls(body: N[], block: Scope): void {
    for (const s of body) {
      if (s.type === 'VariableDeclaration' && s.kind !== 'var') for (const d of s.declarations as N[]) this.patternNames(d.id, (id) => this.declare(id, block));
      else if (s.type === 'ClassDeclaration' && s.id) this.declare(s.id, block);
      else if (s.type === 'FunctionDeclaration' && s.id && !block.fn) this.declare(s.id, block);
    }
  }

  // ---- the walk

  private fn(n: N, scope: Scope): void {
    const inner: Scope = { parent: scope, fn: true, program: false, decls: new Map() };
    // A named function expression sees its own name.
    if (n.type === 'FunctionExpression' && n.id) this.declare(n.id, inner);
    for (const p of n.params as N[]) this.pattern(p, inner, inner);
    if (n.body.type === 'BlockStatement') {
      this.hoist(n.body.body, inner, inner);
      for (const s of n.body.body) this.walk(s, inner);
    } else this.walk(n.body, inner);
  }

  private block(body: N[], scope: Scope): Scope {
    const inner: Scope = { parent: scope, fn: false, program: false, decls: new Map() };
    this.blockDecls(body, inner);
    for (const s of body) this.walk(s, inner);
    return inner;
  }

  walk(n: N | null | undefined, scope: Scope, parent?: N, key?: string): void {
    if (!isNode(n)) return;
    switch (n.type) {
      case 'Identifier':
        if (parent && key && !isReference(parent, key)) return;
        this.pending.push({ id: n, scope, shorthand: parent?.type === 'Property' && parent.shorthand });
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        this.fn(n, scope);
        return;
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const inner: Scope = n.type === 'ClassExpression' && n.id ? { parent: scope, fn: false, program: false, decls: new Map() } : scope;
        if (n.type === 'ClassExpression' && n.id) this.declare(n.id, inner);
        if (n.superClass) this.walk(n.superClass, inner);
        for (const m of n.body.body as N[]) {
          if (m.computed) this.walk(m.key, inner);
          if (m.value) this.walk(m.value, inner);
          if (m.type === 'StaticBlock') this.block(m.body, inner);
        }
        return;
      }
      case 'VariableDeclaration':
        for (const d of n.declarations as N[]) {
          // Names were declared (hoisted, or by the block); their default values and computed keys are expressions.
          this.patternDefaults(d.id, scope);
          if (d.init) {
            this.walk(d.init, scope);
            if (d.id.type === 'Identifier') this.objectOf(d.id, d.init);
          }
        }
        return;
      case 'BlockStatement':
        this.block(n.body, scope);
        return;
      case 'StaticBlock':
        this.block(n.body, scope);
        return;
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const inner: Scope = { parent: scope, fn: false, program: false, decls: new Map() };
        const head = n.type === 'ForStatement' ? n.init : n.left;
        if (head?.type === 'VariableDeclaration' && head.kind !== 'var') for (const d of head.declarations as N[]) this.patternNames(d.id, (id) => this.declare(id, inner));
        for (const k of ['init', 'left', 'right', 'test', 'update', 'body']) if (n[k]) this.walk(n[k], inner, n, k);
        return;
      }
      case 'SwitchStatement': {
        this.walk(n.discriminant, scope);
        const inner: Scope = { parent: scope, fn: false, program: false, decls: new Map() };
        const all = (n.cases as N[]).flatMap((c) => c.consequent as N[]);
        this.blockDecls(all, inner);
        for (const c of n.cases as N[]) {
          if (c.test) this.walk(c.test, inner);
          for (const s of c.consequent) this.walk(s, inner);
        }
        return;
      }
      case 'CatchClause': {
        const inner: Scope = { parent: scope, fn: false, program: false, decls: new Map() };
        if (n.param) this.pattern(n.param, inner, inner);
        this.block(n.body.body, inner);
        return;
      }
      case 'MemberExpression':
        this.members.push({ n, def: parent?.type === 'AssignmentExpression' && key === 'left' });
        break;
      case 'AssignmentExpression':
        if (n.operator === '=' && (n.left.type === 'MemberExpression' || n.left.type === 'Identifier')) this.objectOf(n.left, n.right);
        break;
      case 'LabeledStatement':
        this.walk(n.body, scope);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
        return;
    }
    for (const k in n) {
      if (k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) {
        for (const x of v) if (isNode(x)) this.walk(x, scope, n, k);
      } else if (isNode(v)) this.walk(v, scope, n, k);
    }
  }

  private patternDefaults(p: N | null, scope: Scope): void {
    if (!p) return;
    if (p.type === 'AssignmentPattern') {
      this.patternDefaults(p.left, scope);
      this.walk(p.right, scope);
    } else if (p.type === 'ObjectPattern') {
      for (const prop of p.properties as N[]) {
        if (prop.type === 'RestElement') this.patternDefaults(prop.argument, scope);
        else {
          if (prop.computed) this.walk(prop.key, scope);
          this.patternDefaults(prop.value, scope);
          this.markShorthand(prop);
        }
      }
    } else if (p.type === 'ArrayPattern') for (const e of p.elements as Array<N | null>) this.patternDefaults(e, scope);
    else if (p.type === 'RestElement') this.patternDefaults(p.argument, scope);
  }

  /** `target = {...}` (also X || {...}, and the object a module pattern returns): its keys are paths too. */
  private objectOf(target: N, value: N): void {
    const obj = objectValue(value);
    if (obj) this.objects.push({ target, obj });
  }

  private objectPaths(obj: N, base: string, out: PathUse[]): void {
    for (const p of obj.properties as N[]) {
      if (p.type !== 'Property' || p.computed) continue;
      const name = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' && typeof p.key.value === 'string' ? p.key.value : null;
      if (name == null) continue;
      const value = p.value.type === 'Identifier' ? this.useOf.get(p.value)?.decl : undefined;
      out.push({ id: p.key, key: `${base}.${name}`, def: true, at: value?.id });
      const inner = objectValue(p.value);
      if (inner) this.objectPaths(inner, `${base}.${name}`, out);
    }
  }

  private resolve(id: N, scope: Scope, shorthand: boolean): void {
    let decl: Decl | null = null;
    for (let s: Scope | null = scope; s; s = s.parent) {
      const d = s.decls.get(id.name);
      if (d) {
        decl = d;
        break;
      }
    }
    const u: Use = { id, decl, declaration: false, shorthand };
    this.uses.push(u);
    this.useOf.set(id, u);
  }

  /** A name's key: its own for a global, else the local variable's (`#12`). */
  private nameKey(id: N): string | null {
    const u = this.useOf.get(id);
    if (!u) return null;
    return u.decl && !u.decl.global ? `#${u.decl.uid}` : id.name;
  }

  /** The key of a member expression's path (null: it doesn't start with a name, or has a computed part). */
  private keyOf(n: N): string | null {
    if (n.type === 'ChainExpression') return this.keyOf(n.expression);
    if (n.type === 'Identifier') return this.nameKey(n);
    if (n.type !== 'MemberExpression') return null;
    const name = !n.computed && n.property.type === 'Identifier' ? n.property.name : n.computed && n.property.type === 'Literal' && typeof n.property.value === 'string' ? n.property.value : null;
    if (name == null) return null;
    const base = this.keyOf(n.object);
    if (base == null) return null;
    // window.Contoso is the global Contoso.
    return GLOBAL_OBJECTS.has(base) ? name : `${base}.${name}`;
  }
}

/** Whether an identifier at parent[key] is a name used in an expression (not a property name nor a label). */
function isReference(parent: N, key: string): boolean {
  switch (parent.type) {
    case 'MemberExpression':
      return key !== 'property' || parent.computed;
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return key !== 'key' || parent.computed;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return key !== 'label';
    case 'ExportSpecifier':
    case 'ImportSpecifier':
      return false;
  }
  return true;
}

/** The object literal a value gives (X || {...}, X || (X = {...}), the object a module pattern's function returns). */
function objectValue(v: N | null | undefined): N | undefined {
  if (!v) return undefined;
  if (v.type === 'ObjectExpression') return v;
  if (v.type === 'LogicalExpression' && (v.operator === '||' || v.operator === '??')) return objectValue(v.right);
  if (v.type === 'AssignmentExpression') return objectValue(v.right);
  if (v.type === 'CallExpression') {
    let c = v.callee;
    if (c.type === 'MemberExpression' && !c.computed && (c.property.name === 'call' || c.property.name === 'apply')) c = c.object;
    if ((c.type === 'FunctionExpression' || c.type === 'ArrowFunctionExpression') && c.body.type === 'BlockStatement') {
      const ret = [...(c.body.body as N[])].reverse().find((s) => s.type === 'ReturnStatement');
      return ret?.argument?.type === 'ObjectExpression' ? ret.argument : undefined;
    }
  }
  return undefined;
}


/** A script's names and paths (null when it doesn't parse: in the middle of an edit, or too big). */
export function analyseText(text: string): Analysis | null {
  if (text.length > MAX_LENGTH) return null;
  try {
    const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true, allowReturnOutsideFunction: true }) as unknown as N;
    return new Analyser().run(ast);
  } catch {
    return null;
  }
}

/** A stretch of the text: [start, end) offsets. */
export interface Span {
  start: number;
  end: number;
}

/** What is at an offset: a local variable, or a global name or path (its key; local: it starts with a local variable). */
export type Target = { kind: 'local'; decl: Decl; id: N } | { kind: 'key'; key: string; id: N; local: boolean };

const within = (id: N, offset: number) => offset >= id.start && offset <= id.end;

export function targetAt(a: Analysis, offset: number): Target | null {
  const p = a.paths.find((x) => within(x.id, offset));
  if (p) return { kind: 'key', key: p.key, id: p.id, local: p.key.startsWith('#') };
  const u = a.uses.find((x) => within(x.id, offset));
  if (!u) return null;
  if (u.decl && !u.decl.global) return { kind: 'local', decl: u.decl, id: u.id };
  return { kind: 'key', key: u.id.name, id: u.id, local: false };
}

const span = (n: N): Span => ({ start: n.start, end: n.end });

/** Where a global name or path gets its value in one script. */
export function definitionSpans(key: string, a: Analysis, text: string): Span[] {
  const out: Span[] = [];
  for (const p of a.paths) if (p.def && p.key === key) out.push(span(p.at ?? p.id));
  if (!key.includes('.')) {
    for (const u of a.uses) if (u.declaration && u.decl?.global && u.decl.name === key) out.push(span(u.id));
    // An implicit global: assigned where it is first used, without a declaration (foo = …).
    if (!out.length) for (const u of a.uses) if (!u.decl && u.id.name === key && /^\s*=(?![=>])/.test(text.slice(u.id.end, u.id.end + 40))) out.push(span(u.id));
  }
  return out;
}

/** Every use of a global name or path in one script (its definitions included). */
export function referenceSpans(key: string, a: Analysis): Span[] {
  const out: Span[] = [];
  for (const p of a.paths) if (p.key === key) out.push(span(p.id));
  if (!key.includes('.')) for (const u of a.uses) if ((!u.decl || u.decl.global) && u.id.name === key) out.push(span(u.id));
  return out.sort((x, y) => x.start - y.start);
}

/** Every occurrence of a local variable (its declaration included). */
export function localSpans(decl: Decl, a: Analysis): Array<Span & { shorthand: boolean }> {
  return a.uses.filter((u) => u.decl === decl).map((u) => ({ ...span(u.id), shorthand: u.shorthand }));
}

const RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval undefined NaN Infinity'.split(' '),
);

/** Whether a variable can be called this. */
export const isValidName = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED.has(name);

/** Why a name can't be renamed at an offset, or what (where, and its name now). */
export function renameTarget(a: Analysis | null, offset: number): { span: Span; name: string } | { span: Span | null; reason: string } {
  if (!a) return { span: null, reason: 'Fix the syntax error first: the script must be read as a whole to rename in it.' };
  const t = targetAt(a, offset);
  if (!t) return { span: null, reason: 'Put the cursor on a name to rename it.' };
  if (t.kind === 'key')
    return {
      span: span(t.id),
      reason: `${t.key.includes('.') ? 'A member of a namespace' : 'A global name'} is not renamed here: the form's event handlers and other scripts may use it. Shift+F12 lists where the scripts the manager knows use it.`,
    };
  return { span: span(t.id), name: t.decl.name };
}

/** The edits that rename the local variable at an offset (a { name } shorthand keeps its property: { name: newName }). */
export function renameEdits(a: Analysis | null, offset: number, newName: string): Array<Span & { text: string }> | string {
  if (!isValidName(newName)) return `${newName} is not a name a variable can have.`;
  const t = a && targetAt(a, offset);
  if (!a || !t || t.kind !== 'local') return 'Nothing to rename here.';
  return localSpans(t.decl, a).map((s) => ({ start: s.start, end: s.end, text: s.shorthand ? `${t.decl.name}: ${newName}` : newName }));
}

/** The definitions of a word in a script that doesn't parse right now: function name(, name: function, name = () =>… */
export function textDefinitionSpans(word: string, text: string): Span[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(word) || text.length > MAX_LENGTH) return [];
  const w = word.replace(/\$/g, '\\$');
  // Each has one group, the name: the d flag gives where it is.
  const patterns = [
    new RegExp(`\\bfunction\\s*\\*?\\s*(${w})(?![\\w$])`, 'gd'),
    new RegExp(`(?:^|[^.\\w$])(${w})\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>)`, 'gmd'),
    new RegExp(`\\b(?:var|let|const|class)\\s+(${w})(?![\\w$])`, 'gd'),
  ];
  const out: Span[] = [];
  for (const re of patterns)
    for (const x of text.matchAll(re)) {
      const at = x.indices?.[1];
      if (at && !out.some((s) => s.start === at[0])) out.push({ start: at[0], end: at[1] });
    }
  return out.sort((x, y) => x.start - y.start);
}

/** Every whole-word occurrence of a name, outside strings and comments as far as a quick look can tell (a script that doesn't parse). */
export function textReferenceSpans(word: string, text: string): Span[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(word) || text.length > MAX_LENGTH) return [];
  const re = new RegExp(`(?<![\\w$])${word.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  const out: Span[] = [];
  for (const x of text.matchAll(re)) {
    const at = x.index ?? 0;
    // Not in a // comment on the same line, nor in a string started before it on that line.
    // (At most the 2,000 characters before it, and a pattern without backtracking: minified lines are long.)
    const before = text.slice(Math.max(text.lastIndexOf('\n', at - 1) + 1, at - 2000), at).replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '');
    if (/\/\/|["'`]/.test(before)) continue;
    out.push({ start: at, end: at + word.length });
  }
  return out;
}

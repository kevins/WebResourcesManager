// Reads a script the way the client API IntelliSense needs it: the type of the expression before a dot
// (formContext.getAttribute("name").), the call the cursor is in (parameter hints), the member under the mouse (hover),
// and whether the cursor is in a string that names a column, a control or a table. There is no type checker in the
// bookmarklet, so this works on the tokens of the text: chains of members from Xrm or from a variable, variables
// followed to what was assigned to them, and parameters known by their usual names (executionContext, formContext).
// Strings, comments, regular expressions and template text are tokens of their own, so nothing inside them counts.
// Pure functions of the text, without Monaco: the unit tests run them in Node.

import { GLOBAL, member, type Member, type NameKind, type Signature, typeInfo } from './xrm-model';

export interface Token {
  /** id: a name or keyword; num; str: a quoted string; tpl: a piece of a template literal; rx: a regex; p: punctuation. */
  k: 'id' | 'num' | 'str' | 'tpl' | 'rx' | 'p';
  /** The text; for a string, what is between the quotes. */
  v: string;
  /** Start and end offsets in the text (end exclusive; a string's include its quotes). */
  s: number;
  e: number;
  /** A line break comes before the token (where JavaScript may insert a semicolon). */
  nl: boolean;
  /** A string or template literal that isn't closed (yet). */
  open?: boolean;
}

export interface Lexed {
  toks: Token[];
  /** The comments, as start and end offsets in pairs (a line comment's end includes its line break). */
  comments: number[];
}

// ------------------------------------------------------------------ tokens

const NUM = /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y;
const PUNCT = /\?\.(?!\d)|\.\.\.|>>>=|===|!==|\*\*=|<<=|>>=|>>>|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|&&|\|\||\?\?|\+\+|--|[-+*/%&|^]=|\*\*|<<|>>|[{}()[\];,<>+\-*/%&|^!~?:=.@#]/y;
/** After these words a slash starts a regular expression; after other names it divides. */
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const KEYWORDS = new Set(
  'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof new return super switch this throw try typeof var void while with yield let static await async of null true false undefined'.split(' '),
);
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

const isNl = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const isIdStart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127;
const isIdPart = (c: number) => isIdStart(c) || (c >= 48 && c <= 57);
const isDot = (t: Token | undefined) => !!t && t.k === 'p' && (t.v === '.' || t.v === '?.');
const isP = (t: Token | undefined, v: string) => !!t && t.k === 'p' && t.v === v;

function regexAllowed(prev: Token | undefined): boolean {
  if (!prev) return true;
  if (prev.k === 'id') return REGEX_AFTER.has(prev.v);
  // After a closing parenthesis or bracket a slash divides; after a block's brace a statement (maybe a regex) starts.
  if (prev.k === 'p') return !(prev.v === ')' || prev.v === ']' || prev.v === '++' || prev.v === '--');
  // At the start of a template substitution (`${/x/.test(s)}`) an expression starts.
  return prev.k === 'tpl' && prev.v.endsWith('${');
}

/** The end of the regular expression starting at i, or -1 when the slash isn't one. */
function regexEnd(text: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (isNl(c)) return -1;
    if (c === 92) j++;
    else if (c === 91) inClass = true;
    else if (c === 93) inClass = false;
    else if (c === 47 && !inClass) {
      j++;
      while (j < text.length && /[a-z]/i.test(text[j])) j++;
      return j;
    }
  }
  return -1;
}

/** Splits JavaScript into tokens; comments are left out (their places are kept). */
export function tokenize(text: string): Lexed {
  const toks: Token[] = [];
  const comments: number[] = [];
  // For each open brace: whether it opened a template substitution (${), whose } goes back to the template's text.
  const braces: boolean[] = [];
  const n = text.length;
  let i = 0;
  let nl = false;
  const push = (k: Token['k'], v: string, s: number, e: number, open = false) => {
    const t: Token = { k, v, s, e, nl };
    if (open) t.open = true;
    toks.push(t);
    nl = false;
  };
  // The text of a template literal from j to its end or to the next ${ (s: where this piece starts).
  const template = (j: number, s: number): number => {
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 92) j += 2;
      else if (c === 96) {
        push('tpl', text.slice(s, j + 1), s, j + 1);
        return j + 1;
      } else if (c === 36 && text.charCodeAt(j + 1) === 123) {
        push('tpl', text.slice(s, j + 2), s, j + 2);
        braces.push(true);
        return j + 2;
      } else j++;
    }
    push('tpl', text.slice(s, n), s, n, true);
    return n;
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isNl(c)) {
      nl = true;
      i++;
      continue;
    }
    if (c === 32 || c === 9 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff || (c > 127 && /\s/.test(text[i]))) {
      i++;
      continue;
    }
    if (c === 47) {
      const d = text.charCodeAt(i + 1);
      if (d === 47) {
        let j = i + 2;
        while (j < n && !isNl(text.charCodeAt(j))) j++;
        comments.push(i, j + 1);
        i = j;
        continue;
      }
      if (d === 42) {
        const j = text.indexOf('*/', i + 2);
        const e = j < 0 ? n : j + 2;
        for (let k = i; k < e && !nl; k++) nl = isNl(text.charCodeAt(k));
        comments.push(i, e);
        i = e;
        continue;
      }
      if (regexAllowed(toks[toks.length - 1])) {
        const e = regexEnd(text, i);
        if (e > 0) {
          push('rx', text.slice(i, e), i, e);
          i = e;
          continue;
        }
      }
    }
    if (c === 34 || c === 39) {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const ch = text.charCodeAt(j);
        if (ch === c) {
          closed = true;
          break;
        }
        if (isNl(ch)) break;
        // A backslash escapes the next character, or continues the string on the next line (\ then CR LF).
        j += ch !== 92 ? 1 : text.charCodeAt(j + 1) === 13 && text.charCodeAt(j + 2) === 10 ? 3 : 2;
      }
      j = Math.min(j, n);
      push('str', text.slice(i + 1, j), i, closed ? j + 1 : j, !closed);
      i = closed ? j + 1 : j;
      continue;
    }
    if (c === 96) {
      i = template(i + 1, i);
      continue;
    }
    if (c === 125 && braces.length && braces[braces.length - 1]) {
      braces.pop();
      i = template(i + 1, i);
      continue;
    }
    if (isIdStart(c) || (c === 35 && isIdStart(text.charCodeAt(i + 1)))) {
      let j = i + 1;
      for (; j < n; j++) {
        const d = text.charCodeAt(j);
        if (!isIdPart(d) || (d > 127 && /\s/.test(text[j]))) break;
      }
      push('id', text.slice(i, j), i, j);
      i = j;
      continue;
    }
    if ((c >= 48 && c <= 57) || (c === 46 && text.charCodeAt(i + 1) >= 48 && text.charCodeAt(i + 1) <= 57)) {
      NUM.lastIndex = i;
      const m = NUM.exec(text);
      const e = i + (m ? m[0].length : 1);
      push('num', text.slice(i, e), i, e);
      i = e;
      continue;
    }
    PUNCT.lastIndex = i;
    const v = PUNCT.exec(text)?.[0] ?? text[i];
    if (v === '{') braces.push(false);
    else if (v === '}') braces.pop();
    push('p', v, i, i + v.length);
    i += v.length;
  }
  return { toks, comments };
}

// Completions, hovers and parameter hints ask about the same text many times in a row.
let cache: { text: string; lexed: Lexed } | undefined;
function lex(text: string): Lexed {
  if (cache?.text !== text) cache = { text, lexed: tokenize(text) };
  return cache.lexed;
}

/** The index of the last token that starts before offset (-1 when none does). */
function lastBefore(toks: Token[], offset: number): number {
  let lo = 0;
  let hi = toks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].s < offset) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Whether offset is in code: not in a string, a comment, a regular expression or the text of a template. */
export function inCode(text: string, offset: number): boolean {
  const { toks, comments } = lex(text);
  let lo = 0;
  let hi = comments.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (comments[mid * 2] < offset) {
      if (offset < comments[mid * 2 + 1]) return false;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const t = toks[lastBefore(toks, offset)];
  return !(t && (t.k === 'str' || t.k === 'tpl' || t.k === 'rx') && (offset < t.e || (t.open && offset === t.e)));
}

// ------------------------------------------------------------------ expressions

interface Args {
  n: number;
  /** What the first argument is: it chooses the overload (getAttribute("x") vs getAttribute(0)). */
  first?: ArgKind;
}
type ArgKind = 'string' | 'number' | 'function' | 'other';

/** A piece of a member chain: a name (maybe called), an index ([0]) or a parenthesized expression (at its root). */
interface Seg {
  name?: string;
  call?: Args;
  index?: boolean;
  paren?: [number, number];
}

interface Chain {
  segs: Seg[];
  /** The index of its first token. */
  start: number;
}

/** The index of the bracket that opens the one closed at j (-1 when none does, at or after min). */
function matchBack(toks: Token[], j: number, min: number): number {
  let depth = 0;
  for (let i = j; i >= min; i--) {
    const t = toks[i];
    if (t.k !== 'p') continue;
    if (CLOSE.has(t.v)) depth++;
    else if (OPEN.has(t.v) && --depth === 0) return i;
  }
  return -1;
}

function argKind(toks: Token[], from: number, to: number): ArgKind | undefined {
  const t = toks[from];
  if (!t || from >= to) return undefined;
  if (t.k === 'str' || t.k === 'tpl') return 'string';
  if (t.k === 'num' || (isP(t, '-') && toks[from + 1]?.k === 'num')) return 'number';
  if (t.k === 'id' && (t.v === 'function' || (t.v === 'async' && toks[from + 1]?.v === 'function'))) return 'function';
  // An arrow function: x => ..., (x, i) => ...
  let depth = 0;
  for (let i = from; i < to; i++) {
    const u = toks[i];
    if (u.k !== 'p') continue;
    if (OPEN.has(u.v)) depth++;
    else if (CLOSE.has(u.v)) depth--;
    else if (depth === 0 && u.v === '=>') return 'function';
    else if (depth === 0 && u.v === ',') break;
  }
  return 'other';
}

function argsOf(toks: Token[], open: number, close: number): Args {
  if (close === open + 1) return { n: 0 };
  let n = 1;
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const t = toks[i];
    if (t.k !== 'p') continue;
    if (OPEN.has(t.v)) depth++;
    else if (CLOSE.has(t.v)) depth--;
    else if (depth === 0 && t.v === ',') n++;
  }
  return { n, first: argKind(toks, open + 1, close) };
}

/** The member chain whose last token is toks[end], read backwards (not past min). */
function chainBack(toks: Token[], end: number, min: number): Chain | undefined {
  const segs: Seg[] = [];
  let j = end;
  for (;;) {
    if (j < min) return undefined;
    const t = toks[j];
    if (isP(t, ')')) {
      const open = matchBack(toks, j, min);
      if (open < 0) return undefined;
      const callee = open - 1 >= min ? toks[open - 1] : undefined;
      if (callee?.k === 'id' && !KEYWORDS.has(callee.v)) {
        segs.unshift({ name: callee.v, call: argsOf(toks, open, j) });
        j = open - 1;
      } else if (callee && (isP(callee, ')') || isP(callee, ']'))) {
        return undefined; // f()() and a[0](): not followed
      } else {
        segs.unshift({ paren: [open + 1, j - 1] });
        return { segs, start: open };
      }
    } else if (isP(t, ']')) {
      const open = matchBack(toks, j, min);
      const before = open - 1 >= min ? toks[open - 1] : undefined;
      // Something must be indexed: a name, a call or another index (otherwise it is an array literal).
      if (!before || !(before.k === 'id' || isP(before, ')') || isP(before, ']'))) return undefined;
      segs.unshift({ index: true });
      j = open - 1;
      continue;
    } else if (t.k === 'id') {
      segs.unshift({ name: t.v });
    } else return undefined;
    if (j - 1 >= min && isDot(toks[j - 1])) {
      j -= 2;
      continue;
    }
    return { segs, start: j };
  }
}

/** The last token of the expression that starts at from: up to a comma, a semicolon, a closing bracket or a new statement. */
function exprEnd(toks: Token[], from: number): number {
  let depth = 0;
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (i > from && depth === 0 && t.nl && endsValue(toks[i - 1]) && startsValue(t)) return i - 1;
    if (t.k !== 'p') continue;
    if (OPEN.has(t.v)) depth++;
    else if (CLOSE.has(t.v)) {
      if (depth === 0) return i - 1;
      depth--;
    } else if (depth === 0 && (t.v === ',' || t.v === ';')) return i - 1;
  }
  return toks.length - 1;
}
const OPERATOR_WORDS = new Set(['in', 'of', 'instanceof']);
const endsValue = (t: Token) =>
  t.k === 'num' || t.k === 'str' || t.k === 'rx' || (t.k === 'tpl' && t.v.endsWith('`')) || (t.k === 'id' && !OPERATOR_WORDS.has(t.v)) || (t.k === 'p' && CLOSE.has(t.v));
const startsValue = (t: Token) => (t.k === 'id' ? !OPERATOR_WORDS.has(t.v) : t.k === 'num' || t.k === 'str' || (t.k === 'tpl' && t.v.startsWith('`')));

/** The overload a call uses: the one without parameters when called without arguments, else by the first argument. */
export function pickSignature(sigs: Signature[], args?: Args): Signature {
  if (sigs.length === 1 || !args) return sigs[0];
  if (args.n === 0) return sigs.find((s) => s.params.every((p) => p.optional)) ?? sigs[0];
  const withParams = sigs.filter((s) => s.params.length > 0);
  const want = args.first;
  const fits = (type: string) => (want === 'string' ? type === 'string' : want === 'number' ? /\bnumber\b/.test(type) : want === 'function' ? type === 'function' : false);
  return withParams.find((s) => fits(s.params[0].type)) ?? withParams[0] ?? sigs[0];
}

// Usual names of handler parameters. The strong ones are taken at their word even when the script assigns them
// something this can't follow (var formContext = getFormContext()); the weak ones only when nothing is assigned to
// them, and context-like names only when the script calls .getFormContext() on them (they could be anything).
const CONVENTION: Record<string, string> = {
  executionContext: 'ExecutionContext',
  execContext: 'ExecutionContext',
  executionCtx: 'ExecutionContext',
  execCtx: 'ExecutionContext',
  eContext: 'ExecutionContext',
  econtext: 'ExecutionContext',
  context: 'ExecutionContext',
  ctx: 'ExecutionContext',
  formContext: 'FormContext',
  formCtx: 'FormContext',
  form: 'FormContext',
  fc: 'FormContext',
  // Commands (ribbon) get the form context as their PrimaryControl parameter.
  primaryControl: 'FormContext',
  globalContext: 'GlobalContext',
};
const STRONG = new Set(['executionContext', 'execContext', 'executionCtx', 'execCtx', 'formContext', 'formCtx', 'primaryControl', 'globalContext']);
const NEEDS_GET_FORM_CONTEXT = new Set(['eContext', 'econtext', 'context', 'ctx']);
/** Names of the window the page's Xrm can be reached through (parent.Xrm from an HTML web resource). */
const WINDOWS = new Set(['window', 'parent', 'top', 'opener', 'self', 'globalThis', 'frames']);

/** State of one question about the text: the tokens, and the assignments being followed (to stop at cycles). */
class Ctx {
  depth = 0;
  readonly busy = new Set<number>();
  private callers?: Set<string>;
  constructor(readonly toks: Token[]) {}

  /** Whether the text calls .getFormContext() on this name. */
  getsFormContext(name: string): boolean {
    if (!this.callers) {
      this.callers = new Set();
      const t = this.toks;
      for (let i = 2; i < t.length; i++) if (t[i].k === 'id' && t[i].v === 'getFormContext' && isDot(t[i - 1]) && t[i - 2].k === 'id') this.callers.add(t[i - 2].v);
    }
    return this.callers.has(name);
  }
}

/** The type of the expression whose last token is toks[end]. */
function typeEndingAt(ctx: Ctx, end: number, min = 0): string | undefined {
  const c = chainBack(ctx.toks, end, min);
  return c && chainType(ctx, c);
}

const isName = (s: Seg) => !!s.name && !s.call;

function chainType(ctx: Ctx, { segs, start }: Chain): string | undefined {
  let k = 0;
  let type: string | undefined;
  const first = segs[0];
  if (first.paren) {
    type = first.paren[1] >= first.paren[0] ? typeEndingAt(ctx, first.paren[1], first.paren[0]) : undefined;
    k = 1;
  } else {
    // window.Xrm, parent.Xrm, top.Xrm: the Xrm of the page.
    let w = 0;
    while (w < segs.length - 1 && isName(segs[w]) && WINDOWS.has(segs[w].name!)) w++;
    if (w && segs[w].name === 'Xrm') k = w;
    // A dotted path assigned somewhere: this.formContext = ..., Contoso.formContext = ...
    let plain = k;
    while (plain < segs.length && isName(segs[plain])) plain++;
    for (let p = plain; p >= k + 2 && !type; p--) {
      const found = assigned(ctx, segs.slice(k, p).map((s) => s.name!), start);
      if (found.type) {
        type = found.type;
        k = p;
      }
    }
    if (!type) {
      type = rootType(ctx, segs[k], start);
      k++;
    }
  }
  for (; type && k < segs.length; k++) type = stepType(type, segs[k]);
  return type;
}

function rootType(ctx: Ctx, seg: Seg, at: number): string | undefined {
  if (!seg.name) return undefined;
  const g = member(GLOBAL, seg.name);
  if (g) return valueOf(g, seg);
  if (seg.call || KEYWORDS.has(seg.name)) return undefined;
  return nameType(ctx, seg.name, at);
}

/** The type of a variable or parameter used at token index at. */
function nameType(ctx: Ctx, name: string, at: number): string | undefined {
  const found = assigned(ctx, [name], at);
  if (found.type) return found.type;
  const conv = CONVENTION[name];
  if (!conv || (found.any && !STRONG.has(name))) return undefined;
  if (NEEDS_GET_FORM_CONTEXT.has(name) && !ctx.getsFormContext(name)) return undefined;
  return conv;
}

/**
 * The parameters of the function whose body starts at toks[q] (its { or the token after =>), if it is one, and the
 * index where they start.
 */
function paramsBefore(toks: Token[], q: number): { names: string[]; open: number } | undefined {
  const arrow = isP(toks[q - 1], '=>');
  let close = q - 1;
  if (arrow) {
    if (toks[q - 2]?.k === 'id') return { names: [toks[q - 2].v], open: q - 2 };
    close = q - 2;
  }
  if (!isP(toks[close], ')')) return undefined;
  const open = matchBack(toks, close, 0);
  const head = toks[open - 1];
  // function (...) {, name(...) { (a method), catch (e) {, (...) => {: yes; if (...) {, while (...) {: no.
  if (open < 0 || !(arrow || (head && (head.v === 'function' || head.v === 'catch' || (head.k === 'id' && !KEYWORDS.has(head.v)))))) return undefined;
  return { names: toks.slice(open + 1, close).filter((t) => t.k === 'id').map((t) => t.v), open };
}

/**
 * Follows the assignments to a name or dotted path before token index at, closest first: var/let/const name = ...,
 * name = ..., this.x = ... The first whose value has a known type wins; `any` tells whether there was one at all.
 * A name that is a parameter of the function the use is in stops the search at that function's parameters (where its
 * default value may be): earlier assignments are to another variable of the same name.
 */
function assigned(ctx: Ctx, path: string[], at: number): { type?: string; any: boolean } {
  const { toks } = ctx;
  let any = false;
  if (ctx.depth > 24) return { any };
  let tried = 0;
  let braces = 0;
  // Once the function with this parameter is found: where its parameters start (the search doesn't go below).
  let floor = -1;
  for (let q = Math.min(at, toks.length) - 1; q > Math.max(floor, 0) && tried < 8; q--) {
    const t = toks[q];
    if (path.length === 1 && t.k === 'p' && floor < 0) {
      let fn: ReturnType<typeof paramsBefore>;
      if (t.v === '}') braces++;
      else if (t.v === '{') {
        if (braces > 0) braces--;
        else fn = paramsBefore(toks, q);
      } else if (t.v === '=>' && braces === 0 && !isP(toks[q + 1], '{') && exprEnd(toks, q + 1) >= at) fn = paramsBefore(toks, q + 1);
      if (fn?.names.includes(path[0])) floor = fn.open;
    }
    if (!isP(t, '=')) continue;
    const first = q - (2 * path.length - 1);
    if (first < 0) continue;
    let ok = true;
    for (let p = 0; p < path.length && ok; p++) {
      const u = toks[first + 2 * p];
      ok = u.k === 'id' && u.v === path[p] && (p === 0 || isP(toks[first + 2 * p - 1], '.'));
    }
    // Part of a longer path (a.formContext = ...) is something else.
    if (!ok || isDot(toks[first - 1])) continue;
    const end = exprEnd(toks, q + 1);
    // The use is inside the assigned expression itself (var x = x.y): this assignment can't tell.
    if (end < q + 1 || (at > q && at <= end) || ctx.busy.has(q)) continue;
    any = true;
    tried++;
    ctx.busy.add(q);
    ctx.depth++;
    const type = typeEndingAt(ctx, end, q + 1);
    ctx.depth--;
    ctx.busy.delete(q);
    if (type) return { type, any };
  }
  return { any };
}

function stepType(type: string, seg: Seg): string | undefined {
  if (seg.index) return /^(.+)\[\]$/.exec(type)?.[1];
  if (!seg.name) return undefined;
  const m = member(type, seg.name);
  return m && valueOf(m, seg);
}

function valueOf(m: Member, seg: Seg): string | undefined {
  if (m.kind !== 'method') return seg.call ? undefined : m.type;
  return seg.call ? pickSignature(m.sigs!, seg.call).returns : undefined;
}

/** The method called with the parenthesis at toks[open], and the type it is a member of. */
function calleeAt(ctx: Ctx, open: number): { owner: string; member: Member } | undefined {
  const toks = ctx.toks;
  const name = toks[open - 1];
  if (!name || name.k !== 'id') return undefined;
  let owner: string | undefined = GLOBAL;
  if (isDot(toks[open - 2])) owner = typeEndingAt(ctx, open - 3);
  const m = owner ? member(owner, name.v) : undefined;
  return owner && m?.kind === 'method' ? { owner, member: m } : undefined;
}

/** The bracket that encloses toks[i], and which comma-separated item of it toks[i] is in. */
function enclosing(toks: Token[], i: number): { at: number; arg: number } | undefined {
  let depth = 0;
  let arg = 0;
  for (let j = i - 1; j >= 0; j--) {
    const t = toks[j];
    if (t.k !== 'p') continue;
    if (CLOSE.has(t.v)) depth++;
    else if (OPEN.has(t.v)) {
      if (depth === 0) return { at: j, arg };
      depth--;
    } else if (depth === 0 && t.v === ',') arg++;
    else if (depth === 0 && t.v === ';') return undefined;
  }
  return undefined;
}

// ------------------------------------------------------------------ what the editor asks

/**
 * The type of the expression before the dot that ends just before offset: a type of the model ('FormContext',
 * 'Collection<Tab>') or an array of one ('Attribute[]'); undefined when it is something else or can't be known.
 */
export function typeAtDot(text: string, offset: number): string | undefined {
  const { toks } = lex(text);
  const i = lastBefore(toks, offset);
  if (!isDot(toks[i]) || toks[i].e !== offset) return undefined;
  const type = typeEndingAt(new Ctx(toks), i - 1);
  return type && typeInfo(type.replace(/\[\]$/, '')) ? type : undefined;
}

/** A string the cursor is in, that names a table, a column or a control. */
export interface NameSlot {
  kind: NameKind;
  /** Where the text between the quotes starts and ends. */
  start: number;
  end: number;
  quote: string;
}

/** Object keys whose string values are table logical names (openForm, navigateTo, lookupObjects, lookup values). */
const TABLE_KEYS = new Set(['entityName', 'entityType', 'entityTypes', 'entityLogicalName', 'defaultEntityType']);

/**
 * Whether the cursor is in a string that names something: getAttribute("|"), getControl("|"), get("|") of the
 * columns and controls collections, the table of Xrm.WebApi calls, setEntityTypes(["|"]), { entityName: "|" }.
 */
export function nameSlot(text: string, offset: number): NameSlot | undefined {
  const { toks } = lex(text);
  const i = lastBefore(toks, offset);
  const t = toks[i];
  if (!t || t.k !== 'str') return undefined;
  const end = t.open ? t.e : t.e - 1;
  if (offset < t.s + 1 || offset > end) return undefined;
  const kind = slotKind(new Ctx(toks), i);
  return kind && { kind, start: t.s + 1, end, quote: text[t.s] };
}

function slotKind(ctx: Ctx, i: number): NameKind | undefined {
  const toks = ctx.toks;
  const keyBefore = (j: number) => {
    const key = toks[j - 2];
    return isP(toks[j - 1], ':') && !!key && (key.k === 'id' || key.k === 'str') && TABLE_KEYS.has(key.v);
  };
  if (isP(toks[i - 1], ':')) return keyBefore(i) ? 'table' : undefined;
  const prev = toks[i - 1];
  if (!prev || prev.k !== 'p' || !(prev.v === '(' || prev.v === ',' || prev.v === '[')) return undefined;
  let place = enclosing(toks, i);
  if (!place) return undefined;
  let inArray = false;
  if (toks[place.at].v === '[') {
    // An array of names: setEntityTypes(["account", "|"]), { entityTypes: ["|"] }.
    if (keyBefore(place.at)) return 'table';
    const before = toks[place.at - 1];
    if (!isP(before, '(') && !isP(before, ',')) return undefined;
    place = enclosing(toks, place.at);
    if (!place) return undefined;
    inArray = true;
  }
  if (toks[place.at].v !== '(') return undefined;
  const call = calleeAt(ctx, place.at);
  const arg = place.arg;
  const param = call?.member.sigs!.map((s) => s.params[arg]).find((p) => p?.names && p.type.endsWith('[]') === inArray);
  return param?.names;
}

/** The call the cursor is in, for parameter hints. */
export interface CallSite {
  /** The type the method belongs to (GLOBAL for GetGlobalContext). */
  owner: string;
  member: Member;
  /** The overload that fits what is typed, and the parameter the cursor is at. */
  signature: number;
  parameter: number;
}

export function callAt(text: string, offset: number): CallSite | undefined {
  const { toks } = lex(text);
  const ctx = new Ctx(toks);
  const last = lastBefore(toks, offset);
  let depth = 0;
  let arg = 0;
  for (let j = last; j >= 0; j--) {
    const t = toks[j];
    if (t.k !== 'p') continue;
    if (CLOSE.has(t.v)) {
      depth++;
      continue;
    }
    if (OPEN.has(t.v)) {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (t.v === '(') {
        const call = calleeAt(ctx, j);
        if (!call) return undefined;
        const sigs = call.member.sigs!;
        let signature = 0;
        const first = argKind(toks, j + 1, last + 1);
        if (sigs.length > 1 && first) signature = sigs.indexOf(pickSignature(sigs, { n: arg + 1, first }));
        if (sigs[signature].params.length <= arg) {
          const wider = sigs.findIndex((s) => s.params.length > arg);
          if (wider >= 0) signature = wider;
        }
        return { owner: call.owner, member: call.member, signature, parameter: arg };
      }
      // In a function body that is an argument (addOnChange(function () { | })) there is no call to help with.
      if (t.v === '{' && (isP(toks[j - 1], ')') || isP(toks[j - 1], '=>'))) return undefined;
      // In an object or array literal argument: its commas aren't the call's.
      arg = 0;
      continue;
    }
    if (depth === 0 && t.v === ',') arg++;
    else if (depth === 0 && t.v === ';') return undefined;
  }
  return undefined;
}

/** What the mouse is over: a member of the client API, a global, or a variable of a known type. */
export interface HoverTarget {
  start: number;
  end: number;
  /** The name under the mouse. */
  name: string;
  /** For a member: the type it belongs to (GLOBAL for Xrm and GetGlobalContext). */
  owner?: string;
  member?: Member;
  /** For a variable or parameter: its type. */
  type?: string;
}

export function hoverAt(text: string, offset: number): HoverTarget | undefined {
  const { toks } = lex(text);
  const i = lastBefore(toks, offset + 1);
  const t = toks[i];
  if (!t || t.k !== 'id' || t.e <= offset) return undefined;
  const ctx = new Ctx(toks);
  const at = { start: t.s, end: t.e, name: t.v };
  if (isDot(toks[i - 1])) {
    const owner = typeEndingAt(ctx, i - 2);
    const m = owner ? member(owner, t.v) : undefined;
    return m ? { ...at, owner, member: m } : undefined;
  }
  const g = member(GLOBAL, t.v);
  if (g) return { ...at, owner: GLOBAL, member: g };
  if (KEYWORDS.has(t.v) || isP(toks[i + 1], ':')) return undefined;
  // At its own declaration (var formContext = ...), the variable's type is what it is given.
  const given = isP(toks[i + 1], '=') ? typeEndingAt(ctx, exprEnd(toks, i + 2), i + 2) : undefined;
  const type = given ?? nameType(ctx, t.v, i);
  return type ? { ...at, type } : undefined;
}

// ------------------------------------------------------------------ HTML pages

/** The script of an HTML page: everything outside inline <script> blocks blanked out, so offsets stay the same. */
export interface ScriptView {
  text: string;
  /** Start and end offsets of the inline scripts. */
  blocks: Array<[number, number]>;
}

export function scriptView(html: string): ScriptView {
  const blocks: Array<[number, number]> = [];
  const blank = (s: string) => s.replace(/[^\r\n]/g, ' ');
  let out = '';
  let last = 0;
  // A block still being typed (no </script> yet) runs to the end of the page.
  const re = /<script\b([^>]*)>([\s\S]*?)(?:<\/script\s*>|$)/gi;
  for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
    const attrs = m[1];
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase() || '';
    if (/\bsrc\s*=/i.test(attrs) || (type && !/javascript|ecmascript|^module$/.test(type))) continue;
    const start = m.index + m[0].indexOf('>') + 1;
    const end = start + m[2].length;
    out += blank(html.slice(last, start)) + m[2];
    last = end;
    blocks.push([start, end]);
  }
  out += blank(html.slice(last));
  return { text: out, blocks };
}

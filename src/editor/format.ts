// Format Document (Shift+Alt+F) for every text type: js-beautify for JavaScript, CSS and HTML (the plugin's own
// formatter is a port of it), the manager's XML formatter for XML, XSL, SVG and RESX, and a JSON formatter that only
// changes the spacing between tokens. Options follow the editor's: its indentation (tabs or spaces, size) and the
// file's line ending. Also: which editor language a web resource gets, and keeping a file's own line endings.

import { parse } from 'acorn';
import { generate } from 'astring';
import beautify from 'js-beautify';
import { diffLines } from '../model/diff';
import { TYPES, type WrType } from '../model/types';
import { formatXml, minifyXml } from './xmlformat';

/**
 * The editor language of a web resource: its type's, except JSON. Dataverse has no JSON type, so JSON is stored as a
 * Script (JScript) or as Data (XML) and told apart by its name; checked or formatted as either, it would get false
 * errors, and the XML formatter would break it.
 */
export function languageOf(type: number, name = ''): string {
  if ((type === 3 || type === 4) && /\.json$/i.test(name)) return 'json';
  return TYPES[type as WrType]?.language || 'plaintext';
}

export interface FormatOptions {
  tabSize: number;
  insertSpaces: boolean;
  eol: '\n' | '\r\n';
}

const common = (o: FormatOptions) => ({
  indent_size: o.insertSpaces ? o.tabSize : 1,
  indent_char: o.insertSpaces ? ' ' : '\t',
  indent_with_tabs: !o.insertSpaces,
  eol: o.eol,
  preserve_newlines: true,
  max_preserve_newlines: 2,
  end_with_newline: false,
});

/**
 * Formats text of a Monaco language ('javascript', 'css', 'html', 'xml', 'json'); throws when it can't (XML not well
 * formed, JSON not valid).
 */
export function formatText(language: string, text: string, o: FormatOptions): string {
  const endsWithNewline = /\r?\n$/.test(text);
  let out: string;
  switch (language) {
    case 'javascript':
    case 'typescript':
      out = beautify.js(text, {
        ...common(o),
        brace_style: 'collapse',
        space_after_anon_function: true,
        space_after_named_function: false,
        keep_array_indentation: false,
        break_chained_methods: false,
        unescape_strings: false,
        wrap_line_length: 0,
        e4x: false,
        comma_first: false,
        operator_position: 'before-newline',
        space_in_empty_paren: false,
        jslint_happy: false,
      });
      break;
    case 'css':
      out = beautify.css(text, { ...common(o), selector_separator_newline: true, newline_between_rules: true, space_around_combinator: true });
      break;
    case 'html':
      out = beautify.html(text, {
        ...common(o),
        indent_inner_html: false,
        indent_scripts: 'normal',
        wrap_attributes: 'auto',
        wrap_line_length: 0,
        unformatted: ['code', 'pre', 'textarea'],
        extra_liners: [],
      });
      break;
    case 'xml':
      out = formatXml(text, o.insertSpaces ? ' '.repeat(o.tabSize) : '\t', o.eol);
      break;
    case 'json':
      out = formatJson(text, o.insertSpaces ? ' '.repeat(o.tabSize) : '\t', o.eol);
      break;
    default:
      return text;
  }
  // Keep the file's own last line ending (or its absence).
  out = out.replace(/(\r?\n)+$/, '');
  return endsWithNewline ? out + o.eol : out;
}

/** Whether formatText supports a language. */
export const canFormat = (language: string) => ['javascript', 'typescript', 'css', 'html', 'xml', 'json'].includes(language);

/**
 * Minifies (the plugin's Compress): JavaScript is parsed and printed again without comments and spacing, so it can't
 * change what the script does (names are kept: no renaming, which needs a whole-program view); a parse error refuses.
 * CSS loses comments and spacing; XML the spacing between tags; JSON the spacing between its tokens (refused when it
 * isn't valid).
 */
export function minifyText(language: string, text: string): string {
  switch (language) {
    case 'javascript': {
      const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
      return generate(ast as any, { indent: '', lineEnd: '' });
    }
    case 'css':
      return minifyCss(text);
    case 'xml':
      return minifyXml(text);
    case 'json':
      return minifyJson(text);
    default:
      throw new Error('Minify works on JavaScript, CSS, XML and JSON.');
  }
}

export const canMinify = (language: string) => ['javascript', 'css', 'xml', 'json'].includes(language);

// ------------------------------------------------------------------ JSON

interface JsonToken {
  /** '{', '}', '[', ']', ':', ',', 'string', 'number', 'literal' (true, false, null), 'end', or 'bad' (with `error`). */
  t: string;
  start: number;
  end: number;
  error?: string;
}

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_WORD = /[A-Za-z_$][\w$]*/y;

/** The JSON token at or after offset `i` (whitespace skipped); a 'bad' token says what isn't JSON there. */
function scanJson(text: string, i: number): JsonToken {
  const n = text.length;
  for (let c = text.charCodeAt(i); i < n && (c === 32 || c === 9 || c === 10 || c === 13); c = text.charCodeAt(++i));
  if (i >= n) return { t: 'end', start: n, end: n };
  const bad = (at: number, error: string): JsonToken => ({ t: 'bad', start: at, end: at + 1, error });
  const c = text[i];
  if ('{}[]:,'.includes(c)) return { t: c, start: i, end: i + 1 };
  if (c === '"') {
    for (let j = i + 1; ; ) {
      if (j >= n || text[j] === '\n' || text[j] === '\r') return bad(i, 'A string is not closed on its line: add the closing double quote (a line break in a string is written \\n).');
      const d = text[j];
      if (d === '"') return { t: 'string', start: i, end: j + 1 };
      if (d === '\\') {
        const e = text[j + 1];
        if (e === 'u' ? !/^[0-9a-fA-F]{4}$/.test(text.slice(j + 2, j + 6)) : !e || !'"\\/bfnrt'.includes(e))
          return bad(j, 'This escape sequence is not allowed in JSON: use \\", \\\\, \\/, \\b, \\f, \\n, \\r, \\t, or \\u and four hexadecimal digits.');
        j += e === 'u' ? 6 : 2;
        continue;
      }
      if (d.charCodeAt(0) < 0x20) return bad(j, 'A control character (a tab, for example) must be escaped in a JSON string: write \\t.');
      j++;
    }
  }
  if (c === '-' || (c >= '0' && c <= '9')) {
    JSON_NUMBER.lastIndex = i;
    const m = JSON_NUMBER.exec(text);
    // 012, 1.e5, 1.2.3, 1+2: a number that goes on with digits, a dot or an exponent isn't one JSON allows.
    if (m && !/[\d.eE+-]/.test(text[i + m[0].length] || '')) return { t: 'number', start: i, end: i + m[0].length };
    return bad(i, 'This number is not written the way JSON allows (no leading zeros, a digit on each side of the dot).');
  }
  JSON_WORD.lastIndex = i;
  const word = JSON_WORD.exec(text)?.[0];
  if (word === 'true' || word === 'false' || word === 'null') return { t: 'literal', start: i, end: i + word.length };
  if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return bad(i, 'Comments are not allowed in JSON.');
  if (c === "'") return bad(i, 'Strings must be in double quotes in JSON.');
  if (word) return bad(i, `${word} is not a JSON value: property names and strings must be in double quotes.`);
  return bad(i, `Unexpected character "${c}".`);
}

/** The first place where JSON text breaks the grammar (as JSON.parse would refuse it), or null when it is valid. */
function jsonProblem(text: string): { message: string; offset: number } | null {
  // An explicit stack, not recursion: deeply nested JSON can't overflow the call stack.
  const stack: string[] = [];
  let prev: JsonToken | null = null;
  let tok = scanJson(text, 0);
  const fail = (message: string, at: JsonToken = tok) => ({ message: at.t === 'bad' ? at.error! : at.t === 'end' ? `${message} The text ends too early.` : message, offset: at.start });
  const trailingComma = () => prev?.t === ',' && (tok.t === '}' || tok.t === ']');
  // What comes next: a value, a property name, the colon after it, or a comma or closing bracket after a value.
  let expect: 'value' | 'name' | 'colon' | 'next' = 'value';
  for (;;) {
    const t: string = tok.t;
    if (expect === 'value' || expect === 'name') {
      if (expect === 'value' && (t === '{' || t === '[')) {
        stack.push(t);
        expect = t === '{' ? 'name' : 'value';
        // {} and []: nothing inside.
        const next = scanJson(text, tok.end);
        if (next.t === (t === '{' ? '}' : ']')) {
          stack.pop();
          expect = 'next';
          tok = next;
        }
      } else if (expect === 'value' && (t === 'string' || t === 'number' || t === 'literal')) expect = 'next';
      else if (expect === 'name' && t === 'string') expect = 'colon';
      else if (trailingComma()) return fail('A comma before a closing bracket is not allowed in JSON.', prev!);
      else return fail(expect === 'value' ? 'Expected a value.' : 'Expected a property name in double quotes.');
    } else if (expect === 'colon') {
      if (t !== ':') return fail('Expected ":" after the property name.');
      expect = 'value';
    } else {
      const top = stack[stack.length - 1];
      if (!top) {
        if (t === 'end') return null;
        // A comment says so; anything else after the value is just more than one value.
        const comment = text.startsWith('//', tok.start) || text.startsWith('/*', tok.start);
        return { message: comment ? tok.error! : 'Unexpected text after the end of the JSON value.', offset: tok.start };
      }
      if (t === ',') expect = top === '{' ? 'name' : 'value';
      else if (t === (top === '{' ? '}' : ']')) stack.pop();
      else return fail(top === '{' ? 'Expected "," or "}".' : 'Expected "," or "]".');
    }
    prev = tok;
    tok = scanJson(text, tok.end);
  }
}

/** Line and column (1-based) of an offset. */
function placeOf(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let k = text.indexOf('\n'); k >= 0 && k < offset; k = text.indexOf('\n', k + 1)) {
    line++;
    lineStart = k + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/** Checks JSON text as JSON.parse would; the first problem with its line and column, or null (blank text included). */
export function jsonError(text: string): { message: string; line: number; column: number } | null {
  if (!text.trim()) return null;
  const p = jsonProblem(text);
  return p ? { message: p.message, ...placeOf(text, p.offset) } : null;
}

/** Throws, with its place, the first problem of JSON text that isn't valid. */
function assertJson(text: string): void {
  const p = jsonProblem(text);
  if (!p) return;
  const at = placeOf(text, p.offset);
  throw new Error(`${p.message} (line ${at.line}, column ${at.column})`);
}

/**
 * JSON with one property or array item per line, indented, `"name": value`, and empty objects and arrays kept as {}
 * and []. Every token is kept exactly as written (numbers, escapes, the order and repetition of names): only the
 * spacing between tokens changes, so the data can't change. Refuses JSON that isn't valid; an empty file stays as it is.
 */
export function formatJson(text: string, indent = '  ', eol = '\n'): string {
  if (!text.trim()) return text;
  assertJson(text);
  let out = '';
  let depth = 0;
  const newline = () => eol + indent.repeat(depth);
  for (let tok = scanJson(text, 0); tok.t !== 'end'; tok = scanJson(text, tok.end)) {
    const raw = text.slice(tok.start, tok.end);
    if (tok.t === '{' || tok.t === '[') {
      const next = scanJson(text, tok.end);
      if (next.t === (tok.t === '{' ? '}' : ']')) {
        out += raw + text.slice(next.start, next.end);
        tok = next;
      } else {
        depth++;
        out += raw + newline();
      }
    } else if (tok.t === '}' || tok.t === ']') {
      depth--;
      out += newline() + raw;
    } else if (tok.t === ',') out += ',' + newline();
    else if (tok.t === ':') out += ': ';
    else out += raw;
  }
  return out;
}

/** JSON without the spacing between its tokens (strings kept as written); refuses JSON that isn't valid. */
export function minifyJson(text: string): string {
  if (!text.trim()) return text;
  assertJson(text);
  let out = '';
  for (let tok = scanJson(text, 0); tok.t !== 'end'; tok = scanJson(text, tok.end)) out += text.slice(tok.start, tok.end);
  return out;
}

// ------------------------------------------------------------------ line endings

/** Every line ending made `eol`, as the editor does with the text of a file ('\r\n', '\n' and a lone '\r' all end a line). */
export const normalizeEol = (text: string, eol: string): string => text.replace(/\r\n|\r|\n/g, eol);

/** Whether text has a line ending other than `eol` (the editor would rewrite it). */
export function hasOtherEol(text: string, eol: '\n' | '\r\n'): boolean {
  return eol === '\n' ? text.includes('\r') : /\r(?!\n)|(?:^|[^\r])\n/.test(text);
}

/**
 * The editor's text (every line ending `eol`) with the line endings of `base` kept on the lines that are unchanged.
 * The editor holds a file with one kind of line ending, so a file that mixes them (an LF line in a CRLF file) would
 * otherwise have every line ending rewritten by the first keystroke: a change nobody sees, saved with the next save.
 * Lines added or changed get `eol`. Typing back what was there gives `base` exactly.
 */
export function keepLineEndings(base: string, text: string, eol: '\n' | '\r\n'): string {
  if (!base || !hasOtherEol(base, eol)) return text;
  const ends: string[] = [];
  const re = /\r\n|\r|\n/g;
  for (let m = re.exec(base); m; m = re.exec(base)) ends.push(m[0]);
  const lines = text.split(eol);
  const last = lines.length - 1;
  const own: string[] = new Array(last).fill(eol);
  let i = 0;
  let j = 0;
  // Unchanged lines come in pairs (base line i, text line j): each keeps the base line's ending.
  const pair = (toI: number, toJ: number) => {
    for (; i < toI && j < toJ; i++, j++) if (j < last && i < ends.length) own[j] = ends[i];
  };
  for (const c of diffLines(base, text)) {
    const oldFrom = c.oldCount ? c.oldStart - 1 : c.oldStart;
    const newFrom = c.newCount ? c.newStart - 1 : c.newStart;
    pair(oldFrom, newFrom);
    i = oldFrom + c.oldCount;
    j = newFrom + c.newCount;
  }
  pair(ends.length + 1, lines.length);
  let out = '';
  for (let k = 0; k < last; k++) {
    // A lone CR right before an empty line ending in LF would read as one CRLF (a line lost): that line takes `eol`.
    const end = own[k] === '\r' && lines[k + 1] === '' && k + 1 < last && own[k + 1][0] === '\n' ? eol : own[k];
    out += lines[k] + end;
  }
  return out + lines[last];
}

/** CSS without comments and unneeded spacing; strings and url() values are kept as written. */
export function minifyCss(css: string): string {
  let out = '';
  let i = 0;
  const n = css.length;
  let pendingSpace = false;
  const push = (s: string) => {
    if (pendingSpace && out && /[\w)\]%"'*.#-]$/.test(out) && /^[\w(#.%"'-]/.test(s)) out += ' ';
    pendingSpace = false;
    out += s;
  };
  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const j = css.indexOf('*/', i + 2);
      // Comments starting /*! are licences: kept.
      if (css[i + 2] === '!') push(css.slice(i, j < 0 ? n : j + 2));
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && css[j] !== c) j += css[j] === '\\' ? 2 : 1;
      push(css.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (/\s/.test(c)) {
      pendingSpace = true;
      i++;
      continue;
    }
    if (/[{};:,>~+]/.test(c)) {
      // No space is needed around these, except "+" and "-" in calc() and a colon in a selector (a:hover is kept
      // because the space before it, if any, is meaningful: "a :hover").
      if (c === ':' && pendingSpace && /[\w\])*]$/.test(out) && !/[{;]\s*[\w-]*$/.test(out)) out += ' ';
      if (c === '+' && /calc\([^)]*$/.test(out)) {
        out += ' + ';
        pendingSpace = false;
        i++;
        continue;
      }
      if (c === '}' && out.endsWith(';')) out = out.slice(0, -1);
      pendingSpace = false;
      out += c;
      i++;
      continue;
    }
    push(c);
    i++;
  }
  return out;
}

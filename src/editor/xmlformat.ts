// Formats XML (Data, XSL, SVG and RESX web resources) the way the editor's Format Document does for other languages:
// one element per line, children indented, an element holding only text kept on one line. It works on the text, not a
// parsed document, so attributes, entities, quotes, comments and CDATA stay exactly as written; text is only trimmed.

type Tok =
  | { k: 'open'; raw: string; name: string; self: boolean }
  | { k: 'close'; raw: string; name: string }
  | { k: 'text'; raw: string }
  | { k: 'other'; raw: string }; // declaration, processing instruction, comment, CDATA, doctype

function tokenize(xml: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    if (xml[i] !== '<') {
      const j = xml.indexOf('<', i);
      const end = j < 0 ? n : j;
      out.push({ k: 'text', raw: xml.slice(i, end) });
      i = end;
      continue;
    }
    const rest = (s: string, close: string) => {
      const j = xml.indexOf(close, i + s.length);
      if (j < 0) throw new Error(`Unclosed ${s} at character ${i + 1}.`);
      const raw = xml.slice(i, j + close.length);
      i = j + close.length;
      return raw;
    };
    if (xml.startsWith('<!--', i)) out.push({ k: 'other', raw: rest('<!--', '-->') });
    else if (xml.startsWith('<![CDATA[', i)) out.push({ k: 'other', raw: rest('<![CDATA[', ']]>') });
    else if (xml.startsWith('<?', i)) out.push({ k: 'other', raw: rest('<?', '?>') });
    else if (xml.startsWith('<!', i)) {
      // A doctype, possibly with an internal subset in brackets.
      let depth = 0;
      let j = i + 2;
      for (; j < n; j++) {
        if (xml[j] === '[') depth++;
        else if (xml[j] === ']') depth--;
        else if (xml[j] === '>' && depth <= 0) break;
      }
      if (j >= n) throw new Error(`Unclosed <! at character ${i + 1}.`);
      out.push({ k: 'other', raw: xml.slice(i, j + 1) });
      i = j + 1;
    } else {
      // A tag: find its end, skipping '>' inside quoted attribute values.
      let j = i + 1;
      let quote = '';
      for (; j < n; j++) {
        const c = xml[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= n) throw new Error(`Unclosed tag at character ${i + 1}.`);
      const raw = xml.slice(i, j + 1);
      i = j + 1;
      if (raw[1] === '/') out.push({ k: 'close', raw: raw.replace(/\s+>$/, '>'), name: raw.slice(2, -1).trim() });
      else {
        const name = /^<\s*([^\s/>]+)/.exec(raw)?.[1] || '';
        out.push({ k: 'open', raw, name, self: /\/\s*>$/.test(raw) });
      }
    }
  }
  return out;
}

/** Re-indents an open tag's attributes when the tag is long: one attribute per line, under the first. */
function tagText(raw: string): string {
  return raw.replace(/\s*\n\s*/g, ' ');
}

/**
 * Refuses text that doesn't start with a tag (after spacing): it isn't XML (JSON or text stored as Data), and the
 * formatter would take it for one text node and join its lines, or split it at every '<' inside its strings.
 */
function assertXml(xml: string): void {
  if (xml.trim() && !xml.trimStart().startsWith('<')) throw new Error('This is not XML: it doesn\'t start with a tag, so it is left as it is.');
}

/**
 * Formats `xml` with `indent` (e.g. '  ' or '\t') and line ending `eol`. Throws when the XML is not well formed
 * enough to format (an unclosed tag, a close tag that matches nothing, text that isn't XML at all): the text is then
 * left as it is.
 */
export function formatXml(xml: string, indent = '  ', eol = '\n'): string {
  assertXml(xml);
  const toks = tokenize(xml);
  const lines: string[] = [];
  const stack: string[] = [];
  const pad = () => indent.repeat(stack.length);
  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t];
    if (tok.k === 'text') {
      const s = tok.raw.trim();
      if (s) lines.push(pad() + s.replace(/\s*\n\s*/g, ' '));
      continue;
    }
    if (tok.k === 'other') {
      // Multi-line comments and CDATA keep their own lines, re-indented as a block only at their first line.
      lines.push(pad() + tok.raw.trim());
      continue;
    }
    if (tok.k === 'close') {
      const top = stack.pop();
      if (top === undefined || top !== tok.name) throw new Error(`</${tok.name}> does not close ${top ? `<${top}>` : 'any element'}.`);
      lines.push(pad() + tok.raw);
      continue;
    }
    if (tok.self) {
      lines.push(pad() + tagText(tok.raw));
      continue;
    }
    // <a>text</a> and <a></a> stay on one line.
    const next = toks[t + 1];
    const after = toks[t + 2];
    if (next?.k === 'close' && next.name === tok.name) {
      lines.push(pad() + tagText(tok.raw) + next.raw);
      t += 1;
      continue;
    }
    if (next?.k === 'text' && after?.k === 'close' && after.name === tok.name && !/\n/.test(next.raw.trim())) {
      lines.push(pad() + tagText(tok.raw) + next.raw.trim() + after.raw);
      t += 2;
      continue;
    }
    lines.push(pad() + tagText(tok.raw));
    stack.push(tok.name);
  }
  if (stack.length) throw new Error(`<${stack[stack.length - 1]}> is never closed.`);
  return lines.join(eol) + (/\r?\n$/.test(xml) ? eol : '');
}

/** XML on as few characters as possible: whitespace between tags removed, comments kept. Throws on text that isn't XML. */
export function minifyXml(xml: string): string {
  assertXml(xml);
  return tokenize(xml)
    .map((t) => (t.k === 'text' ? t.raw.trim() : t.k === 'open' ? tagText(t.raw) : t.raw))
    .join('');
}

/** Checks that XML is well formed with the browser's parser; returns the first error ('' when none). */
export function xmlError(xml: string): { message: string; line: number; column: number } | null {
  if (!xml.trim()) return null;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (!err) return null;
  const text = err.textContent || 'The XML is not well formed.';
  const m = /line (\d+) at column (\d+)/i.exec(text) || /line\s*(\d+).*?column\s*(\d+)/is.exec(text);
  return { message: text.split('\n').find((l) => l.trim() && !/^\s*Below is a rendering/i.test(l))?.trim() || text, line: m ? Number(m[1]) : 1, column: m ? Number(m[2]) : 1 };
}

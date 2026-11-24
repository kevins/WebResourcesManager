// Fuzzy matching as VS Code's quick open does it (vs/base/common/fuzzyScorer.ts): the query's characters must appear
// in the target in order, case-insensitively; each matched character scores, and a match scores more when it
// continues the previous one, starts the target, follows a separator (/ \ _ - . space) or is an upper-case letter
// inside a word (camelCase). So "acfo" ranks "account.form.js" above "app/config/footer.js".
// Also the stricter matching of VS Code's command palette (vs/base/common/filters.ts): the starts of words
// (wordMatch: "fa" finds "Fold All") or a run of letters anywhere (contiguousMatch), never letters scattered inside
// words ("save" doesn't find "Add Cursor Above").

export interface FuzzyMatch {
  score: number;
  /** Indexes of the matched characters in the target, ascending. */
  positions: number[];
}

const NO_MATCH = 0;

function separatorBonus(code: number): number {
  switch (code) {
    case 47: // /
    case 92: // \
      return 5;
    case 95: // _
    case 45: // -
    case 46: // .
    case 32: // space
    case 39: // '
    case 34: // "
    case 58: // :
      return 4;
    default:
      return 0;
  }
}

const isUpper = (code: number) => code >= 65 && code <= 90;

function sameChar(a: string, b: string): boolean {
  if (a === b) return true;
  // Path separators match each other, whichever way the user types them.
  return (a === '/' || a === '\\') && (b === '/' || b === '\\');
}

function charScore(q: string, qLower: string, target: string, tLower: string, i: number, seqLen: number): number {
  if (!sameChar(qLower, tLower[i])) return 0;
  let score = 1;
  if (seqLen > 0) score += seqLen * 5;
  if (q === target[i]) score += 1;
  if (i === 0) score += 8;
  else {
    const sep = separatorBonus(target.charCodeAt(i - 1));
    if (sep) score += sep;
    else if (isUpper(target.charCodeAt(i)) && seqLen === 0) score += 2;
  }
  return score;
}

/** How well `query` matches `target`; null when it doesn't (every character of the query must be found, in order). */
export function fuzzyScore(query: string, target: string): FuzzyMatch | null {
  const ql = query.length;
  const tl = target.length;
  if (!ql || tl < ql) return null;
  const qLower = query.toLowerCase();
  const tLower = target.toLowerCase();
  const scores = new Array<number>(ql * tl).fill(0);
  const matches = new Array<number>(ql * tl).fill(0);
  // The scoring matrix: for each query character and target position, the best score of a match of the query so
  // far ending at or before that position, and the length of the run of consecutive matches ending there.
  for (let qi = 0; qi < ql; qi++) {
    const row = qi * tl;
    const prevRow = row - tl;
    for (let ti = 0; ti < tl; ti++) {
      const cur = row + ti;
      const left = ti > 0 ? scores[cur - 1] : 0;
      const diag = qi > 0 && ti > 0 ? scores[prevRow + ti - 1] : 0;
      const seqLen = qi > 0 && ti > 0 ? matches[prevRow + ti - 1] : 0;
      // After the first query character, a character only scores when the ones before it matched (so the query
      // matches in order, and "de" doesn't score the "e" of "ede" as the start of a word).
      const score = !diag && qi > 0 ? 0 : charScore(query[qi], qLower[qi], target, tLower, ti, seqLen);
      if (score && diag + score >= left) {
        matches[cur] = seqLen + 1;
        scores[cur] = diag + score;
      } else {
        matches[cur] = NO_MATCH;
        scores[cur] = left;
      }
    }
  }
  const total = scores[ql * tl - 1];
  if (!total) return null;
  // Walk back from the bottom right corner to find which characters made the score.
  const positions: number[] = [];
  let qi = ql - 1;
  let ti = tl - 1;
  while (qi >= 0 && ti >= 0) {
    if (matches[qi * tl + ti] === NO_MATCH) ti--;
    else {
      positions.push(ti);
      qi--;
      ti--;
    }
  }
  if (positions.length !== ql) return null;
  return { score: total, positions: positions.reverse() };
}

/** Like fuzzyScore, but every space-separated piece of the query must match (in any order); the scores add up. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const pieces = query.split(/\s+/).filter(Boolean);
  if (!pieces.length) return null;
  if (pieces.length === 1) return fuzzyScore(pieces[0], target);
  let score = 0;
  const pos = new Set<number>();
  for (const p of pieces) {
    const m = fuzzyScore(p, target);
    if (!m) return null;
    score += m.score;
    for (const i of m.positions) pos.add(i);
  }
  return { score, positions: [...pos].sort((a, b) => a - b) };
}

/** VS Code's word separators for matching command names (filters.ts), with _ and \ of names and paths. */
const WORD_SEPARATORS = new Set([...'()[]{}<>`\'"-/;:,.?!_\\'].map((c) => c.charCodeAt(0)));
const isWordSeparator = (code: number) => code === 32 || code === 9 || code === 10 || code === 13 || WORD_SEPARATORS.has(code);

/** Where the next word starts from `start` on: a separator, or the character after one. */
function nextWord(t: string, start: number): number {
  for (let i = start; i < t.length; i++) if (isWordSeparator(t.charCodeAt(i)) || (i > 0 && isWordSeparator(t.charCodeAt(i - 1)))) return i;
  return t.length;
}

/**
 * VS Code's matchesWords: the query's characters are found at the start of a word of the target, each one either
 * right after the one before or at the start of a later word ("fa" in "Fold All", "sav al" in "Save All"); a space
 * of the query matches any separator. Null when the query's letters would be scattered inside words. Positions are
 * the matched characters' indexes in the target, ascending (a separator matched by another one isn't among them).
 */
export function wordMatch(query: string, target: string): number[] | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q.length || !t.length) return null;
  // Each pair of positions (in the query, in the target) is tried once: words that repeat don't make it slow.
  const memo = new Map<number, number[] | null>();
  const from = (qi: number, ti: number): number[] | null => {
    if (qi === q.length) return [];
    if (ti === t.length) return null;
    const k = qi * (t.length + 1) + ti;
    const known = memo.get(k);
    if (known !== undefined) return known;
    let out: number[] | null = null;
    const a = q.charCodeAt(qi);
    const b = t.charCodeAt(ti);
    if (a === b || (isWordSeparator(a) && isWordSeparator(b))) {
      let rest = from(qi + 1, ti + 1);
      for (let n = nextWord(t, ti + 1); !rest && n < t.length; n = nextWord(t, n + 1)) rest = from(qi + 1, n);
      if (rest) out = a === b ? [ti, ...rest] : rest;
    }
    memo.set(k, out);
    return out;
  };
  for (let ti = 0; ti < t.length; ti = nextWord(t, ti + 1)) {
    const found = from(0, ti);
    if (found) return found;
  }
  return null;
}

/** The query as one run of characters anywhere in the target (case-insensitive); null when it isn't there. */
export function contiguousMatch(query: string, target: string): number[] | null {
  if (!query) return null;
  const at = target.toLowerCase().indexOf(query.toLowerCase());
  return at < 0 ? null : Array.from({ length: query.length }, (_, i) => at + i);
}

/** Matched positions as [start, end) ranges, the form TreeRow and Highlight take. */
export function toRanges(positions: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of positions) {
    const last = out[out.length - 1];
    if (last && last[1] === p) last[1] = p + 1;
    else out.push([p, p + 1]);
  }
  return out;
}

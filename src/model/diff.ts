// Line differences between two texts (Myers' algorithm), for what the editor shows next to the code: the change bars
// in the gutter (added, modified, deleted, as VS Code shows them against Git), the "+3 −1" counts of the Source
// Control view, and quick checks of what a version changes. The side-by-side comparisons use Monaco's own diff editor.

export interface LineChange {
  /** 1-based first line in the old text; for an insertion, the line after which lines were inserted (0 = top). */
  oldStart: number;
  oldCount: number;
  /** 1-based first line in the new text; for a deletion, the line after which lines were removed (0 = top). */
  newStart: number;
  newCount: number;
}

export const splitLines = (s: string) => (s === '' ? [] : s.split(/\r\n|\r|\n/));

/**
 * The changed line ranges between `a` and `b`. Lines are compared exactly (line endings aside). Gives up on very
 * different large texts (more than `maxD` edits) and then reports one change covering everything.
 */
export function diffLines(a: string, b: string, maxD = 4000): LineChange[] {
  const A = splitLines(a);
  const B = splitLines(b);
  // Common head and tail are cut first: most edits touch a few lines of a large file.
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const a2 = A.slice(head, A.length - tail);
  const b2 = B.slice(head, B.length - tail);
  if (!a2.length && !b2.length) return [];
  if (!a2.length) return [{ oldStart: head, oldCount: 0, newStart: head + 1, newCount: b2.length }];
  if (!b2.length) return [{ oldStart: head + 1, oldCount: a2.length, newStart: head, newCount: 0 }];
  const ops = myers(a2, b2, maxD);
  if (!ops) return [{ oldStart: head + 1, oldCount: a2.length, newStart: head + 1, newCount: b2.length }];
  // ops: the matched pairs (i, j) in order; changes are the gaps between them.
  const out: LineChange[] = [];
  let i = 0;
  let j = 0;
  const flush = (ni: number, nj: number) => {
    if (ni > i || nj > j) {
      const oldCount = ni - i;
      const newCount = nj - j;
      out.push({ oldStart: head + (oldCount ? i + 1 : i), oldCount, newStart: head + (newCount ? j + 1 : j), newCount });
    }
  };
  for (const [mi, mj] of ops) {
    flush(mi, mj);
    i = mi + 1;
    j = mj + 1;
  }
  flush(a2.length, b2.length);
  return out;
}

/** Matched line pairs of the shortest edit script, or null when it needs more than maxD edits. */
function myers(a: string[], b: string[], maxD: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  v[off + 1] = 0;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, off, d);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], off: number, dEnd: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

/** Lines added and removed ("+3 −1"). */
export function diffStat(a: string, b: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const c of diffLines(a, b)) {
    added += c.newCount;
    removed += c.oldCount;
  }
  return { added, removed };
}

/** The gutter marks of VS Code's dirty diff for the new text: lines added, modified, and places where lines were deleted. */
export function gutterMarks(oldText: string, newText: string): { added: number[][]; modified: number[][]; deleted: number[] } {
  const added: number[][] = [];
  const modified: number[][] = [];
  const deleted: number[] = [];
  for (const c of diffLines(oldText, newText)) {
    if (c.newCount === 0) deleted.push(Math.max(1, c.newStart));
    else if (c.oldCount === 0) added.push([c.newStart, c.newStart + c.newCount - 1]);
    else modified.push([c.newStart, c.newStart + c.newCount - 1]);
  }
  return { added, modified, deleted };
}

// Pure, dependency-free line diff (LCS-based). Used by the version-history UI to
// show what changed between an old snapshot and the current content. Kept free of
// any React / DB / server imports so it's trivially unit-testable.

export interface DiffLine {
  type: "add" | "del" | "same";
  text: string;
}

/** Split into lines without letting a single trailing newline produce a spurious
 *  empty final line (so "a\nb" and "a\nb\n" diff the same visible content). */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * A simple LCS-based line diff. Returns the merged sequence of lines tagged as
 * added (in `newText` only), deleted (in `oldText` only), or unchanged. Order
 * follows the classic diff convention: a deletion is emitted before the addition
 * that replaces it.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = toLines(oldText);
  const b = toLines(newText);
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i] });
    i++;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j] });
    j++;
  }
  return out;
}

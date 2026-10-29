/**
 * Ranking for the command palette: every word has to be found somewhere, and
 * a word found at the start of the label (or of a word in it) counts for more
 * than one found in the middle or only in the keywords.
 */

export function queryWords(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

const isWordStart = (s: string, i: number) => i === 0 || !/[a-z0-9]/i.test(s[i - 1]);

/** First index of `w` in `s` at a word start, else anywhere; -1 when absent. */
function findWord(s: string, w: string): { at: number; start: boolean } {
  let i = s.indexOf(w);
  const first = i;
  while (i >= 0) {
    if (isWordStart(s, i)) return { at: i, start: true };
    i = s.indexOf(w, i + 1);
  }
  return { at: first, start: false };
}

/**
 * How well `words` match a row: 0 means it doesn't (a word is missing from
 * both the label and the extra text); higher is better.
 */
export function matchScore(label: string, extra: string, words: string[]): number {
  if (!words.length) return 1;
  const l = label.toLowerCase();
  const x = extra.toLowerCase();
  let score = 0;
  for (const w of words) {
    const inLabel = findWord(l, w);
    if (inLabel.at >= 0) {
      score += inLabel.start ? 20 : 8;
      if (inLabel.at === 0) score += 6;
      continue;
    }
    const inExtra = findWord(x, w);
    if (inExtra.at < 0) return 0;
    score += inExtra.start ? 4 : 1;
  }
  const whole = words.join(' ');
  if (l === whole) score += 60;
  else if (l.startsWith(whole)) score += 30;
  // shorter labels win ties: "Rotate" before "Rotate counter-clockwise"
  return score + 1 / (1 + l.length / 40);
}

/** The stretches of `label` to highlight for `words` (merged, sorted). */
export function matchRanges(label: string, words: string[]): [number, number][] {
  const l = label.toLowerCase();
  const out: [number, number][] = [];
  for (const w of words) {
    const { at } = findWord(l, w);
    if (at >= 0) out.push([at, at + w.length]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Most recent first, no repeats, at most `max`. */
export function pushRecent(list: string[], id: string, max = 6): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

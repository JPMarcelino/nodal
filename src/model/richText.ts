import type { FontName } from './fonts';
import { measureText } from './geometry';
import { exPx, hasMath, mathLines, splitMath, texToSvg, unescapeDollars, type MathSvg } from './latex';

/** Upper-cases plain text but leaves `$…$` maths alone. */
export const upperText = (t: string) => t.split(/(\$[^$]*\$)/).map((s, i) => (i % 2 ? s : s.toUpperCase())).join('');

export type LaidRun =
  | { math: false; text: string; x: number; w: number }
  | { math: true; svg: MathSvg | null; tex: string; x: number; w: number; h: number; depth: number; error?: string };

export interface LaidLine {
  runs: LaidRun[];
  w: number;
  /** Extra room above / below the line for tall formulas. */
  ascent: number;
  descent: number;
}

/**
 * A formula styled like the text around it: Bold makes it bold maths, Italic slants
 * what maths keeps upright (digits, capital Greek). Its own font stays the maths font.
 */
export function styledTex(tex: string, weight = 400, italic = false): string {
  let t = tex;
  if (italic) t = `\\mathit{${t}}`;
  if (weight >= 700) t = `\\boldsymbol{${t}}`;
  return t;
}

/** Lays out text with `$…$` maths into positioned runs (x relative to the line start). */
export function layoutRich(text: string, fontSize: number, weight = 400, font?: FontName, italic = false): LaidLine[] {
  const ex = exPx(fontSize);
  return mathLines(text).map((line) => {
    const runs: LaidRun[] = [];
    let x = 0;
    let ascent = fontSize * 0.8;
    let descent = fontSize * 0.25;
    for (const r of splitMath(line)) {
      if (!r.math) {
        if (!r.text) continue;
        const w = measureText(r.text, fontSize, weight, font).w;
        runs.push({ math: false, text: r.text, x, w });
        x += w;
        continue;
      }
      const svg = texToSvg(styledTex(r.tex, weight, italic), r.display);
      if (!svg || svg.error) {
        // not typeset yet (reserve the space the source takes), or broken: show the source
        const src = (r.display ? `$$${r.tex}$$` : `$${r.tex}$`).replace(/\n/g, ' ');
        const w = measureText(src, fontSize, weight, font).w;
        runs.push({ math: true, svg: null, tex: src, x, w, h: fontSize, depth: 0, error: svg?.message ?? (svg ? 'Invalid formula' : undefined) });
        x += w;
        continue;
      }
      const w = svg.wEx * ex;
      const h = svg.hEx * ex;
      const depth = svg.depthEx * ex;
      runs.push({ math: true, svg, tex: r.tex, x, w, h, depth });
      ascent = Math.max(ascent, h - depth);
      descent = Math.max(descent, depth);
      x += w;
    }
    return { runs, w: x, ascent, descent };
  });
}

/** Size of text that may contain maths (falls back to plain measuring when it has none). */
export function measureRich(text: string, fontSize: number, weight = 400, font?: FontName, italic = false): { w: number; h: number } {
  if (!hasMath(text)) return measureText(unescapeDollars(text), fontSize, weight, font);
  const lines = layoutRich(text, fontSize, weight, font, italic);
  const lineH = fontSize * 1.3;
  const h = lines.reduce((s, l) => s + Math.max(lineH, l.ascent + l.descent + fontSize * 0.25), 0);
  return { w: Math.max(fontSize * 0.5, ...lines.map((l) => l.w)), h: Math.ceil(h) };
}

/** The words of one line, as source text: spaces separate them, and a `$…$` formula is never split. */
function wordsOf(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const r of splitMath(line)) {
    if (r.math) {
      cur += r.display ? `$$${r.tex}$$` : `$${r.tex}$`;
      continue;
    }
    for (const part of r.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        if (cur) out.push(cur);
        cur = '';
      } else cur += part.replace(/\$/g, '\\$');
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Breaks text into lines no wider than `maxW`, at spaces: the result is the same
 * source with newlines where it wraps. Words are the unit (a long word or a
 * formula stays whole, overflowing if it must); lines that already fit, and
 * the author's own line breaks, are left as they are.
 */
export function wrapRich(text: string, fontSize: number, weight: number, maxW: number, font?: FontName, italic = false): string {
  if (!text || !(maxW > 0)) return text;
  const width = (s: string) => measureRich(s, fontSize, weight, font, italic).w;
  const space = measureText(' ', fontSize, weight, font).w;
  return mathLines(text)
    .map((line) => {
      if (width(line) <= maxW) return line;
      const rows: string[] = [];
      let row = '';
      let rowW = 0;
      for (const word of wordsOf(line)) {
        const w = width(word);
        if (row && rowW + space + w > maxW) {
          rows.push(row);
          row = word;
          rowW = w;
        } else {
          row = row ? `${row} ${word}` : word;
          rowW += (rowW ? space : 0) + w;
        }
      }
      if (row) rows.push(row);
      return rows.join('\n');
    })
    .join('\n');
}

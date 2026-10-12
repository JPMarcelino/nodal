import { measureText } from './geometry';
import { exPx, hasMath, splitMath, texToSvg, type MathSvg } from './latex';

export type LaidRun =
  | { math: false; text: string; x: number; w: number }
  | { math: true; svg: MathSvg | null; tex: string; x: number; w: number; h: number; depth: number };

export interface LaidLine {
  runs: LaidRun[];
  w: number;
  /** Extra room above / below the line for tall formulas. */
  ascent: number;
  descent: number;
}

/** Lays out text with `$…$` maths into positioned runs (x relative to the line start). */
export function layoutRich(text: string, fontSize: number, weight = 400): LaidLine[] {
  const ex = exPx(fontSize);
  return text.split('\n').map((line) => {
    const runs: LaidRun[] = [];
    let x = 0;
    let ascent = fontSize * 0.8;
    let descent = fontSize * 0.25;
    for (const r of splitMath(line)) {
      if (!r.math) {
        if (!r.text) continue;
        const w = measureText(r.text, fontSize, weight).w;
        runs.push({ math: false, text: r.text, x, w });
        x += w;
        continue;
      }
      const svg = texToSvg(r.tex, r.display);
      if (!svg) {
        // not typeset yet: reserve the space the source would take
        const src = r.display ? `$$${r.tex}$$` : `$${r.tex}$`;
        const w = measureText(src, fontSize, weight).w;
        runs.push({ math: true, svg: null, tex: src, x, w, h: fontSize, depth: 0 });
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
export function measureRich(text: string, fontSize: number, weight = 400): { w: number; h: number } {
  if (!hasMath(text)) return measureText(text, fontSize, weight);
  const lines = layoutRich(text, fontSize, weight);
  const lineH = fontSize * 1.3;
  const h = lines.reduce((s, l) => s + Math.max(lineH, l.ascent + l.descent + fontSize * 0.25), 0);
  return { w: Math.max(fontSize * 0.5, ...lines.map((l) => l.w)), h: Math.ceil(h) };
}

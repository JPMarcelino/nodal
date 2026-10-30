import { useSyncExternalStore, type CSSProperties } from 'react';
import { hasMath, mathVersion, onMathReady, unescapeDollars } from '../model/latex';
import { FONT_STACKS, type FontName } from '../model/fonts';
import { layoutRich } from '../model/richText';

interface Props {
  text: string;
  x: number;
  /** Baseline of the first line. */
  y: number;
  fontSize?: number;
  anchor?: 'start' | 'middle' | 'end';
  fill: string;
  fontWeight?: number;
  className?: string;
  style?: CSSProperties;
  /** Plain text only: extra content after the text (e.g. a DNP tag). */
  children?: React.ReactNode;
}

/** SVG text that typesets `$…$` LaTeX; plain text renders exactly as a normal <text>. */
export function RichText({ text, x, y, fontSize, anchor = 'start', fill, fontWeight, className, style, children }: Props) {
  const math = hasMath(text);
  // re-render once MathJax has loaded
  useSyncExternalStore(onMathReady, mathVersion, mathVersion);
  if (!math) {
    const plain = unescapeDollars(text);
    const lines = plain.split('\n');
    return (
      <text x={x} y={y} fontSize={fontSize} textAnchor={anchor} fill={fill} fontWeight={fontWeight} className={className} style={style}>
        {lines.length === 1
          ? plain
          : lines.map((l, i) => (
              <tspan key={i} x={x} dy={i === 0 ? 0 : (fontSize ?? 12) * 1.3}>
                {l || ' '}
              </tspan>
            ))}
        {children}
      </text>
    );
  }
  const fs = fontSize ?? 12;
  // formulas follow the text's style too (bold, italic, underline), and the plain runs
  // beside them are measured in the font they are drawn in
  const font = (Object.keys(FONT_STACKS) as FontName[]).find((k) => FONT_STACKS[k] === style?.fontFamily);
  const italic = style?.fontStyle === 'italic';
  const underline = String(style?.textDecoration ?? '').includes('underline');
  const laid = layoutRich(text, fs, fontWeight ?? 400, font, italic);
  let base = y;
  return (
    <g className={className} style={{ ...style, textDecoration: undefined, color: fill }} fontSize={fs} fontWeight={fontWeight}>
      {laid.map((line, i) => {
        if (i > 0) base += Math.max(fs * 1.3, laid[i - 1].descent + line.ascent + fs * 0.25);
        const x0 = anchor === 'middle' ? x - line.w / 2 : anchor === 'end' ? x - line.w : x;
        // SVG text decoration neither reaches a formula nor passes from the group to the runs,
        // so the line is underlined by hand, in one stroke clear of anything hanging below it
        const uy = base + Math.max(fs * 0.12, ...line.runs.map((r) => (r.math && r.svg ? r.depth + fs * 0.08 : 0)));
        return (
          <g key={i}>
            {underline && line.w > 0 && <rect x={x0} y={uy} width={line.w} height={Math.max(0.6, fs * 0.065)} fill={fill} />}
            {line.runs.map((r, j) =>
              !r.math ? (
                <text key={j} x={x0 + r.x} y={base} fill={fill} style={{ whiteSpace: 'pre' }}>
                  {r.text}
                </text>
              ) : r.svg ? (
                <svg
                  key={j}
                  x={x0 + r.x}
                  y={base - (r.h - r.depth)}
                  width={r.w}
                  height={r.h}
                  viewBox={r.svg.viewBox}
                  overflow="visible"
                  fill={fill}
                  stroke={fill}
                  strokeWidth={0}
                  dangerouslySetInnerHTML={{ __html: r.svg.body }}
                />
              ) : (
                <text key={j} x={x0 + r.x} y={base} fill={r.error ? '#e5484d' : fill} opacity={r.error ? 1 : 0.6} style={{ whiteSpace: 'pre' }}>
                  {r.error && <title>{`LaTeX: ${r.error}`}</title>}
                  {r.tex}
                </text>
              ),
            )}
          </g>
        );
      })}
    </g>
  );
}

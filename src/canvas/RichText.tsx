import { useSyncExternalStore, type CSSProperties } from 'react';
import { hasMath, mathVersion, onMathReady, unescapeDollars } from '../model/latex';
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
  const laid = layoutRich(text, fs, fontWeight ?? 400);
  let base = y;
  return (
    <g className={className} style={{ ...style, color: fill }} fontSize={fs} fontWeight={fontWeight}>
      {laid.map((line, i) => {
        if (i > 0) base += Math.max(fs * 1.3, laid[i - 1].descent + line.ascent + fs * 0.25);
        const x0 = anchor === 'middle' ? x - line.w / 2 : anchor === 'end' ? x - line.w : x;
        return (
          <g key={i}>
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
                  dangerouslySetInnerHTML={{ __html: r.svg.body.replace(/currentColor/g, fill) }}
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

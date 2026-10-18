import type { Dash } from './types';

/** Line styles in the order they are listed, with the labels used everywhere. */
export const DASH_OPTIONS: { value: Dash; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'dash-dot', label: 'Dash-dot' },
  { value: 'long-dash', label: 'Long dash' },
];

// pattern lengths in line widths (a 0.01 dash is a dot when the ends are round)
const WIDE: Record<Exclude<Dash, 'solid'>, number[]> = {
  dashed: [4, 3],
  dotted: [0.01, 2.5],
  'dash-dot': [4, 2.5, 0.01, 2.5],
  'long-dash': [9, 4],
};
const TIGHT: Record<Exclude<Dash, 'solid'>, number[]> = {
  dashed: [3, 2],
  dotted: [0.01, 2],
  'dash-dot': [3, 2, 0.01, 2],
  'long-dash': [7, 3],
};

/** The stroke-dasharray of a line style at line width `w` (`tight`: the closer spacing of part drawings); undefined = solid. */
export function dashArray(d: Dash | undefined, w: number, tight = false): string | undefined {
  if (!d || d === 'solid') return undefined;
  const p = (tight ? TIGHT : WIDE)[d];
  return p ? p.map((n) => (n === 0.01 ? n : +(n * w).toFixed(3))).join(' ') : undefined;
}

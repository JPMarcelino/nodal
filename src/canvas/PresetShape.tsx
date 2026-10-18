import type { SVGProps } from 'react';
import { polyPath } from '../model/path';
import type { ShapePreset } from '../model/shapePresets';

/** A library shape's outline drawn into a box (the library tiles and the draw preview). */
export function PresetShape({ preset, x, y, w, h, ...rest }: { preset: ShapePreset; x: number; y: number; w: number; h: number } & SVGProps<SVGElement>) {
  const f = preset.build({ w, h });
  if (f.kind === 'ellipse') return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...(rest as SVGProps<SVGEllipseElement>)} />;
  // polygons and curved outlines alike
  if (f.kind === 'polygon') return <path d={polyPath({ x, y, w, h, poly: f.poly, curve: f.curve, open: f.open })} {...(rest as SVGProps<SVGPathElement>)} />;
  return <rect x={x} y={y} width={w} height={h} rx={Math.min(f.radius ?? 0, w / 2, h / 2)} {...(rest as SVGProps<SVGRectElement>)} />;
}

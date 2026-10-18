import type { SVGProps } from 'react';
import { polyPoints } from '../model/polygon';
import type { ShapePreset } from '../model/shapePresets';

/** A library shape's outline drawn into a box (the library tiles and the draw preview). */
export function PresetShape({ preset, x, y, w, h, ...rest }: { preset: ShapePreset; x: number; y: number; w: number; h: number } & SVGProps<SVGElement>) {
  const f = preset.build({ w, h });
  if (f.kind === 'ellipse') return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...(rest as SVGProps<SVGEllipseElement>)} />;
  if (f.kind === 'polygon') {
    const pts = polyPoints({ x, y, w, h, poly: f.poly });
    return <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} {...(rest as SVGProps<SVGPolygonElement>)} />;
  }
  return <rect x={x} y={y} width={w} height={h} rx={Math.min(f.radius ?? 0, w / 2, h / 2)} {...(rest as SVGProps<SVGRectElement>)} />;
}

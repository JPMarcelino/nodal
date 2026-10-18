import { makeShape } from './doc';
import { arcNodes, closeLoop, joinNodes, type PathNode, unitPath } from './path';
import type { CircuitDoc, ShapeItem } from './types';

/**
 * The basic-shapes library: ready-made outlines placed like any other shape.
 * Most are polygons whose corners are fractions (0–1) of the box, so rotation,
 * fill, titles, export and hit-testing need nothing extra; curved ones add
 * Bézier handles (`curve`, see model/path.ts). A builder returns the fields to
 * lay over a fresh shape (kind and geometry).
 */
export type PresetCategory = 'Basic' | 'Flowchart' | 'Arrows';

export interface ShapePreset {
  id: string;
  name: string;
  category: PresetCategory;
  /** Extra words the library search matches. */
  keywords?: string;
  /** Always drawn with equal sides (a circle). */
  square?: boolean;
  /** Fields for a shape of this size (the box itself is set by the caller). */
  build: (box: { w: number; h: number }) => Partial<ShapeItem>;
}

/** Size a single click places. */
export const PRESET_SIZE = { w: 80, h: 60 };

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** Corners scaled so their bounding box is exactly the unit square. */
function fit(pts: [number, number][]): number[] {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  return pts.flatMap(([x, y]) => [r5((x - x0) / w), r5((y - y0) / h)]);
}

/** A regular `n`-gon with a vertex at the top. */
const regular = (n: number) => fit(Array.from({ length: n }, (_, i) => [Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / n), Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / n)]));

/** A five-pointed star (inner radius in the usual 0.382 ratio). */
const star = () =>
  fit(
    Array.from({ length: 10 }, (_, i) => {
      const r = i % 2 ? 0.382 : 1;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      return [r * Math.cos(a), r * Math.sin(a)] as [number, number];
    }),
  );

const polygon = (poly: number[]) => (): Partial<ShapeItem> => ({ kind: 'polygon', poly });
/** A curved outline, fitted to the unit box once. */
const curved = (nodes: PathNode[]) => {
  const f = unitPath(nodes);
  return (): Partial<ShapeItem> => ({ kind: 'polygon', ...f });
};

/** Flowchart document: a box whose bottom edge waves. */
const DOCUMENT: PathNode[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 0.85, out: { x: 0.6, y: 1.15 } },
  { x: 0, y: 0.85, in: { x: 0.4, y: 0.55 } },
];

/** Database cylinder: the top ellipse (front and back), the sides and the bottom's front, then the top's front again to close. */
const CYLINDER: PathNode[] = closeLoop(
  joinNodes(
    arcNodes(0.5, 0.15, 0.5, 0.15, 180, 0),
    arcNodes(0.5, 0.15, 0.5, 0.15, 0, -180),
    [{ x: 0, y: 0.85 }],
    arcNodes(0.5, 0.85, 0.5, 0.15, 180, 0),
    [{ x: 1, y: 0.15 }],
    arcNodes(0.5, 0.15, 0.5, 0.15, 0, 180),
  ),
);

/** A cloud: bumps bulging out between points round an ellipse. */
const cloud = (): PathNode[] => {
  const n = 9;
  const pts = Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const r = i % 2 ? 0.9 : 1;
    return { x: r * Math.cos(a), y: 0.7 * r * Math.sin(a), a };
  });
  return pts.map((p, i) => {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    // handles lean outwards (radially) and a little along the chord, so each stretch is a bump
    const out = { x: p.x + 0.35 * Math.cos(p.a) + 0.15 * (next.x - p.x), y: p.y + 0.35 * Math.sin(p.a) + 0.15 * (next.y - p.y) };
    const inn = { x: p.x + 0.35 * Math.cos(p.a) + 0.15 * (prev.x - p.x), y: p.y + 0.35 * Math.sin(p.a) + 0.15 * (prev.y - p.y) };
    return { x: p.x, y: p.y, in: inn, out };
  });
};

/** Delay: flat on the left, a half ellipse on the right. */
const DELAY: PathNode[] = joinNodes([{ x: 0, y: 0 }], arcNodes(0.5, 0.5, 0.5, 0.5, -90, 90), [{ x: 0, y: 1 }]);

/** Display: pointed on the left, rounded on the right. */
const DISPLAY: PathNode[] = joinNodes([{ x: 0, y: 0.5 }, { x: 0.2, y: 0 }], arcNodes(0.85, 0.5, 0.15, 0.5, -90, 90), [{ x: 0.2, y: 1 }]);

/** Stored data: a curved-in right side and a curved-out left side. */
const STORED: PathNode[] = joinNodes(arcNodes(1, 0.5, 0.15, 0.5, -90, -270), arcNodes(0.15, 0.5, 0.15, 0.5, 90, 270));

/** Circular arrow: a thick three-quarter ring ending in an arrowhead. */
const CIRCLE_ARROW: PathNode[] = joinNodes(
  arcNodes(0, 0, 1, 1, 90, 360),
  [
    { x: 1.25, y: 0 },
    { x: 0.8, y: 0.45 },
    { x: 0.35, y: 0 },
  ],
  arcNodes(0, 0, 0.6, 0.6, 360, 90),
);
const DIAMOND = [0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5];
const HEXAGON = [0.25, 0, 0.75, 0, 1, 0.5, 0.75, 1, 0.25, 1, 0, 0.5];
const PARALLELOGRAM = [0.2, 0, 1, 0, 0.8, 1, 0, 1];
const TRIANGLE = [0.5, 0, 1, 1, 0, 1];

export const SHAPE_PRESETS: ShapePreset[] = [
  { id: 'rounded-rect', name: 'Rounded rectangle', category: 'Basic', keywords: 'rect box', build: () => ({ kind: 'rect', radius: 12 }) },
  { id: 'circle', name: 'Circle', category: 'Basic', keywords: 'round ellipse oval', square: true, build: () => ({ kind: 'ellipse' }) },
  { id: 'triangle', name: 'Triangle', category: 'Basic', build: polygon(TRIANGLE) },
  { id: 'right-triangle', name: 'Right triangle', category: 'Basic', build: polygon([0, 0, 1, 1, 0, 1]) },
  { id: 'diamond', name: 'Diamond', category: 'Basic', keywords: 'rhombus', build: polygon(DIAMOND) },
  { id: 'parallelogram', name: 'Parallelogram', category: 'Basic', keywords: 'skew', build: polygon(PARALLELOGRAM) },
  { id: 'trapezoid', name: 'Trapezoid', category: 'Basic', build: polygon([0.2, 0, 0.8, 0, 1, 1, 0, 1]) },
  { id: 'pentagon', name: 'Pentagon', category: 'Basic', build: polygon(regular(5)) },
  { id: 'hexagon', name: 'Hexagon', category: 'Basic', build: polygon(HEXAGON) },
  { id: 'octagon', name: 'Octagon', category: 'Basic', keywords: 'stop', build: polygon([0.29, 0, 0.71, 0, 1, 0.29, 1, 0.71, 0.71, 1, 0.29, 1, 0, 0.71, 0, 0.29]) },
  { id: 'star', name: 'Star', category: 'Basic', build: polygon(star()) },
  { id: 'cloud', name: 'Cloud', category: 'Basic', keywords: 'internet network thought', build: curved(cloud()) },
  { id: 'cross', name: 'Cross', category: 'Basic', keywords: 'plus add', build: polygon([0.33, 0, 0.67, 0, 0.67, 0.33, 1, 0.33, 1, 0.67, 0.67, 0.67, 0.67, 1, 0.33, 1, 0.33, 0.67, 0, 0.67, 0, 0.33, 0.33, 0.33]) },

  { id: 'flow-process', name: 'Process', category: 'Flowchart', keywords: 'step rectangle', build: () => ({ kind: 'rect', radius: 0 }) },
  { id: 'flow-decision', name: 'Decision', category: 'Flowchart', keywords: 'if branch diamond', build: polygon(DIAMOND) },
  { id: 'flow-terminator', name: 'Terminator', category: 'Flowchart', keywords: 'start end stadium pill', build: ({ w, h }) => ({ kind: 'rect', radius: Math.min(w, h) / 2 }) },
  { id: 'flow-data', name: 'Data', category: 'Flowchart', keywords: 'input output parallelogram', build: polygon(PARALLELOGRAM) },
  { id: 'flow-manual-input', name: 'Manual input', category: 'Flowchart', keywords: 'keyboard', build: polygon([0, 0.25, 1, 0, 1, 1, 0, 1]) },
  { id: 'flow-preparation', name: 'Preparation', category: 'Flowchart', keywords: 'setup hexagon', build: polygon(HEXAGON) },
  { id: 'flow-off-page', name: 'Off-page connector', category: 'Flowchart', keywords: 'link reference', build: polygon([0, 0, 1, 0, 1, 0.65, 0.5, 1, 0, 0.65]) },
  { id: 'flow-merge', name: 'Merge', category: 'Flowchart', keywords: 'inverted triangle', build: polygon([0, 0, 1, 0, 0.5, 1]) },
  { id: 'flow-extract', name: 'Extract', category: 'Flowchart', keywords: 'triangle', build: polygon(TRIANGLE) },
  { id: 'flow-document', name: 'Document', category: 'Flowchart', keywords: 'page paper report wave', build: curved(DOCUMENT) },
  { id: 'flow-database', name: 'Database', category: 'Flowchart', keywords: 'cylinder storage disk db', build: curved(CYLINDER) },
  { id: 'flow-delay', name: 'Delay', category: 'Flowchart', keywords: 'wait d shape', build: curved(DELAY) },
  { id: 'flow-display', name: 'Display', category: 'Flowchart', keywords: 'screen monitor', build: curved(DISPLAY) },
  { id: 'flow-stored-data', name: 'Stored data', category: 'Flowchart', keywords: 'storage', build: curved(STORED) },

  { id: 'arrow-block', name: 'Arrow block', category: 'Arrows', keywords: 'right block arrow', build: polygon([0, 0.3, 0.6, 0.3, 0.6, 0, 1, 0.5, 0.6, 1, 0.6, 0.7, 0, 0.7]) },
  { id: 'chevron', name: 'Chevron', category: 'Arrows', keywords: 'step process', build: polygon([0, 0, 0.7, 0, 1, 0.5, 0.7, 1, 0, 1, 0.3, 0.5]) },
  { id: 'circle-arrow', name: 'Circular arrow', category: 'Arrows', keywords: 'cycle refresh loop rotate', square: true, build: curved(CIRCLE_ARROW) },
];

export const PRESET_CATEGORIES: { id: PresetCategory; label: string }[] = [
  { id: 'Basic', label: 'Basic shapes' },
  { id: 'Flowchart', label: 'Flowchart' },
  { id: 'Arrows', label: 'Arrows' },
];

export const getPreset = (id: string | null | undefined): ShapePreset | undefined => SHAPE_PRESETS.find((p) => p.id === id);

/** Presets matching a search query (every word in the name, category or keywords). */
export function searchPresets(query: string): ShapePreset[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return SHAPE_PRESETS.filter((p) => {
    const hay = `${p.name} ${p.category} ${p.keywords ?? ''} shape`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A new shape of a preset in the given box (a square preset is cut down to equal sides). */
export function makePresetShape(doc: CircuitDoc, preset: ShapePreset, x: number, y: number, w: number, h: number): ShapeItem {
  const side = Math.min(w, h);
  const bw = preset.square ? side : w;
  const bh = preset.square ? side : h;
  const fields = preset.build({ w: bw, h: bh });
  const s = makeShape(doc, fields.kind ?? 'rect', x, y, bw, bh);
  return Object.assign(s, fields);
}

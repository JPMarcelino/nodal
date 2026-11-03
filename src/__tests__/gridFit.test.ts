import { describe, expect, it } from 'vitest';
import type { SvgDrawing, SvgPolyline } from '../io/svgImport';
import { ellipseOf, joinStrokes, recognizeShapes, rectOf, simplifyPolyline } from '../io/svgShapes';
import { drawingPoints, fitPitch, previewGridFit, snapDrawing } from '../model/gridFit';

const line = (pts: [number, number][], extra: Partial<SvgPolyline> = {}): SvgPolyline => ({ pts: pts.map(([x, y]) => ({ x, y })), closed: false, width: 2, color: '#000000', dashed: false, ...extra });
const drawing = (lines: SvgPolyline[], more: Partial<SvgDrawing> = {}): SvgDrawing => ({ lines, boxes: [], dots: [], texts: [], ...more });
const onLattice = (v: number, p: number) => Math.abs(v / p - Math.round(v / p)) < 1e-6;

describe('fitPitch', () => {
  it('finds the drawing’s own spacing, even off round numbers (mm drawings)', () => {
    const mm = 3.7795;
    const pts = [0, 7, 13, 120, 251].map((k, i) => ({ x: 5.2 + k * mm, y: -3.1 + (i * 3 + 1) * mm }));
    expect(fitPitch(pts)).toBeCloseTo(mm, 3);
  });

  it('prefers round spacings and divides the page grid when told to', () => {
    const pts = [{ x: 0, y: 0 }, { x: 25, y: 10 }, { x: 50, y: 35 }];
    expect(fitPitch(pts)).toBe(5);
    // with a 10 px grid on the page, the pitch must also divide 10
    expect(fitPitch([{ x: 0, y: 0 }, { x: 7.5, y: 0 }], { divides: 10 })).toBe(2.5);
    expect(fitPitch([{ x: 0, y: 0 }, { x: 30, y: 20 }], { divides: 10 })).toBe(10);
  });

  it('keeps the grid when the drawing is spaced in whole grid steps', () => {
    const d = drawing([line([[0, 0], [40, 0], [40, 80]])]);
    expect(previewGridFit(d, 10, false).refined).toBe(10);
  });
});

describe('snapDrawing', () => {
  it('refined: every point lands on the grid, sizes unchanged', () => {
    const d = drawing([line([[1.3, 1.3], [8.8, 1.3], [8.8, 3.8]])], { boxes: [{ kind: 'rect', x: 3.8, y: 6.3, w: 5, h: 2.5, rx: 0, stroke: '#000000', strokeWidth: 1, fill: 'none', fillOpacity: 0, dashed: false }] });
    const fit = previewGridFit(d, 10, true, { x: 100, y: 100 });
    expect(fit.refined).toBe(2.5);
    const { drawing: out, maxShift } = snapDrawing(d, fit.refined, { x: 100, y: 100 });
    expect(maxShift).toBeLessThan(0.5);
    for (const p of drawingPoints(out)) {
      expect(onLattice(p.x + 100, 2.5)).toBe(true);
      expect(onLattice(p.y + 100, 2.5)).toBe(true);
    }
    const l = out.lines[0].pts;
    expect(l[1].x - l[0].x).toBeCloseTo(7.5, 9);
    expect(l[2].y - l[1].y).toBeCloseTo(2.5, 9);
    expect(out.boxes[0].w).toBeCloseTo(5, 9);
  });

  it('snap: points move to the current grid; straight runs stay straight', () => {
    const d = drawing([line([[2, 3], [57, 3], [57, 41]]), line([[30, 3], [30, 18]])]);
    const { drawing: out, maxShift } = snapDrawing(d, 10);
    expect(maxShift).toBeLessThanOrEqual(Math.hypot(5, 5));
    const [a, b] = out.lines;
    expect(a.pts[0].y).toBe(a.pts[1].y);
    expect(a.pts[1].x).toBe(a.pts[2].x);
    // the tee still starts on the run it branched from
    expect(b.pts[0].y).toBe(a.pts[0].y);
    for (const p of drawingPoints(out)) expect(onLattice(p.x, 10) && onLattice(p.y, 10)).toBe(true);
  });
});

describe('recognizeShapes', () => {
  it('joins loose segments into one polyline, but not across a tee or a dot', () => {
    const joined = joinStrokes([line([[0, 0], [50, 0]]), line([[50, 0], [50, 40]]), line([[50, 40], [90, 40]])]);
    expect(joined).toHaveLength(1);
    expect(joined[0].pts.map((p) => [p.x, p.y])).toEqual([[0, 0], [50, 0], [50, 40], [90, 40]]);
    // a third stroke ending at the corner makes it a junction
    expect(joinStrokes([line([[0, 0], [50, 0]]), line([[50, 0], [50, 40]]), line([[50, 0], [80, 0]])])).toHaveLength(3);
    // a stroke passing straight through the meeting point too
    expect(joinStrokes([line([[0, 0], [50, 0]]), line([[50, 0], [50, 40]]), line([[50, -20], [50, -1], [50, 20]])]).length).toBeGreaterThan(1);
    // a dot marks a connection
    expect(joinStrokes([line([[0, 0], [50, 0]]), line([[50, 0], [50, 40]])], [{ x: 50, y: 0 }])).toHaveLength(2);
    // different widths are different strokes
    expect(joinStrokes([line([[0, 0], [50, 0]]), line([[50, 0], [50, 40]], { width: 1 })])).toHaveLength(2);
  });

  it('drops points in the middle of a straight run, but keeps a doubling back', () => {
    expect(simplifyPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 5 }], false)).toHaveLength(3);
    expect(simplifyPolyline([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 0 }], false)).toHaveLength(3);
  });

  it('reads a rectangle drawn as four separate lines as a rectangle', () => {
    const d = recognizeShapes(drawing([line([[0, 0], [40, 0]]), line([[40, 20], [40, 0]]), line([[40, 20], [0, 20]]), line([[0, 20], [0, 0]])]));
    expect(d.lines).toHaveLength(0);
    expect(d.boxes).toEqual([expect.objectContaining({ kind: 'rect', x: 0, y: 0, w: 40, h: 20, strokeWidth: 2 })]);
  });

  it('keeps a slanted quadrilateral as an outline', () => {
    expect(rectOf(line([[0, 0], [40, 5], [40, 25], [0, 20], [0, 0]], { closed: true }))).toBeNull();
  });

  it('reads a closed curve around a circle as an ellipse, and an arc as not', () => {
    const ring = (from: number, to: number, n = 32) => Array.from({ length: n + 1 }, (_, i) => {
      const a = from + ((to - from) * i) / n;
      return [30 + 20 * Math.cos(a), 10 + 10 * Math.sin(a)] as [number, number];
    });
    const nodes = [{ x: 0, y: 0 }];
    const e = ellipseOf(line(ring(0, 2 * Math.PI), { closed: true, nodes, fill: '#ff0000', fillOpacity: 1 }));
    expect(e).toMatchObject({ kind: 'ellipse', x: 10, y: 0, w: 40, h: 20, fill: '#ff0000' });
    expect(ellipseOf(line(ring(0, Math.PI), { closed: true, nodes }))).toBeNull();
  });
});

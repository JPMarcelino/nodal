import { describe, expect, it } from 'vitest';
import { arcToCubics, parsePathData } from '../io/svgImport';
import { parseDraw, primsToDsl } from '../model/symbols/dsl';

describe('parsePathData', () => {
  it('normalises relative, H/V and implicit commands to absolute segments', () => {
    const segs = parsePathData('m10 10 20 0 v20 H10 z M5,5l1-1');
    expect(segs.map((s) => s.c).join('')).toBe('MLLLZML');
    expect(segs[1].p).toEqual([30, 10]);
    expect(segs[2].p).toEqual([30, 30]);
    expect(segs[3].p).toEqual([10, 30]);
    expect(segs[6].p).toEqual([6, 4]);
  });

  it('reflects control points for S and T', () => {
    const [, c, s] = parsePathData('M0 0 C0 10 10 10 10 0 S20 -10 20 0');
    expect(c.c).toBe('C');
    expect(s.p.slice(0, 2)).toEqual([10, -10]);
    const [, , t] = parsePathData('M0 0 Q5 10 10 0 T20 0');
    expect(t.p).toEqual([15, -10, 20, 0]);
  });

  it('reads compact arc flags and turns arcs into curves ending on the target', () => {
    const segs = parsePathData('M0 0a10 10 0 0110 10');
    expect(segs[1].c).toBe('C');
    expect(segs[segs.length - 1].p.slice(-2)).toEqual([10, 10]);
  });

  it('rejects junk instead of looping', () => {
    expect(() => parsePathData('M0 0 Z 5 5')).toThrow();
  });
});

describe('arcToCubics', () => {
  it('draws a half circle through the expected midpoint', () => {
    const curves = arcToCubics(-10, 0, 10, 10, 0, false, true, 10, 0)!;
    expect(curves).toHaveLength(2);
    // end of the first quarter is the top of the circle (y down: sweep=1 goes through y = -10)
    expect(curves[0][4]).toBeCloseTo(0, 6);
    expect(Math.abs(curves[0][5])).toBeCloseTo(10, 6);
  });
  it('treats a zero radius as a straight line', () => {
    expect(arcToCubics(0, 0, 0, 5, 0, false, true, 10, 0)).toBeNull();
  });
});

describe('imported drawings survive the symbol DSL', () => {
  it('keeps zero-width (fill only) shapes and paths', () => {
    const src = primsToDsl([
      { t: 'poly', pts: [0, 0, 10, 0, 10, 10], fill: 'solid', w: 0 },
      { t: 'path', d: 'M0 0 C1 2 3 4 5 6 Z', fill: 'none', w: 0.5 },
      { t: 'line', pts: [0, 0, 10, 10], w: 1.25 },
    ]);
    const back = parseDraw(src);
    expect(back.map((p) => p.t)).toEqual(['poly', 'path', 'line']);
    expect(back.map((p) => ('w' in p ? p.w : undefined))).toEqual([0, 0.5, 1.25]);
  });
});

describe('insertSvgDrawing', () => {
  it('turns strokes into straight wires joined by junctions where they meet', async () => {
    const { createDoc } = await import('../model/doc');
    const { insertSvgDrawing } = await import('../model/svgDrawing');
    const doc = createDoc();
    const line = (pts: [number, number][], width = 2) => ({ pts: pts.map(([x, y]) => ({ x, y })), closed: false, width, color: '#000000', dashed: false });
    const ids = insertSvgDrawing(
      doc,
      {
        // a horizontal bus, a branch teeing into its middle, and an L whose end meets the bus end
        lines: [line([[0, 0], [100, 0]]), line([[50, 0], [50, 40]], 1), line([[100, 0], [100, 30], [130, 30]])],
        boxes: [{ kind: 'rect', x: 0, y: 50, w: 20, h: 10, rx: 0, stroke: '#000000', strokeWidth: 1, fill: 'none', fillOpacity: 0, dashed: false }],
        dots: [{ x: 50, y: 0 }],
        texts: [],
      },
      { x: 200, y: 100 },
      undefined,
      'drawing',
    );
    const items = ids.map((id) => doc.items[id]);
    const wires = items.filter((i) => i.type === 'wire');
    const junctions = items.filter((i) => i.type === 'junction');
    // bus split at the tee → 2 pieces, plus the branch and the L
    expect(wires).toHaveLength(4);
    expect(junctions.map((j) => j.type === 'junction' && [j.x, j.y])).toEqual(expect.arrayContaining([[250, 100], [300, 100]]));
    for (const w of wires) if (w.type === 'wire') expect(w.routing).toBe('straight');
    const branch = wires.find((w) => w.type === 'wire' && w.style?.width === 1);
    expect(branch && branch.type === 'wire' && branch.a.kind).toBe('junction');
    // the L keeps its corner as a vertex
    expect(wires.some((w) => w.type === 'wire' && w.pts.length === 1 && w.pts[0].x === 300 && w.pts[0].y === 130)).toBe(true);
    expect(items.filter((i) => i.type === 'shape')).toHaveLength(1);
    // all grouped together under the file name
    const g = items[0].group!;
    expect(doc.groups[g].name).toBe('drawing');
    expect(items.every((i) => i.group === g)).toBe(true);
  });
});

describe('SVG import options and symbol recognition', () => {
  /** A drawing of `symbol` as a placed part would draw it, plus extra strokes. */
  async function drawn(placed: { symbol: string; x: number; y: number; rot: 0 | 90 | 180 | 270; flipX?: boolean; scale?: number }[], extra: [number, number][][] = []) {
    const { createDoc } = await import('../model/doc');
    const { instanceSymbol } = await import('../model/registry');
    const { toWorld } = await import('../model/geometry');
    const { primPolys } = await import('../model/svgSymbols');
    const doc = createDoc();
    const line = (pts: { x: number; y: number }[]) => ({ pts, closed: false, width: 2, color: '#000000', dashed: false });
    const lines = placed.flatMap((p) => {
      const c = { flipX: false, ...p };
      const def = instanceSymbol(doc, c);
      return def.prims.flatMap(primPolys).map((poly) => line(poly.map((q) => toWorld(c, def, q.x, q.y))));
    });
    for (const e of extra) lines.push(line(e.map(([x, y]) => ({ x, y }))));
    return { doc, drawing: { lines, boxes: [], dots: [], texts: [{ x: placed[0].x + 30, y: placed[0].y - 20, size: 10, anchor: 'start' as const, text: 'R7', color: '#000000' }] } };
  }

  it('finds a rotated resistor and a scaled capacitor, and nothing in a bare wire', async () => {
    const { recognizeSymbols } = await import('../model/svgSymbols');
    const { doc, drawing } = await drawn(
      [
        { symbol: 'resistor', x: 100, y: 40, rot: 90 },
        { symbol: 'capacitor', x: 300, y: 0, rot: 0, scale: 2 },
      ],
      [[[0, 200], [160, 200]]],
    );
    const { parts, rest } = recognizeSymbols(doc, drawing);
    const r = parts.find((p) => p.symbol === 'resistor');
    const c = parts.find((p) => p.symbol === 'capacitor');
    expect(parts).toHaveLength(2);
    expect(r && [r.x, r.y, r.rot % 180]).toEqual([100, 40, 90]);
    expect(r?.ref).toBe('R7');
    expect(c && [c.x, c.y, c.scale]).toEqual([300, 0, 2]);
    // only the wire and nothing else is left
    expect(rest.lines).toHaveLength(1);
    expect(rest.texts).toHaveLength(0);
  });

  it('needs every piece of the symbol', async () => {
    const { recognizeSymbols } = await import('../model/svgSymbols');
    const { doc, drawing } = await drawn([{ symbol: 'capacitor', x: 0, y: 0, rot: 0 }]);
    drawing.lines.splice(1, 1); // drop a plate
    expect(recognizeSymbols(doc, drawing).parts.some((p) => p.symbol === 'capacitor')).toBe(false);
  });

  it('places recognised parts and wires them up at their pins', async () => {
    const { insertSvgDrawing, DEFAULT_SVG_IMPORT } = await import('../model/svgDrawing');
    // a horizontal resistor with pins at (-40, 0) / (40, 0) and a wire leaving its right pin
    const { doc, drawing } = await drawn([{ symbol: 'resistor', x: 0, y: 0, rot: 0 }], [[[40, 0], [100, 0], [100, 50]]]);
    const ids = insertSvgDrawing(doc, drawing, { x: 0, y: 0 }, undefined, 'x', { ...DEFAULT_SVG_IMPORT, symbols: true });
    const items = ids.map((id) => doc.items[id]);
    const part = items.find((i) => i.type === 'component');
    const wire = items.find((i) => i.type === 'wire');
    expect(part?.type === 'component' && [part.symbol, part.ref]).toEqual(['resistor', 'R7']);
    expect(wire?.type === 'wire' && wire.a).toEqual({ kind: 'port', comp: part!.id, port: '2' });
    expect(items.filter((i) => i.type === 'junction')).toHaveLength(0);
  });

  it('makes lines and polygons instead of wires and boxes when asked', async () => {
    const { createDoc } = await import('../model/doc');
    const { insertSvgDrawing } = await import('../model/svgDrawing');
    const doc = createDoc();
    const ids = insertSvgDrawing(
      doc,
      {
        lines: [
          { pts: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }], closed: false, width: 2, color: '#000000', dashed: false },
          { pts: [{ x: 0, y: 40 }, { x: 20, y: 40 }, { x: 10, y: 60 }], closed: true, width: 1, color: '#ff0000', dashed: false, fill: '#00ff00', fillOpacity: 0.5, stroked: true },
        ],
        boxes: [{ kind: 'rect', x: 0, y: 70, w: 20, h: 10, rx: 0, stroke: '#000000', strokeWidth: 1, fill: 'none', fillOpacity: 0, dashed: false }],
        dots: [{ x: 50, y: 30, r: 2 }],
        texts: [],
      },
      { x: 0, y: 0 },
      undefined,
      'y',
      { strokes: 'lines', closed: 'polygons', boxes: 'outlines', symbols: false },
    );
    const shapes = ids.map((id) => doc.items[id]).flatMap((i) => (i.type === 'shape' ? [i] : []));
    expect(ids.every((id) => doc.items[id].type === 'shape')).toBe(true);
    expect(shapes.filter((s) => s.kind === 'line').map((s) => [s.x, s.y, s.w, s.h])).toEqual([[0, 0, 50, 0], [50, 0, 0, 30]]);
    const polys = shapes.filter((s) => s.kind === 'polygon');
    expect(polys).toHaveLength(2);
    expect(polys[0]).toMatchObject({ fill: '#00ff00', fillOpacity: 0.5, stroke: '#ff0000' });
    expect(polys[1].poly).toHaveLength(8);
    expect(shapes.filter((s) => s.kind === 'ellipse')).toHaveLength(1);
  });
});

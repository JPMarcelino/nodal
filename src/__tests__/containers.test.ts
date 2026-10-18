import { describe, expect, it } from 'vitest';
import { withContents } from '../model/containers';
import { createDoc, makeShape } from '../model/doc';
import { alignItems, distributeItems, translateItems } from '../model/ops';
import { pathBounds, pathNodes } from '../model/path';
import { SHAPE_PRESETS, getPreset, makePresetShape, searchPresets } from '../model/shapePresets';
import type { CircuitDoc, ShapeItem } from '../model/types';

const add = (doc: CircuitDoc, x: number, y: number, w: number, h: number, extra: Partial<ShapeItem> = {}) => {
  const s = Object.assign(makeShape(doc, 'rect', x, y, w, h), extra);
  doc.items[s.id] = s;
  return s.id;
};

describe('shape presets', () => {
  it('has unique ids and names per category', () => {
    expect(new Set(SHAPE_PRESETS.map((p) => p.id)).size).toBe(SHAPE_PRESETS.length);
    for (const c of ['Basic', 'Flowchart', 'Arrows']) {
      const names = SHAPE_PRESETS.filter((p) => p.category === c).map((p) => p.name);
      expect(names.length).toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('builds closed polygons spanning the unit box', () => {
    for (const p of SHAPE_PRESETS) {
      const f = p.build({ w: 80, h: 60 });
      if (f.kind !== 'polygon') continue;
      const a = f.poly!;
      if (f.curve) {
        // curved outlines: the curve itself (not its nodes) spans the unit box
        const b = pathBounds(pathNodes({ x: 0, y: 0, w: 1, h: 1, poly: a, curve: f.curve }), f.open);
        expect([b.x, b.y, b.x + b.w, b.y + b.h].map((v) => Math.round(v * 1e3) / 1e3 + 0), p.id).toEqual([0, 0, 1, 1]);
        expect(f.curve.length, p.id).toBe(a.length * 2);
        continue;
      }
      expect(a.length % 2, p.id).toBe(0);
      expect(a.length / 2, p.id).toBeGreaterThanOrEqual(3);
      expect(a.every((v) => v >= 0 && v <= 1), p.id).toBe(true);
      const xs = a.filter((_, i) => i % 2 === 0);
      const ys = a.filter((_, i) => i % 2 === 1);
      expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], p.id).toEqual([0, 1, 0, 1]);
      // non-degenerate: shoelace area is positive
      let area = 0;
      for (let i = 0; i < xs.length; i++) {
        const j = (i + 1) % xs.length;
        area += xs[i] * ys[j] - xs[j] * ys[i];
      }
      expect(Math.abs(area) / 2, p.id).toBeGreaterThan(0.1);
    }
  });

  it('makes rounded and stadium rectangles and circles', () => {
    const doc = createDoc();
    expect(makePresetShape(doc, getPreset('rounded-rect')!, 0, 0, 80, 60)).toMatchObject({ kind: 'rect', radius: 12 });
    expect(makePresetShape(doc, getPreset('flow-terminator')!, 0, 0, 80, 40).radius).toBe(20);
    const c = makePresetShape(doc, getPreset('circle')!, 0, 0, 80, 60);
    expect([c.kind, c.w, c.h]).toEqual(['ellipse', 60, 60]);
    const t = makePresetShape(doc, getPreset('triangle')!, 5, 6, 80, 60);
    expect(t).toMatchObject({ kind: 'polygon', x: 5, y: 6, w: 80, h: 60 });
  });

  it('is searchable by name and keyword', () => {
    expect(searchPresets('hexa').map((p) => p.id)).toContain('hexagon');
    expect(searchPresets('start end').map((p) => p.id)).toContain('flow-terminator');
    expect(searchPresets('')).toEqual([]);
  });
});

describe('containers', () => {
  it('carries items fully inside and leaves the rest', () => {
    const doc = createDoc();
    const box = add(doc, 0, 0, 200, 200, { container: true });
    const inside = add(doc, 20, 20, 50, 50);
    const partial = add(doc, 180, 20, 50, 50);
    const outside = add(doc, 300, 300, 10, 10);
    const ids = withContents(doc, [box]);
    expect(ids.has(inside)).toBe(true);
    expect(ids.has(partial)).toBe(false);
    expect(ids.has(outside)).toBe(false);
    const base = structuredClone(doc);
    translateItems(base, doc, ids, 30, 40);
    expect([doc.items[inside].type === 'shape' && (doc.items[inside] as ShapeItem).x, (doc.items[partial] as ShapeItem).x]).toEqual([50, 180]);
    expect((doc.items[box] as ShapeItem).y).toBe(40);
  });

  it('does nothing for a plain rectangle', () => {
    const doc = createDoc();
    const box = add(doc, 0, 0, 200, 200);
    add(doc, 20, 20, 50, 50);
    expect(withContents(doc, [box]).size).toBe(1);
  });

  it('uses the turned box of a rotated container', () => {
    const doc = createDoc();
    const box = add(doc, 0, 0, 200, 40, { container: true, rot: 90 });
    // turned about (100, 20): occupies x 80..120, y -80..120
    const inside = add(doc, 85, 50, 20, 20);
    const outside = add(doc, 10, 10, 20, 20);
    const ids = withContents(doc, [box]);
    expect(ids.has(inside)).toBe(true);
    expect(ids.has(outside)).toBe(false);
  });

  it('moves nested containers recursively, once', () => {
    const doc = createDoc();
    const outer = add(doc, 0, 0, 400, 400, { container: true });
    const inner = add(doc, 50, 50, 200, 200, { container: true });
    const leaf = add(doc, 60, 60, 20, 20);
    const ids = withContents(doc, [outer, inner]);
    expect([...ids].sort()).toEqual([outer, inner, leaf].sort());
    const base = structuredClone(doc);
    translateItems(base, doc, ids, 10, 0);
    expect((doc.items[leaf] as ShapeItem).x).toBe(70);
  });

  it('keeps locked items and locked containers in place', () => {
    const doc = createDoc();
    const box = add(doc, 0, 0, 200, 200, { container: true });
    const free = add(doc, 20, 20, 30, 30);
    const pinned = add(doc, 100, 100, 30, 30, { locked: true });
    const ids = withContents(doc, [box]);
    expect(ids.has(free)).toBe(true);
    expect(ids.has(pinned)).toBe(false);
    const base = structuredClone(doc);
    translateItems(base, doc, ids, 10, 10);
    expect((doc.items[pinned] as ShapeItem).x).toBe(100);

    const lockedBox = add(doc, 500, 0, 200, 200, { container: true, locked: true });
    const child = add(doc, 520, 20, 30, 30);
    expect(withContents(doc, [lockedBox]).has(child)).toBe(false);
  });
});

describe('library presets', () => {
  it('fills basic and flowchart shapes with the page colour, but not arrows', () => {
    const doc = createDoc();
    doc.settings.background = '#112233';
    const box = makePresetShape(doc, getPreset('flow-process')!, 0, 0, 80, 60);
    expect(box.fill).toBe('#112233');
    expect(box.fillOpacity).toBe(1);
    expect(makePresetShape(doc, getPreset('arrow-block')!, 0, 0, 80, 60).fillOpacity).toBe(0);
    doc.settings.background = '';
    expect(makePresetShape(doc, getPreset('triangle')!, 0, 0, 80, 60, 'light').fill).toBe('#fffdf9');
  });

  it('draws the database as an open path with no stretch twice', () => {
    const s = makePresetShape(createDoc(), getPreset('flow-database')!, 0, 0, 80, 60);
    expect(s.open).toBe(true);
    const b = pathBounds(pathNodes(s), true);
    expect(b.w).toBeCloseTo(80, 1);
    expect(b.h).toBeCloseTo(60, 1);
  });
});

describe('align and distribute with containers', () => {
  it('carry a container\'s contents, and let selected contents ride along', () => {
    const doc = createDoc();
    const box = add(doc, 0, 0, 100, 100, { container: true });
    const inner = add(doc, 10, 10, 20, 20);
    const other = add(doc, 300, 200, 100, 100);
    alignItems(doc, [box, inner, other], 'bottom');
    // the box dropped to the other's bottom edge and took the inner shape with it
    expect((doc.items[box] as ShapeItem).y).toBe(200);
    expect((doc.items[inner] as ShapeItem).y).toBe(210);
    expect((doc.items[other] as ShapeItem).y).toBe(200);
  });

  it('distributes containers with their contents', () => {
    const doc = createDoc();
    const a = add(doc, 0, 0, 100, 100, { container: true });
    const ai = add(doc, 10, 10, 20, 20);
    const b = add(doc, 150, 0, 100, 100);
    const c = add(doc, 600, 0, 100, 100);
    distributeItems(doc, [a, b, c], 'x');
    expect((doc.items[b] as ShapeItem).x).toBe(300);
    expect((doc.items[a] as ShapeItem).x).toBe(0);
    expect((doc.items[ai] as ShapeItem).x).toBe(10);
  });
});

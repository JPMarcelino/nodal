import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createDoc, makeComponent, makeShape, uid } from '../model/doc';
import { computeSceneData, updateSceneData, type SceneData } from '../canvas/Scene';
import type { CircuitDoc, ComponentItem, ShapeItem, WireItem } from '../model/types';

function freeWire(doc: CircuitDoc, ax: number, ay: number, bx: number, by: number): WireItem {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: ax, y: ay }, b: { kind: 'free', x: bx, y: by }, pts: [] };
  doc.items[w.id] = w;
  return w;
}

function sample(): { doc: CircuitDoc; wa: WireItem; wb: WireItem; c: string; u: string } {
  const doc = createDoc();
  const c = makeComponent(doc, 'resistor', 100, 100);
  doc.items[c.id] = c;
  const u = makeComponent(doc, 'resistor', 500, 500);
  doc.items[u.id] = u;
  const wa = freeWire(doc, 0, 50, 200, 50);
  const wb = freeWire(doc, 100, 0, 100, 200);
  const wc: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: c.id, port: '1' }, b: { kind: 'free', x: 300, y: 300 }, pts: [] };
  doc.items[wc.id] = wc;
  return { doc, wa, wb, c: c.id, u: u.id };
}

function sameScene(a: SceneData, b: SceneData) {
  expect([...a.polys].map(([id, pts]) => [id, pts])).toEqual([...b.polys].map(([id, pts]) => [id, pts]));
  expect(a.crossings).toEqual(b.crossings);
  expect(a.hops).toEqual(b.hops);
  expect(a.layers).toEqual(b.layers);
  expect(a.portDegree).toEqual(b.portDegree);
  expect(a.junctionDegree).toEqual(b.junctionDegree);
  expect(a.touching).toEqual(b.touching);
}

describe('updateSceneData', () => {
  it('returns the cached object when only a shape moved', () => {
    const { doc } = sample();
    const s = makeShape(doc, 'rect', 0, 0, 40, 40);
    doc.items[s.id] = s;
    const s0 = doc.items[s.id] as ShapeItem;
    const base = computeSceneData(doc);
    const moved = produce(doc, (d) => {
      d.items[s.id] = { ...s0, x: s0.x + 25 };
    });
    expect(updateSceneData(doc, base, moved)).toBe(base);
  });

  it('matches a full recompute while reusing untouched wire polylines', () => {
    const { doc, wa, wb } = sample();
    const base = computeSceneData(doc);
    const moved = produce(doc, (d) => {
      d.items[wa.id] = { ...wa, pts: [{ x: 100, y: 20 }] };
    });
    const next = updateSceneData(doc, base, moved);
    sameScene(next, computeSceneData(moved));
    expect(next.polys.get(wb.id)).toBe(base.polys.get(wb.id));
    expect(next.polys.get(wa.id)).not.toBe(base.polys.get(wa.id));
    expect(next.crossings).not.toBe(base.crossings);
  });

  it('reuses crossings and polys when an unconnected component moves', () => {
    const { doc, u } = sample();
    const u0 = doc.items[u] as ComponentItem;
    const base = computeSceneData(doc);
    const moved = produce(doc, (d) => {
      d.items[u] = { ...u0, x: u0.x + 10 };
    });
    const next = updateSceneData(doc, base, moved);
    sameScene(next, computeSceneData(moved));
    expect(next).not.toBe(base);
    expect(next.crossings).toBe(base.crossings);
    expect(next.hops).toBe(base.hops);
    expect(next.touching).not.toBe(base.touching);
    for (const [id, pts] of base.polys) expect(next.polys.get(id)).toBe(pts);
  });

  it('recomputes the wires attached to a moved component', () => {
    const { doc, c, wb } = sample();
    const c0 = doc.items[c] as ComponentItem;
    const base = computeSceneData(doc);
    const moved = produce(doc, (d) => {
      d.items[c] = { ...c0, x: c0.x + 30 };
    });
    const next = updateSceneData(doc, base, moved);
    sameScene(next, computeSceneData(moved));
    const wired = (Object.values(moved.items) as WireItem[]).find((w) => w.type === 'wire' && (w.a.kind === 'port' || w.b.kind === 'port'))!;
    expect(next.polys.get(wired.id)).not.toBe(base.polys.get(wired.id));
    expect(next.polys.get(wb.id)).toBe(base.polys.get(wb.id));
  });

  it('falls back to a full recompute when settings change', () => {
    const { doc } = sample();
    const base = computeSceneData(doc);
    const changed = produce(doc, (d) => {
      d.settings.hops = 'none';
    });
    const next = updateSceneData(doc, base, changed);
    sameScene(next, computeSceneData(changed));
    expect(next.hops.size).toBe(0);
  });
});

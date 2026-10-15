import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createDoc, makeComponent, makeShape, uid } from '../model/doc';
import { computeSceneData, updateSceneData, type SceneData } from '../canvas/Scene';
import type { CircuitDoc, ComponentItem, JunctionItem, ShapeItem, WireItem } from '../model/types';
import type { Crossing } from '../model/wires';

function freeWire(doc: CircuitDoc, ax: number, ay: number, bx: number, by: number): WireItem {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: ax, y: ay }, b: { kind: 'free', x: bx, y: by }, pts: [] };
  doc.items[w.id] = w;
  return w;
}

function sample(): { doc: CircuitDoc; wa: WireItem; wb: WireItem; wc: WireItem; wd: WireItem; c: string; u: string; jn: string; ju: string } {
  const doc = createDoc();
  const c = makeComponent(doc, 'resistor', 100, 100);
  doc.items[c.id] = c;
  const u = makeComponent(doc, 'resistor', 500, 500);
  doc.items[u.id] = u;
  const jn: JunctionItem = { id: uid('j'), type: 'junction', x: 100, y: 50 };
  doc.items[jn.id] = jn;
  const ju: JunctionItem = { id: uid('j'), type: 'junction', x: 400, y: 400 };
  doc.items[ju.id] = ju;
  const wa = freeWire(doc, 0, 50, 200, 50);
  const wb = freeWire(doc, 100, 0, 100, 200);
  const wc: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: c.id, port: '1' }, b: { kind: 'free', x: 300, y: 300 }, pts: [] };
  doc.items[wc.id] = wc;
  const wd: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'junction', id: jn.id }, b: { kind: 'free', x: 100, y: 150 }, pts: [] };
  doc.items[wd.id] = wd;
  return { doc, wa, wb, wc, wd, c: c.id, u: u.id, jn: jn.id, ju: ju.id };
}

const normCross = (cs: Crossing[]) =>
  cs.map((c) => JSON.stringify({ pt: c.pt, sides: [c.a, c.b].map((s) => JSON.stringify(s)).sort() })).sort();
const normHops = (m: Map<string, { seg: number; d: number }[]>) =>
  [...m.entries()].map(([k, v]) => `${k}:${JSON.stringify([...v].sort((a, b) => a.seg - b.seg || a.d - b.d))}`).sort();
const normCells = (m: Map<string, string[]>) => [...m.entries()].map(([k, v]) => `${k}=${[...v].sort().join(',')}`).sort();

function sameScene(a: SceneData, b: SceneData) {
  expect([...a.polys].map(([id, pts]) => [id, pts])).toEqual([...b.polys].map(([id, pts]) => [id, pts]));
  expect(normCross(a.crossings)).toEqual(normCross(b.crossings));
  expect(normHops(a.hops)).toEqual(normHops(b.hops));
  expect(a.layers).toEqual(b.layers);
  expect(a.portDegree).toEqual(b.portDegree);
  expect(a.junctionDegree).toEqual(b.junctionDegree);
  expect(a.touching).toEqual(b.touching);
  expect(normCells(a.touchCells)).toEqual(normCells(b.touchCells));
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

  it('returns the cached object when only a component label moved', () => {
    const { doc, c } = sample();
    const c0 = doc.items[c] as ComponentItem;
    const base = computeSceneData(doc);
    const moved = produce(doc, (d) => {
      d.items[c] = { ...c0, labelDx: 12, labelDy: -4 };
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

  it('recomputes only the wires attached to a moved component', () => {
    const { doc, c, wa, wb, wc } = sample();
    const c0 = doc.items[c] as ComponentItem;
    const base = computeSceneData(doc);
    const moved = produce(doc, (d) => {
      d.items[c] = { ...c0, x: c0.x + 30 };
    });
    const next = updateSceneData(doc, base, moved);
    sameScene(next, computeSceneData(moved));
    expect(next.polys.get(wc.id)).not.toBe(base.polys.get(wc.id));
    expect(next.polys.get(wa.id)).toBe(base.polys.get(wa.id));
    expect(next.polys.get(wb.id)).toBe(base.polys.get(wb.id));
  });

  it('recomputes only the wires attached to a moved junction', () => {
    const { doc, jn, wa, wb, wd } = sample();
    const j0 = doc.items[jn] as JunctionItem;
    const base = computeSceneData(doc);
    const moved = produce(doc, (d) => {
      d.items[jn] = { ...j0, x: j0.x + 20 };
    });
    const next = updateSceneData(doc, base, moved);
    sameScene(next, computeSceneData(moved));
    expect(next.polys.get(wd.id)).not.toBe(base.polys.get(wd.id));
    expect(next.polys.get(wa.id)).toBe(base.polys.get(wa.id));
    expect(next.polys.get(wb.id)).toBe(base.polys.get(wb.id));
  });

  it('returns the cached object when an unconnected junction moves', () => {
    const { doc, ju } = sample();
    const j0 = doc.items[ju] as JunctionItem;
    const base = computeSceneData(doc);
    const moved = produce(doc, (d) => {
      d.items[ju] = { ...j0, x: j0.x + 20 };
    });
    expect(updateSceneData(doc, base, moved)).toBe(base);
  });

  it('counts changed-versus-changed pairs once when two wires move', () => {
    const { doc, wa, wb } = sample();
    const base = computeSceneData(doc);
    const moved = produce(doc, (d) => {
      d.items[wa.id] = { ...wa, pts: [{ x: 50, y: 20 }] };
      d.items[wb.id] = { ...wb, pts: [{ x: 130, y: 60 }] };
    });
    const next = updateSceneData(doc, base, moved);
    sameScene(next, computeSceneData(moved));
    expect(next.polys.get(wa.id)).not.toBe(base.polys.get(wa.id));
    expect(next.polys.get(wb.id)).not.toBe(base.polys.get(wb.id));
  });

  it('handles deleting a wire', () => {
    const { doc, wa } = sample();
    const base = computeSceneData(doc);
    const cut = produce(doc, (d) => {
      delete d.items[wa.id];
    });
    const next = updateSceneData(doc, base, cut);
    sameScene(next, computeSceneData(cut));
    expect(next.polys.has(wa.id)).toBe(false);
    expect(next.crossings).not.toBe(base.crossings);
    expect(next.touching).toBe(base.touching);
  });

  it('handles deleting a component', () => {
    const { doc, u } = sample();
    const base = computeSceneData(doc);
    const cut = produce(doc, (d) => {
      delete d.items[u];
    });
    const next = updateSceneData(doc, base, cut);
    sameScene(next, computeSceneData(cut));
    expect(next.crossings).toBe(base.crossings);
    expect(next.touching).not.toBe(base.touching);
  });

  it('handles deleting a junction', () => {
    const { doc, jn } = sample();
    const base = computeSceneData(doc);
    const cut = produce(doc, (d) => {
      delete d.items[jn];
    });
    const next = updateSceneData(doc, base, cut);
    sameScene(next, computeSceneData(cut));
  });

  it('handles hiding and unhiding a wire', () => {
    const { doc, wb } = sample();
    const base = computeSceneData(doc);
    const hidden = produce(doc, (d) => {
      d.items[wb.id] = { ...wb, hidden: true };
    });
    const hid = updateSceneData(doc, base, hidden);
    sameScene(hid, computeSceneData(hidden));
    expect(hid.polys.has(wb.id)).toBe(false);
    expect(hid.crossings).not.toBe(base.crossings);
    const shown = produce(hidden, (d) => {
      d.items[wb.id] = { ...wb, hidden: undefined };
    });
    const back = updateSceneData(hidden, hid, shown);
    sameScene(back, computeSceneData(shown));
    expect(back.polys.has(wb.id)).toBe(true);
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

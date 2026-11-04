import { describe, expect, it } from 'vitest';
import { applySolder } from '../canvas/solder';
import type { SceneData } from '../canvas/Scene';
import { computeHotSpots } from '../model/hotspots';
import { createDoc, makeComponent, uid } from '../model/doc';
import { computeNets } from '../model/netlist';
import { solderWires } from '../model/ops';
import { joinTouches } from '../model/touches';
import type { CircuitDoc, JunctionItem, Point, WireItem } from '../model/types';
import { computeHops, portPosition, wireCrossings, wireCrossingsChanged, wirePolyline, type Crossing } from '../model/wires';

function freeWire(doc: CircuitDoc, ax: number, ay: number, bx: number, by: number): WireItem {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: ax, y: ay }, b: { kind: 'free', x: bx, y: by }, pts: [] };
  doc.items[w.id] = w;
  return w;
}

function polysOf(doc: CircuitDoc): Map<string, Point[]> {
  const m = new Map<string, Point[]>();
  for (const it of Object.values(doc.items)) if (it.type === 'wire') m.set(it.id, wirePolyline(doc, it));
  return m;
}

function sceneData(crossings: Crossing[] = []): SceneData {
  return { polys: new Map(), hops: new Map(), crossings, layers: new Map(), portDegree: new Map(), junctionDegree: new Map(), touching: new Set(), touchCells: new Map() };
}

const snap = (doc: CircuitDoc) => JSON.parse(JSON.stringify(doc));

describe('applySolder respects locks', () => {
  it('solders an unlocked crossing (success path)', () => {
    const doc = createDoc();
    freeWire(doc, 0, 50, 100, 50);
    freeWire(doc, 50, 0, 50, 100);
    const data = sceneData(wireCrossings(polysOf(doc)));
    expect(applySolder(doc, { kind: 'crossing', pt: { x: 50, y: 50 } }, data)).toBeNull();
    expect(Object.values(doc.items).filter((i) => i.type === 'junction')).toHaveLength(1);
  });

  it('refuses a crossing when any wire there is locked', () => {
    const doc = createDoc();
    freeWire(doc, 0, 50, 100, 50);
    const v = freeWire(doc, 50, 0, 50, 100);
    v.locked = true;
    const data = sceneData(wireCrossings(polysOf(doc)));
    expect(data.crossings).toHaveLength(1);
    const before = snap(doc);
    expect(applySolder(doc, { kind: 'crossing', pt: { x: 50, y: 50 } }, data)).toBe('Locked wires cannot be soldered');
    expect(snap(doc)).toEqual(before);
  });

  it('refuses to unsolder a locked junction', () => {
    const doc = createDoc();
    const h = freeWire(doc, 0, 50, 100, 50);
    const v = freeWire(doc, 50, 0, 50, 100);
    const jid = solderWires(doc, [h.id, v.id], { x: 50, y: 50 })!;
    (doc.items[jid] as JunctionItem).locked = true;
    const before = snap(doc);
    expect(applySolder(doc, { kind: 'junction', pt: { x: 50, y: 50 }, id: jid }, sceneData())).toBe('Locked wires cannot be unsoldered');
    expect(snap(doc)).toEqual(before);
  });

  it('refuses to unsolder a junction with a locked wire attached', () => {
    const doc = createDoc();
    const h = freeWire(doc, 0, 50, 100, 50);
    const v = freeWire(doc, 50, 0, 50, 100);
    const jid = solderWires(doc, [h.id, v.id], { x: 50, y: 50 })!;
    // one of the four pieces still runs through the junction: locking it must block the unsolder
    (doc.items[h.id] as WireItem).locked = true;
    const before = snap(doc);
    expect(applySolder(doc, { kind: 'junction', pt: { x: 50, y: 50 }, id: jid }, sceneData())).toBe('Locked wires cannot be unsoldered');
    expect(snap(doc)).toEqual(before);
  });

  it('refuses to unsolder a pin with a locked wire on it', () => {
    const doc = createDoc();
    const c = makeComponent(doc, 'resistor', 100, 100);
    doc.items[c.id] = c;
    const at = portPosition(doc, c, '1')!;
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: c.id, port: '1' }, b: { kind: 'free', x: at.pt.x + 100, y: at.pt.y }, pts: [] };
    doc.items[w.id] = w;
    w.locked = true;
    const before = snap(doc);
    expect(applySolder(doc, { kind: 'pin', pt: { ...at.pt }, comp: c.id, port: '1', ends: 1 }, sceneData())).toBe('Locked wires cannot be unsoldered');
    expect(snap(doc)).toEqual(before);
  });
});

describe('a wire looping back over its own route', () => {
  /** A top run that turns down and back along the bottom to a junction, a left branch from it rising through the top run, and a middle branch. */
  function box(doc: CircuitDoc) {
    const j: JunctionItem = { id: uid('j'), type: 'junction', x: 100, y: 100 };
    doc.items[j.id] = j;
    const mk = (a: WireItem['a'], b: WireItem['b'], pts: Point[]): WireItem => {
      const w: WireItem = { id: uid('w'), type: 'wire', a, b, pts, routing: 'straight' };
      doc.items[w.id] = w;
      return w;
    };
    mk({ kind: 'free', x: 0, y: 0 }, { kind: 'junction', id: j.id }, [{ x: 200, y: 0 }, { x: 200, y: 100 }]);
    mk({ kind: 'junction', id: j.id }, { kind: 'free', x: 50, y: -40 }, [{ x: 50, y: 100 }]);
    mk({ kind: 'junction', id: j.id }, { kind: 'free', x: 100, y: -40 }, []);
    return j;
  }
  const at = (cs: Crossing[], x: number, y: number) => cs.some((c) => Math.hypot(c.pt.x - x, c.pt.y - y) < 0.01);
  /** Wire ends on a junction (a loop with both ends on it counts twice). */
  const endsOn = (doc: CircuitDoc, id: string) =>
    Object.values(doc.items).reduce((n, w) => (w.type !== 'wire' ? n : n + [w.a, w.b].filter((ep) => ep.kind === 'junction' && ep.id === id).length), 0);

  it('keeps its hop after the junction is unsoldered and the halves merge into one wire', () => {
    const doc = createDoc();
    const j = box(doc);
    expect(at(wireCrossings(polysOf(doc)), 50, 0)).toBe(true);
    expect(applySolder(doc, { kind: 'junction', pt: { x: 100, y: 100 }, id: j.id }, sceneData())).toBeNull();
    const wires = Object.values(doc.items).filter((i) => i.type === 'wire');
    expect(wires).toHaveLength(2);
    const polys = polysOf(doc);
    const cs = wireCrossings(polys);
    // the merged loop crosses itself at the top left; the middle branch crosses the top run
    expect(at(cs, 50, 0)).toBe(true);
    expect(at(cs, 100, 0)).toBe(true);
    const self = cs.find((c) => Math.hypot(c.pt.x - 50, c.pt.y) < 0.01)!;
    expect(self.a.wire).toBe(self.b.wire);
    expect([...computeHops(polys, 5).values()].flat().length).toBe(2);
    // the incremental finder agrees with the full sweep
    expect(wireCrossingsChanged(polys, new Set(polys.keys())).length).toBe(cs.length);
  });

  it('solders a wire to itself where it crosses its own route', () => {
    const doc = createDoc();
    const j = box(doc);
    applySolder(doc, { kind: 'junction', pt: { x: 100, y: 100 }, id: j.id }, sceneData());
    const data = sceneData(wireCrossings(polysOf(doc)));
    expect(applySolder(doc, { kind: 'crossing', pt: { x: 50, y: 0 } }, data)).toBeNull();
    const jn = Object.values(doc.items).find((i): i is JunctionItem => i.type === 'junction' && i.x === 50 && i.y === 0);
    expect(jn).toBeDefined();
    expect(endsOn(doc, jn!.id)).toBe(4);
  });

  it('joins a loose end resting on its own route', () => {
    const doc = createDoc();
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: 0, y: 0 }, b: { kind: 'free', x: 50, y: 0 }, pts: [{ x: 100, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 50 }], routing: 'straight' };
    doc.items[w.id] = w;
    expect(computeHotSpots(doc, polysOf(doc), []).some((h) => h.kind === 'end' && h.end === 'b')).toBe(false);
    const out = joinTouches(doc);
    const jn = Object.values(out.items).find((i): i is JunctionItem => i.type === 'junction');
    expect(endsOn(out, jn!.id)).toBe(3);
    expect(computeNets(out).filter((n) => n.wires.length)).toHaveLength(1);
  });

});

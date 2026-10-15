import { describe, expect, it } from 'vitest';
import { createDoc, drawOrder, makeComponent, makeShape, normalizeDoc, uid } from '../model/doc';
import { clampTitleOffset, labelLayout, shapeTitle } from '../canvas/Scene';
import { getSymbol } from '../model/registry';
import { clipPolylineToRect, simplify } from '../model/geometry';
import { cleanup, deleteItems, deleteWirePart, extractFragment, groupItems, insertFragment, reorderItem, rotateItems, solderPinToWire, translateDetached, translateItems, solderTouch, solderWires, splitWire, ungroupItems, unsolderJunction, unsolderPort } from '../model/ops';
import { computeHotSpots } from '../model/hotspots';
import { computeNets } from '../model/netlist';
import type { CircuitDoc, JunctionItem, WireItem } from '../model/types';
import { buildWirePath, computeHops, endpointInfo, crossingStack, hopLayerMap, moveWireNode, orthogonalize, restack, wireCrossings, wirePolyline } from '../model/wires';

function freeWire(doc: CircuitDoc, ax: number, ay: number, bx: number, by: number): WireItem {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: ax, y: ay }, b: { kind: 'free', x: bx, y: by }, pts: [] };
  doc.items[w.id] = w;
  return w;
}

const idWire = (id: string, hopLayer: number) => ({ type: 'wire', id, hopLayer });

describe('wire geometry', () => {
  it('inserts orthogonal elbows', () => {
    expect(orthogonalize([{ x: 0, y: 0 }, { x: 50, y: 30 }])).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }]);
  });

  it('draws a hop where a horizontal wire crosses a vertical one', () => {
    const polys = new Map([
      ['h', [{ x: 0, y: 50 }, { x: 100, y: 50 }]],
      ['v', [{ x: 50, y: 0 }, { x: 50, y: 100 }]],
    ]);
    const hops = computeHops(polys, 5);
    expect(hops.get('h')).toEqual([{ seg: 0, d: 50 }]);
    expect(hops.get('v')).toBeUndefined();
    expect(buildWirePath(polys.get('h')!, 0, hops.get('h'), 'arc', 5)).toContain('A5,5');
  });

  it('does not hop at T connections', () => {
    const polys = new Map([
      ['h', [{ x: 0, y: 50 }, { x: 100, y: 50 }]],
      ['v', [{ x: 50, y: 50 }, { x: 50, y: 100 }]],
    ]);
    expect(computeHops(polys, 5).size).toBe(0);
  });

  it('honours wire stacking layers', () => {
    const polys = new Map([
      ['h', [{ x: 0, y: 50 }, { x: 100, y: 50 }]],
      ['v', [{ x: 50, y: 0 }, { x: 50, y: 100 }]],
    ]);
    // vertical wire on a higher layer hops over the horizontal one
    expect(computeHops(polys, 5, hopLayerMap([idWire('v', 1)])).get('v')).toEqual([{ seg: 0, d: 50 }]);
    expect(computeHops(polys, 5, hopLayerMap([idWire('v', 1)])).get('h')).toBeUndefined();
    // horizontal wire pushed below: the vertical one must hop instead
    expect(computeHops(polys, 5, hopLayerMap([idWire('h', -1)])).get('v')).toEqual([{ seg: 0, d: 50 }]);
    // equal layers: falls back to the geometric rule (horizontal hops)
    expect(computeHops(polys, 5, hopLayerMap([idWire('h', -1), idWire('v', -1)])).get('h')).toEqual([{ seg: 0, d: 50 }]);
    // lower of two "under" wires stays flat
    expect(computeHops(polys, 5, hopLayerMap([idWire('h', -2), idWire('v', -1)])).get('v')).toEqual([{ seg: 0, d: 50 }]);
  });

  it('lists the wires stacked at a crossing, top first', () => {
    const polys = new Map([
      ['h', [{ x: 0, y: 50 }, { x: 100, y: 50 }]],
      ['v', [{ x: 50, y: 0 }, { x: 50, y: 100 }]],
    ]);
    const cr = wireCrossings(polys);
    expect(cr).toHaveLength(1);
    expect(crossingStack(cr, { x: 51, y: 49 }, 5).map((s) => s.wire)).toEqual(['h', 'v']);
    expect(crossingStack(cr, { x: 50, y: 50 }, 5, new Map([['v', 1]])).map((s) => s.wire)).toEqual(['v', 'h']);
    expect(crossingStack(cr, { x: 0, y: 0 }, 5)).toEqual([]);
  });

  it('restacks wires into the requested order with minimal layer changes', () => {
    // two "under" wires: put b on top
    const m = restack(['b', 'a'], new Map([['a', -1], ['b', -1]]));
    expect(m.get('b')).toBe(-1);
    expect(m.get('a')).toBe(-2);
    // three automatic wires
    const n = restack(['c', 'a', 'b'], new Map());
    expect([n.get('c'), n.get('a'), n.get('b')]).toEqual([0, -1, -2]);
  });

  it('rounds corners when a radius is set', () => {
    const d = buildWirePath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10);
    expect(d).toContain('Q100,0');
  });
});

describe('editing wire points', () => {
  // Z-shaped wire: two fixed ends and two bends
  const z = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 50, y: 100 },
    { x: 100, y: 100 },
  ];

  it('moves a bend and slides its neighbour so segments stay orthogonal', () => {
    const out = moveWireNode(z, 1, { x: 70, y: 0 }, false);
    expect(out[1]).toEqual({ x: 70, y: 0 });
    expect(out[2]).toEqual({ x: 70, y: 100 });
  });

  it('never moves the attached wire ends', () => {
    const out = moveWireNode(z, 1, { x: 50, y: 20 }, false);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[3]).toEqual({ x: 100, y: 100 });
  });

  it('moves only the chosen point in free mode', () => {
    const out = moveWireNode(z, 1, { x: 70, y: 20 }, true);
    expect(out).toEqual([z[0], { x: 70, y: 20 }, z[2], z[3]]);
  });

  it('does not mutate the input polyline', () => {
    const copy = z.map((p) => ({ ...p }));
    moveWireNode(z, 2, { x: 10, y: 10 }, false);
    expect(z).toEqual(copy);
  });

  it('simplify removes spikes that double back on themselves', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }])).toEqual([
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
    ]);
  });
});

describe('polyline clipping', () => {
  const r = { x: 10, y: 10, w: 80, h: 80 };

  it('cuts a wire entering and leaving the rectangle', () => {
    const pieces = clipPolylineToRect([{ x: 0, y: 30 }, { x: 100, y: 30 }], r);
    expect(pieces).toEqual([[{ x: 10, y: 30 }, { x: 90, y: 30 }]]);
  });

  it('keeps wires fully inside', () => {
    const pieces = clipPolylineToRect([{ x: 20, y: 50 }, { x: 60, y: 50 }], r);
    expect(pieces).toEqual([[{ x: 20, y: 50 }, { x: 60, y: 50 }]]);
  });

  it('drops wires fully outside and keeps multiple disjoint pieces', () => {
    expect(clipPolylineToRect([{ x: 0, y: 0 }, { x: 5, y: 5 }], r)).toEqual([]);
    const zig = [
      { x: 0, y: 30 },
      { x: 50, y: 30 },
      { x: 50, y: -10 },
      { x: 80, y: -10 },
      { x: 80, y: 60 },
    ];
    const pieces = clipPolylineToRect(zig, r);
    expect(pieces.length).toBe(2);
    expect(pieces[0]).toEqual([{ x: 10, y: 30 }, { x: 50, y: 30 }, { x: 50, y: 10 }]);
    expect(pieces[1]).toEqual([{ x: 80, y: 10 }, { x: 80, y: 60 }]);
  });
});

describe('junctions', () => {
  it('splits a wire into two at a junction and merges back on delete', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    const jid = splitWire(doc, w.id, 0, { x: 40, y: 0 });
    expect(Object.values(doc.items).filter((i) => i.type === 'wire')).toHaveLength(2);
    const branch = freeWire(doc, 40, 0, 40, 60);
    branch.a = { kind: 'junction', id: jid };
    cleanup(doc);
    expect(Object.values(doc.items).filter((i) => i.type === 'junction')).toHaveLength(1);
    deleteItems(doc, [branch.id]);
    const wires = Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire');
    expect(wires).toHaveLength(1);
    expect(Object.values(doc.items).filter((i) => i.type === 'junction')).toHaveLength(0);
    expect(wirePolyline(doc, wires[0])).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  });
});

describe('components & nets', () => {
  it('connects pins through wires and keeps wires attached when rotating', () => {
    const doc = createDoc();
    const r1 = makeComponent(doc, 'resistor', 100, 100);
    doc.items[r1.id] = r1;
    const r2 = makeComponent(doc, 'resistor', 300, 100);
    doc.items[r2.id] = r2;
    expect(r2.ref).toBe('R2');
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: r1.id, port: '2' }, b: { kind: 'port', comp: r2.id, port: '1' }, pts: [] };
    doc.items[w.id] = w;
    const nets = computeNets(doc).filter((n) => n.pins.length === 2);
    expect(nets).toHaveLength(1);
    rotateItems(doc, new Set([r1.id]), 90);
    expect((doc.items[r1.id] as { rot: number }).rot).toBe(90);
    const poly = wirePolyline(doc, doc.items[w.id] as WireItem);
    expect(poly[0]).toEqual({ x: 100, y: 140 });
    expect(poly[poly.length - 1]).toEqual({ x: 260, y: 100 });
  });

  it('groups, ungroups and copies with fresh ids and references', () => {
    const doc = createDoc();
    const a = makeComponent(doc, 'capacitor', 0, 0);
    doc.items[a.id] = a;
    const b = makeComponent(doc, 'capacitor', 100, 0);
    doc.items[b.id] = b;
    const g = groupItems(doc, [a.id, b.id]);
    expect(g).toBeTruthy();
    expect(doc.items[a.id].group).toBe(g);
    const frag = extractFragment(doc, new Set([a.id, b.id]));
    const ids = insertFragment(doc, frag, 20, 20);
    expect(ids).toHaveLength(2);
    expect(Object.keys(doc.groups)).toHaveLength(2);
    const refs = Object.values(doc.items).map((i) => (i.type === 'component' ? i.ref : ''));
    expect(new Set(refs).size).toBe(4);
    ungroupItems(doc, [a.id]);
    expect(doc.items[a.id].group).toBeUndefined();
  });
});

describe('soldering and net names', () => {
  it('solders two crossing wires into one net with a shared junction', () => {
    const doc = createDoc();
    const h = freeWire(doc, 0, 50, 100, 50);
    const v = freeWire(doc, 50, 0, 50, 100);
    expect(computeNets(doc)).toHaveLength(2);
    const jid = solderWires(doc, [h.id, v.id], { x: 50, y: 50 });
    expect(jid).toBeTruthy();
    cleanup(doc);
    expect(doc.items[jid!]).toBeTruthy();
    const wires = Object.values(doc.items).filter((i) => i.type === 'wire');
    expect(wires).toHaveLength(4);
    expect(computeNets(doc)).toHaveLength(1);
  });

  it('refuses to solder where the wires do not pass', () => {
    const doc = createDoc();
    const h = freeWire(doc, 0, 50, 100, 50);
    const v = freeWire(doc, 50, 0, 50, 100);
    expect(solderWires(doc, [h.id, v.id], { x: 10, y: 10 })).toBeNull();
  });

  it('names every unnamed net net1, net2… by age', () => {
    const doc = createDoc();
    const a = freeWire(doc, 0, 0, 100, 0);
    const b = freeWire(doc, 0, 50, 100, 50);
    const nets = computeNets(doc);
    expect(nets.find((n) => n.wires.includes(a.id))!.name).toBe('net1');
    expect(nets.find((n) => n.wires.includes(b.id))!.name).toBe('net2');
    // a newer net never renumbers the older ones
    freeWire(doc, 0, 90, 100, 90);
    expect(computeNets(doc).find((n) => n.wires.includes(a.id))!.name).toBe('net1');
  });

  it('upgrades the old hopOver flag to a stacking layer', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0) as WireItem & { hopOver?: boolean };
    w.hopOver = false;
    const loaded = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    const lw = loaded.items[w.id] as WireItem & { hopOver?: boolean };
    expect(lw.hopLayer).toBe(-1);
    expect(lw.hopOver).toBeUndefined();
  });
});

describe('closed loops (rectangles)', () => {
  const junction = (doc: CircuitDoc, x: number, y: number) => {
    const id = uid('j');
    doc.items[id] = { id, type: 'junction', x, y };
    return id;
  };
  const link = (doc: CircuitDoc, a: string, b: string, pts: { x: number; y: number }[] = []) => {
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'junction', id: a }, b: { kind: 'junction', id: b }, pts };
    doc.items[w.id] = w;
    return w;
  };

  it('four wires joined corner to corner become one closed wire without losing any side', () => {
    const doc = createDoc();
    const [tl, tr, br, bl] = [junction(doc, 0, 0), junction(doc, 100, 0), junction(doc, 100, 100), junction(doc, 0, 100)];
    link(doc, tl, tr);
    link(doc, tr, br);
    link(doc, br, bl);
    link(doc, bl, tl);
    cleanup(doc);
    const wires = Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire');
    expect(wires).toHaveLength(1);
    const poly = wirePolyline(doc, wires[0]);
    // every corner of the rectangle is still on the wire
    for (const c of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]) expect(poly).toContainEqual(c);
  });

  it('keeps a loop that closes on a junction which also has a branch', () => {
    const doc = createDoc();
    const j = junction(doc, 0, 0);
    const loop = link(doc, j, j, [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
    const stub: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'junction', id: j }, b: { kind: 'free', x: -50, y: 0 }, pts: [] };
    doc.items[stub.id] = stub;
    cleanup(doc);
    // previously the loop and the stub were "merged" and the loop vanished
    expect(doc.items[loop.id]).toBeTruthy();
    expect(doc.items[stub.id]).toBeTruthy();
    expect(doc.items[j]).toBeTruthy();
    expect(wirePolyline(doc, doc.items[loop.id] as WireItem)).toHaveLength(5);
  });
});

describe('solder / unsolder cycle', () => {
  it('unsolders a 4-way junction back into two crossing wires and solders again', () => {
    const doc = createDoc();
    const h = freeWire(doc, 0, 50, 100, 50);
    const v = freeWire(doc, 50, 0, 50, 100);
    const jid = solderWires(doc, [h.id, v.id], { x: 50, y: 50 })!;
    cleanup(doc);
    expect(computeNets(doc)).toHaveLength(1);
    expect(unsolderJunction(doc, jid)).toEqual({ through: 2, detached: 0 });
    const wires = Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire');
    expect(wires).toHaveLength(2);
    expect(Object.values(doc.items).some((i) => i.type === 'junction')).toBe(false);
    expect(computeNets(doc)).toHaveLength(2);
    // and back again
    expect(solderWires(doc, wires.map((w) => w.id), { x: 50, y: 50 })).toBeTruthy();
  });

  it('a wire ending on another wire is a touch that can be soldered, then unsoldered back to a touch', () => {
    const doc = createDoc();
    const top = freeWire(doc, 0, 0, 200, 0);
    const branch = freeWire(doc, 50, 0, 50, 100);
    const touch = () => computeHotSpots(doc, new Map(Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire').map((w) => [w.id, wirePolyline(doc, w)])), []).find((h) => h.kind === 'touch');
    const t = touch();
    expect(t).toBeTruthy();
    expect(t!.kind === 'touch' && t!.target.kind).toBe('wire');
    if (t?.kind !== 'touch') return;
    expect(solderTouch(doc, t.wire, t.end, t.target)).toBe(true);
    cleanup(doc);
    expect(computeNets(doc)).toHaveLength(1);
    const j = Object.values(doc.items).find((i) => i.type === 'junction')!;
    expect(unsolderJunction(doc, j.id)).toEqual({ through: 1, detached: 1 });
    expect(computeNets(doc)).toHaveLength(2);
    expect(touch()).toBeTruthy();
    void top;
    void branch;
  });

  it('a loose end resting on hidden wires or junctions stays a plain end', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    const hj: JunctionItem = { id: 'hj', type: 'junction', x: 100, y: 0, hidden: true };
    doc.items[hj.id] = hj;
    const hw = freeWire(doc, 100, 0, 200, 0);
    hw.hidden = true;
    const spots = computeHotSpots(doc, new Map(Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire').map((x) => [x.id, wirePolyline(doc, x)])), []);
    expect(spots.some((h) => h.kind === 'touch')).toBe(false);
    expect(spots.some((h) => h.kind === 'end' && h.wire === w.id && h.end === 'b')).toBe(true);
  });
});

describe('pins on wires', () => {
  it('solders a pin that lies on a wire, then unsolders it back', () => {
    const doc = createDoc();
    const c = makeComponent(doc, 'resistor', 100, 100);
    doc.items[c.id] = c;
    const def = c.symbol;
    void def;
    const pin = endpointInfo(doc, { kind: 'port', comp: c.id, port: '1' })!.pt;
    // a vertical wire running straight through pin 1
    const w = freeWire(doc, pin.x, pin.y - 100, pin.x, pin.y + 100);
    const spots = () => computeHotSpots(doc, new Map([...Object.values(doc.items)].filter((i): i is WireItem => i.type === 'wire').map((x) => [x.id, wirePolyline(doc, x)])), []);
    expect(spots().some((h) => h.kind === 'pinTouch')).toBe(true);
    expect(solderPinToWire(doc, c.id, '1', w.id)).toBe(true);
    cleanup(doc);
    const attached = Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire' && [i.a, i.b].some((ep) => ep.kind === 'port' && ep.comp === c.id && ep.port === '1'));
    expect(attached).toHaveLength(2);
    expect(spots().some((h) => h.kind === 'pin')).toBe(true);
    // unsolder: the two halves run straight through, so they rejoin into one wire over the pin
    expect(unsolderPort(doc, c.id, '1')).toEqual({ through: 1, detached: 0 });
    expect(Object.values(doc.items).filter((i) => i.type === 'wire')).toHaveLength(1);
    expect(spots().some((h) => h.kind === 'pinTouch')).toBe(true);
  });
});

describe('moving parts', () => {
  const setup = () => {
    const doc = createDoc();
    const c = makeComponent(doc, 'resistor', 100, 100);
    doc.items[c.id] = c;
    const pin = endpointInfo(doc, { kind: 'port', comp: c.id, port: '1' })!.pt;
    const wired: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: c.id, port: '1' }, b: { kind: 'free', x: pin.x - 100, y: pin.y }, pts: [] };
    doc.items[wired.id] = wired;
    return { doc, c, pin, wired };
  };

  it('normal move drags connected wires along', () => {
    const { doc, c, wired } = setup();
    const base = structuredClone(doc);
    translateItems(base, doc, new Set([c.id]), 0, 50);
    const w = doc.items[wired.id] as WireItem;
    expect(w.a.kind).toBe('port');
    expect(wirePolyline(doc, w)[0]).toEqual(endpointInfo(doc, { kind: 'port', comp: c.id, port: '1' })!.pt);
  });

  it('normal move also drags loose ends that rest on a moving pin', () => {
    const { doc, c, pin, wired } = setup();
    (doc.items[wired.id] as WireItem).a = { kind: 'free', x: pin.x, y: pin.y };
    const base = structuredClone(doc);
    translateItems(base, doc, new Set([c.id]), 0, 50);
    expect(wirePolyline(doc, doc.items[wired.id] as WireItem)[0]).toEqual({ x: pin.x, y: pin.y + 50 });
  });

  it('alt move leaves the wire behind with a loose end', () => {
    const { doc, c, pin, wired } = setup();
    const base = structuredClone(doc);
    translateDetached(base, doc, new Set([c.id]), 0, 50);
    const w = doc.items[wired.id] as WireItem;
    expect(w.a).toEqual({ kind: 'free', x: pin.x, y: pin.y });
    expect((doc.items[c.id] as typeof c).y).toBe(150);
  });
});

describe('zone titles', () => {
  it('can sit anywhere inside, or just outside near the edge, but no further', () => {
    const doc = createDoc();
    const z = { ...makeShape(doc, 'zone', 0, 0, 200, 100), text: 'Power' };
    // inside: unchanged
    expect(clampTitleOffset(z, 60, 40)).toEqual({ dx: 60, dy: 40 });
    // far away: pulled back to within the edge margin
    const far = clampTitleOffset(z, 2000, -2000);
    const t = shapeTitle({ ...z, textDx: far.dx, textDy: far.dy }).box;
    expect(t.x + t.w / 2).toBeLessThanOrEqual(200 + 26.01);
    expect(t.y + t.h / 2).toBeGreaterThanOrEqual(-26.01);
    // just outside the top edge is allowed
    const above = clampTitleOffset(z, 0, -30);
    expect(above.dy).toBe(-30);
  });
});

describe('layer order', () => {
  it('moves an item before / after another in the front-first list', () => {
    const doc = createDoc();
    const a = freeWire(doc, 0, 0, 10, 0);
    const b = freeWire(doc, 0, 10, 10, 10);
    const c = freeWire(doc, 0, 20, 10, 20);
    const list = () => {
      const o = drawOrder(doc);
      return [a.id, b.id, c.id].sort((x, y) => o.get(y)! - o.get(x)!);
    };
    // default: newest in front
    expect(list()).toEqual([c.id, b.id, a.id]);
    expect(reorderItem(doc, a.id, c.id, 'before')).toBe(true);
    expect(list()).toEqual([a.id, c.id, b.id]);
    expect(reorderItem(doc, a.id, b.id, 'after')).toBe(true);
    expect(list()).toEqual([c.id, b.id, a.id]);
    expect(reorderItem(doc, a.id, a.id, 'after')).toBe(false);
  });

  it('keeps parts and wires in one shared order', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    const r = makeComponent(doc, 'resistor', 50, 0);
    doc.items[r.id] = r;
    const z = makeShape(doc, 'zone', 0, 0, 200, 100);
    doc.items[z.id] = z;
    const front = () => {
      const o = drawOrder(doc);
      return [w.id, r.id, z.id].sort((x, y) => o.get(y)! - o.get(x)!);
    };
    // the wire goes over the part, not just within the wires
    expect(reorderItem(doc, w.id, r.id, 'before')).toBe(true);
    expect(front().indexOf(w.id)).toBeLessThan(front().indexOf(r.id));
    expect(reorderItem(doc, w.id, r.id, 'after')).toBe(true);
    expect(front().indexOf(w.id)).toBeGreaterThan(front().indexOf(r.id));
    // anything added after a reorder lands on top, even once items are deleted
    delete doc.items[z.id];
    const w2 = freeWire(doc, 0, 50, 100, 50);
    expect(drawOrder(doc).get(w2.id)).toBe(Math.max(...drawOrder(doc).values()));
  });
});

describe('part labels', () => {
  it('moves the reference and value labels independently', () => {
    const doc = createDoc();
    const c = makeComponent(doc, 'resistor', 100, 100);
    const def = getSymbol(doc, c.symbol);
    const base = labelLayout(c, def);
    // old files: one offset moves both
    const both = labelLayout({ ...c, labelDx: 10, labelDy: 5 }, def);
    expect(both.ref!.x - base.ref!.x).toBe(10);
    expect(both.value!.x - base.value!.x).toBe(10);
    // the value moved on its own stays put when the reference moves
    const split = labelLayout({ ...c, labelDx: 10, labelDy: 5, valueDx: -20, valueDy: 0 }, def);
    expect(split.ref!.x - base.ref!.x).toBe(10);
    expect(split.value!.x - base.value!.x).toBe(-20);
    expect(split.value!.y).toBe(base.value!.y);
  });
});

describe('delete a wire node or segment', () => {
  /** A wire whose full polyline is exactly the given points. */
  function bentWire(doc: CircuitDoc, full: [number, number][]) {
    const w = freeWire(doc, full[0][0], full[0][1], full[full.length - 1][0], full[full.length - 1][1]);
    w.pts = full.slice(1, -1).map(([x, y]) => ({ x, y }));
    return w;
  }
  const wires = (doc: CircuitDoc) => Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire');
  const poly = (doc: CircuitDoc, id: string) => wirePolyline(doc, doc.items[id] as WireItem);

  it('splits the wire when a middle segment is removed, leaving a gap', () => {
    const doc = createDoc();
    const w = bentWire(doc, [[0, 0], [100, 0], [100, 100], [200, 100]]);
    deleteWirePart(doc, { wire: w.id, kind: 'segment', index: 1 });
    const ws = wires(doc);
    expect(ws.length).toBe(2);
    const first = poly(doc, w.id); // keeps the original id
    const second = poly(doc, ws.find((x) => x.id !== w.id)!.id);
    expect(first).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(second).toEqual([{ x: 100, y: 100 }, { x: 200, y: 100 }]);
    // both inner ends are loose now
    expect((doc.items[w.id] as WireItem).b.kind).toBe('free');
  });

  it('shortens the wire when an end segment is removed', () => {
    const doc = createDoc();
    const w = bentWire(doc, [[0, 0], [100, 0], [100, 100], [200, 100]]);
    deleteWirePart(doc, { wire: w.id, kind: 'segment', index: 0 });
    expect(wires(doc).length).toBe(1);
    expect(poly(doc, w.id)).toEqual([{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }]);
    expect((doc.items[w.id] as WireItem).a).toEqual({ kind: 'free', x: 100, y: 0 });

    const doc2 = createDoc();
    const w2 = bentWire(doc2, [[0, 0], [100, 0], [100, 100], [200, 100]]);
    deleteWirePart(doc2, { wire: w2.id, kind: 'segment', index: 2 });
    expect(poly(doc2, w2.id)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
  });

  it('deletes the whole wire when it has a single segment', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    deleteWirePart(doc, { wire: w.id, kind: 'segment', index: 0 });
    expect(wires(doc).length).toBe(0);
  });

  it('removes an end node by removing its end segment', () => {
    const doc = createDoc();
    const w = bentWire(doc, [[0, 0], [100, 0], [100, 100], [200, 100]]);
    deleteWirePart(doc, { wire: w.id, kind: 'node', index: 0 });
    expect(poly(doc, w.id)).toEqual([{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }]);
  });

  it('removes an interior bend and keeps the route orthogonal', () => {
    const doc = createDoc();
    const w = bentWire(doc, [[0, 0], [100, 0], [100, 100], [200, 100]]);
    deleteWirePart(doc, { wire: w.id, kind: 'node', index: 2 });
    expect(poly(doc, w.id)).toEqual([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }]);
    expect(wires(doc).length).toBe(1);
  });

  it('removes a bend directly on a straight-routed wire (diagonal allowed)', () => {
    const doc = createDoc();
    const w = bentWire(doc, [[0, 0], [100, 0], [100, 100], [200, 100]]);
    w.routing = 'straight';
    deleteWirePart(doc, { wire: w.id, kind: 'node', index: 2 });
    expect(poly(doc, w.id)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 100 }]);
  });
});

import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent } from '../model/doc';
import { computeNets } from '../model/netlist';
import { cleanup, deleteItems, rotateItems, splitWire } from '../model/ops';
import { resolveWireOverlaps } from '../model/overlap';
import { settleEdit } from '../model/settle';
import { compileSource } from '../model/symbols/dsl';
import type { CircuitDoc, Endpoint, Item, WireItem } from '../model/types';
import { moveWireSegment, reconnectWireEnd } from '../model/wireCommit';
import { computeHops, wirePolyline } from '../model/wires';

const F = (x: number, y: number): Endpoint => ({ kind: 'free', x, y });
const J = (id: string): Endpoint => ({ kind: 'junction', id });
const P = (comp: string, port: string): Endpoint => ({ kind: 'port', comp, port });
const wire = (id: string, a: Endpoint, b: Endpoint, extra: Partial<WireItem> = {}): WireItem => ({ id, type: 'wire', a, b, pts: [], ...extra });

function docWith(items: Item[]): CircuitDoc {
  const d = createDoc();
  for (const it of items) d.items[it.id] = it;
  return d;
}
const wires = (d: CircuitDoc) => Object.values(d.items).filter((i): i is WireItem => i.type === 'wire');
const junctions = (d: CircuitDoc) => Object.values(d.items).filter((i) => i.type === 'junction');
const netWith = (d: CircuitDoc, comp: string, port: string) =>
  computeNets(d).find((n) => n.pins.some((p) => p.comp === comp && p.port === port));

describe('merging wires at a junction', () => {
  it('keeps both wire names, so a net joined by the second name stays joined', () => {
    const d = createDoc();
    const r1 = makeComponent(d, 'resistor', 40, 100);
    d.items[r1.id] = r1;
    const r2 = makeComponent(d, 'resistor', 500, 100);
    d.items[r2.id] = r2;
    const p1 = P(r1.id, '1');
    const p2 = P(r2.id, '1');
    d.items.j = { id: 'j', type: 'junction', x: 100, y: 100 };
    d.items.w1 = wire('w1', p1, J('j'), { label: 'A' });
    d.items.w2 = wire('w2', J('j'), F(200, 100), { label: 'B' });
    d.items.w3 = wire('w3', F(100, 40), J('j'));
    d.items.w4 = wire('w4', F(400, 100), p2, { label: 'B' });
    expect(netWith(d, r1.id, '1')!.pins.map((p) => p.ref)).toEqual(['R1', 'R2']);

    deleteItems(d, ['w3']);

    // deleting an unrelated stub used to merge w1 and w2, dropping the name B
    const net = netWith(d, r1.id, '1')!;
    expect(net.pins.map((p) => p.ref)).toEqual(['R1', 'R2']);
    expect(net.names).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('does not merge a locked, styled or separately grouped wire into a plain one', () => {
    const d = docWith([
      { id: 'j', type: 'junction', x: 100, y: 0 },
      wire('w1', F(0, 0), J('j')),
      wire('w2', J('j'), F(200, 0), { locked: true, style: { color: '#ff0000' }, hopLayer: 3 }),
      wire('w3', J('j'), F(100, 100)),
    ]);
    deleteItems(d, ['w3']);
    expect(d.items.j).toBeTruthy();
    expect((d.items.w2 as WireItem).locked).toBe(true);
    expect((d.items.w2 as WireItem).style?.color).toBe('#ff0000');
    expect((d.items.w2 as WireItem).hopLayer).toBe(3);
    expect(d.items.w1).toBeTruthy();
  });
});

describe('two solder dots on one spot', () => {
  it('fuse into one connection instead of leaving a lose end under a dot', () => {
    const base = docWith([
      { id: 'j1', type: 'junction', x: 100, y: 100 },
      { id: 'j2', type: 'junction', x: 100, y: 140 },
      wire('wA', F(0, 100), J('j1')),
      wire('wB', J('j1'), F(200, 100)),
      wire('wC', J('j1'), F(100, 0)),
      wire('x1', F(0, 140), J('j2')),
      wire('x2', J('j2'), F(200, 140)),
      wire('x3', J('j2'), F(100, 300)),
    ]);
    const next = produce(base, (d) => {
      moveWireSegment(d as CircuitDoc, 'wA', wirePolyline(base, base.items.wA as WireItem), 0, 0, 40, base);
      cleanup(d as CircuitDoc);
    });
    expect(junctions(next)).toHaveLength(1);
    const keep = junctions(next)[0].id;
    const wc = next.items.wC as WireItem;
    expect(wc.a.kind === 'junction' && wc.a.id === keep).toBe(true);
    expect(wc.b.kind === 'free' && wc.b.x === 100 && wc.b.y === 0).toBe(true);
    // every wire that met either dot is one net again
    const nets = computeNets(next);
    const withC = nets.find((n) => n.wires.includes('wC'))!;
    expect(withC.wires).toEqual(expect.arrayContaining(['wA', 'wB', 'x1', 'x2', 'x3']));
  });
});

describe('a pin on a solder dot', () => {
  it('connects the part dropped with a pin on the dot and removes the short across it', () => {
    const prev = docWith([
      { id: 'j', type: 'junction', x: 100, y: 100 },
      wire('wA', F(0, 100), J('j')),
      wire('wB', J('j'), F(200, 100)),
      wire('wC', J('j'), F(100, 0)),
    ]);
    const r = makeComponent(prev, 'resistor', 140, 100); // pins at 100 and 180
    const next = produce(prev, (d) => void (d.items[r.id] = r));
    const out = settleEdit(prev, next);

    expect(out.items.j).toBeUndefined();
    expect(wires(out).some((w) => w.a.kind === 'port' && w.a.comp === r.id && w.a.port === '1')).toBe(true);
    const one = netWith(out, r.id, '1')!;
    expect(one.wires).toEqual(expect.arrayContaining(['wA', 'wC']));
    const two = netWith(out, r.id, '2')!;
    expect(two.wires.length).toBeGreaterThan(0);
    // the piece that ran from the dot (pin 1) to pin 2 is not there to short it
    expect(wires(out).filter((w) => w.a.kind === 'port' && w.b.kind === 'port' && w.a.comp === r.id && w.b.comp === r.id)).toEqual([]);
    expect(wires(out).some((w) => w.a.kind === 'free' && w.a.x === 100 && w.a.y === 100)).toBe(false);
  });

  it('connects a dot dragged exactly onto a pin', () => {
    const base = createDoc();
    const r = makeComponent(base, 'resistor', 140, 100); // pins at 100 and 180
    base.items[r.id] = r;
    base.items.j = { id: 'j', type: 'junction', x: 100, y: 140 };
    base.items.wA = wire('wA', F(0, 140), J('j'));
    base.items.wB = wire('wB', J('j'), F(200, 140));
    base.items.wC = wire('wC', J('j'), F(100, 60));
    const next = produce(base, (d) => {
      moveWireSegment(d as CircuitDoc, 'wA', wirePolyline(base, base.items.wA as WireItem), 0, 0, -40, base);
      cleanup(d as CircuitDoc);
    });
    expect(next.items.j).toBeUndefined();
    expect(wires(next).some((w) => (w.a.kind === 'port' && w.a.comp === r.id && w.a.port === '1') || (w.b.kind === 'port' && w.b.comp === r.id && w.b.port === '1'))).toBe(true);
    expect(wires(next).some((w) => w.a.kind === 'free' && w.a.x === 100 && w.a.y === 100)).toBe(false);
  });
});

describe('locked things stay where they are', () => {
  it('dragging a segment at a locked junction leaves the dot and its locked wire alone', () => {
    const base = docWith([
      { id: 'j', type: 'junction', x: 100, y: 100, locked: true },
      wire('wA', F(0, 100), J('j')),
      wire('wB', J('j'), F(200, 100), { locked: true }),
      wire('wC', J('j'), F(100, 0)),
    ]);
    const before = wirePolyline(base, base.items.wB as WireItem);
    const next = produce(base, (d) => void moveWireSegment(d as CircuitDoc, 'wA', wirePolyline(base, base.items.wA as WireItem), 0, 0, 40, base));
    expect(next.items.j).toMatchObject({ x: 100, y: 100 });
    expect(wirePolyline(next, next.items.wB as WireItem)).toEqual(before);
  });

  it('does not cut a locked wire when another wire is laid along it', () => {
    const base = docWith([wire('L', F(0, 0), F(200, 0), { locked: true })]);
    const next = produce(base, (d) => void (d.items.N = wire('N', F(50, 0), F(150, 0))));
    const out = resolveWireOverlaps(base, next);
    expect(out.items.L).toBeTruthy();
    expect(junctions(out)).toHaveLength(0);
    expect(wires(out)).toHaveLength(2);
  });
});

describe('turning parts', () => {
  it('turns the label side of a wire carried rigidly between two turned parts', () => {
    const d = createDoc();
    const r1 = makeComponent(d, 'resistor', 100, 100); // pins at 60 and 140
    const r2 = makeComponent(d, 'resistor', 300, 100); // pins at 260 and 340
    d.items[r1.id] = r1;
    d.items[r2.id] = r2;
    d.items.w = wire('w', P(r1.id, '2'), P(r2.id, '1'), { label: 'SIG', labelSide: 'above' });
    rotateItems(d, new Set([r1.id, r2.id]), 90);
    expect((d.items.w as WireItem).labelSide).toBe('right');
  });
});

describe('smaller wire fixes', () => {
  it('keeps a label on the half of a split wire where it was drawn', () => {
    const d = docWith([wire('w', F(0, 0), F(100, 0), { label: 'N', labelAt: 0.9 })]);
    splitWire(d, 'w', 0, { x: 50, y: 0 });
    const labelled = wires(d).filter((w) => w.label === 'N');
    expect(labelled).toHaveLength(1);
    const w = labelled[0];
    expect(w.id).not.toBe('w');
    expect(w.labelAt).toBeCloseTo(0.8, 6);
  });

  it('refuses to reconnect a wire end onto the same wire', () => {
    const d = docWith([wire('w', F(0, 0), F(100, 0))]);
    const ok = reconnectWireEnd(d, 'w', 'a', { kind: 'wireEnd', wire: 'w', end: 'b', pt: { x: 100, y: 0 } });
    expect(ok).toBe(false);
    expect(d.items.w).toBeTruthy();
  });

  it('lets the other wire hop when the preferred one has no room near its end', () => {
    const polys = new Map([
      ['H', [{ x: 0, y: 0 }, { x: 100, y: 0 }]],
      ['V', [{ x: 97, y: -50 }, { x: 97, y: 50 }]],
    ]);
    const hops = computeHops(polys, 5);
    expect(hops.get('V')).toEqual([{ seg: 0, d: 50 }]);
    expect(hops.get('H')).toBeUndefined();
  });

  it('connects two stacked pins of one part', () => {
    const d = createDoc();
    const def = compileSource({
      id: 'stacked',
      name: 'Stacked pins',
      category: 'My symbols',
      w: 40,
      h: 20,
      draw: 'L 0 10 40 10',
      ports: '1:20,10 2:20,10',
      prefix: 'U',
      value: '',
      fields: '',
      keywords: '',
    });
    d.symbols[def.id] = def;
    const c = makeComponent(d, 'stacked', 100, 100);
    d.items[c.id] = c;
    const nets = computeNets(d);
    const withPins = nets.filter((n) => n.pins.some((p) => p.comp === c.id));
    expect(withPins).toHaveLength(1);
    expect(withPins[0].pins.map((p) => p.port).sort()).toEqual(['1', '2']);
  });
});

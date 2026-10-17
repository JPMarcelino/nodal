import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import type { CircuitDoc, WireItem } from '../model/types';
import { endpointInfo, wirePolyline } from '../model/wires';
import {
  buildWirePreview,
  commitWire,
  moveWireSegment,
  reconnectWireEnd,
  resolveWireEndpoint,
  sameWireTarget,
  wireTargetForEndpoint,
  type WireTarget,
} from '../model/wireCommit';

function twoResistors() {
  const doc = createDoc();
  const c1 = makeComponent(doc, 'resistor', 100, 100);
  doc.items[c1.id] = c1;
  const c2 = makeComponent(doc, 'resistor', 300, 100);
  doc.items[c2.id] = c2;
  return { doc, c1, c2 };
}

function portTarget(doc: CircuitDoc, comp: string, port: string): WireTarget {
  const info = endpointInfo(doc, { kind: 'port', comp, port })!;
  return { kind: 'port', comp, port, pt: { ...info.pt }, dir: { ...info.dir } };
}

const grid = (x: number, y: number): WireTarget => ({ kind: 'grid', pt: { x, y } });

function freeWire(doc: CircuitDoc, ax: number, ay: number, bx: number, by: number): WireItem {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: ax, y: ay }, b: { kind: 'free', x: bx, y: by }, pts: [] };
  doc.items[w.id] = w;
  return w;
}

describe('buildWirePreview', () => {
  it('keeps straight runs straight and adds one elbow for diagonal ends', () => {
    expect(buildWirePreview({ x: 0, y: 0 }, [], true, { x: 100, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    // hFirst: horizontal leg first
    expect(buildWirePreview({ x: 0, y: 0 }, [], true, { x: 100, y: 50 })).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
    ]);
    // !hFirst: vertical leg first
    expect(buildWirePreview({ x: 0, y: 0 }, [], false, { x: 100, y: 50 })).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ]);
  });

  it('takes the other elbow when the first would run back over the drawn leg', () => {
    expect(buildWirePreview({ x: 0, y: 0 }, [{ x: 100, y: 0 }], true, { x: 50, y: 50 })).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 50 },
    ]);
  });
});

describe('commitWire', () => {
  it('commits a grid-to-grid wire with free ends', () => {
    const doc = createDoc();
    const id = commitWire(doc, grid(0, 0), grid(100, 50));
    expect(id).toBeTruthy();
    const w = doc.items[id!] as WireItem;
    expect(w.a).toEqual({ kind: 'free', x: 0, y: 0 });
    expect(w.b).toEqual({ kind: 'free', x: 100, y: 50 });
    expect(wirePolyline(doc, w)).toEqual(buildWirePreview({ x: 0, y: 0 }, [], true, { x: 100, y: 50 }));
  });

  it('commits a port-to-port wire that stays connected', () => {
    const { doc, c1, c2 } = twoResistors();
    const id = commitWire(doc, portTarget(doc, c1.id, '2'), portTarget(doc, c2.id, '1'));
    expect(id).toBeTruthy();
    const w = doc.items[id!] as WireItem;
    expect(w.a).toEqual({ kind: 'port', comp: c1.id, port: '2' });
    expect(w.b).toEqual({ kind: 'port', comp: c2.id, port: '1' });
    expect(wirePolyline(doc, w).length).toBeGreaterThanOrEqual(2);
  });

  it('commits a port-to-grid wire with one dangling end', () => {
    const { doc, c1 } = twoResistors();
    const id = commitWire(doc, portTarget(doc, c1.id, '2'), grid(400, 400));
    expect(id).toBeTruthy();
    const w = doc.items[id!] as WireItem;
    expect(w.a).toEqual({ kind: 'port', comp: c1.id, port: '2' });
    expect(w.b).toEqual({ kind: 'free', x: 400, y: 400 });
  });

  it('rejects a zero-length wire', () => {
    const doc = createDoc();
    expect(commitWire(doc, grid(10, 10), grid(10, 10))).toBeNull();
    expect(Object.values(doc.items)).toHaveLength(0);
  });

  it('rejects same port to same port without a loop, but allows a loop', () => {
    const { doc, c1 } = twoResistors();
    const p = portTarget(doc, c1.id, '2');
    // one collinear via point: preview is [p, v, p], too short for a loop
    const stub = { x: p.pt.x + 60, y: p.pt.y };
    expect(commitWire(doc, p, { ...p }, { via: [stub] })).toBeNull();
    // out and back with elbows: a real loop is kept
    const loop = commitWire(
      doc,
      p,
      { ...p },
      { via: [{ x: p.pt.x + 60, y: p.pt.y }, { x: p.pt.x + 60, y: p.pt.y + 60 }] },
    );
    expect(loop).toBeTruthy();
    const w = doc.items[loop!] as WireItem;
    expect(wirePolyline(doc, w).length).toBeGreaterThanOrEqual(4);
  });
});

describe('resolveWireEndpoint', () => {
  it('resolves port, junction and grid targets directly', () => {
    const { doc, c1 } = twoResistors();
    expect(resolveWireEndpoint(doc, portTarget(doc, c1.id, '1'))).toEqual({ kind: 'port', comp: c1.id, port: '1' });
    const jid = uid('j');
    doc.items[jid] = { id: jid, type: 'junction', x: 5, y: 5 };
    expect(resolveWireEndpoint(doc, { kind: 'junction', id: jid, pt: { x: 5, y: 5 } })).toEqual({ kind: 'junction', id: jid });
    expect(resolveWireEndpoint(doc, grid(7, 8))).toEqual({ kind: 'free', x: 7, y: 8 });
  });

  it('splits a wire in the middle and joins both halves at a junction', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    const ep = resolveWireEndpoint(doc, { kind: 'wire', wire: w.id, seg: 0, pt: { x: 40, y: 0 } });
    expect(ep.kind).toBe('junction');
    const wires = Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire');
    expect(wires).toHaveLength(2);
    for (const x of wires) {
      const ends = [x.a, x.b];
      expect(ends.some((e) => e.kind === 'junction' && e.id === (ep as { id: string }).id)).toBe(true);
    }
  });

  it('splits the visible wire when a hidden or locked wire also overlaps the point', () => {
    for (const flag of ['hidden', 'locked'] as const) {
      const doc = createDoc();
      const w = freeWire(doc, 0, 0, 100, 0);
      // decoy straight through the drop point (d=0); the point sits 0.4 off the visible wire
      const decoy = freeWire(doc, 40, -50, 40, 50);
      decoy[flag] = true;
      const ep = resolveWireEndpoint(doc, { kind: 'wire', wire: 'other', seg: 0, pt: { x: 40, y: 0.4 } });
      expect(ep.kind).toBe('junction');
      const jid = (ep as { id: string }).id;
      // the decoy is untouched: still one wire with free ends, joined to nothing
      expect(decoy.a).toEqual({ kind: 'free', x: 40, y: -50 });
      expect(decoy.b).toEqual({ kind: 'free', x: 40, y: 50 });
      expect(Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire')).toHaveLength(3);
      const halves = Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire' && i.id !== decoy.id);
      expect(halves).toHaveLength(2);
      for (const h of halves) expect([h.a, h.b].some((e) => e.kind === 'junction' && e.id === jid)).toBe(true);
      void w;
    }
  });

  it('joins a loose wire end through a shared junction, reusing it on repeat', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    const t: WireTarget = { kind: 'wireEnd', wire: w.id, end: 'b', pt: { x: 100, y: 0 } };
    const first = resolveWireEndpoint(doc, t);
    expect(first.kind).toBe('junction');
    expect((doc.items[w.id] as WireItem).b).toEqual(first);
    // already connected: the same junction comes back, no second one is made
    expect(resolveWireEndpoint(doc, t)).toEqual(first);
    expect(Object.values(doc.items).filter((i) => i.type === 'junction')).toHaveLength(1);
  });

  it('connects to an already-connected wire end instead of forking', () => {
    const { doc, c1 } = twoResistors();
    const w = freeWire(doc, 0, 0, 100, 0);
    w.b = { kind: 'port', comp: c1.id, port: '1' };
    const ep = resolveWireEndpoint(doc, { kind: 'wireEnd', wire: w.id, end: 'b', pt: { x: 100, y: 0 } });
    expect(ep).toEqual({ kind: 'port', comp: c1.id, port: '1' });
    expect(Object.values(doc.items).filter((i) => i.type === 'junction')).toHaveLength(0);
  });

  it("landing a 'wire' target on a free wire end shares a junction with it", () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    const ep = resolveWireEndpoint(doc, { kind: 'wire', wire: 'other', seg: 0, pt: { x: 100, y: 0 } });
    expect(ep.kind).toBe('junction');
    expect((doc.items[w.id] as WireItem).b).toEqual(ep);
    expect(Object.values(doc.items).filter((i) => i.type === 'junction')).toHaveLength(1);
  });

  it("landing a 'wire' target on a connected wire end returns the existing endpoint", () => {
    const { doc, c1 } = twoResistors();
    const pin = endpointInfo(doc, { kind: 'port', comp: c1.id, port: '1' })!.pt;
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: 0, y: 0 }, b: { kind: 'port', comp: c1.id, port: '1' }, pts: [] };
    doc.items[w.id] = w;
    const ep = resolveWireEndpoint(doc, { kind: 'wire', wire: 'other', seg: 0, pt: { ...pin } });
    expect(ep).toEqual({ kind: 'port', comp: c1.id, port: '1' });
    expect(Object.values(doc.items).filter((i) => i.type === 'junction')).toHaveLength(0);
  });
});

describe('moveWireSegment (segment gesture splicing)', () => {
  it('inserts a stub copy so an attached end stays put', () => {
    const doc = createDoc();
    const jid = uid('j');
    doc.items[jid] = { id: jid, type: 'junction', x: 0, y: 0 };
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'junction', id: jid }, b: { kind: 'free', x: 100, y: 0 }, pts: [] };
    doc.items[w.id] = w;
    expect(moveWireSegment(doc, w.id, [{ x: 0, y: 0 }, { x: 100, y: 0 }], 0, 0, 20)).toBe(true);
    // the junction end did not move; the dragged segment gained a stub leg
    expect(w.a).toEqual({ kind: 'junction', id: jid });
    expect(w.pts).toEqual([{ x: 0, y: 20 }]);
    expect(wirePolyline(doc, w)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 100, y: 20 }]);
  });

  it('moves free ends along with the segment', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    expect(moveWireSegment(doc, w.id, [{ x: 0, y: 0 }, { x: 100, y: 0 }], 0, 0, 20)).toBe(true);
    expect(w.a).toEqual({ kind: 'free', x: 0, y: 20 });
    expect(w.b).toEqual({ kind: 'free', x: 100, y: 20 });
    expect(w.pts).toEqual([]);
  });

  it('refuses to move a segment of a locked wire', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    w.locked = true;
    expect(moveWireSegment(doc, w.id, [{ x: 0, y: 0 }, { x: 100, y: 0 }], 0, 0, 20)).toBe(false);
    expect(w.a).toEqual({ kind: 'free', x: 0, y: 0 });
    expect(w.b).toEqual({ kind: 'free', x: 100, y: 0 });
    expect(w.pts).toEqual([]);
  });
});

describe('reconnectWireEnd (endpoint detach-vs-reconnect)', () => {
  it('refuses to drop a wire end onto its own other end', () => {
    const { doc, c1, c2 } = twoResistors();
    const w: WireItem = {
      id: uid('w'),
      type: 'wire',
      a: { kind: 'port', comp: c1.id, port: '2' },
      b: { kind: 'port', comp: c2.id, port: '1' },
      pts: [],
    };
    doc.items[w.id] = w;
    const ontoB = wireTargetForEndpoint(w.b);
    expect(reconnectWireEnd(doc, w.id, 'a', ontoB)).toBe(false);
    expect((doc.items[w.id] as WireItem).a).toEqual({ kind: 'port', comp: c1.id, port: '2' });
  });

  it('detaches to grid as a free end at the drop point', () => {
    const { doc, c1 } = twoResistors();
    const pin = endpointInfo(doc, { kind: 'port', comp: c1.id, port: '2' })!.pt;
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: c1.id, port: '2' }, b: { kind: 'free', x: pin.x + 100, y: pin.y }, pts: [] };
    doc.items[w.id] = w;
    expect(reconnectWireEnd(doc, w.id, 'a', grid(pin.x + 50, pin.y + 50))).toBe(true);
    const after = doc.items[w.id] as WireItem;
    expect(after.a).toEqual({ kind: 'free', x: pin.x + 50, y: pin.y + 50 });
    expect(wirePolyline(doc, after)[0]).toEqual({ x: pin.x + 50, y: pin.y + 50 });
  });

  it('reconnects a loose end onto a port', () => {
    const { doc, c1, c2 } = twoResistors();
    const w = freeWire(doc, 0, 0, 200, 0);
    expect(reconnectWireEnd(doc, w.id, 'a', portTarget(doc, c1.id, '1'))).toBe(true);
    expect((doc.items[w.id] as WireItem).a).toEqual({ kind: 'port', comp: c1.id, port: '1' });
    expect(reconnectWireEnd(doc, w.id, 'b', portTarget(doc, c2.id, '1'))).toBe(true);
    expect((doc.items[w.id] as WireItem).b).toEqual({ kind: 'port', comp: c2.id, port: '1' });
    expect(wirePolyline(doc, doc.items[w.id] as WireItem).length).toBeGreaterThanOrEqual(2);
  });

  it('sameWireTarget only matches identical ports or junctions', () => {
    expect(sameWireTarget(grid(0, 0), grid(0, 0))).toBe(false);
    expect(
      sameWireTarget(
        { kind: 'port', comp: 'c1', port: '1', pt: { x: 0, y: 0 }, dir: { x: 0, y: 0 } },
        { kind: 'port', comp: 'c1', port: '1', pt: { x: 9, y: 9 }, dir: { x: 0, y: 0 } },
      ),
    ).toBe(true);
  });
});

describe('closing a shape onto a wire end', () => {
  it('ends on the free end it was aimed at even after starting on the same wire split it', () => {
    // a wire from (300, 200) bending at the old solder point (200, 200) into a 45° stub up to (160, 160)
    const doc = createDoc();
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: 300, y: 200 }, b: { kind: 'free', x: 160, y: 160 }, pts: [{ x: 200, y: 200 }], routing: 'straight' };
    doc.items[w.id] = w;
    // start on the bend (splitting the wire there), loop round and finish on the stub's free end
    commitWire(doc, { kind: 'wire', wire: w.id, seg: 0, pt: { x: 200, y: 200 } }, { kind: 'wireEnd', wire: w.id, end: 'b', pt: { x: 160, y: 160 } }, {
      angle: '45',
      straight: true,
      via: [{ x: 160, y: 240 }, { x: 60, y: 240 }, { x: 60, y: 160 }],
    });
    const polys = Object.values(doc.items)
      .filter((i): i is WireItem => i.type === 'wire')
      .map((x) => wirePolyline(doc, x));
    const has = (p: { x: number; y: number }[], a: [number, number], b: [number, number]) =>
      p.some((q, i) => i > 0 && [[q, p[i - 1]], [p[i - 1], q]].some(([u, v]) => u.x === a[0] && u.y === a[1] && v.x === b[0] && v.y === b[1]));
    // the new run reaches (160, 160) from (60, 160): nothing jumps from the last corner to the solder point
    expect(polys.some((p) => has(p, [60, 160], [160, 160]))).toBe(true);
    expect(polys.some((p) => has(p, [60, 160], [200, 200]))).toBe(false);
    // the stub is drawn once
    expect(polys.filter((p) => has(p, [200, 200], [160, 160]))).toHaveLength(1);
  });

  it('keeps a 45° stub diagonal when it joins a right-angle wire', () => {
    const doc = createDoc();
    const w = freeWire(doc, 300, 200, 200, 200);
    commitWire(doc, { kind: 'wireEnd', wire: w.id, end: 'b', pt: { x: 200, y: 200 } }, grid(160, 160), { angle: '45' });
    const wires = Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire');
    expect(wires).toHaveLength(1);
    expect(wirePolyline(doc, wires[0])).toEqual([{ x: 300, y: 200 }, { x: 200, y: 200 }, { x: 160, y: 160 }]);
  });
});

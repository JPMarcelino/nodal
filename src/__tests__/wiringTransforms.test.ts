import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, makeShape, uid } from '../model/doc';
import { computeNets } from '../model/netlist';
import { cleanup, extractFragment, flipItems, followParts, insertFragment, rotateItems, scaleItems, splitWire, translateItems, turnPivot } from '../model/ops';
import { moveItemsToPage } from '../model/pageOps';
import { addPage } from '../model/pages';
import { settleEdit } from '../model/settle';
import { componentBounds, segmentIntersectsRect } from '../model/geometry';
import { instanceSymbol } from '../model/registry';
import type { CircuitDoc, ComponentItem, Endpoint, Item, WireItem } from '../model/types';
import { endpointInfo, wirePolyline } from '../model/wires';
import { resolveConnector } from '../model/connectors';
import { labelBox, labelLayout, labelLook } from '../canvas/Scene';

const add = <T extends Item>(d: CircuitDoc, it: T): T => ((d.items[it.id] = it), it);
const wire = (d: CircuitDoc, a: Endpoint, b: Endpoint, pts: { x: number; y: number }[] = [], extra: Partial<WireItem> = {}) =>
  add(d, { id: uid('w'), type: 'wire', a, b, pts, ...extra } as WireItem);
const port = (comp: string, p: string): Endpoint => ({ kind: 'port', comp, port: p });
const free = (x: number, y: number): Endpoint => ({ kind: 'free', x, y });
const wires = (d: CircuitDoc) => Object.values(d.items).filter((i): i is WireItem => i.type === 'wire');
/** Pin keys ("ref.port") grouped per net, for comparing connectivity. */
const nets = (d: CircuitDoc) =>
  computeNets(d)
    .map((n) => n.pins.map((p) => `${p.comp}.${p.port}`).sort().join(' '))
    .filter((n) => n.includes(' '))
    .sort();
/** The far (free) end each pin's net reaches. */
const reach = (d: CircuitDoc, comp: string, p: string) => {
  const ends: string[] = [];
  const seen = new Set<string>();
  const walk = (ep: Endpoint) => {
    for (const w of wires(d)) {
      if (seen.has(w.id)) continue;
      for (const [x, y] of [[w.a, w.b], [w.b, w.a]] as const) {
        const same = JSON.stringify(x) === JSON.stringify(ep);
        if (!same) continue;
        seen.add(w.id);
        if (y.kind === 'free') ends.push(`${y.x},${y.y}`);
        else walk(y);
      }
    }
  };
  walk(port(comp, p));
  return ends.sort();
};
const commit = (d: CircuitDoc, fn: (x: CircuitDoc) => void) => settleEdit(d, produce(d, (x) => fn(x as CircuitDoc)));

function diode() {
  const d = createDoc();
  const c = add(d, makeComponent(d, 'diode', 0, 0));
  wire(d, port(c.id, 'A'), free(-100, 0));
  wire(d, port(c.id, 'K'), free(100, 0));
  return { d, c: c.id };
}

describe('turning and flipping a lone part', () => {
  it('keeps each pin on its own net when flipped', () => {
    const { d, c } = diode();
    const n = commit(d, (x) => flipItems(x, new Set([c]), 'x'));
    expect(reach(n, c, 'A')).toEqual(['-100,0']);
    expect(reach(n, c, 'K')).toEqual(['100,0']);
    // and the leads go around the part, not through it
    const comp = n.items[c] as ComponentItem;
    const r = componentBounds(comp, instanceSymbol(n, comp));
    const body = { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
    for (const w of wires(n)) {
      const full = wirePolyline(n, w);
      expect(full.some((q, i) => i > 0 && segmentIntersectsRect(full[i - 1], q, body))).toBe(false);
    }
  });

  it('keeps each pin on its own net when turned twice', () => {
    const { d, c } = diode();
    const once = commit(d, (x) => rotateItems(x, new Set([c]), 90));
    const twice = commit(once, (x) => rotateItems(x, new Set([c]), 90));
    expect(reach(twice, c, 'A')).toEqual(['-100,0']);
    expect(reach(twice, c, 'K')).toEqual(['100,0']);
  });

  it('does not short a part whose leads are dragged on top of each other', () => {
    const { d, c } = diode();
    const n = commit(d, (x) => translateItems(d, x, new Set([c]), 200, 0));
    expect(reach(n, c, 'A')).toEqual(['-100,0']);
    expect(reach(n, c, 'K')).toEqual(['100,0']);
  });
});

describe('turn pivot', () => {
  function pair() {
    const d = createDoc();
    const r1 = add(d, makeComponent(d, 'resistor', 0, 0));
    const r2 = add(d, makeComponent(d, 'resistor', 30, 20));
    return { d, ids: new Set([r1.id, r2.id]) };
  }
  const where = (d: CircuitDoc) => Object.values(d.items).map((i) => (i.type === 'component' ? [i.x, i.y, i.rot, !!i.flipX] : null));

  it('comes back after two flips (pivot worked out afresh) and four turns (pivot kept, as the R key does)', () => {
    const { d, ids } = pair();
    let n = d;
    for (let k = 0; k < 2; k++) n = produce(n, (x) => flipItems(x as CircuitDoc, ids, 'x'));
    expect(where(n)).toEqual(where(d));
    n = d;
    const piv = turnPivot(d, ids);
    for (let k = 0; k < 4; k++) n = produce(n, (x) => rotateItems(x as CircuitDoc, ids, 90, piv));
    expect(where(n)).toEqual(where(d));
  });

  it('keeps grid points on the grid for quarter turns', () => {
    const { d, ids } = pair();
    const p = turnPivot(d, ids);
    const g = d.settings.grid;
    expect(Math.abs(((p.x + p.y) / g) % 1)).toBe(0);
    expect(Math.abs(((p.y - p.x) / g) % 1)).toBe(0);
  });
});

describe('cleanup', () => {
  it('keeps a pin set down on a junction connected', () => {
    const d = createDoc();
    const r1 = add(d, makeComponent(d, 'resistor', 0, 0));
    const r2 = add(d, makeComponent(d, 'resistor', 200, 100));
    const r3 = add(d, makeComponent(d, 'resistor', 200, -100));
    const j = add(d, { id: uid('j'), type: 'junction', x: 100, y: 0 } as Item);
    wire(d, port(r1.id, '2'), { kind: 'junction', id: j.id });
    wire(d, { kind: 'junction', id: j.id }, port(r2.id, '1'));
    wire(d, { kind: 'junction', id: j.id }, port(r3.id, '1'));
    // R1's right pin lands exactly on the junction: its wire has no length left
    const moved = produce(d, (x) => translateItems(d, x as CircuitDoc, new Set([r1.id]), 60, 0));
    const tidy = produce(moved, (x) => cleanup(x as CircuitDoc));
    expect(nets(tidy)).toEqual([[`${r1.id}.2`, `${r2.id}.1`, `${r3.id}.1`].sort().join(' ')]);
  });

  it('lets go of an end whose pin is gone instead of deleting the wire', () => {
    const d = createDoc();
    const r1 = add(d, makeComponent(d, 'resistor', 0, 0));
    const w = wire(d, port(r1.id, '9'), free(100, 100), [{ x: 60, y: 0 }, { x: 60, y: 100 }]);
    const tidy = produce(d, (x) => cleanup(x as CircuitDoc));
    expect(tidy.items[w.id]).toMatchObject({ a: { kind: 'free', x: 60, y: 0 }, pts: [{ x: 60, y: 100 }] });
  });
});

describe('locked parts in a selection', () => {
  it('scaling leaves the wire ends on a locked part where they are', () => {
    const d = createDoc();
    const r1 = add(d, { ...makeComponent(d, 'resistor', 0, 0), locked: true });
    const r2 = add(d, makeComponent(d, 'resistor', 200, 100));
    const w = wire(d, port(r1.id, '2'), port(r2.id, '1'), [{ x: 100, y: 0 }, { x: 100, y: 100 }]);
    const n = produce(d, (x) => void scaleItems(d, x as CircuitDoc, new Set([r1.id, r2.id, w.id]), 2, { x: 0, y: 0 }));
    const full = wirePolyline(n, n.items[w.id] as WireItem);
    expect(full[0]).toEqual({ x: 40, y: 0 });
    // still square, every run horizontal or vertical
    for (let i = 1; i < full.length; i++) expect(full[i].x === full[i - 1].x || full[i].y === full[i - 1].y).toBe(true);
  });
});

describe('wire labels', () => {
  it('splitting a named wire draws the name once', () => {
    const d = createDoc();
    const w = wire(d, free(0, 0), free(200, 0), [], { label: 'VCC', labelSide: 'below' });
    const n = produce(d, (x) => void splitWire(x as CircuitDoc, w.id, 0, { x: 100, y: 0 }));
    expect(wires(n).filter((x) => x.label === 'VCC')).toHaveLength(1);
  });

  it('a turned wire keeps its name beside the run', () => {
    const d = createDoc();
    const w = wire(d, free(0, 0), free(200, 0), [], { label: 'CLK', labelSide: 'above' });
    const n = produce(d, (x) => rotateItems(x as CircuitDoc, new Set([w.id]), 90));
    expect((n.items[w.id] as WireItem).labelSide).toBe('right');
  });
});

describe('copy and paste', () => {
  it('copies the junction selected parts meet at', () => {
    const d = createDoc();
    const r1 = add(d, makeComponent(d, 'resistor', 0, 0));
    const r2 = add(d, makeComponent(d, 'resistor', 200, 100));
    const r3 = add(d, makeComponent(d, 'resistor', 200, -100));
    const j = add(d, { id: uid('j'), type: 'junction', x: 100, y: 0 } as Item);
    for (const [c, p] of [[r1.id, '2'], [r2.id, '1'], [r3.id, '1']]) wire(d, { kind: 'junction', id: j.id }, port(c, p));
    const frag = extractFragment(d, new Set([r1.id, r2.id]));
    expect(frag.items.some((i) => i.type === 'junction')).toBe(true);
    const n = produce(d, (x) => {
      insertFragment(x as CircuitDoc, frag, 0, 300);
      cleanup(x as CircuitDoc);
    });
    // the copies of R1 and R2 are joined, through one merged wire
    const copies = Object.values(n.items).filter((i) => i.type === 'component' && i.y >= 200).map((i) => i.id);
    expect(computeNets(n).some((net) => copies.every((c) => net.pins.some((p) => p.comp === c)))).toBe(true);
  });

  it('pasting inside an entered group lands in that group, not a copy of it', () => {
    const d = createDoc();
    const r1 = add(d, { ...makeComponent(d, 'resistor', 0, 0), group: 'g1' });
    add(d, { ...makeComponent(d, 'resistor', 0, 100), group: 'g1' });
    d.groups.g1 = { id: 'g1', name: 'G' };
    const frag = extractFragment(d, new Set([r1.id]));
    let ids: string[] = [];
    const n = produce(d, (x) => void (ids = insertFragment(x as CircuitDoc, frag, 20, 20, 'g1')));
    expect(n.items[ids[0]].group).toBe('g1');
    expect(Object.keys(n.groups)).toEqual(['g1']);
  });

  it('puts copies in front of what is already there', () => {
    const d = createDoc();
    const r1 = add(d, { ...makeComponent(d, 'resistor', 0, 0), z: 0 });
    add(d, { ...makeShape(d, 'rect', -100, -100, 300, 300), z: 5 });
    let ids: string[] = [];
    const n = produce(d, (x) => void (ids = insertFragment(x as CircuitDoc, extractFragment(d, new Set([r1.id])), 20, 20)));
    expect(n.items[ids[0]].z).toBeUndefined();
  });
});

describe('moving to another page', () => {
  it('keeps the route of a wire left behind and tidies its junction', () => {
    const d = createDoc();
    const r1 = add(d, makeComponent(d, 'resistor', 0, 0));
    const r2 = add(d, makeComponent(d, 'resistor', 300, 100));
    const w = wire(d, port(r1.id, '2'), port(r2.id, '1'), [{ x: 100, y: 0 }, { x: 100, y: 100 }]);
    const n = produce(d, (x) => {
      const page = addPage(x as CircuitDoc, 'Two');
      moveItemsToPage(x as CircuitDoc, [r2.id], page);
    });
    const left = n.items[w.id] as WireItem;
    expect(left.b).toEqual(free(260, 100));
    expect(left.pts).toEqual([{ x: 100, y: 0 }, { x: 100, y: 100 }]);
  });
});

describe('editing a part directly', () => {
  it('a turn typed in brings its wires along, square', () => {
    const d = createDoc();
    const r = add(d, makeComponent(d, 'resistor', 0, 0));
    const w = wire(d, port(r.id, '2'), free(200, 200), [{ x: 200, y: 0 }]);
    const n = produce(d, (x) => {
      (x.items[r.id] as ComponentItem).rot = 90;
      followParts(d, x as CircuitDoc, new Set([r.id]));
    });
    const full = wirePolyline(n, n.items[w.id] as WireItem);
    expect(full[0]).toEqual(endpointInfo(n, port(r.id, '2'))!.pt);
    for (let i = 1; i < full.length; i++) expect(full[i].x === full[i - 1].x || full[i].y === full[i - 1].y).toBe(true);
    const comp = n.items[r.id] as ComponentItem;
    const b = componentBounds(comp, instanceSymbol(n, comp));
    const body = { x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 };
    expect(full.some((q, i) => i > 0 && segmentIntersectsRect(full[i - 1], q, body))).toBe(false);
  });
});

describe('glued connectors', () => {
  it('stay on the same spot of shapes flipped with them', () => {
    const d = createDoc();
    const a = add(d, makeShape(d, 'rect', 0, 0, 100, 60));
    const b = add(d, makeShape(d, 'rect', 300, 0, 100, 60));
    const arrow = add(d, { ...makeShape(d, 'arrow', 100, 30, 200, 0), from: { id: a.id, fx: 1, fy: 0.5 }, to: { id: b.id, fx: 0, fy: 0.5 } });
    const before = resolveConnector(d, arrow);
    const ids = new Set([a.id, b.id, arrow.id]);
    const piv = turnPivot(d, ids);
    const n = produce(d, (x) => flipItems(x as CircuitDoc, ids, 'x', piv));
    const after = resolveConnector(n, n.items[arrow.id] as typeof arrow);
    // mirrored: the arrow still runs between the facing sides, now from right to left
    expect(after.start).toEqual({ x: 2 * piv.x - before.start.x, y: before.start.y });
    expect(after.end).toEqual({ x: 2 * piv.x - before.end.x, y: before.end.y });
  });
});

describe('review follow-ups', () => {
  it('a dragged label of a mirrored part stays off the part', () => {
    const d = createDoc();
    const r = add(d, { ...makeComponent(d, 'resistor', 0, 0, 90), labelDx: 6, labelDy: 0 });
    const n = produce(d, (x) => flipItems(x as CircuitDoc, new Set([r.id]), 'x'));
    const c = n.items[r.id] as ComponentItem;
    const def = instanceSymbol(n, c);
    const box = labelBox(labelLayout(c, def).ref!, labelLook(c, 'ref', def));
    const body = componentBounds(c, def);
    // the label now sits on the left, clear of the body
    expect(box.x + box.w).toBeLessThanOrEqual(body.x);
  });

  it('a pin set down on a locked junction keeps the junction', () => {
    const d = createDoc();
    const r1 = add(d, makeComponent(d, 'resistor', 0, 0));
    const r2 = add(d, makeComponent(d, 'resistor', 200, 100));
    const r3 = add(d, makeComponent(d, 'resistor', 200, -100));
    const j = add(d, { id: uid('j'), type: 'junction', x: 100, y: 0, locked: true } as Item);
    wire(d, port(r1.id, '2'), { kind: 'junction', id: j.id });
    wire(d, { kind: 'junction', id: j.id }, port(r2.id, '1'));
    wire(d, { kind: 'junction', id: j.id }, port(r3.id, '1'));
    const moved = produce(d, (x) => translateItems(d, x as CircuitDoc, new Set([r1.id]), 60, 0));
    const tidy = produce(moved, (x) => cleanup(x as CircuitDoc));
    expect(tidy.items[j.id]).toBeDefined();
    expect(nets(tidy)).toEqual([[`${r1.id}.2`, `${r2.id}.1`, `${r3.id}.1`].sort().join(' ')]);
  });
});

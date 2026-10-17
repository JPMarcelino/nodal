import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, groupTags, makeComponent, selectedGroup } from '../model/doc';
import { groupItems, scaleItems } from '../model/ops';
import type { CircuitDoc, ComponentItem, WireItem } from '../model/types';
import { endpointInfo } from '../model/wires';

/** A resistor and a capacitor joined by a wire, grouped. */
function grouped() {
  const d = createDoc();
  const r = makeComponent(d, 'resistor', 0, 0);
  const c = makeComponent(d, 'capacitor', 200, 0);
  d.items[r.id] = r;
  d.items[c.id] = c;
  d.items.w = { id: 'w', type: 'wire', a: { kind: 'port', comp: r.id, port: '2' }, b: { kind: 'port', comp: c.id, port: '1' }, pts: [] };
  const gid = groupItems(d, [r.id, c.id, 'w'])!;
  return { d, r: r.id, c: c.id, gid };
}

describe('resizing a group', () => {
  it('scales every part alike and spreads the layout about the pivot', () => {
    const { d, r, c } = grouped();
    const ids = new Set([r, c, 'w']);
    const out = produce(d, (x) => void scaleItems(d, x as CircuitDoc, ids, 0.75, { x: 100, y: 0 }));
    const R = out.items[r] as ComponentItem;
    const C = out.items[c] as ComponentItem;
    // 75% would snap a lone part back to 100%; in a group every part takes it
    expect(R.scale).toBe(0.75);
    expect(C.scale).toBe(0.75);
    expect(R.x).toBeCloseTo(25);
    expect(C.x).toBeCloseTo(175);
    // the wire still reaches both pins
    const w = out.items.w as WireItem;
    expect(endpointInfo(out, w.a)).not.toBeNull();
    expect(endpointInfo(out, w.b)).not.toBeNull();
  });

  it('keeps every part within 10%…1000%', () => {
    const { d, r, c } = grouped();
    (d.items[r] as ComponentItem).scale = 8;
    const out = produce(d, (x) => void scaleItems(d, x as CircuitDoc, new Set([r, c]), 3, { x: 0, y: 0 }));
    expect((out.items[r] as ComponentItem).scale).toBe(10);
    expect((out.items[c] as ComponentItem).scale).toBeCloseTo(1.25);
  });

  it('leaves locked members exactly as they were', () => {
    const { d, r, c } = grouped();
    const lockedC = d.items[c] as ComponentItem;
    lockedC.locked = true;
    // a locked part must not constrain the group factor either
    lockedC.scale = 8;
    const lockedW = d.items.w as WireItem;
    lockedW.locked = true;
    lockedW.pts = [{ x: 100, y: -20 }];
    const beforeC = { x: lockedC.x, y: lockedC.y, scale: lockedC.scale };
    const beforeW = { a: lockedW.a, b: lockedW.b, pts: [...lockedW.pts] };
    const ids = new Set([r, c, 'w']);
    let factor = 0;
    const out = produce(d, (x) => {
      factor = scaleItems(d, x as CircuitDoc, ids, 2, { x: 100, y: 0 });
    });
    expect(factor).toBe(2);
    const R = out.items[r] as ComponentItem;
    expect(R.scale).toBe(2);
    expect(R.x).toBeCloseTo(-100);
    const C = out.items[c] as ComponentItem;
    expect(C.x).toBe(beforeC.x);
    expect(C.y).toBe(beforeC.y);
    expect(C.scale).toBe(beforeC.scale);
    const W = out.items.w as WireItem;
    expect(W.a).toEqual(beforeW.a);
    expect(W.b).toEqual(beforeW.b);
    expect(W.pts).toEqual(beforeW.pts);
  });

  it('takes the `_` collision path for a bridge id without duplicating the wire', () => {
    // two resistors butted end to end: r1's right pin sits on r2's left pin
    const d = createDoc();
    const r1 = makeComponent(d, 'resistor', 0, 0);
    d.items[r1.id] = r1;
    const r2 = makeComponent(d, 'resistor', 80, 0);
    d.items[r2.id] = r2;
    // the deterministic bridge id is already taken (a previously committed
    // bridge wire would sit there on the next gesture), so the bridge must
    // take the `while (base.items[id]) id += '_'` path
    const bridgeId = `w-${r2.id}-1-${r1.id}-2`;
    d.items[bridgeId] = { id: bridgeId, type: 'junction', x: -999, y: -999 };
    // scaling r2 away pulls the butted pins apart, which bridges them
    const out = produce(d, (x) => void scaleItems(d, x as CircuitDoc, new Set([r2.id]), 2, { x: 0, y: 0 }));
    const ws = Object.values(out.items).filter((i): i is WireItem => i.type === 'wire');
    expect(ws).toHaveLength(1);
    expect(ws[0].id).toBe(`${bridgeId}_`);
    expect(ws[0].a).toEqual({ kind: 'port', comp: r1.id, port: '2' });
    expect(ws[0].b).toEqual({ kind: 'port', comp: r2.id, port: '1' });
    // the item the id collided with is untouched
    expect(out.items[bridgeId]).toEqual({ id: bridgeId, type: 'junction', x: -999, y: -999 });
    // a follow-up gesture from the committed doc adds no parallel wire
    const next = produce(out, (x) => void scaleItems(out, x as CircuitDoc, new Set([r2.id]), 1.5, { x: 0, y: 0 }));
    expect(Object.values(next.items).filter((i) => i.type === 'wire')).toHaveLength(1);
  });
});

describe('group names', () => {
  it('tags groups in the current scope and recognises a whole-group selection', () => {
    const { d, r, c, gid } = grouped();
    const tags = groupTags(d);
    expect(tags.map((t) => t.id)).toEqual([gid]);
    expect(tags[0].name).toBe(d.groups[gid].name);
    expect(groupTags(d, gid)).toEqual([]);
    expect(selectedGroup(d, [r, c, 'w'])).toBe(gid);
    expect(selectedGroup(d, [r, c])).toBeUndefined();
  });
});

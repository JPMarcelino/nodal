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

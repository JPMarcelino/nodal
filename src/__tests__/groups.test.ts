import { describe, expect, it } from 'vitest';
import { createDoc, groupChain, makeComponent } from '../model/doc';
import { groupItems } from '../model/ops';

describe('groupItems', () => {
  it('keeps an already-grouped selection nested instead of pulling members out', () => {
    const doc = createDoc();
    const a = makeComponent(doc, 'resistor', 0, 0);
    doc.items[a.id] = a;
    const b = makeComponent(doc, 'resistor', 100, 0);
    doc.items[b.id] = b;
    const c = makeComponent(doc, 'resistor', 200, 0);
    doc.items[c.id] = c;
    const g1 = groupItems(doc, [a.id, b.id, c.id]);
    expect(g1).toBeTruthy();
    const gid = groupItems(doc, [a.id, b.id, c.id]);
    expect(gid).toBeTruthy();
    expect(gid).not.toBe(g1);
    expect(doc.groups[g1!].group).toBe(gid);
    for (const m of [a, b, c]) {
      expect(doc.items[m.id].group).toBe(g1);
      expect(groupChain(doc, doc.items[m.id].group)).toEqual([g1, gid]);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { createDoc, makeShape, ZONE_COLOURS } from '../model/doc';

describe('zone colours', () => {
  it('cycle through the palette, reusing the least used colour', () => {
    const doc = createDoc();
    const add = () => {
      const z = makeShape(doc, 'zone', 0, 0, 100, 100);
      doc.items[z.id] = z;
      return z;
    };
    const first = ZONE_COLOURS.map(() => add());
    expect(first.map((z) => z.fill)).toEqual(ZONE_COLOURS);
    expect(first.every((z) => z.stroke === z.fill)).toBe(true);
    // the cycle starts again, then fills the gap a deleted zone leaves
    expect(add().fill).toBe(ZONE_COLOURS[0]);
    delete doc.items[first[3].id];
    expect(add().fill).toBe(ZONE_COLOURS[3]);
  });

  it('leave other shapes alone', () => {
    const doc = createDoc();
    expect(makeShape(doc, 'rect', 0, 0, 10, 10).fill).toBe('#7aa2f7');
  });
});

import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, normalizeDoc } from '../model/doc';
import { countParts, diffDocs, pruneAutos, sameContent } from '../model/versions';
import type { CircuitDoc } from '../model/types';

const HOUR = 3600e3;

function withResistor(doc: CircuitDoc, x = 0): CircuitDoc {
  return produce(doc, (d) => {
    const c = makeComponent(d as CircuitDoc, 'resistor', x, 0);
    d.items[c.id] = c;
  });
}

describe('document identity', () => {
  it('new documents get an id that survives a save and reload', () => {
    const a = createDoc();
    expect(a.id).toBeTruthy();
    expect(normalizeDoc(JSON.parse(JSON.stringify(a))).id).toBe(a.id);
  });

  it('files from before ids get one when opened', () => {
    const { id: _, ...legacy } = createDoc();
    expect(normalizeDoc(legacy).id).toBeTruthy();
  });
});

describe('version comparison', () => {
  it('counts added, removed and changed items', () => {
    const a = withResistor(withResistor(createDoc()), 50);
    const [first, second] = Object.keys(a.items);
    const b = produce(withResistor(a, 100), (d) => {
      delete d.items[first];
      (d.items[second] as { x: number }).x = 70;
    });
    expect(diffDocs(a, b)).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(countParts(b)).toEqual({ parts: 2, wires: 0 });
  });

  it('treats equal content as the same, whatever the object identity', () => {
    const a = withResistor(createDoc());
    expect(sameContent(a, JSON.parse(JSON.stringify(a)))).toBe(true);
    expect(sameContent(a, withResistor(a, 40))).toBe(false);
  });
});

describe('pruning automatic versions', () => {
  it('keeps named versions and the newest automatic ones', () => {
    const now = 100 * 24 * HOUR;
    const vs = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, t: now - i * 60e3, auto: true }));
    vs.push({ id: 'named', t: now - 400 * 24 * HOUR, auto: false });
    const drop = pruneAutos(vs, now, 12);
    expect(drop).not.toContain('named');
    expect(drop).not.toContain('a0');
    // the 8 older ones all fall in the same hour (or the one before): at most two survive
    expect(drop.length).toBeGreaterThanOrEqual(6);
  });

  it('thins old versions to one per day and forgets very old ones', () => {
    const now = 100 * 24 * HOUR;
    const vs = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `d3-${i}`, t: now - 3 * 24 * HOUR - i * HOUR, auto: true })),
      { id: 'ancient', t: now - 90 * 24 * HOUR, auto: true },
    ];
    const drop = pruneAutos(vs, now, 0);
    expect(drop).toContain('ancient');
    expect(vs.filter((v) => !drop.includes(v.id)).length).toBeLessThanOrEqual(2);
  });
});

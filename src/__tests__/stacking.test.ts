import { describe, expect, it } from 'vitest';
import { createDoc, drawOrder, makeShape, normalizeDoc, uid } from '../model/doc';
import { extractFragment, insertFragment, restackItems } from '../model/ops';
import type { CircuitDoc, Item, ShapeItem, WireItem } from '../model/types';

function freeWire(doc: CircuitDoc, ax: number, ay: number, bx: number, by: number, z?: number): WireItem {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: ax, y: ay }, b: { kind: 'free', x: bx, y: by }, pts: [], ...(z !== undefined ? { z } : {}) };
  doc.items[w.id] = w;
  return w;
}

/** A shape as older versions saved it: banded by `layer`, z only within the band. */
function legacyShape(doc: CircuitDoc, id: string, layer: 'below' | 'above', z: number): Item {
  const s = { ...makeShape(doc, 'rect', 0, 0, 50, 50), id, layer, z } as unknown as Item;
  doc.items[id] = s;
  return s;
}

const backToFront = (doc: CircuitDoc) => {
  const o = drawOrder(doc);
  return Object.keys(doc.items).sort((a, b) => o.get(a)! - o.get(b)!);
};

describe('one stacking order', () => {
  it('migrates shape layers to z without changing the picture, and is idempotent', () => {
    const doc = createDoc();
    // shape z values used to be compared only within their band, so they overlap the circuit's
    legacyShape(doc, 'above2', 'above', 2);
    const w1 = freeWire(doc, 0, 0, 10, 0, 5);
    legacyShape(doc, 'below3', 'below', 3);
    const w2 = freeWire(doc, 0, 10, 10, 10); // no z: in front of the circuit
    legacyShape(doc, 'above1', 'above', 1);
    legacyShape(doc, 'below1', 'below', 1);
    const w0 = freeWire(doc, 0, 20, 10, 20, 0);

    const migrated = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    expect(backToFront(migrated)).toEqual(['below1', 'below3', w0.id, w1.id, w2.id, 'above1', 'above2']);
    for (const it of Object.values(migrated.items)) {
      expect('layer' in it).toBe(false);
      expect(typeof it.z).toBe('number');
    }
    const again = normalizeDoc(JSON.parse(JSON.stringify(migrated)));
    expect(again.items).toEqual(migrated.items);
  });

  it('leaves current documents alone', () => {
    const doc = createDoc();
    freeWire(doc, 0, 0, 10, 0);
    const z = makeShape(doc, 'zone', 0, 0, 10, 10);
    doc.items[z.id] = z;
    const before = JSON.parse(JSON.stringify(doc.items));
    expect(normalizeDoc(JSON.parse(JSON.stringify(doc))).items).toEqual(before);
  });

  it('pastes a legacy fragment behind / in front of the circuit as before', () => {
    const src = createDoc();
    legacyShape(src, 'zoneOld', 'below', 9);
    const frag = extractFragment(src, new Set(['zoneOld']));
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 10, 0);
    const [id] = insertFragment(doc, frag, 0, 0);
    expect('layer' in doc.items[id]).toBe(false);
    expect(backToFront(doc)).toEqual([id, w.id]);
  });

  it('creates area shapes at the back and annotations at the front', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    const add = (kind: ShapeItem['kind']) => {
      const s = makeShape(doc, kind, 0, 0, 20, 20);
      doc.items[s.id] = s;
      return s.id;
    };
    const zone = add('zone');
    const rect = add('rect');
    const text = add('text');
    const arrow = add('arrow');
    const ink = add('ink');
    const image = add('image');
    // newest back shape is the backmost; newest front shape the frontmost
    expect(backToFront(doc)).toEqual([image, rect, zone, w.id, text, arrow, ink]);
    for (const it of Object.values(doc.items)) expect('layer' in it).toBe(false);
  });

  it('brings items forward / back across shapes, wires and parts alike', () => {
    const doc = createDoc();
    const zone = makeShape(doc, 'zone', 0, 0, 100, 100);
    doc.items[zone.id] = zone;
    const w = freeWire(doc, 0, 50, 100, 50);
    const far = freeWire(doc, 500, 500, 600, 500);
    expect(backToFront(doc)).toEqual([zone.id, w.id, far.id]);
    // forward steps past the next item it overlaps (the wire), not just the next one in the list
    expect(restackItems(doc, [zone.id], 'forward')).toBe(true);
    expect(backToFront(doc)).toEqual([w.id, zone.id, far.id]);
    expect(restackItems(doc, [zone.id], 'front')).toBe(true);
    expect(backToFront(doc)).toEqual([w.id, far.id, zone.id]);
    expect(restackItems(doc, [zone.id], 'front')).toBe(false);
    // backward skips the far wire it doesn't overlap and goes under the one it does
    expect(restackItems(doc, [zone.id], 'backward')).toBe(true);
    expect(backToFront(doc)).toEqual([zone.id, w.id, far.id]);
    expect(restackItems(doc, [far.id, zone.id], 'back')).toBe(true);
    expect(backToFront(doc)).toEqual([zone.id, far.id, w.id]);
  });
});

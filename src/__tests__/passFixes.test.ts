import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent } from '../model/doc';
import { annotate, extractFragment, insertFragment } from '../model/ops';
import { fragmentFromText } from '../io/clipboardCopy';
import type { CircuitDoc, ComponentItem } from '../model/types';

function place(doc: CircuitDoc, x: number, y: number) {
  const c = makeComponent(doc, 'resistor', x, y);
  doc.items[c.id] = c;
  return c;
}

describe('annotate', () => {
  it('numbers rows top to bottom, left to right, with rows that never chain past 40px', () => {
    const doc = createDoc();
    const a = place(doc, 300, 0);
    const b = place(doc, 200, 30);
    const c = place(doc, 100, 60);
    annotate(doc);
    // a and b share the first row (b is left of a); c starts a new row
    expect([b.ref, a.ref, c.ref]).toEqual(['R1', 'R2', 'R3']);
  });
});

describe('insertFragment', () => {
  it('keeps the circuit’s own definition of a symbol it already has', () => {
    const src = createDoc();
    const r = place(src, 0, 0);
    const frag = extractFragment(src, new Set([r.id]));
    frag.symbols = { mine: { id: 'mine', name: 'Old' } as unknown as CircuitDoc['symbols'][string] };
    const doc = createDoc();
    doc.symbols.mine = { id: 'mine', name: 'New' } as unknown as CircuitDoc['symbols'][string];
    insertFragment(doc, frag, 0, 0);
    expect((doc.symbols.mine as unknown as { name: string }).name).toBe('New');
  });
});

describe('fragmentFromText', () => {
  it('rejects fragments whose items are not items', () => {
    expect(fragmentFromText('{"format":"nodal-fragment","items":[null],"groups":[],"symbols":{}}')).toBeNull();
    const ok = { format: 'nodal-fragment', items: [{ id: 'x', type: 'wire' } as unknown as ComponentItem], groups: [], symbols: {} };
    expect(fragmentFromText(JSON.stringify(ok))).not.toBeNull();
  });
});

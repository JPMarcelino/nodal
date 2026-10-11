import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent } from '../model/doc';
import { librarySymbols } from '../model/registry';
import { compileSource } from '../model/symbols/dsl';
import type { CircuitDoc } from '../model/types';

const custom = compileSource({ id: 'user-thing', name: 'Thing', category: 'My symbols', w: 40, h: 20, draw: 'L 0 10 40 10', ports: '1:0,10', prefix: 'U', value: '', fields: '', keywords: '' });
const listed = (doc: CircuitDoc) => librarySymbols(doc).some((d) => d.id === custom.id);

describe('library listing of circuit symbols', () => {
  it('lists a circuit symbol only while a part uses it', () => {
    const unused = produce(createDoc(), (d) => void (d.symbols[custom.id] = custom));
    expect(listed(unused)).toBe(false);
    const used = produce(unused, (d) => {
      const c = makeComponent(d as CircuitDoc, custom.id, 0, 0);
      d.items[c.id] = c;
    });
    expect(listed(used)).toBe(true);
  });

  it('still lists every circuit symbol when no items are given', () => {
    const doc = produce(createDoc(), (d) => void (d.symbols[custom.id] = custom));
    expect(librarySymbols({ symbols: doc.symbols }).some((d) => d.id === custom.id)).toBe(true);
  });
});

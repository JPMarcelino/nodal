import { describe, expect, it } from 'vitest';
import { createDoc, itemBounds } from '../model/doc';
import { applyLook, lookKeys, lookOf } from '../model/style';
import type { JunctionItem } from '../model/types';

const solder = (): JunctionItem => ({ id: 'j1', type: 'junction', x: 100, y: 50 });

describe('solder dots are editable', () => {
  it('offers a colour and a size, defaulting to the circuit look', () => {
    const doc = createDoc();
    const j = solder();
    expect(lookKeys(j)).toEqual(['line', 'width']);
    expect(lookOf(doc, j)).toMatchObject({ line: '', width: doc.settings.junctionSize });
  });

  it('takes a colour and size, and lets go of them again', () => {
    const j = solder();
    applyLook(j, { line: '#3ddc97', width: 6 });
    expect(j).toMatchObject({ color: '#3ddc97', size: 6 });
    applyLook(j, { line: '' });
    expect(j.color).toBeUndefined();
    expect(j.size).toBe(6);
  });

  it('grows its clickable and export bounds with the dot', () => {
    const doc = createDoc();
    const j = solder();
    const small = itemBounds(doc, j)!;
    j.size = 12;
    const big = itemBounds(doc, j)!;
    expect(big.w).toBeGreaterThan(small.w);
    expect(big.w).toBe(24);
  });
});

import { describe, expect, it } from 'vitest';
import { compileSource, sourceOf } from '../model/symbols/dsl';
import type { VariantRef } from '../model/types';

const variants: VariantRef[] = [
  { id: 'user-base-b', name: 'Type B' },
  { id: 'user-base-c', name: 'Type C' },
];

const source = (extra: { variants?: VariantRef[] } = {}) => ({
  id: 'user-base',
  name: 'Base',
  category: 'My symbols',
  w: 40,
  h: 20,
  draw: 'L 0 10 40 10',
  ports: '1:0,10 2:40,10',
  prefix: 'U',
  value: '',
  fields: '',
  keywords: '',
  ...extra,
});

describe('symbol source round-trips drawing types', () => {
  it('keeps the type list through compile and sourceOf', () => {
    const def = compileSource(source({ variants }));
    expect(def.variants).toEqual(variants);
    expect(sourceOf(def).variants).toEqual(variants);
    // editing and saving the same symbol recompiles from this source
    expect(compileSource(sourceOf(def)).variants).toEqual(variants);
  });

  it('takes the current type list even when the stored source pre-dates it', () => {
    const def = compileSource(source());
    def.variants = variants;
    expect(sourceOf(def).variants).toEqual(variants);
  });

  it('does not resurrect types that were removed from the symbol', () => {
    const def = compileSource(source({ variants }));
    def.variants = undefined;
    expect(sourceOf(def).variants).toBeUndefined();
  });
});

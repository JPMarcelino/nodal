import { describe, expect, it } from 'vitest';
import { compileSource, sourceOf, type SymbolSource } from '../model/symbols/dsl';
import type { VariantRef } from '../model/types';

const variants: VariantRef[] = [
  { id: 'user-base-b', name: 'Type B' },
  { id: 'user-base-c', name: 'Type C' },
];

const closed = 'L 0 10 40 10\nC 20 10 4';

const source = (extra: Partial<SymbolSource> = {}): SymbolSource => ({
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

describe('symbol source round-trips the remaining symbol fields', () => {
  it('keeps labels and the closed drawing through compile and sourceOf', () => {
    const def = compileSource(source({ hideLabels: true, valueIsLabel: true, closed }));
    expect(def.hideLabels).toBe(true);
    expect(def.valueIsLabel).toBe(true);
    expect(def.closedPrims).toHaveLength(2);

    const again = sourceOf(def);
    expect(again.hideLabels).toBe(true);
    expect(again.valueIsLabel).toBe(true);
    expect(again.closed).toBe(closed);
    // editing and saving the same symbol recompiles from this source
    expect(compileSource(again).closedPrims).toEqual(def.closedPrims);
  });

  it('takes the current fields even when the stored source pre-dates them', () => {
    const def = compileSource(source());
    def.hideLabels = true;
    def.valueIsLabel = true;
    def.closedPrims = compileSource(source({ closed })).closedPrims;

    const src = sourceOf(def);
    expect(src.hideLabels).toBe(true);
    expect(src.valueIsLabel).toBe(true);
    expect(src.closed).toBe(closed);
  });

  it('clears removed fields and rebuilds them without a stored source', () => {
    const def = compileSource(source({ hideLabels: true, valueIsLabel: true, closed }));
    def.hideLabels = false;
    def.valueIsLabel = undefined;
    def.closedPrims = undefined;
    delete def.source;

    const src = sourceOf(def);
    expect(src.hideLabels).toBe(false);
    expect(src.valueIsLabel).toBeUndefined();
    expect(src.closed).toBeUndefined();
  });

  it('rebuilds the closed drawing when a symbol has no stored source', () => {
    const def = compileSource(source({ closed }));
    delete def.source;
    expect(sourceOf(def).closed).toBe(closed);
  });
});

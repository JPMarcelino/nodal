import { beforeEach, describe, expect, it } from 'vitest';
import { addPage } from '../model/pages';
import { createDoc } from '../model/doc';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

describe('export names', () => {
  beforeEach(async () => {
    const { set } = await import('../store/store');
    set({ doc: createDoc('SBR_DTC'), page: undefined, selection: [] });
  });

  it('follows the open page, and says what part of it is exported', async () => {
    const { S, set } = await import('../store/store');
    const { exportBaseName } = await import('../io/fileActions');
    const doc = S().doc;
    const power = addPage(doc, 'Power supply');
    set({ doc, page: power });
    expect(exportBaseName()).toBe('Power supply');
    expect(exportBaseName({ ids: ['r1'] })).toBe('Power supply (selection)');
    expect(exportBaseName({ clip: { x: 120.4, y: -30, w: 80, h: 60 } })).toBe('Power supply (area 120,-30)');
  });

  it('uses the circuit name when there is only one page', async () => {
    const { exportBaseName } = await import('../io/fileActions');
    expect(exportBaseName()).toBe('SBR_DTC');
  });
});

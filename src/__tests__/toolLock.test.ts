import { describe, expect, it } from 'vitest';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

describe('tool lock', () => {
  it('placing a part returns to Select unless the tool lock (or Shift) keeps it armed', async () => {
    const { S, set, setPrefs } = await import('../store/store');
    const { createDoc } = await import('../model/doc');
    const A = await import('../store/actions');
    const { cancel } = await import('../store/commands');

    set({ doc: createDoc(), page: undefined, scope: undefined, selection: [] });
    setPrefs({ toolLock: false, shortcuts: 'nodal' });

    // lock off: one part, then placing ends
    A.startPlacing('resistor');
    const first = A.placeArmed(0, 0);
    expect(first && S().doc.items[first]).toBeTruthy();
    expect(S().placing).toBeNull();
    expect(S().tool).toBe('select');

    // Shift keeps placing once
    A.startPlacing('resistor');
    A.placeArmed(40, 0, true);
    expect(S().placing?.symbol).toBe('resistor');
    set({ placing: null });

    // lock on: keeps placing copies
    A.toggleToolLock();
    expect(S().prefs.toolLock).toBe(true);
    A.startPlacing('capacitor');
    A.placeArmed(80, 0);
    A.placeArmed(120, 0);
    expect(S().placing?.symbol).toBe('capacitor');
    expect(Object.values(S().doc.items).filter((i) => i.type === 'component' && i.symbol === 'capacitor')).toHaveLength(2);

    // Esc still stops placing (the tool is Select)
    cancel();
    expect(S().placing).toBeNull();
    expect(S().tool).toBe('select');

    A.toggleToolLock();
    expect(S().prefs.toolLock).toBe(false);
  });

  it('the lock has a free default key', async () => {
    const { COMMANDS } = await import('../store/commands');
    const lock = COMMANDS.find((c) => c.id === 'tool.lock')!;
    expect(lock.keys).toEqual(['Shift+Q']);
    const clash = COMMANDS.filter((c) => c.id !== 'tool.lock' && (c.keys.includes('Shift+Q') || c.cadence?.includes('Shift+Q')));
    expect(clash).toEqual([]);
  });
});

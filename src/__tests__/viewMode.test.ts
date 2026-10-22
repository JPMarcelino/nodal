import { describe, expect, it } from 'vitest';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

async function setup() {
  const store = await import('../store/store');
  const { createDoc, makeComponent } = await import('../model/doc');
  const A = await import('../store/actions');
  const commands = await import('../store/commands');
  const doc = createDoc();
  const r = makeComponent(doc, 'resistor', 0, 0);
  doc.items[r.id] = r;
  store.set({ doc, page: undefined, scope: undefined, selection: [r.id], past: [], future: [], viewOnly: false, viewMode: false, tool: 'select', placing: null });
  return { ...store, A, ...commands, rid: r.id };
}

describe('view mode', () => {
  it('refuses every edit while on, and allows them again when off', async () => {
    const { S, set, mutate, undo, A, COMMAND_MAP, rid, readOnly } = await setup();
    const before = S().doc;

    A.setViewMode(true);
    expect(S().viewMode).toBe(true);
    expect(readOnly()).toBe(true);
    expect(mutate((d) => void delete d.items[rid])).toBe(false);
    A.deleteSelection();
    COMMAND_MAP.get('edit.delete')!.run();
    COMMAND_MAP.get('arrange.rotateCw')!.run();
    COMMAND_MAP.get('edit.nudgeRight')!.run();
    expect(A.copyInPlace()).toEqual([]);
    expect(S().doc).toBe(before);

    // only the tools that look; nothing gets armed for placing
    A.setTool('wire');
    expect(S().tool).toBe('select');
    A.setTool('pan');
    expect(S().tool).toBe('pan');
    A.startPlacing('resistor');
    expect(S().placing).toBeNull();

    // selecting, finding and copying still work; edit commands are hidden
    set({ selection: [rid] });
    expect(COMMAND_MAP.get('edit.delete')!.when!()).toBe(false);
    expect(COMMAND_MAP.get('edit.undo')!.when!()).toBe(false);
    expect(COMMAND_MAP.get('edit.copy')!.when!()).toBe(true);
    expect(COMMAND_MAP.get('edit.find')!.when).toBeUndefined();
    A.selectAll();
    expect(S().selection).toEqual([rid]);

    A.setViewMode(false);
    expect(readOnly()).toBe(false);
    expect(mutate((d) => void delete d.items[rid])).toBe(true);
    expect(S().doc.items[rid]).toBeUndefined();

    // undo is refused in View mode too
    A.setViewMode(true);
    undo();
    expect(S().doc.items[rid]).toBeUndefined();
    A.setViewMode(false);
    undo();
    expect(S().doc.items[rid]).toBeTruthy();
  });

  it('turning View mode off never lets a view-only session guest edit', async () => {
    const { S, set, mutate, A, readOnly, rid } = await setup();
    set({ viewOnly: true });
    A.setViewMode(true);
    A.setViewMode(false);
    expect(S().viewMode).toBe(false);
    expect(S().viewOnly).toBe(true);
    expect(readOnly()).toBe(true);
    expect(mutate((d) => void delete d.items[rid])).toBe(false);
    expect(S().doc.items[rid]).toBeTruthy();
    set({ viewOnly: false });
  });

  it('View mode and stats have free default keys in both schemes', async () => {
    const { COMMANDS, defaultKeys } = await import('../store/commands');
    for (const [id, key] of [
      ['view.viewMode', 'Alt+Shift+R'],
      ['view.stats', 'Alt+/'],
    ] as const) {
      const c = COMMANDS.find((x) => x.id === id)!;
      expect(c.keys).toEqual([key]);
      expect(defaultKeys(c, 'nodal')).toEqual([key]);
      expect(defaultKeys(c, 'cadence')).toEqual([key]);
      const clash = COMMANDS.filter((x) => x.id !== id && (defaultKeys(x, 'nodal').includes(key) || defaultKeys(x, 'cadence').includes(key)));
      expect(clash).toEqual([]);
    }
  });

  it('the hint line says how to leave View mode', async () => {
    const { hintFor } = await import('../ui/hints');
    expect(hintFor({ tool: 'select', placing: false, selection: [], viewMode: true, key: (k) => (k === 'view.viewMode' ? 'Alt+⇧+R' : k) })).toBe('View mode — Alt+⇧+R to edit');
  });
});

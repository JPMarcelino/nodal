import { describe, expect, it } from 'vitest';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

async function setup() {
  const store = await import('../store/store');
  const { createDoc } = await import('../model/doc');
  const A = await import('../store/actions');
  const { computeNets } = await import('../model/netlist');
  const { portPosition } = await import('../model/wires');
  store.set({ doc: createDoc(), page: undefined, scope: undefined, selection: [], past: [], future: [], viewOnly: false, placing: null });
  const r1 = A.placeComponent('resistor', 0, 0);
  const items = () => Object.values(store.vdoc().items);
  const parts = () => items().filter((i) => i.type === 'component');
  const wires = () => items().filter((i) => i.type === 'wire');
  /** Whether two pins share a net. */
  const joined = (a: string, b: string) => computeNets(store.vdoc()).some((n) => n.pins.some((p) => p.comp === a) && n.pins.some((p) => p.comp === b));
  const pins = (id: string) => {
    const c = store.vdoc().items[id];
    if (c?.type !== 'component') return [];
    return ['1', '2'].map((p) => portPosition(store.vdoc(), c, p)!.pt);
  };
  return { ...store, A, r1, parts, wires, joined, pins };
}

describe('quick add', () => {
  it('chaining right adds a copy wired to the right pin, selected, and chains again', async () => {
    const { S, A, r1, parts, wires, joined, pins } = await setup();
    A.quickAdd('right');
    expect(parts()).toHaveLength(2);
    expect(wires()).toHaveLength(1);
    const r2 = S().selection[0];
    expect(r2).not.toBe(r1);
    const c2 = S().doc.items[r2];
    expect(c2.type === 'component' && c2.symbol === 'resistor' && c2.rot === 0 && c2.ref === 'R2').toBe(true);
    // back pin on the source pin's line, two grid steps out
    expect(pins(r2)[0]).toEqual({ x: 60, y: 0 });
    expect(joined(r1, r2)).toBe(true);
    const w = wires()[0];
    expect(w.type === 'wire' && w.a.kind === 'port' && w.a.comp === r1 && w.a.port === '2' && w.b.kind === 'port' && w.b.comp === r2 && w.b.port === '1').toBe(true);

    // pressing again builds a chain
    A.quickAdd('right');
    const r3 = S().selection[0];
    expect(parts()).toHaveLength(3);
    expect(joined(r2, r3)).toBe(true);
    expect(pins(r3)[0]).toEqual({ x: 160, y: 0 });
  });

  it('the copy carries the value, fields and style but not the reference or DNP', async () => {
    const { S, A, r1, mutate } = await setup();
    mutate((d) => {
      const c = d.items[r1];
      if (c.type !== 'component') return;
      c.value = '4k7';
      c.color = '#ff0000';
      c.lineWidth = 3;
      c.props.footprint = '0603';
      c.props.mpn = 'RC0603-4K7';
      c.props.dnp = '1';
    });
    A.quickAdd('right');
    const c2 = S().doc.items[S().selection[0]];
    if (c2.type !== 'component') throw new Error('no copy');
    expect(c2.ref).toBe('R2');
    expect(c2.value).toBe('4k7');
    expect(c2.color).toBe('#ff0000');
    expect(c2.lineWidth).toBe(3);
    expect(c2.props.footprint).toBe('0603');
    expect(c2.props.mpn).toBe('RC0603-4K7');
    expect(c2.props.dnp).toBeUndefined();
    expect(c2.locked).toBeFalsy();
  });

  it('chaining down turns a horizontal resistor vertical', async () => {
    const { S, A, r1, joined, pins } = await setup();
    A.quickAdd('down');
    const r2 = S().selection[0];
    const c2 = S().doc.items[r2];
    expect(c2.type === 'component' && (c2.rot === 90 || c2.rot === 270)).toBe(true);
    const [p1, p2] = pins(r2);
    expect(p1.x).toBe(p2.x);
    // the top pin sits on the source pin's vertical line, below it
    const top = p1.y < p2.y ? p1 : p2;
    expect(top).toEqual({ x: 40, y: 20 });
    expect(joined(r1, r2)).toBe(true);
  });

  it('skips an occupied spot by stepping further out', async () => {
    const { S, A, r1, joined, pins, set } = await setup();
    // a vertical part right where the copy would land (but clear of the wire's line)
    const blocker = A.placeComponent('resistor', 100, 50, 90);
    set({ selection: [r1] });
    A.quickAdd('right');
    const r2 = S().selection[0];
    expect(r2).not.toBe(blocker);
    const back = pins(r2)[0];
    expect(back.y).toBe(0);
    expect(back.x).toBeGreaterThan(110);
    expect(joined(r1, r2)).toBe(true);
    expect(joined(blocker, r2)).toBe(false);
  });

  it('routes the wire round a part sitting on the line', async () => {
    const { S, A, r1, joined, pins, set, wires } = await setup();
    const blocker = A.placeComponent('resistor', 100, 0);
    set({ selection: [r1] });
    A.quickAdd('right');
    const r2 = S().selection[0];
    expect(pins(r2)[0].y).toBe(0);
    expect(pins(r2)[0].x).toBeGreaterThan(140);
    expect(joined(r1, r2)).toBe(true);
    expect(joined(blocker, r2)).toBe(false);
    expect(joined(blocker, r1)).toBe(false);
    expect(wires()).toHaveLength(1);
  });

  it('one undo removes both the part and its wire', async () => {
    const { A, parts, wires, undo } = await setup();
    A.quickAdd('right');
    expect(parts()).toHaveLength(2);
    expect(wires()).toHaveLength(1);
    undo();
    expect(parts()).toHaveLength(1);
    expect(wires()).toHaveLength(0);
  });

  it('does nothing for locked parts, several selected, or a view-only session', async () => {
    const { S, A, r1, parts, set, mutate } = await setup();
    set({ viewOnly: true });
    A.quickAdd('right');
    expect(parts()).toHaveLength(1);
    set({ viewOnly: false });
    mutate((d) => void (d.items[r1].locked = true));
    A.quickAdd('right');
    expect(parts()).toHaveLength(1);
    mutate((d) => void (d.items[r1].locked = false));
    const other = A.placeComponent('resistor', 0, 200);
    set({ selection: [r1, other] });
    A.quickAdd('right');
    expect(parts()).toHaveLength(2);
    expect(S().selection).toEqual([r1, other]);
  });

  it('the default keys are free', async () => {
    const { COMMANDS } = await import('../store/commands');
    for (const k of ['Mod+Shift+ArrowRight', 'Mod+Shift+ArrowLeft', 'Mod+Shift+ArrowUp', 'Mod+Shift+ArrowDown']) {
      expect(COMMANDS.filter((c) => c.keys.includes(k) || c.cadence?.includes(k))).toHaveLength(1);
    }
  });
});

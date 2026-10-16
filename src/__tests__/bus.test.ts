import { describe, expect, it } from 'vitest';
import { busMembers, busNets, wireStyleFor } from '../model/bus';
import { createDoc, makeComponent } from '../model/doc';
import { runErc } from '../model/erc';
import { computeNets } from '../model/netlist';
import type { CircuitDoc, Endpoint, WireItem } from '../model/types';
import { commitWire } from '../model/wireCommit';

const F = (x: number, y: number) => ({ kind: 'free' as const, x, y });

describe('bus names', () => {
  it('expands ranges either way round, lists and plain names', () => {
    expect(busMembers('D[0..3]')).toEqual(['D0', 'D1', 'D2', 'D3']);
    expect(busMembers('A[3:0]')).toEqual(['A3', 'A2', 'A1', 'A0']);
    expect(busMembers('Q[1-2]_N')).toEqual(['Q1_N', 'Q2_N']);
    expect(busMembers('{CLK, RST, D[0..1]}')).toEqual(['CLK', 'RST', 'D0', 'D1']);
    expect(busMembers('SDA')).toEqual(['SDA']);
    expect(busMembers('')).toEqual([]);
    expect(busMembers('X[0..99999]')).toHaveLength(256);
  });
});

/** A bus named D[0..3] along y=0 from x=0 to x=200. */
function withBus(name = 'D[0..3]') {
  const d = createDoc();
  const bus: WireItem = { id: 'bus', type: 'wire', a: F(0, 0), b: F(200, 0), pts: [], bus: true, label: name };
  d.items.bus = bus;
  return d;
}
/** Draws a plain wire from the bus at x down to a grid point (the bus is found under the point). */
const tap = (d: CircuitDoc, x: number, to: Endpoint & { kind: 'free' }) => commitWire(d, { kind: 'wire', wire: 'bus', seg: 0, pt: { x, y: 0 } }, { kind: 'grid', pt: { x: to.x, y: to.y } });

describe('bus taps', () => {
  it('names new taps after the next free signal and keeps them apart electrically', () => {
    const d = withBus();
    const t1 = tap(d, 40, F(40, 60))!;
    const t2 = tap(d, 80, F(80, 60))!;
    expect((d.items[t1] as WireItem).label).toBe('D0');
    expect((d.items[t2] as WireItem).label).toBe('D1');
    // the bus split into pieces that are still buses, and the taps stay plain wires
    const nets = busNets(d);
    expect(nets).toHaveLength(1);
    expect(nets[0].wires.length).toBeGreaterThanOrEqual(2);
    expect(nets[0].taps.map((t) => t.wire).sort()).toEqual([t1, t2].sort());
    // the bus does not short its taps together
    const netOf = (id: string) => computeNets(d).find((n) => n.wires.includes(id));
    expect(netOf(t1)).not.toBe(netOf(t2));
    expect(netOf('bus')).toBeUndefined();
  });

  it('joins a tap to elsewhere by its signal name', () => {
    const d = withBus();
    const r = makeComponent(d, 'resistor', 300, 300);
    d.items[r.id] = r;
    const t = tap(d, 40, F(40, 60))!;
    d.items.far = { id: 'far', type: 'wire', a: { kind: 'port', comp: r.id, port: '1' }, b: F(200, 300), pts: [], label: 'D0' };
    const net = computeNets(d).find((n) => n.wires.includes(t))!;
    expect(net.wires).toContain('far');
    expect(net.pins.map((p) => p.comp)).toContain(r.id);
  });

  it('flags unnamed buses and taps that are not signals, but not loose bus ends', () => {
    const d = withBus('');
    expect(runErc(d).map((i) => i.rule)).toContain('bus-unnamed');
    expect(runErc(d).some((i) => i.rule === 'loose-end' && i.items.includes('bus'))).toBe(false);
    const named = withBus();
    const t = tap(named, 40, F(40, 60))!;
    (named.items[t] as WireItem).label = 'X9';
    expect(runErc(named).find((i) => i.rule === 'bus-tap')?.items).toEqual([t]);
  });

  it('draws buses with the bus look unless overridden', () => {
    const d = withBus();
    expect(wireStyleFor(d.settings, d.items.bus as WireItem).width).toBe(5);
    d.settings.bus = { width: 8 };
    expect(wireStyleFor(d.settings, d.items.bus as WireItem).width).toBe(8);
    expect(wireStyleFor(d.settings, { ...(d.items.bus as WireItem), style: { width: 3 } }).width).toBe(3);
    expect(wireStyleFor(d.settings, { bus: false }).width).toBe(d.settings.wire.width);
  });
});

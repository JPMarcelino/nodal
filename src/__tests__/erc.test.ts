import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import { runErc } from '../model/erc';
import { loadMath, splitMath, stripMath, texToSvg } from '../model/latex';
import { computeNets } from '../model/netlist';
import { measureRich } from '../model/richText';
import type { CircuitDoc, ComponentItem, WireItem } from '../model/types';

function place(doc: CircuitDoc, symbol: string, x: number, y: number, rot: ComponentItem['rot'] = 0) {
  const c = makeComponent(doc, symbol, x, y, rot);
  doc.items[c.id] = c;
  return c;
}
function wire(doc: CircuitDoc, a: ComponentItem, pa: string, b: ComponentItem, pb: string) {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: a.id, port: pa }, b: { kind: 'port', comp: b.id, port: pb }, pts: [] };
  doc.items[w.id] = w;
  return w;
}
const rules = (doc: CircuitDoc) => runErc(doc).map((i) => i.rule);

describe('electrical rules check', () => {
  it('flags unconnected pins, and is quiet once they are wired', () => {
    const doc = createDoc();
    const r = place(doc, 'resistor', 0, 0);
    expect(rules(doc)).toContain('unconnected-pin');
    const v = place(doc, 'vcc', 200, -200);
    wire(doc, r, '1', v, 'VCC');
    const issues = runErc(doc).filter((i) => i.items.includes(r.id) && i.rule === 'unconnected-pin');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/pin 2/);
  });

  it('reports duplicate references as errors', () => {
    const doc = produce(createDoc(), (d) => {
      const a = place(d as CircuitDoc, 'resistor', 0, 0);
      const b = place(d as CircuitDoc, 'resistor', 200, 0);
      b.ref = a.ref;
    });
    const dup = runErc(doc).find((i) => i.rule === 'duplicate-ref');
    expect(dup?.severity).toBe('error');
  });

  it('connects pins that touch, and a no-connect flag on a pin silences it', () => {
    const doc = createDoc();
    const r1 = place(doc, 'resistor', 0, 0);
    place(doc, 'resistor', 80, 0); // pin 2 of r1 sits on pin 1 of r2
    const nets = computeNets(doc);
    expect(nets.some((n) => n.pins.length === 2)).toBe(true);
    // r1 pin 1 is open; cap it with a no-connect flag sitting on the pin
    // r1 pin 1 is at (-40, 0); the flag's pin is 10 px left of its centre
    place(doc, 'no-connect', -30, 0);
    const open = runErc(doc).filter((i) => i.rule === 'unconnected-pin' && i.items.includes(r1.id));
    expect(open).toHaveLength(0);
  });

  it('warns about shorted supply rails', () => {
    const doc = createDoc();
    const a = place(doc, 'vcc', 0, 0);
    const b = place(doc, 'vcc', 200, 0);
    b.value = '+3V3';
    a.value = '+5V';
    wire(doc, a, 'VCC', b, 'VCC');
    const short = runErc(doc).find((i) => i.rule === 'shorted-nets');
    expect(short?.severity).toBe('error');
  });
});

describe('latex', () => {
  it('splits text into plain and maths runs', () => {
    expect(splitMath('Gain $A_v = -R_f/R_1$ here')).toEqual([
      { math: false, text: 'Gain ' },
      { math: true, tex: 'A_v = -R_f/R_1', display: false },
      { math: false, text: ' here' },
    ]);
    expect(splitMath('costs \\$5')).toEqual([{ math: false, text: 'costs $5' }]);
    expect(stripMath('$$\\frac{1}{2}$$')).toBe('\\frac{1}{2}');
  });

  it('typesets formulas to SVG paths', async () => {
    await loadMath();
    const svg = texToSvg('V_{out} = \\frac{R_2}{R_1 + R_2} V_{in}')!;
    expect(svg.error).toBe(false);
    expect(svg.body).toContain('<path');
    expect(svg.wEx).toBeGreaterThan(5);
    expect(measureRich('$\\frac{1}{2}$', 16).h).toBeGreaterThan(16);
  });
});

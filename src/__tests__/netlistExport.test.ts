import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import { spiceValue, toBomCsv, toKicadNetlist, toSpiceNetlist } from '../model/netlist';
import type { CircuitDoc, ComponentItem } from '../model/types';

function place(doc: CircuitDoc, symbol: string, x: number, y: number) {
  const c = makeComponent(doc, symbol, x, y);
  doc.items[c.id] = c;
  return c;
}
function wire(doc: CircuitDoc, a: ComponentItem, pa: string, b: ComponentItem, pb: string) {
  const id = uid('w');
  doc.items[id] = { id, type: 'wire', a: { kind: 'port', comp: a.id, port: pa }, b: { kind: 'port', comp: b.id, port: pb }, pts: [] };
}

describe('SPICE export', () => {
  it('converts engineering values', () => {
    expect(spiceValue('10kΩ')).toBe('10k');
    expect(spiceValue('4k7')).toBe('4.7k');
    expect(spiceValue('4R7')).toBe('4.7');
    expect(spiceValue('100nF')).toBe('100n');
    expect(spiceValue('10µF')).toBe('10u');
    expect(spiceValue('1MΩ')).toBe('1meg');
    expect(spiceValue('9V')).toBe('9');
  });

  it('writes BJT nodes as collector, base, emitter and sources as DC', () => {
    const doc = createDoc();
    const q = place(doc, 'npn', 0, 0);
    const v = place(doc, 'dc-source', 200, 0);
    const g = place(doc, 'gnd', 200, 200);
    wire(doc, v, '+', q, 'C');
    wire(doc, v, '-', g, 'GND');
    wire(doc, q, 'E', g, 'GND');
    const net = toSpiceNetlist(doc);
    const line = net.split('\n').find((l) => l.startsWith('Q1'))!;
    const [, c, b, e] = line.split(' ');
    expect(e).toBe('0');
    expect(b).not.toBe(c);
    expect(c).not.toBe('0');
    expect(net).toMatch(/^V1 \S+ 0 DC 5$/m);
  });

  it('leaves out connectors and do-not-populate parts', () => {
    const doc = createDoc();
    place(doc, 'header-1x2', 0, 0);
    const r = place(doc, 'resistor', 200, 0);
    r.props.dnp = '1';
    const net = toSpiceNetlist(doc);
    expect(net).not.toMatch(/^J1 /m);
    expect(net).not.toMatch(/^R1 /m);
    expect(net).toMatch(/Not simulated: .*J1.*R1/);
  });
});

describe('BOM and KiCad export', () => {
  it('lists footprints and part numbers, with DNP parts last', () => {
    const doc = createDoc();
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 100, 0);
    const c = place(doc, 'resistor', 200, 0);
    for (const x of [a, b, c]) Object.assign(x.props, { footprint: 'R_0603', mpn: 'RC0603FR-0710KL' });
    c.props.dnp = '1';
    const rows = toBomCsv(doc).trim().split('\n');
    expect(rows[0]).toMatch(/^Item,Quantity,References,Value,Description,Footprint/);
    expect(rows[1]).toMatch(/^1,2,"R1, R2",.*"R_0603",.*"RC0603FR-0710KL".*,Yes$/);
    expect(rows[2]).toMatch(/^2,1,"R3",.*,DNP$/);
  });

  it('writes components with footprints and nets with pins', () => {
    const doc = createDoc();
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'capacitor', 200, 0);
    a.props.footprint = 'Resistor_SMD:R_0603';
    wire(doc, a, '2', b, '1');
    const out = toKicadNetlist(doc);
    expect(out).toContain('(comp (ref "R1") (value "10kΩ") (footprint "Resistor_SMD:R_0603")');
    expect(out).toMatch(/\(node \(ref "R1"\) \(pin "2"\)/);
    expect(out).toMatch(/\(node \(ref "C1"\) \(pin "1"\)/);
  });
});

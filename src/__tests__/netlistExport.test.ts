import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import { runErc } from '../model/erc';
import { computeNets, spiceValue, toBomCsv, toKicadNetlist, toSpiceNetlist } from '../model/netlist';
import { addPage } from '../model/pages';
import type { CircuitDoc, ComponentItem, WireItem } from '../model/types';

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

  it('de-duplicates references that clash across pages in every export', () => {
    const doc = createDoc();
    const p2 = addPage(doc, 'Second');
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    b.page = p2;
    b.ref = a.ref;
    expect(a.ref).toBe('R1');

    const spice = toSpiceNetlist(doc);
    expect(spice).toMatch(/^R1 /m);
    expect(spice).toMatch(/^R1_2 /m);

    const bom = toBomCsv(doc).trim().split('\n')[1];
    expect(bom).toContain('"R1, R1-2"');

    const kicad = toKicadNetlist(doc);
    const compRefs = [...kicad.matchAll(/\(comp \(ref "([^"]+)"\)/g)].map((m) => m[1]);
    const nodeRefs = [...kicad.matchAll(/\(node \(ref "([^"]+)"\)/g)].map((m) => m[1]);
    expect(compRefs.sort()).toEqual(['R1', 'R1-2']);
    expect([...new Set(nodeRefs)].sort()).toEqual(['R1', 'R1-2']);
  });
});

describe('wire labels name nets', () => {
  function labelledWire(doc: CircuitDoc, a: ComponentItem, pa: string, b: ComponentItem, pb: string, label: string, hidden = false) {
    const id = uid('w');
    const w: WireItem = { id, type: 'wire', a: { kind: 'port', comp: a.id, port: pa }, b: { kind: 'port', comp: b.id, port: pb }, pts: [], label };
    if (hidden) w.labelHidden = true;
    doc.items[id] = w;
    return w;
  }

  it('names the net after a single labelled wire', () => {
    const doc = createDoc();
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    const w = labelledWire(doc, a, '2', b, '1', 'VOUT');
    const net = computeNets(doc).find((n) => n.wires.includes(w.id))!;
    expect(net.name).toBe('VOUT');
    expect(net.pins).toHaveLength(2);
  });

  it('joins physically separate wires that share a label', () => {
    const doc = createDoc();
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    const c = place(doc, 'resistor', 400, 0);
    const d = place(doc, 'resistor', 600, 0);
    const w1 = labelledWire(doc, a, '2', b, '1', 'SDA');
    const w2 = labelledWire(doc, c, '2', d, '1', ' SDA ');
    const named = computeNets(doc).filter((n) => n.name === 'SDA');
    expect(named).toHaveLength(1);
    expect(named[0].wires).toEqual(expect.arrayContaining([w1.id, w2.id]));
    expect(named[0].pins).toHaveLength(4);
  });

  it('joins a wire label with a net-label symbol of the same name', () => {
    const doc = createDoc();
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    const c = place(doc, 'resistor', 400, 0);
    const w1 = labelledWire(doc, a, '2', b, '1', 'SDA');
    const lbl = place(doc, 'net-label', 800, 0);
    lbl.value = 'SDA';
    wire(doc, c, '1', lbl, 'N');
    const nets = computeNets(doc);
    const named = nets.filter((n) => n.name === 'SDA');
    expect(named).toHaveLength(1);
    expect(named[0].wires).toContain(w1.id);
    expect(named[0].pins.map((p) => p.comp)).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
  });

  it('keeps the symbol name but reports a disagreeing wire label as shorted', () => {
    const doc = createDoc();
    const v = place(doc, 'vcc', 0, -200);
    v.value = '5V';
    const r = place(doc, 'resistor', 0, 0);
    const w = labelledWire(doc, r, '1', v, 'VCC', '3V3');
    const net = computeNets(doc).find((n) => n.wires.includes(w.id))!;
    expect(net.names).toEqual(expect.arrayContaining(['5V', '3V3']));
    expect(net.name).toBe('5V');
    const short = runErc(doc).find((i) => i.rule === 'shorted-nets');
    expect(short?.message).toMatch(/5V/);
    expect(short?.message).toMatch(/3V3/);
  });

  it('uses the wire label in SPICE and KiCad exports', () => {
    const doc = createDoc();
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    labelledWire(doc, a, '2', b, '1', 'VOUT');
    const spice = toSpiceNetlist(doc);
    expect(spice.split('\n').find((l) => l.startsWith('R1'))).toContain('VOUT');
    expect(toKicadNetlist(doc)).toContain('(name "VOUT")');
  });

  it('a hidden wire label still names its net', () => {
    const doc = createDoc();
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    const w = labelledWire(doc, a, '2', b, '1', 'VOUT', true);
    expect(computeNets(doc).find((n) => n.wires.includes(w.id))!.name).toBe('VOUT');
  });

  it('label-blind nets stay physical (wire-label drag targets)', () => {
    const doc = createDoc();
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    const c = place(doc, 'resistor', 400, 0);
    const d = place(doc, 'resistor', 600, 0);
    const w1 = labelledWire(doc, a, '2', b, '1', 'SDA');
    const w2 = labelledWire(doc, c, '2', d, '1', 'SDA');
    expect(computeNets(doc).filter((n) => n.name === 'SDA')).toHaveLength(1);
    const physical = computeNets(doc, { ignoreLabels: true });
    const n1 = physical.find((n) => n.wires.includes(w1.id))!;
    const n2 = physical.find((n) => n.wires.includes(w2.id))!;
    expect(n1).not.toBe(n2);
  });
});

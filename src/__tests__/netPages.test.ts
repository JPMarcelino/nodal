import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import { computeNets, netItemsOnPage, netPages, type Net } from '../model/netlist';
import { addPage, docPages } from '../model/pages';
import type { CircuitDoc, ComponentItem, WireItem } from '../model/types';

function place(doc: CircuitDoc, symbol: string, x: number, y: number, page?: string) {
  const c = makeComponent(doc, symbol, x, y);
  if (page) c.page = page;
  doc.items[c.id] = c;
  return c;
}

function wire(doc: CircuitDoc, a: ComponentItem, pa: string, b: ComponentItem, pb: string, extra: Partial<WireItem> = {}) {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: a.id, port: pa }, b: { kind: 'port', comp: b.id, port: pb }, pts: [], ...extra };
  doc.items[w.id] = w;
  return w;
}

function freeWire(doc: CircuitDoc, page?: string) {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: 0, y: 0 }, b: { kind: 'free', x: 100, y: 0 }, pts: [], page };
  doc.items[w.id] = w;
  return w;
}

describe('netPages', () => {
  it('maps a wire-only net and a pin-only net to their pages', () => {
    const doc = createDoc();
    const power = addPage(doc, 'Power');
    const wireId = freeWire(doc, power).id;
    const resistor = place(doc, 'resistor', 200, 0, power);

    const nets = computeNets(doc);
    const wireNet = nets.find((n) => n.wires.includes(wireId))!;
    const pinNet = nets.find((n) => n.pins.some((p) => p.comp === resistor.id))!;
    expect(wireNet.pins).toEqual([]);
    expect(pinNet.wires).toEqual([]);
    expect(netPages(doc, wireNet)).toEqual([power]);
    expect(netPages(doc, pinNet)).toEqual([power]);
  });

  it('lists every page of a mixed net in document page order', () => {
    const doc = createDoc();
    const second = addPage(doc, 'Power');
    const third = addPage(doc, 'Sense');
    const first = docPages(doc)[0].id;
    const r1 = place(doc, 'resistor', 0, 0);
    const r2 = place(doc, 'resistor', 100, 0);
    const r3 = place(doc, 'resistor', 0, 0, third);
    const r4 = place(doc, 'resistor', 100, 0, third);
    wire(doc, r1, '1', r2, '1', { label: 'SDA', page: first });
    wire(doc, r3, '1', r4, '1', { label: 'SDA', page: third });

    const net = computeNets(doc).find((n) => n.name === 'SDA')!;
    expect(netPages(doc, net)).toEqual([first, third]);
    expect(netPages(doc, net)).not.toContain(second);
  });

  it('ignores ids missing from the document and returns [] when none are found', () => {
    const doc = createDoc();
    const power = addPage(doc, 'Power');
    const wireId = freeWire(doc, power).id;
    const net: Net = {
      name: 'X',
      names: ['X'],
      wires: [wireId, 'missing-wire'],
      pins: [{ comp: 'missing-part', ref: 'R9', port: '1', portName: '1' }],
    };
    expect(netPages(doc, net)).toEqual([power]);
    expect(netPages(doc, { ...net, wires: ['missing-wire'], pins: [] })).toEqual([]);
  });

  it('resolves a one-page document to its first page', () => {
    const doc = createDoc();
    const resistor = place(doc, 'resistor', 0, 0);
    const net = computeNets(doc).find((n) => n.pins.some((p) => p.comp === resistor.id))!;
    expect(netPages(doc, net)).toEqual([docPages(doc)[0].id]);
  });
});

describe('netItemsOnPage', () => {
  it('returns only the wires and pin components on the requested page, wires first', () => {
    const doc = createDoc();
    const first = docPages(doc)[0].id;
    const power = addPage(doc, 'Power');
    const r1 = place(doc, 'resistor', 0, 0, first);
    const r2 = place(doc, 'resistor', 100, 0, power);
    const w1 = freeWire(doc, first);
    const w2 = freeWire(doc, power);
    const net: Net = {
      name: 'SDA',
      names: ['SDA'],
      wires: [w1.id, 'missing-wire', w2.id],
      pins: [
        { comp: r1.id, ref: 'R1', port: '1', portName: '1' },
        { comp: 'missing-part', ref: 'R9', port: '1', portName: '1' },
        { comp: r2.id, ref: 'R2', port: '1', portName: '1' },
      ],
    };
    expect(netItemsOnPage(doc, net, power)).toEqual([w2.id, r2.id]);
    expect(netItemsOnPage(doc, net, first)).toEqual([w1.id, r1.id]);
  });

  it('resolves unset and unknown pages to the first page', () => {
    const doc = createDoc();
    const first = docPages(doc)[0].id;
    const power = addPage(doc, 'Power');
    const r1 = place(doc, 'resistor', 0, 0, first);
    const r2 = place(doc, 'resistor', 100, 0, power);
    const w1 = freeWire(doc, first);
    const w2 = freeWire(doc, power);
    const net: Net = {
      name: 'SDA',
      names: ['SDA'],
      wires: [w1.id, w2.id],
      pins: [
        { comp: r1.id, ref: 'R1', port: '1', portName: '1' },
        { comp: r2.id, ref: 'R2', port: '1', portName: '1' },
      ],
    };
    expect(netItemsOnPage(doc, net)).toEqual([w1.id, r1.id]);
    expect(netItemsOnPage(doc, net, 'no-such-page')).toEqual([w1.id, r1.id]);
  });
});

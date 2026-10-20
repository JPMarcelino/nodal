import { describe, expect, it } from 'vitest';
import type { Draft } from 'immer';
import { createDoc, makeComponent, uid } from '../model/doc';
import { incrementLabels, incrementName } from '../model/increment';
import { extractFragment, insertFragment } from '../model/ops';
import type { CircuitDoc, ComponentItem, WireItem } from '../model/types';

describe('incrementName', () => {
  const cases: [string, string][] = [
    ['D0', 'D1'],
    ['ADC_CH9', 'ADC_CH10'],
    ['A07', 'A08'],
    ['P099', 'P100'],
    ['X9', 'X10'],
    ['12', '13'],
    ['GND', 'GND'],
    ['NET', 'NET'],
    ['', ''],
    ['$V_{1}$', '$V_{1}$'],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(incrementName(input)).toBe(expected);
    });
  }
});

describe('incrementLabels', () => {
  it('bumps label copies only, leaving originals alone', () => {
    const doc: CircuitDoc = createDoc('increment');
    const net = makeComponent(doc, 'net-label', 0, 0);
    net.value = 'D0';
    doc.items[net.id] = net;
    const rail = makeComponent(doc, 'vcc', 0, 40);
    rail.value = 'VCC';
    doc.items[rail.id] = rail;
    const res = makeComponent(doc, 'resistor', 0, 80);
    res.ref = 'R1';
    res.value = '10k';
    doc.items[res.id] = res;
    const wire: WireItem = {
      id: uid('w'),
      type: 'wire',
      a: { kind: 'free', x: 0, y: 0 },
      b: { kind: 'free', x: 100, y: 0 },
      pts: [],
      label: 'BUS3',
    };
    doc.items[wire.id] = wire;

    const ids = new Set([net.id, rail.id, res.id, wire.id]);
    const frag = extractFragment(doc, ids);
    const copies = insertFragment(doc, frag, 0, 20);
    const bumped = incrementLabels(doc as Draft<CircuitDoc>, copies);
    expect(bumped).toBe(true);

    const byId = new Map(copies.map((id) => [id, doc.items[id]]));
    const copyNet = [...byId.values()].find(
      (i): i is ComponentItem => i.type === 'component' && i.symbol === 'net-label' && i.id !== net.id,
    )!;
    const copyRail = [...byId.values()].find(
      (i): i is ComponentItem => i.type === 'component' && i.symbol === 'vcc' && i.id !== rail.id,
    )!;
    const copyRes = [...byId.values()].find(
      (i): i is ComponentItem => i.type === 'component' && i.symbol === 'resistor' && i.id !== res.id,
    )!;
    const copyWire = [...byId.values()].find((i): i is WireItem => i.type === 'wire' && i.id !== wire.id)!;

    expect(copyNet.value).toBe('D1');
    expect(copyRail.value).toBe('VCC');
    expect(copyRes.value).toBe('10k');
    expect(copyRes.ref).not.toBe('R1');
    expect(copyWire.label).toBe('BUS4');

    // originals keep their names
    expect((doc.items[net.id] as ComponentItem).value).toBe('D0');
    expect((doc.items[rail.id] as ComponentItem).value).toBe('VCC');
    expect((doc.items[res.id] as ComponentItem).value).toBe('10k');
    expect((doc.items[res.id] as ComponentItem).ref).toBe('R1');
    expect((doc.items[wire.id] as WireItem).label).toBe('BUS3');
  });
});

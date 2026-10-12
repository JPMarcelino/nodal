import { createDoc, makeComponent, makeShape, uid } from './doc';
import type { CircuitDoc, ComponentItem, Endpoint, Point, WireItem } from './types';

/** Seed document: an NE555 astable LED flasher. */
export function sampleDoc(): CircuitDoc {
  const doc = createDoc('555 LED flasher');
  const add = (symbol: string, x: number, y: number, value?: string, rot: ComponentItem['rot'] = 0) => {
    const c = makeComponent(doc, symbol, x, y, rot);
    if (value !== undefined) c.value = value;
    doc.items[c.id] = c;
    return c;
  };
  const p = (c: ComponentItem, port: string): Endpoint => ({ kind: 'port', comp: c.id, port });
  const junction = (x: number, y: number): Endpoint => {
    const id = uid('j');
    doc.items[id] = { id, type: 'junction', x, y };
    return { kind: 'junction', id };
  };
  const wire = (a: Endpoint, b: Endpoint, pts: Point[] = []) => {
    const w: WireItem = { id: uid('w'), type: 'wire', a, b, pts };
    doc.items[w.id] = w;
  };

  const u1 = add('ne555', 400, 300);
  const vcc = add('vcc', 380, 140, '+9V');
  const gnd = add('gnd', 380, 580);
  const ra = add('resistor', 260, 220, '10kΩ', 90);
  const rb = add('resistor', 260, 380, '68kΩ', 90);
  const c1 = add('capacitor-polarized', 260, 480, '10µF', 90);
  const c2 = add('capacitor', 400, 420, '10nF', 90);
  const r3 = add('resistor', 520, 280, '470Ω');
  const d1 = add('led', 600, 330, 'Red', 90);

  // supply rail
  const jTop = junction(380, 180);
  wire(p(vcc, 'VCC'), jTop);
  wire(jTop, p(u1, 'VCC'));
  wire(jTop, p(u1, 'RST'), [{ x: 400, y: 180 }]);
  wire(jTop, p(ra, '1'));
  // timing network
  const jDis = junction(260, 320);
  wire(p(ra, '2'), jDis);
  wire(jDis, p(rb, '1'));
  wire(jDis, p(u1, 'DIS'));
  const jThr = junction(260, 440);
  wire(p(rb, '2'), jThr);
  wire(jThr, p(c1, '+'));
  wire(p(u1, 'THR'), jThr, [{ x: 300, y: 300 }, { x: 300, y: 440 }]);
  wire(p(u1, 'TRIG'), p(u1, 'THR'), [{ x: 320, y: 280 }, { x: 320, y: 300 }]);
  // ground rail
  const jGnd = junction(380, 540);
  const jRail = junction(400, 540);
  wire(p(u1, 'GND'), jGnd);
  wire(jGnd, p(gnd, 'GND'));
  wire(p(c1, '-'), jGnd, [{ x: 260, y: 540 }]);
  wire(p(u1, 'CTRL'), p(c2, '1'));
  wire(p(c2, '2'), jRail);
  wire(jRail, jGnd);
  // output stage
  wire(p(u1, 'OUT'), p(r3, '1'));
  wire(p(r3, '2'), p(d1, 'A'), [{ x: 600, y: 280 }]);
  wire(p(d1, 'K'), jRail, [{ x: 600, y: 540 }]);

  const zone = makeShape(doc, 'zone', 200, 150, 130, 380);
  zone.text = 'Timing network';
  zone.fill = '#7aa2f7';
  zone.stroke = '#7aa2f7';
  doc.items[zone.id] = zone;
  const out = makeShape(doc, 'zone', 500, 224, 160, 166);
  out.text = 'Output';
  out.fill = '#f7768e';
  out.stroke = '#f7768e';
  doc.items[out.id] = out;
  const title = makeShape(doc, 'text', 200, 80, 0, 0);
  title.text = '555 astable LED flasher  ·  f ≈ 1.44 / ((Ra + 2Rb)·C1) ≈ 1 Hz';
  title.fontSize = 16;
  title.bold = true;
  title.w = 520;
  title.h = 22;
  doc.items[title.id] = title;
  return doc;
}

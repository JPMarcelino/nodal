import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, makeShape } from '../model/doc';
import { getSymbol, instanceSymbol } from '../model/registry';
import { applyLook, commonLook } from '../model/style';
import { scalePath, scaleSymbol } from '../model/symbols/scale';
import type { CircuitDoc, ComponentItem, WireItem } from '../model/types';
import { portPosition } from '../model/wires';

describe('resizing parts', () => {
  it('scales geometry, pins and text but keeps line widths', () => {
    const def = getSymbol(createDoc(), 'resistor');
    const big = scaleSymbol(def, 2);
    expect(big.w).toBe(def.w * 2);
    expect(big.ports.map((p) => [p.x, p.y])).toEqual(def.ports.map((p) => [p.x * 2, p.y * 2]));
    def.prims.forEach((p, i) => {
      const q = big.prims[i];
      if ('w' in p) expect((q as typeof p).w).toBe(p.w);
    });
    expect(scaleSymbol(def, 1)).toBe(def);
    expect(scaleSymbol(def, 2)).toBe(big); // cached
  });

  it('leaves arc flags and rotation alone when scaling path data', () => {
    expect(scalePath('M10 0 A5 5 30 1 0 20 10 L4,4z', 2)).toBe('M 20 0 A 10 10 30 1 0 40 20 L 8 8 z');
  });

  it('moves pins with the size, so wires follow', () => {
    const doc = produce(createDoc(), (d) => {
      const c = makeComponent(d as CircuitDoc, 'resistor', 100, 100);
      d.items[c.id] = c;
    });
    const c = Object.values(doc.items)[0] as ComponentItem;
    const port = instanceSymbol(doc, c).ports[0];
    const at1 = portPosition(doc, c, port.id)!.pt;
    const doc2 = produce(doc, (d) => void ((d.items[c.id] as ComponentItem).scale = 2));
    const at2 = portPosition(doc2, doc2.items[c.id] as ComponentItem, port.id)!.pt;
    expect(at2.x - 100).toBeCloseTo((at1.x - 100) * 2);
    expect(at2.y - 100).toBeCloseTo((at1.y - 100) * 2);
  });
});

describe('placing parts', () => {
  it('hides values by default but keeps net names on labels', () => {
    const doc = createDoc();
    expect(makeComponent(doc, 'resistor', 0, 0).showValue).toBe(false);
    expect(makeComponent(doc, 'net-label', 0, 0).showValue).toBe(true);
  });
});

describe('styling a mixed selection', () => {
  it('applies one style to parts, wires and shapes, each in its own fields', () => {
    const doc = produce(createDoc(), (d) => {
      const c = makeComponent(d as CircuitDoc, 'resistor', 0, 0);
      d.items[c.id] = c;
      const s = makeShape(d as CircuitDoc, 'rect', 0, 0, 40, 20);
      d.items[s.id] = s;
      d.items.w1 = { id: 'w1', type: 'wire', a: { kind: 'free', x: 0, y: 0 }, b: { kind: 'free', x: 50, y: 0 }, pts: [] } as WireItem;
    });
    const next = produce(doc, (d) => {
      for (const it of Object.values(d.items)) applyLook(it, { line: '#ff0000', fill: '#00ff00', width: 3, dash: 'dashed' });
    });
    const [c, s, w] = Object.values(next.items);
    expect(c).toMatchObject({ color: '#ff0000', fill: '#00ff00', lineWidth: 3, dash: 'dashed' });
    expect(s).toMatchObject({ stroke: '#ff0000', fill: '#00ff00', strokeWidth: 3, dash: 'dashed' });
    expect(s.type === 'shape' && s.fillOpacity).toBeGreaterThan(0);
    expect((w as WireItem).style).toMatchObject({ color: '#ff0000', width: 3, dash: 'dashed' });
    expect((w as WireItem).style).not.toHaveProperty('fill');
    const shared = commonLook(next, Object.values(next.items));
    expect(shared.value.line).toBe('#ff0000');
    expect(shared.mixed.has('line')).toBe(false);
  });

  it('resets to defaults with empty values', () => {
    const doc = produce(createDoc(), (d) => {
      const c = makeComponent(d as CircuitDoc, 'resistor', 0, 0);
      Object.assign(c, { color: '#f00', fill: '#0f0', lineWidth: 3 });
      d.items[c.id] = c;
    });
    const next = produce(doc, (d) => Object.values(d.items).forEach((it) => applyLook(it, { line: '', fill: '', width: 2 })));
    const c = Object.values(next.items)[0] as ComponentItem;
    expect(c.color).toBeUndefined();
    expect(c.fill).toBeUndefined();
    expect(c.lineWidth).toBeUndefined();
  });
});

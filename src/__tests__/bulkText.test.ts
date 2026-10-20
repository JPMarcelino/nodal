import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { labelLook, wireLabelLook } from '../canvas/Scene';
import { createDoc, makeComponent, makeShape } from '../model/doc';
import { getSymbol } from '../model/registry';
import { shapeText } from '../model/shapeText';
import { applyLook, commonLook } from '../model/style';
import type { CircuitDoc, ComponentItem, Item, ShapeItem, WireItem } from '../model/types';

/** A document with two net labels, a resistor, a labelled wire and a text. */
function setup() {
  return produce(createDoc(), (d) => {
    const doc = d as CircuitDoc;
    for (const [i, sym] of (['net-label', 'net-label', 'resistor'] as const).entries()) {
      const c = makeComponent(doc, sym, i * 100, 0);
      c.id = `c${i}`;
      if (sym === 'net-label') c.value = `D${i}`;
      d.items[c.id] = c;
    }
    d.items.w = { id: 'w', type: 'wire', a: { kind: 'free', x: 0, y: 100 }, b: { kind: 'free', x: 100, y: 100 }, pts: [], label: 'clk' } as WireItem;
    const t = makeShape(doc, 'text', 0, 200, 50, 20);
    t.id = 't';
    t.text = 'hello';
    d.items.t = t;
  });
}

const restyle = (doc: CircuitDoc, ids: string[], p: Parameters<typeof applyLook>[1]) =>
  produce(doc, (d) => ids.forEach((id) => applyLook(d.items[id] as Item, p)));

describe('bulk text formatting', () => {
  it('offers the same text keys for parts, labelled wires and text', () => {
    const doc = setup();
    const { keys } = commonLook(doc, ['c0', 'c1', 'c2', 'w', 't'].map((id) => doc.items[id]));
    for (const k of ['size', 'bold', 'italic', 'underline', 'allCaps', 'font', 'text', 'align'] as const) expect(keys.has(k)).toBe(true);
  });

  it('changes the size of several net labels at once', () => {
    const doc = restyle(setup(), ['c0', 'c1'], { size: 18 });
    for (const id of ['c0', 'c1']) {
      const c = doc.items[id] as ComponentItem;
      expect(labelLook(c, 'value', getSymbol(doc, c.symbol)).size).toBe(18);
    }
    const { value, mixed } = commonLook(doc, [doc.items.c0, doc.items.c1]);
    expect(value.size).toBe(18);
    expect(mixed.has('size')).toBe(false);
  });

  it('styles both labels of a part and clears the old label colour', () => {
    let doc = produce(setup(), (d) => void ((d.items.c2 as ComponentItem).labelColor = '#ff0000'));
    doc = restyle(doc, ['c2'], { italic: true, text: '#00ff00', font: 'mono' });
    const c = doc.items.c2 as ComponentItem;
    expect(c.refStyle).toMatchObject({ italic: true, color: '#00ff00', font: 'mono' });
    expect(c.valueStyle).toMatchObject({ italic: true, color: '#00ff00', font: 'mono' });
    expect(c.labelColor).toBeUndefined();
    // switching it back off leaves no empty style behind
    const off = restyle(doc, ['c2'], { italic: false, text: '', font: '' }).items.c2 as ComponentItem;
    expect(off.refStyle).toBeUndefined();
  });

  it('formats wire labels and text shapes from the same patch', () => {
    const doc = restyle(setup(), ['w', 't'], { size: 14, allCaps: true, bold: false });
    const w = doc.items.w as WireItem;
    expect(wireLabelLook(w)).toMatchObject({ text: 'CLK', size: 14, weight: 400 });
    const t = doc.items.t as ShapeItem;
    expect(t.fontSize).toBe(14);
    expect(shapeText(t)).toBe('HELLO');
  });

  it('keeps maths as written in all caps', () => {
    const t = { ...(setup().items.t as ShapeItem), text: 'gain $\\alpha$', allCaps: true };
    expect(shapeText(t)).toBe('GAIN $\\alpha$');
  });
});

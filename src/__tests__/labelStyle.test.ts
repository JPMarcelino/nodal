import { describe, expect, it } from 'vitest';
import { frozenLabelOffsets, labelBox, labelLayout, labelLook } from '../canvas/Scene';
import { labelBox as modelLabelBox, labelLayout as modelLabelLayout, labelLook as modelLabelLook } from '../model/labels';
import { createDoc, makeComponent } from '../model/doc';
import { instanceSymbol } from '../model/registry';
import type { ComponentItem } from '../model/types';

const part = (over: Partial<ComponentItem> = {}) => {
  const doc = createDoc();
  const c = { ...makeComponent(doc, 'resistor', 100, 100), ref: 'R1', value: '10k', showValue: true, ...over };
  return { c, def: instanceSymbol(doc, c) };
};

describe('part label styles', () => {
  it('keeps the canvas re-exports pointing at the model layer', () => {
    expect(labelBox).toBe(modelLabelBox);
    expect(labelLayout).toBe(modelLabelLayout);
    expect(labelLook).toBe(modelLabelLook);
  });

  it('uses the defaults when unstyled', () => {
    const { c, def } = part();
    expect(labelLook(c, 'ref', def)).toMatchObject({ text: 'R1', size: 11, weight: 650 });
    expect(labelLook(c, 'value', def)).toMatchObject({ text: '10k', size: 10.5, weight: 400 });
  });

  it('applies size, weight, prefix, suffix and caps outside maths only', () => {
    const { c, def } = part({ value: 'r $\\Omega$', valueStyle: { size: 14, bold: true, prefix: 'v = ', suffix: ' ok', allCaps: true } });
    expect(labelLook(c, 'value', def)).toMatchObject({ text: 'V = R $\\Omega$ OK', size: 14, weight: 700 });
    const { c: plain } = part({ refStyle: { bold: false } });
    expect(labelLook(plain, 'ref', def).weight).toBe(400);
  });

  it('aligns the hit box to the chosen alignment', () => {
    const { c, def } = part({ refStyle: { align: 'end' } });
    const at = { x: 50, y: 20, anchor: 'start' as const };
    const box = labelBox(at, labelLook(c, 'ref', def));
    expect(box.x + box.w).toBeCloseTo(50);
  });

  it('places both labels at a fixed spot and keeps them there when one is dragged', () => {
    const { c, def } = part({ labelSpot: 'below' });
    const L = labelLayout(c, def);
    expect(L.value!.y).toBeGreaterThan(L.ref!.y);
    expect(L.ref!.y).toBeGreaterThan(c.y);
    expect(frozenLabelOffsets(c, def)).toEqual({ labelDx: 0, labelDy: 0, valueDx: 0, valueDy: 0 });
  });
});

import { describe, expect, it } from 'vitest';
import { exportSvg } from '../io/export';
import { DASH_OPTIONS, dashArray } from '../model/dash';
import { createDoc, makeShape } from '../model/doc';
import { flipItems } from '../model/ops';
import { measureRich, wrapRich } from '../model/richText';
import { measureTextShape, shapeText } from '../model/shapeText';
import { applyLook, lookOf } from '../model/style';
import type { CircuitDoc, ShapeItem } from '../model/types';

function docWith(...shapes: ShapeItem[]): CircuitDoc {
  const doc = createDoc();
  for (const s of shapes) doc.items[s.id] = s;
  return doc;
}

describe('wrapping', () => {
  const w = (s: string) => measureRich(s, 12, 400).w;

  it('breaks at spaces so no line is wider than the limit', () => {
    const text = 'alpha beta gamma delta epsilon';
    const out = wrapRich(text, 12, 400, w('alpha beta') + 1);
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(text);
    for (const l of lines) expect(w(l)).toBeLessThanOrEqual(w('alpha beta') + 1);
  });

  it('leaves text that fits, and the author’s own breaks, alone', () => {
    expect(wrapRich('one two', 12, 400, 1000)).toBe('one two');
    expect(wrapRich('a\nb c', 12, 400, 1000)).toBe('a\nb c');
    expect(wrapRich('', 12, 400, 10)).toBe('');
  });

  it('keeps a long word whole, even when it overflows', () => {
    expect(wrapRich('supercalifragilistic is long', 12, 400, 20).split('\n')).toEqual(['supercalifragilistic', 'is', 'long']);
  });

  it('keeps a formula in one piece', () => {
    const out = wrapRich('see $a + b$ and $$x^2 + y$$ here', 12, 400, 10);
    const lines = out.split('\n');
    expect(lines).toContain('$a + b$');
    expect(lines).toContain('$$x^2 + y$$');
    // formulas glued to words stay glued
    expect(wrapRich('x=$a b$,', 12, 400, 10)).toBe('x=$a b$,');
  });

  it('wraps box titles to the box and free text to its wrap width', () => {
    const rect = { ...makeShape(createDoc(), 'rect', 0, 0, 90, 60), text: 'alpha beta gamma delta epsilon' };
    expect(shapeText(rect).split('\n').length).toBeGreaterThan(1);
    const free = { ...makeShape(createDoc(), 'text', 0, 0, 10, 10), text: 'alpha beta gamma delta' };
    expect(shapeText(free)).toBe(free.text);
    const narrow = { ...free, wrapW: 60 };
    expect(shapeText(narrow).split('\n').length).toBeGreaterThan(1);
    expect(measureTextShape(narrow).w).toBe(60);
  });
});

describe('line styles', () => {
  it('maps every style to a dash pattern', () => {
    expect(DASH_OPTIONS.map((o) => o.value)).toEqual(['solid', 'dashed', 'dotted', 'dash-dot', 'long-dash']);
    expect(dashArray('solid', 2)).toBeUndefined();
    expect(dashArray('dashed', 2)).toBe('8 6');
    expect(dashArray('dotted', 2)).toBe('0.01 5');
    expect(dashArray('dash-dot', 2)).toBe('8 5 0.01 5');
    expect(dashArray('long-dash', 2)).toBe('18 8');
    expect(dashArray('dash-dot', 2, true)).toBe('6 4 0.01 4');
    for (const o of DASH_OPTIONS.slice(1)) expect(dashArray(o.value, 3)).toMatch(/^[\d. ]+$/);
  });
});

describe('exporting styled shapes', () => {
  const styled = () => {
    const d0 = createDoc();
    const a = { ...makeShape(d0, 'rect', 0, 0, 80, 40), fill: '#ff0000', fillOpacity: 1, gradient: { to: '#0000ff', angle: 45 }, shadow: true, opacity: 0.5, strokeOpacity: 0.4, cap: 'round', join: 'bevel', dash: 'dash-dot', italic: true, font: 'serif', text: 'Hi' } as ShapeItem;
    const b = { ...makeShape(d0, 'ellipse', 200, 0, 80, 40), fill: '#00ff00', fillOpacity: 1, gradient: { to: '#ffffff', angle: 0 } } as ShapeItem;
    return { doc: docWith(a, b), a, b };
  };

  it('defines the gradients and the shadow filter in the svg', () => {
    const { doc, a, b } = styled();
    const { svg } = exportSvg(doc, { theme: 'light', background: false, padding: 10 });
    expect(svg).toContain('id="nodal-shadow"');
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('<feDropShadow');
    expect(svg.match(/id="nodal-shadow"/g)).toHaveLength(1);
    expect(svg).toContain(`id="nodal-grad-${a.id}"`);
    expect(svg).toContain(`id="nodal-grad-${b.id}"`);
    expect(svg).toContain(`fill="url(#nodal-grad-${a.id})"`);
    expect(svg).toContain('filter="url(#nodal-shadow)"');
    expect(svg).toContain('stroke-linejoin="bevel"');
    expect(svg).toContain('font-style:italic');
  });

  it('includes only the definitions a selection uses', () => {
    const { doc, a, b } = styled();
    const { svg } = exportSvg(doc, { theme: 'light', background: false, padding: 10, ids: [b.id] });
    expect(svg).toContain(`id="nodal-grad-${b.id}"`);
    expect(svg).not.toContain(`nodal-grad-${a.id}`);
    expect(svg).not.toContain('nodal-shadow');
  });

  it('adds no definitions to a plain drawing', () => {
    const doc = docWith(makeShape(createDoc(), 'rect', 0, 0, 40, 40));
    expect(exportSvg(doc, { theme: 'light', background: false, padding: 10 }).svg).not.toContain('<defs');
  });
});

describe('copying a style', () => {
  it('carries the text, line, fill and effect options', () => {
    const d0 = createDoc();
    const from = {
      ...makeShape(d0, 'rect', 0, 0, 80, 40),
      fill: '#112233',
      fillOpacity: 0.6,
      gradient: { to: '#445566', angle: 120 },
      fontSize: 20,
      bold: false,
      italic: true,
      underline: true,
      font: 'mono',
      align: 'end',
      valign: 'bottom',
      strokeOpacity: 0.3,
      cap: 'square',
      join: 'round',
      dash: 'long-dash',
      radius: 12,
      opacity: 0.7,
      shadow: true,
    } as ShapeItem;
    const to = makeShape(d0, 'rect', 0, 0, 10, 10);
    const copied = lookOf(docWith(from, to), from);
    applyLook(to, copied);
    expect(lookOf(docWith(from, to), to)).toEqual(copied);
    expect(to).toMatchObject({ fontSize: 20, bold: false, italic: true, underline: true, font: 'mono', align: 'end', valign: 'bottom', strokeOpacity: 0.3, cap: 'square', join: 'round', dash: 'long-dash', radius: 12, opacity: 0.7, shadow: true, gradient: { to: '#445566', angle: 120 } });
  });

  it('removes what the source does not have', () => {
    const d0 = createDoc();
    const plain = makeShape(d0, 'rect', 0, 0, 10, 10);
    const fancy = { ...makeShape(d0, 'rect', 0, 0, 10, 10), shadow: true, opacity: 0.5, italic: true, gradient: { to: '#fff', angle: 0 }, fill: '#123456', fillOpacity: 1 } as ShapeItem;
    applyLook(fancy, lookOf(docWith(plain, fancy), plain));
    expect(fancy.shadow).toBeUndefined();
    expect(fancy.opacity).toBeUndefined();
    expect(fancy.italic).toBeUndefined();
    expect(fancy.gradient).toBeUndefined();
  });

  it('turns a flat fill into a gradient and back', () => {
    const d0 = createDoc();
    const s = makeShape(d0, 'zone', 0, 0, 10, 10);
    applyLook(s, { fillKind: 'gradient' });
    expect(s.gradient).toBeDefined();
    expect(s.fillOpacity).toBeGreaterThan(0);
    applyLook(s, { fillKind: 'none' });
    expect(s.fill).toBe('none');
    expect(s.gradient).toBeUndefined();
  });
});

describe('flipping images', () => {
  it('mirrors the picture itself', () => {
    const img = { ...makeShape(createDoc(), 'image', 0, 0, 40, 20), src: 'data:image/png;base64,AAAA' } as ShapeItem;
    const doc = docWith(img);
    flipItems(doc, new Set([img.id]), 'x');
    expect((doc.items[img.id] as ShapeItem).flipX).toBe(true);
    flipItems(doc, new Set([img.id]), 'x');
    expect((doc.items[img.id] as ShapeItem).flipX).toBeFalsy();
    // a vertical flip is a mirror plus a half turn
    flipItems(doc, new Set([img.id]), 'y');
    expect(doc.items[img.id]).toMatchObject({ flipX: true, rot: 180 });
  });
});

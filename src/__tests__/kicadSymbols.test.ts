import { describe, expect, it } from 'vitest';
import { kicadText, kicadToSymbols, parseSExpr, readKicadLibrary } from '../io/kicadSymbols';
import { searchKicad, type KicadIndex } from '../model/kicadLibrary';
import { toWorld } from '../model/geometry';
import type { SymbolDef } from '../model/types';

const pin = (type: string, style: string, x: number, y: number, a: number, len: number, name: string, num: string) =>
  `(pin ${type} ${style} (at ${x} ${y} ${a}) (length ${len}) (name "${name}" (effects (font (size 1.27 1.27)))) (number "${num}" (effects (font (size 1.27 1.27)))))`;

const LIB = `(kicad_symbol_lib (version 20251024) (generator "kicad_symbol_editor")
  (symbol "R" (pin_numbers (hide yes)) (pin_names (offset 0))
    (property "Reference" "R" (at 2.032 0 90)) (property "Value" "R" (at 0 0 90))
    (property "Description" "Resistor") (property "ki_keywords" "R res resistor")
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "R_1_1" ${pin('passive', 'line', 0, 3.81, 270, 1.27, '', '1')} ${pin('passive', 'line', 0, -3.81, 90, 1.27, '', '2')}))
  (symbol "R_Big" (extends "R") (property "Reference" "R" (at 0 0 0)) (property "Value" "R_Big" (at 0 0 0)) (property "Description" "Big resistor"))
  (symbol "DUAL" (pin_names (offset 1.016))
    (property "Reference" "U" (at 0 0 0)) (property "Value" "DUAL" (at 0 0 0))
    (symbol "DUAL_1_1" (polyline (pts (xy -5.08 5.08) (xy 5.08 0) (xy -5.08 -5.08) (xy -5.08 5.08)) (stroke (width 0.254) (type default)) (fill (type background)))
      ${pin('input', 'line', -7.62, 2.54, 0, 2.54, '+', '3')} ${pin('input', 'inverted', -7.62, -2.54, 0, 2.54, '~{EN}', '2')} ${pin('output', 'line', 7.62, 0, 180, 2.54, '~', '1')})
    (symbol "DUAL_2_1" (polyline (pts (xy -5.08 5.08) (xy 5.08 0) (xy -5.08 -5.08) (xy -5.08 5.08)) (stroke (width 0.254) (type default)) (fill (type background)))
      ${pin('input', 'line', -7.62, 2.54, 0, 2.54, '+', '5')} ${pin('output', 'line', 7.62, 0, 180, 2.54, '~', '7')})
    (symbol "DUAL_3_1" ${pin('power_in', 'line', -2.54, 7.62, 270, 3.81, 'V+', '8')} ${pin('power_in', 'line', -2.54, -7.62, 90, 3.81, 'V-', '4')}))
  (symbol "GND" (power global) (pin_names (offset 0) (hide yes))
    (property "Reference" "#PWR" (at 0 0 0)) (property "Value" "GND" (at 0 0 0))
    (symbol "GND_0_1" (arc (start 0 -1.27) (mid 1.27 -2.54) (end 0 -3.81) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "GND_1_1" ${pin('power_in', 'line', 0, 0, 270, 0, 'GND', '1')})))`;

/** World positions of a symbol's pins when placed with its centre on (300, 300) at each rotation. */
const placedPins = (def: SymbolDef) =>
  ([0, 90, 180, 270] as const).flatMap((rot) => def.ports.map((p) => toWorld({ x: 300, y: 300, rot, flipX: false }, def, p.x, p.y)));

describe('KiCad symbol import', () => {
  const defs = kicadToSymbols(LIB, 'Test');
  const byId = (id: string) => defs.find((d) => d.id === id)!;

  it('parses S-expressions with quoted strings and escapes', () => {
    expect(parseSExpr('(a "b c" (d "e\\"f") 1.5)')).toEqual([['a', 'b c', ['d', 'e"f'], '1.5']]);
  });

  it('draws a part at 10 px per 50 mil, pins on the outer end of their lines', () => {
    const r = byId('kicad:Test:R');
    expect(r).toMatchObject({ name: 'R', prefix: 'R', value: 'R', category: 'KiCad: Test', w: 20, h: 60 });
    expect(r.ports.map((p) => [p.id, p.x, p.y, p.side])).toEqual([
      ['1', 10, 0, 'top'],
      ['2', 10, 60, 'bottom'],
    ]);
    expect(r.prims).toContainEqual({ t: 'rect', x: 2, y: 10, w: 16, h: 40, fill: 'none' });
    expect(r.keywords).toContain('resistor');
  });

  it('keeps every pin on the grid wherever the part is placed and however it is turned', () => {
    for (const d of defs) for (const p of placedPins(d)) expect([p.x % 10, p.y % 10]).toEqual([0, 0]);
  });

  it('gives a derived part its parent drawing and its own properties', () => {
    const big = byId('kicad:Test:R_Big');
    expect(big.prims).toEqual(byId('kicad:Test:R').prims);
    expect(big).toMatchObject({ value: 'R_Big', fields: [{ key: 'description', default: 'Big resistor' }] });
    const lib = readKicadLibrary(LIB);
    expect(lib.parts.find((p) => p.name === 'R_Big')?.root).toBe('R');
    expect(lib.drawings.has('R_Big')).toBe(false);
  });

  it('turns extra units into types of the first', () => {
    const a = byId('kicad:Test:DUAL');
    expect(a.variantName).toBe('Unit A');
    expect(a.variants).toEqual([
      { id: 'kicad:Test:DUAL#B', name: 'Unit B' },
      { id: 'kicad:Test:DUAL#C', name: 'Unit C' },
    ]);
    expect(byId('kicad:Test:DUAL#B')).toMatchObject({ variantOf: a.id, prefix: 'U' });
    expect(byId('kicad:Test:DUAL#B').ports.map((p) => p.id)).toEqual(['5', '7']);
    expect(byId('kicad:Test:DUAL#C').ports.map((p) => p.name)).toEqual(['V+', 'V-']);
  });

  it('draws pin styles and names: bubbles, overbars, hidden "~" names', () => {
    const a = byId('kicad:Test:DUAL');
    expect(a.prims.some((p) => p.t === 'circle' && p.r === 3)).toBe(true);
    const texts = a.prims.flatMap((p) => (p.t === 'text' ? [p.text] : []));
    expect(texts).toContain('+');
    expect(texts).toContain('E̅N̅');
    expect(texts).not.toContain('~');
    // the background-filled body is drawn over the pin lines, names over the body
    const body = a.prims.findIndex((p) => p.t === 'poly');
    expect(a.prims.findIndex((p) => p.t === 'line')).toBeLessThan(body);
    expect(a.prims.findIndex((p) => p.t === 'text')).toBeGreaterThan(body);
    expect(a.prims[body]).toMatchObject({ fill: 'bg' });
  });

  it('marks power symbols and draws three-point arcs through their middle', () => {
    const g = byId('kicad:Test:GND');
    expect(g).toMatchObject({ prefix: '#PWR', value: 'GND', hideLabels: true, valueIsLabel: true });
    const arc = g.prims.find((p) => p.t === 'line')!;
    if (arc.t !== 'line') throw new Error('no arc');
    const pts = arc.pts;
    // the arc bulges right (x = +10 px from the pin at its middle)
    const xs = pts.filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs) - xs[0]).toBeCloseTo(10, 0);
    expect(g.prims.some((p) => p.t === 'text')).toBe(false);
  });

  it('reads KiCad text markup', () => {
    expect(kicadText('~{CS}')).toBe('C̅S̅');
    expect(kicadText('V_{CC}')).toBe('VCC');
    expect(kicadText('A{slash}B')).toBe('A/B');
  });
});

describe('KiCad library search', () => {
  const ix: KicadIndex = {
    format: 1,
    version: 'test',
    libs: [
      { name: 'Device', group: 'Basic components' },
      { name: 'Amplifier_Operational', group: 'Amplifiers & comparators' },
    ],
    parts: [
      [1, 'LM358', 0, 'U', '', 'Dual op-amp', 'dual opamp', 3, 0, '', ''],
      [1, 'LM358_DFN', 1, 'U', '', 'Dual op-amp, DFN', 'dual opamp', 3, 0, '', ''],
      [0, 'R', 0, 'R', '', 'Resistor', 'R res resistor', 1, 0, '', ''],
      [0, 'R_Small', 1, 'R', '', 'Resistor, small symbol', 'R res resistor', 1, 0, '', ''],
    ],
  };

  it('puts exact and generic names first and needs every word', () => {
    expect(searchKicad(ix, 'lm358').map((e) => e[1])).toEqual(['LM358', 'LM358_DFN']);
    expect(searchKicad(ix, 'resistor').map((e) => e[1])).toEqual(['R', 'R_Small']);
    expect(searchKicad(ix, 'opamp dfn').map((e) => e[1])).toEqual(['LM358_DFN']);
    expect(searchKicad(ix, '  ')).toEqual([]);
  });
});

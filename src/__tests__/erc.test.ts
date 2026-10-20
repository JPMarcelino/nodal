import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, normalizeDoc, uid } from '../model/doc';
import { runErc, splitIgnored, type ErcIssue } from '../model/erc';
import { hasMath, loadMath, mathLines, scrubMathSvg, splitMath, stripMath, texToSvg } from '../model/latex';
import { computeNets } from '../model/netlist';
import { measureRich } from '../model/richText';
import type { CircuitDoc, ComponentItem, WireItem } from '../model/types';

function place(doc: CircuitDoc, symbol: string, x: number, y: number, rot: ComponentItem['rot'] = 0) {
  const c = makeComponent(doc, symbol, x, y, rot);
  doc.items[c.id] = c;
  return c;
}
function wire(doc: CircuitDoc, a: ComponentItem, pa: string, b: ComponentItem, pb: string) {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: a.id, port: pa }, b: { kind: 'port', comp: b.id, port: pb }, pts: [] };
  doc.items[w.id] = w;
  return w;
}
const rules = (doc: CircuitDoc) => runErc(doc).map((i) => i.rule);

describe('electrical rules check', () => {
  it('flags unconnected pins, and is quiet once they are wired', () => {
    const doc = createDoc();
    const r = place(doc, 'resistor', 0, 0);
    expect(rules(doc)).toContain('unconnected-pin');
    const v = place(doc, 'vcc', 200, -200);
    wire(doc, r, '1', v, 'VCC');
    const issues = runErc(doc).filter((i) => i.items.includes(r.id) && i.rule === 'unconnected-pin');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/pin 2/);
  });

  it('reports duplicate references as errors', () => {
    const doc = produce(createDoc(), (d) => {
      const a = place(d as CircuitDoc, 'resistor', 0, 0);
      const b = place(d as CircuitDoc, 'resistor', 200, 0);
      b.ref = a.ref;
    });
    const dup = runErc(doc).find((i) => i.rule === 'duplicate-ref');
    expect(dup?.severity).toBe('error');
  });

  it('connects pins that touch, and a no-connect flag on a pin silences it', () => {
    const doc = createDoc();
    const r1 = place(doc, 'resistor', 0, 0);
    place(doc, 'resistor', 80, 0); // pin 2 of r1 sits on pin 1 of r2
    const nets = computeNets(doc);
    expect(nets.some((n) => n.pins.length === 2)).toBe(true);
    // r1 pin 1 is open; cap it with a no-connect flag sitting on the pin
    // r1 pin 1 is at (-40, 0); the flag's pin is 10 px left of its centre
    place(doc, 'no-connect', -30, 0);
    const open = runErc(doc).filter((i) => i.rule === 'unconnected-pin' && i.items.includes(r1.id));
    expect(open).toHaveLength(0);
  });

  it('warns about shorted supply rails', () => {
    const doc = createDoc();
    const a = place(doc, 'vcc', 0, 0);
    const b = place(doc, 'vcc', 200, 0);
    b.value = '+3V3';
    a.value = '+5V';
    wire(doc, a, 'VCC', b, 'VCC');
    const short = runErc(doc).find((i) => i.rule === 'shorted-nets');
    expect(short?.severity).toBe('error');
  });

  it('does not flag a net label joined by a wire label as single-use', () => {
    const doc = createDoc();
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: a.id, port: '2' }, b: { kind: 'port', comp: b.id, port: '1' }, pts: [], label: 'SDA' };
    doc.items[w.id] = w;
    const c = place(doc, 'resistor', 400, 0);
    const lbl = place(doc, 'net-label', 800, 0);
    lbl.value = 'SDA';
    wire(doc, c, '1', lbl, 'N');
    expect(computeNets(doc).filter((n) => n.name === 'SDA')).toHaveLength(1);
    expect(runErc(doc).some((i) => i.rule === 'single-label')).toBe(false);
  });
});

describe('splitIgnored', () => {
  const keys = ['a', 'b', 'c'];
  const issues = (ks: string[]): ErcIssue[] => ks.map((key) => ({ key, rule: 'loose-end', severity: 'warning', message: key, items: [], at: null }));
  it('treats a missing list as empty', () => {
    const { active, ignored } = splitIgnored(issues(keys), undefined);
    expect(active.map((i) => i.key)).toEqual(keys);
    expect(ignored).toEqual([]);
  });
  it('treats an empty list as empty', () => {
    const { active, ignored } = splitIgnored(issues(keys), []);
    expect(active).toHaveLength(3);
    expect(ignored).toEqual([]);
  });
  it('ignores one key out of several and keeps order', () => {
    const { active, ignored } = splitIgnored(issues(keys), ['b']);
    expect(active.map((i) => i.key)).toEqual(['a', 'c']);
    expect(ignored.map((i) => i.key)).toEqual(['b']);
  });
  it('ignores stale keys that match nothing', () => {
    const { active, ignored } = splitIgnored(issues(['a']), ['stale', 'a']);
    expect(active).toEqual([]);
    expect(ignored.map((i) => i.key)).toEqual(['a']);
  });
  it('does not change runErc output, only the split', () => {
    const doc = createDoc();
    const label = place(doc, 'net-label', 0, 0);
    const all = runErc(doc);
    const single = all.find((i) => i.key === `single-label:${label.id}`);
    expect(single).toBeDefined();
    const { active, ignored } = splitIgnored(all, [`single-label:${label.id}`]);
    expect(ignored.map((i) => i.key)).toContain(`single-label:${label.id}`);
    expect(active.every((i) => i.key !== `single-label:${label.id}`)).toBe(true);
    // other findings for the same label (e.g. unconnected-label) stay active
    expect(active.length).toBe(all.length - 1);
    // runErc itself still reports it
    expect(runErc(doc).some((i) => i.key === `single-label:${label.id}`)).toBe(true);
  });
  it('loading a file without ercIgnored, or with a non-array value, does not crash', () => {
    const base = createDoc();
    expect(normalizeDoc(structuredClone({ ...base, settings: {} })).settings.ercIgnored).toBeUndefined();
    expect(normalizeDoc(structuredClone({ ...base, settings: { ercIgnored: 'nope' } })).settings.ercIgnored).toBeUndefined();
  });
});

describe('latex', () => {
  it('splits text into plain and maths runs', () => {
    expect(splitMath('Gain $A_v = -R_f/R_1$ here')).toEqual([
      { math: false, text: 'Gain ' },
      { math: true, tex: 'A_v = -R_f/R_1', display: false },
      { math: false, text: ' here' },
    ]);
    expect(splitMath('costs \\$5')).toEqual([{ math: false, text: 'costs $5' }]);
    expect(stripMath('$$\\frac{1}{2}$$')).toBe('\\frac{1}{2}');
  });

  it('leaves prices and loose dollar signs as text', () => {
    expect(hasMath('Costs $5 and $10 total')).toBe(false);
    expect(hasMath('from $ 5 to $ 9')).toBe(false);
    expect(hasMath('$x$')).toBe(true);
    expect(hasMath('a $x$, then $y$2')).toBe(true);
    expect(splitMath('$a$5 and $b$')).toEqual([{ math: false, text: '$a$5 and ' }, { math: true, tex: 'b', display: false }]);
  });

  it('keeps a display formula that spans lines on one line', () => {
    expect(mathLines('one\n$$a\\\\\nb$$ two\nthree')).toEqual(['one', '$$a\\\\\nb$$ two', 'three']);
    expect(mathLines('$a$\n$b$')).toEqual(['$a$', '$b$']);
  });

  it('reports broken formulas and knows the common siunitx commands', async () => {
    await loadMath();
    const bad = texToSvg('\\frac{1')!;
    expect(bad.error).toBe(true);
    expect(bad.message).toBeTruthy();
    expect(texToSvg('\\SI{10}{\\kilo\\ohm} + \\si{\\micro\\farad}')!.error).toBe(false);
  });

  it('typesets formulas to SVG paths', async () => {
    await loadMath();
    const svg = texToSvg('V_{out} = \\frac{R_2}{R_1 + R_2} V_{in}')!;
    expect(svg.error).toBe(false);
    expect(svg.body).toContain('<path');
    expect(svg.wEx).toBeGreaterThan(5);
    expect(measureRich('$\\frac{1}{2}$', 16).h).toBeGreaterThan(16);
  });

  it('scrubs handlers and dangerous links from math SVG (injected as HTML)', () => {
    expect(scrubMathSvg('<a href="javascript:alert(1)"><path d="M0 0"/></a>')).toBe('<a><path d="M0 0"/></a>');
    expect(scrubMathSvg("<a xlink:href='data:text/html,evil'>x</a>")).toBe('<a>x</a>');
    expect(scrubMathSvg('<g onload="evil()">x</g>')).toBe('<g>x</g>');
    // ordinary output and safe links pass through untouched
    expect(scrubMathSvg('<path d="M0 0L10 10" fill="currentColor"/>')).toBe('<path d="M0 0L10 10" fill="currentColor"/>');
    expect(scrubMathSvg('<a href="https://example.com">x</a>')).toContain('https://example.com');
    expect(scrubMathSvg('<a href="#x">x</a>')).toContain('#x');
  });
});

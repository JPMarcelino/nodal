import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, makeShape, normalizeDoc, uid } from '../model/doc';
import type { WireItem } from '../model/types';
import { wirePolyline } from '../model/wires';
import { clipAreaDoc, exportSvg, exportDxf, EXPORT_THEMES, pageTitle, plainColours, selectionDoc } from '../io/export';
import { pagePalette } from '../canvas/Scene';
import { addPage, viewDoc } from '../model/pages';
import { scrubMathSvg } from '../model/latex';

function twoResistors() {
  const doc = createDoc();
  const c1 = makeComponent(doc, 'resistor', 100, 100);
  doc.items[c1.id] = c1;
  const c2 = makeComponent(doc, 'resistor', 300, 100);
  doc.items[c2.id] = c2;
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: c1.id, port: '2' }, b: { kind: 'port', comp: c2.id, port: '1' }, pts: [] };
  doc.items[w.id] = w;
  return { doc, c1, c2, w };
}

describe('selectionDoc', () => {
  it('keeps a wire-only selection renderable by re-anchoring dangling ends', () => {
    const { doc, w } = twoResistors();
    const before = wirePolyline(doc, w);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const d = selectionDoc(doc, [w.id]);
    const kept = d.items[w.id] as WireItem;
    expect(kept).toBeDefined();
    expect(kept.a.kind).toBe('free');
    expect(kept.b.kind).toBe('free');
    // original endpoints were at the ports, so the frozen wire matches the original shape
    expect(wirePolyline(d, kept)).toEqual(before);
    // original doc untouched
    expect((doc.items[w.id] as WireItem).a.kind).toBe('port');
  });

  it('pulls in wires connecting two selected components', () => {
    const { doc, c1, c2, w } = twoResistors();
    const d = selectionDoc(doc, [c1.id, c2.id]);
    expect(d.items[w.id]).toBeDefined();
    const kept = d.items[w.id] as WireItem;
    expect(kept.a).toEqual({ kind: 'port', comp: c1.id, port: '2' });
    expect(wirePolyline(d, kept).length).toBeGreaterThanOrEqual(2);
  });

  it('freezes only the unselected end of a partly-selected wire', () => {
    const { doc, c1, w } = twoResistors();
    const d = selectionDoc(doc, [w.id, c1.id]);
    const kept = d.items[w.id] as WireItem;
    expect(kept.a).toEqual({ kind: 'port', comp: c1.id, port: '2' });
    expect(kept.b.kind).toBe('free');
    expect(wirePolyline(d, kept).length).toBeGreaterThanOrEqual(2);
  });

  it('exportSvg({ids:[wire]}) keeps a wire connecting unselected items', () => {
    const { doc, w } = twoResistors();
    const { svg } = exportSvg(doc, { theme: 'light', background: false, padding: 10, ids: [w.id] });
    expect(svg).toContain(`data-id="${w.id}"`);
  });

  it('writes concrete colours for a dark export (no currentColor or CSS variables)', () => {
    const { doc } = twoResistors();
    const { svg } = exportSvg(doc, { theme: 'dark', background: true, padding: 10 });
    expect(svg).not.toMatch(/currentColor|--sym-bg|var\(/);
    expect(svg).toContain('stroke="#e6dfcf"');
  });

  it('keeps a part colour, and the light theme symbol colour, in the export', () => {
    const { doc, c1 } = twoResistors();
    c1.color = '#ff0000';
    const { svg } = exportSvg(doc, { theme: 'light', background: true, padding: 10 });
    expect(svg).toContain('stroke="#ff0000"');
    expect(svg).toContain('stroke="#1f1c16"');
    expect(svg).not.toMatch(/currentColor|color:/);
  });

  it('leaves symbol interiors and page-coloured fills see-through without a background', () => {
    const doc = createDoc();
    const op = makeComponent(doc, 'opamp', 100, 100);
    doc.items[op.id] = op;
    const box = makeShape(doc, 'rect', 300, 100, 60, 40);
    Object.assign(box, { fill: '#0f0e0c', fillOpacity: 1 });
    doc.items[box.id] = box;
    const solid = exportSvg(doc, { theme: 'light', background: true, padding: 10 }).svg;
    expect(solid).toContain('fill="#ffffff"');
    expect(solid).not.toContain('#0f0e0c');
    const clear = exportSvg(doc, { theme: 'dark', background: false, padding: 10 }).svg;
    expect(clear).not.toContain('#0f0e0c');
    expect(exportSvg(doc, { theme: 'dark', background: false, padding: 10, opaqueSymbols: true }).svg).toContain('#0f0e0c');
  });

  it('fills part interiors with the document page colour in an export', () => {
    const doc = createDoc();
    const op = makeComponent(doc, 'opamp', 100, 100);
    doc.items[op.id] = op;
    doc.settings.background = '#eeeeee';
    const svg = exportSvg(doc, { theme: 'dark', background: true, padding: 10 }).svg;
    // the page rect, the op-amp body and its label backdrop all use the page colour
    expect((svg.match(/fill="#eeeeee"/g) ?? []).length).toBeGreaterThan(1);
    expect(svg).not.toContain('fill="#0f0e0c"');
  });

  it('keeps black parts readable: black ink follows the page, not the literal colour', () => {
    const { doc, c1 } = twoResistors();
    c1.color = '#000000';
    const dark = exportSvg(doc, { theme: 'dark', background: true, padding: 10 }).svg;
    expect(dark).toContain('stroke="#e6dfcf"');
    expect(dark).not.toContain('stroke="#000000"');
    const light = exportSvg(doc, { theme: 'light', background: true, padding: 10 }).svg;
    expect(light).toContain('stroke="#000000"');
    // on a page with its own white background, black stays black even in dark theme
    doc.settings.background = '#ffffff';
    expect(exportSvg(doc, { theme: 'dark', background: true, padding: 10 }).svg).toContain('stroke="#000000"');
  });

  it('follows the document background, not the theme, when the drawing sets one', () => {
    // dark theme on a white page: parts, wires and labels must stay dark
    const { doc } = twoResistors();
    doc.settings.background = '#ffffff';
    const white = exportSvg(doc, { theme: 'dark', background: true, padding: 10 }).svg;
    expect(white).toContain('stroke="#1f1c16"');
    expect(white).not.toContain('stroke="#e6dfcf"');
    expect(white).toContain('fill="#ffffff"');
    // light theme on a dark page: the other way round
    doc.settings.background = '#112233';
    const dark = exportSvg(doc, { theme: 'light', background: true, padding: 10 }).svg;
    expect(dark).toContain('stroke="#e6dfcf"');
    expect(dark).toContain('fill="#112233"');
    // without a page colour the chooser's theme still decides
    doc.settings.background = '';
    expect(pagePalette(doc.settings, EXPORT_THEMES.dark)).toBe(EXPORT_THEMES.dark);
    expect(exportSvg(doc, { theme: 'dark', background: true, padding: 10 }).svg).toContain('stroke="#e6dfcf"');
  });

  it('reads named, rgb and alpha hex page colours, not only #rgb / #rrggbb', () => {
    // dark theme on a page named white: parts must still turn dark, not stay light
    for (const background of ['white', 'rgb(255 255 255)', 'rgb(255, 255, 255)', '#ffffffff']) {
      const page = pagePalette({ background }, EXPORT_THEMES.dark);
      expect(page.bg).toBe(background);
      expect(page.symBg).toBe(background);
      expect(page.sym).toBe('#1f1c16');
      expect(page.label).toBe('#1f1c16');
      expect(page.ink).toBe('#000000');
    }
    // and the other way round: a dark named / rgba page under the light theme
    for (const background of ['black', 'rgb(17 34 51)', 'hsla(210, 50%, 13%, 1)']) {
      const page = pagePalette({ background }, EXPORT_THEMES.light);
      expect(page.sym).toBe('#e6dfcf');
      expect(page.ink).toBe('#e6dfcf');
    }
  });

  it('leaves the theme palette intact when a page colour cannot be read', () => {
    // no DOM in a node test, so var() cannot be resolved here; the whole palette must stay the theme's
    expect(pagePalette({ background: 'var(--canvas)' }, EXPORT_THEMES.dark)).toBe(EXPORT_THEMES.dark);
    expect(pagePalette({ background: 'transparent' }, EXPORT_THEMES.light)).toBe(EXPORT_THEMES.light);
  });

  it('keeps symbol interiors see-through on a custom page when the export has no background', () => {
    const doc = createDoc();
    const op = makeComponent(doc, 'opamp', 100, 100);
    doc.items[op.id] = op;
    doc.settings.background = '#ffffff';
    const clear = exportSvg(doc, { theme: 'dark', background: false, padding: 10 }).svg;
    expect(clear).not.toContain('fill="#ffffff"');
    expect(clear).toContain('stroke="#1f1c16"');
  });

  it('escapes a crafted page colour instead of injecting markup into the SVG', () => {
    const doc = createDoc();
    const op = makeComponent(doc, 'opamp', 100, 100);
    doc.items[op.id] = op;
    doc.settings.background = 'x"><img src=x onerror=alert(1)><z fill="';
    const svg = exportSvg(doc, { theme: 'light', background: true, padding: 10 }).svg;
    expect(svg).not.toMatch(/<img\b/);
    expect(svg).not.toMatch(/<z\b/);
    expect(svg).not.toContain('"><img');
    // the same value is escaped in the page rect and in symbol interiors
    expect(svg).toContain('fill="x&#34;&#62;&#60;img');
  });

  it('keeps colours CSS.supports accepts but drops unsafe page colours when loading', () => {
    const doc = createDoc();
    const loaded = (background: string) => {
      doc.settings.background = background;
      return normalizeDoc(JSON.parse(JSON.stringify(doc))).settings.background;
    };
    for (const ok of [
      '#112233',
      'rgba(1, 2, 3, 0.5)',
      'oklch(0.55 0.1 200)',
      'lab(50% 40 59)',
      'color-mix(in srgb, red, blue)',
      'var(--canvas)',
    ]) {
      expect(loaded(ok)).toBe(ok);
    }
    for (const bad of [
      'x"><img src=x onerror=alert(1)><z fill="',
      'red;background:url(http://evil)',
      'url(http://evil/x)',
      'red}',
      'red&blue',
      "red'blue",
      'red`blue',
      'red\\blue',
    ]) {
      expect(loaded(bad)).toBe('');
    }
  });

  it('draws junction dots in an area export', () => {
    const doc = createDoc();
    const j = { id: uid('j'), type: 'junction', x: 100, y: 100 } as const;
    doc.items[j.id] = j as never;
    for (const [x, y] of [[0, 100], [200, 100], [100, 200]]) {
      const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'junction', id: j.id }, b: { kind: 'free', x, y }, pts: [] };
      doc.items[w.id] = w;
    }
    const page = exportSvg(doc, { theme: 'dark', background: false, padding: 10 }).svg;
    const area = exportSvg(doc, { theme: 'dark', background: false, padding: 10, clip: { x: 50, y: 50, w: 100, h: 100 } }).svg;
    const dots = (svg: string) => (svg.match(/<circle/g) ?? []).length;
    expect(dots(page)).toBeGreaterThan(0);
    expect(dots(area)).toBe(dots(page));
  });

  it('writes black as ACI 7 in DXF', () => {
    const doc = createDoc();
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: 0, y: 0 }, b: { kind: 'free', x: 50, y: 0 }, pts: [], style: { color: '#000000' } } as WireItem;
    doc.items[w.id] = w;
    expect(exportDxf(doc)).not.toMatch(/\n62\n8\n/);
  });

  it('keeps a cut wire in its place in the stack in an area export', () => {
    const doc = createDoc();
    const shape = makeShape(doc, 'rect', 0, 0, 200, 100);
    shape.z = 7;
    doc.items[shape.id] = shape;
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: -50, y: 50 }, b: { kind: 'free', x: 250, y: 50 }, pts: [], z: 2 };
    doc.items[w.id] = w;
    const cut = Object.values(clipAreaDoc(doc, { x: 0, y: 0, w: 100, h: 100 }).items).find((it) => it.type === 'wire');
    expect(cut?.z).toBe(2);
  });

  it('hides what is behind a page-coloured body in a transparent export, without painting a colour', () => {
    const doc = createDoc();
    const pane = makeShape(doc, 'rect', 0, 0, 200, 100);
    Object.assign(pane, { fill: '#0f0e0c', fillOpacity: 1, z: 0 });
    doc.items[pane.id] = pane;
    const gate = makeComponent(doc, 'not-gate', 60, 20);
    gate.z = 5;
    doc.items[gate.id] = gate;
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: 20, y: 20 }, b: { kind: 'free', x: 200, y: 20 }, pts: [], z: 1 };
    doc.items[w.id] = w;
    const clear = exportSvg(doc, { theme: 'dark', background: false, padding: 10 }).svg;
    // the part's page-coloured triangle and bubble become a mask over everything behind it
    expect(clear).toMatch(/<mask[^>]*>/);
    expect(clear).toMatch(/<g mask="url\(#nodal-knockout-/);
    expect(clear).not.toContain('#0f0e0c');
    // the wire outside the part is still drawn
    expect(clear).toContain(`data-id="${w.id}"`);
    // with a background the opaque interiors already hide what is behind them
    expect(exportSvg(doc, { theme: 'dark', background: true, padding: 10 }).svg).not.toContain('<mask');
  });

  it('keeps a quoted font name intact when stripping colour declarations', () => {
    const out = plainColours('<g style="font-family:&quot;Times New Roman&quot;;color:red"><text>x</text></g>', '#000000');
    expect(out).toContain('style="font-family:&quot;Times New Roman&quot;"');
    expect(out).not.toContain('color:red');
  });

  it('names a page export after its page, and a one-page circuit after itself', () => {
    const one = createDoc('SBR_DTC');
    expect(pageTitle(one)).toBe('SBR_DTC');
    expect(exportSvg(one, { theme: 'light', background: false, padding: 10 }).svg).toContain('<title>SBR_DTC</title>');
    const doc = createDoc('SBR_DTC');
    const second = addPage(doc, 'Power supply');
    expect(pageTitle(viewDoc(doc, second))).toBe('Power supply');
    expect(pageTitle(viewDoc(doc, second))).not.toBe(doc.name);
  });

  it('escapes & and < in formula attributes so the SVG stays valid XML', () => {
    expect(scrubMathSvg('<a href="http://x/?a=1&b=2"><g data-x="1<2 &amp; ok">x</g></a>')).toBe('<a href="http://x/?a=1&amp;b=2"><g data-x="1&lt;2 &amp; ok">x</g></a>');
  });
});

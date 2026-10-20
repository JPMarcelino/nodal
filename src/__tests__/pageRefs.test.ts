import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { computeSceneData, EDITOR_PALETTE, Scene } from '../canvas/Scene';
import { exportSvg } from '../io/export';
import { createDoc, makeComponent, uid } from '../model/doc';
import { addPage, docPages, itemPage, movePage, viewDoc, viewPage, viewSource } from '../model/pages';
import { pageCrossRefs } from '../model/pageRefs';
import type { CircuitDoc, ComponentItem, WireItem } from '../model/types';

function place(doc: CircuitDoc, symbol: string, x: number, y: number, page?: string, value?: string) {
  const c = makeComponent(doc, symbol, x, y);
  if (page) c.page = page;
  if (value !== undefined) c.value = value;
  doc.items[c.id] = c;
  return c;
}

function wire(doc: CircuitDoc, a: ComponentItem, pa: string, b: ComponentItem, pb: string, extra: Partial<WireItem> = {}) {
  const id = uid('w');
  const w: WireItem = { id, type: 'wire', a: { kind: 'port', comp: a.id, port: pa }, b: { kind: 'port', comp: b.id, port: pb }, pts: [], ...extra };
  doc.items[id] = w;
  return w;
}

/** Three pages: net label "SDA" on pages 1 and 3, a wire labelled "SDA" on page 2. */
function threePages() {
  const doc = createDoc();
  const p1 = docPages(doc)[0].id;
  const p2 = addPage(doc, 'Two');
  const p3 = addPage(doc, 'Three');
  const l1 = place(doc, 'net-label', 0, 0, p1, 'SDA');
  const l3 = place(doc, 'net-label', 0, 0, p3, 'SDA');
  // a wire on page 2 carrying the same name
  const r1 = place(doc, 'resistor', 0, 0, p2);
  const r2 = place(doc, 'resistor', 200, 0, p2);
  const w = wire(doc, r1, '2', r2, '1', { label: 'SDA', page: p2 });
  return { doc, p1, p2, p3, l1, l3, w };
}

describe('pageCrossRefs', () => {
  it('returns an empty map for a one-page document, the same object on every call', () => {
    const doc = createDoc();
    place(doc, 'net-label', 0, 0, undefined, 'SDA');
    expect(pageCrossRefs(doc).size).toBe(0);
    expect(pageCrossRefs(doc)).toBe(pageCrossRefs(doc));
    expect(pageCrossRefs(doc, undefined)).toBe(pageCrossRefs(doc));
  });

  it('references the other pages of a net label, including wire-labelled pages', () => {
    const { doc, p1, p3, l1, l3 } = threePages();
    expect(pageCrossRefs(doc, p1).get(l1.id)).toBe('[2, 3]');
    expect(pageCrossRefs(doc, p3).get(l3.id)).toBe('[1, 2]');
  });

  it('has no entry for a name that appears only on its own page', () => {
    const doc = createDoc();
    const p2 = addPage(doc);
    const p1 = docPages(doc)[0].id;
    place(doc, 'net-label', 0, 0, p1, 'LOCAL');
    place(doc, 'net-label', 100, 0, p1, 'LOCAL');
    expect(pageCrossRefs(doc, p1).size).toBe(0);
    expect(pageCrossRefs(doc, p2).size).toBe(0);
  });

  it('never annotates power rails, even on every page', () => {
    const doc = createDoc();
    const p2 = addPage(doc);
    const p3 = addPage(doc);
    const p1 = docPages(doc)[0].id;
    const g1 = place(doc, 'gnd', 0, 0, p1);
    place(doc, 'gnd', 0, 0, p2);
    place(doc, 'gnd', 0, 0, p3);
    expect(pageCrossRefs(doc, p1).get(g1.id)).toBeUndefined();
    expect(pageCrossRefs(doc, p1).size).toBe(0);
  });

  it('follows page order when pages move', () => {
    const { doc, p1, p3, l1, l3 } = threePages();
    const next = produce(doc, (d) => movePage(d as CircuitDoc, p3, 0));
    expect(docPages(next).map((p) => p.id)).toEqual([p3, p1, expect.any(String)]);
    // l1 is now on page 2, l3 on page 1
    expect(itemPage(next, next.items[l1.id])).toBe(p1);
    expect(pageCrossRefs(next, p1).get(l1.id)).toBe('[1, 3]');
    expect(pageCrossRefs(next, p3).get(l3.id)).toBe('[2, 3]');
  });

  it('ignores hidden labels on other pages and empty names', () => {
    const doc = createDoc();
    const p2 = addPage(doc);
    const p1 = docPages(doc)[0].id;
    const l1 = place(doc, 'net-label', 0, 0, p1, 'SDA');
    const l2 = place(doc, 'net-label', 0, 0, p2, 'SDA');
    l2.hidden = true;
    const empty = place(doc, 'net-label', 50, 0, p1, '  ');
    place(doc, 'net-label', 50, 0, p2, '  ');
    expect(pageCrossRefs(doc, p1).get(l1.id)).toBeUndefined();
    expect(pageCrossRefs(doc, p1).get(empty.id)).toBeUndefined();
    expect(pageCrossRefs(doc, p1).size).toBe(0);
  });

  it('is memoised per document and page', () => {
    const { doc, p1, p3 } = threePages();
    expect(pageCrossRefs(doc, p1)).toBe(pageCrossRefs(doc, p1));
    expect(pageCrossRefs(doc, p1)).not.toBe(pageCrossRefs(doc, p3));
  });

  it('tracks a view back to its whole document', () => {
    const { doc, p1 } = threePages();
    const view = viewDoc(doc, p1);
    expect(viewSource(view)).toBe(doc);
    expect(viewPage(view)).toBe(p1);
    // a document that is its own view has no separate source
    expect(viewSource(createDoc())).toBeUndefined();
  });
});

describe('page-ref rendering', () => {
  it('exportSvg marks up cross-page labels, and not one-page docs', () => {
    const { doc, p1 } = threePages();
    const { svg } = exportSvg(viewDoc(doc, p1), { theme: 'light', background: false, padding: 10 });
    expect(svg).toContain('class="page-ref"');
    expect(svg).toContain('[2, 3]');
    const one = createDoc();
    place(one, 'net-label', 0, 0, undefined, 'SDA');
    const solo = exportSvg(one, { theme: 'light', background: false, padding: 10 }).svg;
    expect(solo).not.toContain('class="page-ref"');
  });

  it('Scene renders the tspan only when the value label is shown and an xref exists', () => {
    const { doc, p1, l1 } = threePages();
    const render = (d: CircuitDoc, xrefs?: ReadonlyMap<string, string>) =>
      renderToStaticMarkup(createElement(Scene, { doc: d, data: computeSceneData(d), palette: EDITOR_PALETTE, xrefs }));
    const xrefs = pageCrossRefs(doc, p1);
    const withRef = render(viewDoc(doc, p1), xrefs);
    expect(withRef).toContain('page-ref');
    expect(withRef).toContain('[2, 3]');
    // no xref map: no page-ref
    expect(render(viewDoc(doc, p1))).not.toContain('page-ref');
    // value label hidden: no page-ref even with an xref
    const hidden = { ...doc, items: { ...doc.items, [l1.id]: { ...l1, showValue: false } } };
    expect(render(hidden, xrefs)).not.toContain('page-ref');
    // the DNP tag still renders next to the reference
    const dnp = { ...doc, items: { ...doc.items, [l1.id]: { ...l1, props: { dnp: '1' } } } };
    const dnpSvg = render(viewDoc(dnp, p1), pageCrossRefs(dnp, p1));
    expect(dnpSvg).toContain('dnp-tag');
    expect(dnpSvg).toContain('page-ref');
  });
});

import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import type { CircuitDoc, ComponentItem } from '../model/types';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

/** A two-page document: R1 on the first page, R2 (and a wire between nothing) on Power. */
async function twoPages(name = 'Two pages') {
  const { createDoc, makeComponent } = await import('../model/doc');
  const { addPage } = await import('../model/pages');
  const doc = createDoc(name);
  const power = addPage(doc, 'Power');
  const one = makeComponent(doc, 'resistor', 0, 0);
  doc.items[one.id] = one;
  const two = makeComponent(doc, 'capacitor', 200, 0);
  two.page = power;
  doc.items[two.id] = two;
  return { doc, first: doc.pages![0].id, power, one, two };
}

describe('saving and opening .nodal files', () => {
  it('writes every page and every item on its page, and reads them back', async () => {
    const { normalizeDoc } = await import('../model/doc');
    const { docPages, itemPage, viewDoc } = await import('../model/pages');
    const { circuitToText } = await import('../io/fileActions');
    const { doc, power, one, two } = await twoPages();

    const text = circuitToText(doc);
    const loaded = normalizeDoc(JSON.parse(text));
    expect(docPages(loaded).map((p) => [p.id, p.name])).toEqual(docPages(doc).map((p) => [p.id, p.name]));
    expect(itemPage(loaded, loaded.items[one.id])).toBe(loaded.pages![0].id);
    expect(itemPage(loaded, loaded.items[two.id])).toBe(power);
    expect(Object.keys(viewDoc(loaded, power).items)).toEqual([two.id]);
    expect(Object.keys(viewDoc(loaded).items)).toEqual([one.id]);
    // the file is valid again when opened a second time
    expect(circuitToText(loaded)).toBe(text);
  });

  it('keeps the pages in order through reordering, duplicating and deleting', async () => {
    const { normalizeDoc } = await import('../model/doc');
    const { docPages, itemPage, pageItemIds, movePage } = await import('../model/pages');
    const { deletePage, duplicatePage } = await import('../model/pageOps');
    const { circuitToText } = await import('../io/fileActions');
    const { doc, first, power, one } = await twoPages();

    let next = produce(doc, (d) => {
      movePage(d as CircuitDoc, first, 1);
      duplicatePage(d as CircuitDoc, power, 'Backup');
    });
    const backup = docPages(next)[1].id;
    expect(docPages(next).map((p) => p.name)).toEqual(['Power', 'Backup', 'Page 1']);
    // every copy is on the new page, the original stays on Power
    expect(pageItemIds(next, backup).every((id) => itemPage(next, next.items[id]) === backup)).toBe(true);
    expect(itemPage(next, next.items[one.id])).toBe(first);

    next = produce(next, (d) => void deletePage(d as CircuitDoc, first));
    const loaded = normalizeDoc(JSON.parse(circuitToText(next)));
    expect(docPages(loaded).map((p) => p.name)).toEqual(['Power', 'Backup']);
    expect(JSON.parse(circuitToText(loaded))).toEqual(JSON.parse(circuitToText(next)));
  });

  it('repairs stale page ids when writing, without touching the open document', async () => {
    const { createDoc, makeComponent } = await import('../model/doc');
    const { itemPage } = await import('../model/pages');
    const { circuitToText } = await import('../io/fileActions');
    const doc = createDoc('Stale');
    const a = makeComponent(doc, 'resistor', 0, 0);
    a.page = 'gone'; // e.g. imported from a circuit whose page ids do not exist here
    doc.items[a.id] = a;
    const text = circuitToText(doc);
    expect((JSON.parse(text).items[a.id] as ComponentItem).page).toBeUndefined();
    expect(JSON.parse(text).pages).toBeUndefined();
    // the file puts it on the one implicit page; the in-memory item is unchanged
    expect(itemPage(doc, doc.items[a.id])).toBe('page1');
    expect(doc.items[a.id].page).toBe('gone');
  });
});

describe('exported pictures carry the pages too', () => {
  it('reads a legacy whole-circuit scene with every page', async () => {
    const { normalizeDoc } = await import('../model/doc');
    const { docPages, itemPage } = await import('../model/pages');
    const { sceneFromSvgText, sceneJson, svgWithScene } = await import('../io/embeddedScene');
    const { doc, power, two } = await twoPages();

    const svg = svgWithScene('<svg xmlns="http://www.w3.org/2000/svg"></svg>', sceneJson(doc));
    const scene = sceneFromSvgText(svg);
    expect(scene).toBeTruthy();
    const loaded = normalizeDoc(JSON.parse(scene!));
    expect(docPages(loaded).map((p) => p.name)).toEqual(['Page 1', 'Power']);
    expect(itemPage(loaded, loaded.items[two.id])).toBe(power);
  });

  it('carries only the page on screen, not every page of the circuit', async () => {
    const { set } = await import('../store/store');
    const { itemPage } = await import('../model/pages');
    const { sceneForScope } = await import('../io/fileActions');
    const { doc, power, one, two } = await twoPages();

    set({ doc, page: power, selection: [] });
    const onPower = JSON.parse(sceneForScope({}));
    // just the drawing shown, with its page name
    expect(Object.keys(onPower.items)).toEqual([two.id]);
    expect(onPower.pages).toEqual([{ id: power, name: 'Power' }]);
    expect((onPower.items[two.id] as ComponentItem).page).toBeUndefined();

    set({ doc, page: doc.pages![0].id, selection: [one.id] });
    const firstPage = JSON.parse(sceneForScope({}));
    expect(Object.keys(firstPage.items)).toEqual([one.id]);
    expect(firstPage.pages).toEqual([{ id: doc.pages![0].id, name: 'Page 1' }]);

    // a selection carries only its own page too
    set({ doc, page: power, selection: [two.id] });
    const selected = JSON.parse(sceneForScope({ ids: [two.id] }));
    expect(Object.keys(selected.items)).toEqual([two.id]);
    expect(selected.pages.map((p: { name: string }) => p.name)).toEqual(['Power']);
    expect(itemPage(selected, selected.items[two.id])).toBe(selected.pages[0].id);
  });

  it('leaves an empty page empty instead of borrowing another page', async () => {
    const { set } = await import('../store/store');
    const { createDoc, makeComponent } = await import('../model/doc');
    const { addPage } = await import('../model/pages');
    const { sceneForScope } = await import('../io/fileActions');
    const doc = createDoc('Empty');
    const part = makeComponent(doc, 'resistor', 0, 0);
    doc.items[part.id] = part;
    const blank = addPage(doc, 'Blank');
    set({ doc, page: blank, selection: [] });
    const scene = JSON.parse(sceneForScope({}));
    expect(scene.items).toEqual({});
    expect(scene.pages).toEqual([{ id: blank, name: 'Blank' }]);
  });
});

describe('importing old pictures that carried every page', () => {
  /** A page-exported SVG from before scenes were scoped: the whole circuit inside. */
  async function oldSvg() {
    const { viewDoc } = await import('../model/pages');
    const { exportSvg } = await import('../io/export');
    const { sceneJson, svgWithScene } = await import('../io/embeddedScene');
    const { doc, power, one, two } = await twoPages('Old export');
    // an export from before page names were used: the circuit's name in the
    // title, and nothing in the geometry that says which page it was — except
    // the picture's own window
    const svg = svgWithScene(
      exportSvg(viewDoc(doc, power), { theme: 'light', background: false, padding: 20, title: doc.name }).svg,
      sceneJson(doc),
    );
    return { svg, doc, power, one, two };
  }

  it('imports only the page the SVG shows, not every page stacked', async () => {
    const { S, set } = await import('../store/store');
    const { createDoc } = await import('../model/doc');
    const { itemPage } = await import('../model/pages');
    const { importFileText } = await import('../io/importFiles');
    const { svg, two } = await oldSvg();

    set({ doc: createDoc('Open'), page: undefined, past: [], future: [], selection: [], toasts: [] });
    await importFileText('Old export.svg', svg, { x: 300, y: 300 });
    const added = Object.values(S().doc.items).filter((i) => i.type === 'component');
    expect(added).toHaveLength(1);
    // exactly the part that was drawn on the exported page
    expect(added[0].type === 'component' && added[0].symbol).toBe('capacitor');
    expect(itemPage(S().doc, added[0])).toBe('page1');
    expect(S().doc.items[two.id]).toBeUndefined();
  });

  it('imports the page named by a PNG file name, and falls back to the first drawing', async () => {
    const { S, set } = await import('../store/store');
    const { createDoc } = await import('../model/doc');
    const { importDroppedFiles } = await import('../io/importFiles');
    const { pngWithScene, sceneJson } = await import('../io/embeddedScene');
    const { doc } = await oldSvg();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const pictured = await pngWithScene(new Blob([png], { type: 'image/png' }), sceneJson(doc));
    const symbols = () => Object.values(S().doc.items).filter((i) => i.type === 'component').map((i) => (i as ComponentItem).symbol);

    set({ doc: createDoc('Open'), page: undefined, past: [], future: [], selection: [], toasts: [] });
    await importDroppedFiles([new File([pictured], 'Power.png', { type: 'image/png' })], { x: 100, y: 100 });
    expect(symbols()).toEqual(['capacitor']);

    // a renamed file no longer says which page it was: the first drawing is added
    set({ doc: createDoc('Open'), page: undefined, past: [], future: [], selection: [], toasts: [] });
    await importDroppedFiles([new File([pictured], 'renamed.png', { type: 'image/png' })], { x: 100, y: 100 });
    expect(symbols()).toEqual(['resistor']);
  });

  it('finds the page by the picture proportions when its name says nothing', async () => {
    const { S, set } = await import('../store/store');
    const { createDoc, makeComponent } = await import('../model/doc');
    const { addPage, viewDoc } = await import('../model/pages');
    const { exportBox } = await import('../io/export');
    const { pngWithScene, sceneJson } = await import('../io/embeddedScene');
    const { importDroppedFiles } = await import('../io/importFiles');

    // a tall first page and a small Power page: their pictures do not look alike
    const doc = createDoc('Old export');
    const power = addPage(doc, 'Power');
    for (const y of [0, 200, 400]) {
      const r = makeComponent(doc, 'resistor', 0, y);
      doc.items[r.id] = r;
    }
    const c = makeComponent(doc, 'capacitor', 0, 0);
    c.page = power;
    doc.items[c.id] = c;
    const box = exportBox(viewDoc(doc, power), { theme: 'light', background: false, padding: 20 });

    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));
    // the export's size (at 3x) in the image header, as an old page export had
    const dv = new DataView(png.buffer);
    dv.setUint32(16, Math.ceil(box.w * 3));
    dv.setUint32(20, Math.ceil(box.h * 3));
    const pictured = await pngWithScene(new Blob([png], { type: 'image/png' }), sceneJson(doc));

    set({ doc: createDoc('Open'), page: undefined, past: [], future: [], selection: [], toasts: [] });
    await importDroppedFiles([new File([pictured], 'Old export.png', { type: 'image/png' })], { x: 100, y: 100 });
    const symbols = Object.values(S().doc.items).filter((i) => i.type === 'component').map((i) => (i as ComponentItem).symbol);
    expect(symbols).toEqual(['capacitor']);
  });
});

describe('importing circuits with pages', () => {
  it('puts a whole multi-page circuit on the page it is added to', async () => {
    const { S, set } = await import('../store/store');
    const { createDoc } = await import('../model/doc');
    const { itemPage } = await import('../model/pages');
    const { insertCircuit } = await import('../io/sharing');
    const { doc: src } = await twoPages('Imported');

    // a one-page circuit has nowhere for the source's page ids to point
    set({ doc: createDoc('One page'), page: undefined, past: [], future: [], selection: [] });
    const ids = insertCircuit(src, { x: 300, y: 300 });
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(S().doc.items[id].page).toBeUndefined();
      expect(itemPage(S().doc, S().doc.items[id])).toBe('page1');
    }

    // on a multi-page circuit, everything lands on the page in view
    const { doc: target, power } = await twoPages('Target');
    set({ doc: target, page: power, past: [], future: [], selection: [] });
    const more = insertCircuit(src, { x: 500, y: 300 });
    expect(more).toHaveLength(2);
    for (const id of more) expect(itemPage(S().doc, S().doc.items[id])).toBe(power);
  });

  it('copies items without their old page, so pasting cannot scatter them', async () => {
    const { S, set } = await import('../store/store');
    const { createDoc } = await import('../model/doc');
    const { docPages, itemPage, viewDoc } = await import('../model/pages');
    const { extractFragment, insertFragment } = await import('../model/ops');
    const { doc, power, two } = await twoPages('Source');

    const frag = extractFragment(viewDoc(doc, power), new Set([two.id]));
    expect(frag.items[0].page).toBeUndefined();
    // insert straight into the whole document, as a rewrite would
    const target = createDoc('Target');
    const [copy] = insertFragment(target, frag, 0, 0);
    expect(target.items[copy].page).toBeUndefined();
    expect(itemPage(target, target.items[copy])).toBe(docPages(target)[0].id);
    // and the same through the store, onto the active page
    set({ doc, page: docPages(doc)[0].id, past: [], future: [], selection: [] });
    const { pasteFragment } = await import('../store/actions');
    pasteFragment(frag, { x: 400, y: 400 });
    const pasted = S().selection[0];
    expect(itemPage(S().doc, S().doc.items[pasted])).toBe(docPages(S().doc)[0].id);
  });
});

describe('duplicating a page', () => {
  it('copies the locks of the right items, whatever their stacking order', async () => {
    const { createDoc, makeComponent, makeShape } = await import('../model/doc');
    const { docPages, pageItemIds } = await import('../model/pages');
    const { duplicatePage } = await import('../model/pageOps');
    const doc = createDoc('Locks');
    // a shape behind everything is drawn first but added last: insertion order and draw order differ
    const back = makeShape(doc, 'rect', 0, 0, 10, 10);
    back.z = -5;
    doc.items[back.id] = back;
    const locked = makeComponent(doc, 'resistor', 0, 0);
    locked.locked = true;
    doc.items[locked.id] = locked;
    const free = makeComponent(doc, 'capacitor', 100, 0);
    doc.items[free.id] = free;
    const first = docPages(doc)[0].id;

    let copy = '';
    const next = produce(doc, (d) => void (copy = duplicatePage(d as CircuitDoc, first)));
    const copies = pageItemIds(next, copy).map((id) => next.items[id]);
    const copyLocked = copies.find((it) => it.type === 'component' && (it as ComponentItem).ref === locked.ref)!;
    const copyFree = copies.find((it) => it.type === 'component' && (it as ComponentItem).ref === free.ref)!;
    expect(!!copyLocked.locked).toBe(true);
    expect(!!copyFree.locked).toBe(false);
  });
});

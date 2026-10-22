import { describe, expect, it } from 'vitest';
import type { CircuitDoc } from '../model/types';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

describe('importFileText', () => {
  it('routes each Nodal file kind by its contents', async () => {
    const { S, set } = await import('../store/store');
    const { createDoc, makeComponent } = await import('../model/doc');
    const { compileSource } = await import('../model/symbols/dsl');
    const { buildTemplateFile, templateToText } = await import('../io/sharing');
    const { importFileText } = await import('../io/importFiles');

    const thing = compileSource({ id: 'user-imp', name: 'Imp', category: 'My symbols', w: 40, h: 20, draw: 'L 0 10 40 10', ports: '1:0,10', prefix: 'U', value: '', fields: '', keywords: '' });

    // a symbol library merges into "My symbols"
    set({ userLibrary: {} });
    await importFileText('lib.json', JSON.stringify({ format: 'nodal-library', version: 1, app: 'Nodal', name: 'x', symbols: { [thing.id]: thing } }));
    expect(S().userLibrary[thing.id]).toBeTruthy();

    // a dropped circuit is added to the open one, grouped under its name, at the drop point
    const circuit = createDoc();
    circuit.name = 'Dropped circuit';
    const r = makeComponent(circuit, 'resistor', 0, 0);
    circuit.items[r.id] = r;
    const open = createDoc('Open circuit');
    const mine = makeComponent(open, 'capacitor', 0, 0);
    open.items[mine.id] = mine;
    set({ doc: open, dirty: false });
    await importFileText('c.nodal', JSON.stringify(circuit), { x: 200, y: 200 });
    expect(S().doc.name).toBe('Open circuit');
    expect(S().doc.items[mine.id]).toBeTruthy();
    const dropped = Object.values(S().doc.items).find((i) => i.type === 'component' && i.symbol === 'resistor');
    expect(dropped && S().doc.groups[dropped.group!]?.name).toBe('Dropped circuit');
    expect(dropped && 'x' in dropped && Math.abs(dropped.x - 200) < 50).toBe(true);
    expect(S().doc.id).toBe(open.id);

    // a template is inserted around the drop point
    const tpl = templateToText(buildTemplateFile([dropped!.id])!);
    const before = Object.keys(S().doc.items).length;
    await importFileText('t.nodal-template.json', tpl, { x: 400, y: 400 });
    expect(Object.keys(S().doc.items).length).toBe(before + 1);
    const added = S().doc.items[S().selection[0]];
    expect(added && 'x' in added && Math.abs(added.x - 400) < 100).toBe(true);

    // anything else reports an error instead of throwing
    await importFileText('notes.txt', 'hello');
    expect(S().toasts[S().toasts.length - 1]?.kind).toBe('error');
  });
});

describe('pictures exported with their circuit', () => {
  it('import as that circuit', async () => {
    const { S, set } = await import('../store/store');
    const { createDoc, makeComponent } = await import('../model/doc');
    const { exportSvg } = await import('../io/export');
    const { pngWithScene, sceneJson, svgWithScene } = await import('../io/embeddedScene');
    const { importDroppedFiles, importFileText } = await import('../io/importFiles');

    const circuit = createDoc('Pictured');
    const r = makeComponent(circuit, 'inductor', 0, 0);
    circuit.items[r.id] = r;
    const inductors = () => Object.values(S().doc.items).filter((i) => i.type === 'component' && i.symbol === 'inductor');
    set({ doc: createDoc('Open circuit'), dirty: false });

    // an SVG carrying its circuit is added as a group, not converted as a drawing
    const svg = svgWithScene(exportSvg(circuit, { theme: 'light', background: false, padding: 20 }).svg, sceneJson(circuit));
    await importFileText('pictured.svg', svg, { x: 100, y: 100 });
    expect(inductors().length).toBe(1);
    expect(S().doc.groups[inductors()[0].group!]?.name).toBe('Pictured');
    expect(S().doc.name).toBe('Open circuit');

    // so is a dropped PNG carrying it
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const withScene = await pngWithScene(new Blob([png], { type: 'image/png' }), sceneJson(circuit));
    await importDroppedFiles([new File([withScene], 'pictured.png', { type: 'image/png' })], { x: 300, y: 100 });
    expect(inductors().length).toBe(2);
    expect(S().toasts[S().toasts.length - 1]).toMatchObject({ kind: 'success', text: expect.stringContaining('“pictured”') });
  });
});

describe('pasteClipboardContent', () => {
  it('pastes fragments, images and SVG in priority order', async () => {
    const { S, set, mutate } = await import('../store/store');
    const { createDoc, makeComponent } = await import('../model/doc');
    const { extractFragment } = await import('../model/ops');
    const { pasteClipboardContent } = await import('../io/clipboardPaste');

    const reset = () => set({ doc: createDoc(), past: [], future: [], selection: [], toasts: [] });
    const fakePic = { src: 'data:image/png;base64,AA==', w: 200, h: 100 };

    // fragment text inserts the fragment at `at`
    reset();
    const src = createDoc();
    const r = makeComponent(src, 'resistor', 0, 0);
    src.items[r.id] = r;
    const fragText = JSON.stringify(extractFragment(src, new Set([r.id])));
    expect(await pasteClipboardContent({ text: fragText }, { x: 400, y: 400 })).toBe('fragment');
    const ids = Object.keys(S().doc.items);
    expect(ids).toHaveLength(1);
    expect(S().selection).toEqual(ids);

    // a fragment beats an image present at the same time
    reset();
    let decoded = 0;
    expect(
      await pasteClipboardContent(
        { text: fragText, imageBlob: new Blob(['x'], { type: 'image/png' }) },
        { x: 0, y: 0 },
        { rasterToPicture: async () => (decoded++, fakePic) },
      ),
    ).toBe('fragment');
    expect(decoded).toBe(0);

    // an image blob lands in insertPictures, centred on `at`
    reset();
    expect(
      await pasteClipboardContent(
        { text: 'screenshot', imageBlob: new Blob(['x'], { type: 'image/png' }) },
        { x: 300, y: 300 },
        { rasterToPicture: async () => fakePic },
      ),
    ).toBe('image');
    const pic = Object.values(S().doc.items)[0];
    expect(pic && pic.type === 'shape' && pic.kind === 'image').toBe(true);
    expect(S().selection).toHaveLength(1);
    expect(S().toasts[S().toasts.length - 1]?.text).toBe('Pasted image');

    // a decode failure toasts and never throws
    reset();
    expect(
      await pasteClipboardContent(
        { imageBlob: new Blob(['x'], { type: 'image/png' }) },
        undefined,
        { rasterToPicture: async () => { throw new Error('empty'); } },
      ),
    ).toBe('image');
    expect(Object.keys(S().doc.items)).toHaveLength(0);
    expect(S().toasts[S().toasts.length - 1]?.text).toBe('Could not paste image: empty');

    // SVG text (or an SVG clipboard item) is routed to the SVG import
    reset();
    const seen: string[] = [];
    const stubSvg = async (_n: string, body: string) => {
      seen.push(body);
      mutate((d) => {
        const c = makeComponent(d as CircuitDoc, 'resistor', 0, 0);
        d.items[c.id] = c;
      });
    };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
    expect(await pasteClipboardContent({ text: `  ${svg}` }, { x: 1, y: 2 }, { importSvg: stubSvg })).toBe('svg');
    expect(seen).toHaveLength(1);
    expect(Object.keys(S().doc.items)).toHaveLength(1);
    expect(await pasteClipboardContent({ svgText: svg }, undefined, { importSvg: stubSvg })).toBe('svg');
    expect(seen).toHaveLength(2);

    // anything else leaves the doc alone
    reset();
    expect(await pasteClipboardContent({ text: 'hello' })).toBe('none');
    expect(Object.keys(S().doc.items)).toHaveLength(0);
  });
});

describe('importFileText', () => {
  it('places pictures as image shapes stacked around the drop point, in one undo step', async () => {
    const { S, set, undo } = await import('../store/store');
    const { createDoc } = await import('../model/doc');
    const { insertPictures, isPdf, isRaster } = await import('../io/imageImport');

    expect(isPdf(new File([], 'scan.PDF'))).toBe(true);
    expect(isRaster(new File([], 'photo.jpg'))).toBe(true);
    expect(isRaster(new File([], 'logo.svg', { type: 'image/svg+xml' }))).toBe(false);

    set({ doc: createDoc(), past: [], selection: [] });
    const ids = insertPictures(
      [
        { src: 'data:image/png;base64,AA==', w: 200, h: 100 },
        { src: 'data:image/png;base64,AA==', w: 200, h: 100 },
      ],
      { x: 0, y: 0 },
    );
    const [a, b] = ids.map((id) => S().doc.items[id]);
    expect(a.type === 'shape' && a.kind === 'image' && a.src).toBeTruthy();
    // second page sits below the first, both roughly centred on the point
    expect(a.type === 'shape' && b.type === 'shape' && b.y > a.y + a.h).toBe(true);
    expect(a.type === 'shape' && Math.abs(a.x + a.w / 2) <= S().doc.settings.grid).toBe(true);
    expect(S().selection).toEqual(ids);
    undo();
    expect(Object.keys(S().doc.items)).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
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

    // a circuit replaces the (empty, so no confirm) document
    const circuit = createDoc();
    circuit.name = 'Dropped circuit';
    const r = makeComponent(circuit, 'resistor', 0, 0);
    circuit.items[r.id] = r;
    set({ doc: createDoc(), dirty: false });
    await importFileText('c.nodal', JSON.stringify(circuit));
    expect(S().doc.name).toBe('Dropped circuit');

    // a template is inserted around the drop point
    const tpl = templateToText(buildTemplateFile([r.id])!);
    const before = Object.keys(S().doc.items).length;
    await importFileText('t.nodal-template.json', tpl, null, { x: 400, y: 400 });
    expect(Object.keys(S().doc.items).length).toBe(before + 1);
    const added = S().doc.items[S().selection[0]];
    expect(added && 'x' in added && Math.abs(added.x - 400) < 100).toBe(true);

    // anything else reports an error instead of throwing
    await importFileText('notes.txt', 'hello');
    expect(S().toasts[S().toasts.length - 1]?.kind).toBe('error');
  });

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

import { afterEach, describe, expect, it, vi } from 'vitest';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseJsonText', () => {
  it('skips a UTF-8 byte order mark', async () => {
    const { parseJsonText } = await import('../io/files');
    expect(parseJsonText('\uFEFF{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText('[1]')).toEqual([1]);
  });

  it('says plainly when the text is not JSON', async () => {
    const { parseJsonText } = await import('../io/files');
    expect(() => parseJsonText('{oops')).toThrow('this is not valid JSON (the file may be damaged)');
  });
});

describe('nodalFileFormat', () => {
  it('tells each Nodal file kind apart and never throws', async () => {
    const { nodalFileFormat } = await import('../io/files');
    expect(nodalFileFormat('\uFEFF{"format":"nodal","items":{}}')).toBe('circuit');
    expect(nodalFileFormat('{"format":"nodal-library","symbols":{}}')).toBe('library');
    expect(nodalFileFormat('{"format":"nodal-template"}')).toBe('template');
    expect(nodalFileFormat('{"format":"nodal-fragment","items":[]}')).toBe('fragment');
    expect(nodalFileFormat('{"format":"other"}')).toBe('unknown');
    expect(nodalFileFormat('null')).toBe('unknown');
    expect(nodalFileFormat('42')).toBe('unknown');
    expect(nodalFileFormat('')).toBe('unknown');
    expect(nodalFileFormat('<svg/>')).toBe('unknown');
  });
});

describe('sanitizeName', () => {
  it('makes names Windows accepts', async () => {
    const { sanitizeName } = await import('../io/files');
    expect(sanitizeName('a/b:c')).toBe('a_b_c');
    expect(sanitizeName('  two \t\n words  ')).toBe('two words');
    expect(sanitizeName('bell\u0007name')).toBe('bellname');
    expect(sanitizeName('v1. ')).toBe('v1');
    expect(sanitizeName('...')).toBe('circuit');
    expect(sanitizeName('')).toBe('circuit');
    expect(sanitizeName('CON')).toBe('_CON');
    expect(sanitizeName('nul.txt')).toBe('_nul.txt');
    expect(sanitizeName('com1')).toBe('_com1');
    expect(sanitizeName('LPT9')).toBe('_LPT9');
    expect(sanitizeName('Console')).toBe('Console');
    expect(sanitizeName('COM10')).toBe('COM10');
  });
});

describe('importing', () => {
  it('reads a circuit saved with a byte order mark', async () => {
    const { S, set } = await import('../store/store');
    const { createDoc, makeComponent } = await import('../model/doc');
    const { importFileText } = await import('../io/importFiles');
    const circuit = createDoc('BOM circuit');
    const r = makeComponent(circuit, 'resistor', 0, 0);
    circuit.items[r.id] = r;
    set({ doc: createDoc('Open circuit'), dirty: false, viewMode: false, viewOnly: false });
    await importFileText('bom.nodal', '\uFEFF' + JSON.stringify(circuit));
    expect(Object.values(S().doc.items).some((i) => i.type === 'component' && i.symbol === 'resistor')).toBe(true);
    expect(S().toasts[S().toasts.length - 1]).toMatchObject({ kind: 'success', text: expect.stringContaining('“bom”') });
  });

  it('rejects JSON whose items are missing or not a record', async () => {
    const { normalizeDoc } = await import('../model/doc');
    expect(() => normalizeDoc(null)).toThrow('not a Nodal circuit');
    expect(() => normalizeDoc({ format: 'nodal', items: null })).toThrow('not a Nodal circuit');
    expect(() => normalizeDoc({ format: 'nodal', items: [] })).toThrow('not a Nodal circuit');
    // damaged side records fall back to empty ones instead of crashing the canvas
    const doc = normalizeDoc({ format: 'nodal', items: {}, settings: null, groups: [], symbols: 'oops' });
    expect(doc.groups).toEqual({});
    expect(doc.symbols).toEqual({});
    expect(doc.settings.grid).toBe(10);
  });

  it('never lets an imported library replace a built-in symbol', async () => {
    const { getUserLibrary } = await import('../model/registry');
    const { BUILTIN } = await import('../model/symbols');
    const { importLibraryText } = await import('../io/sharing');
    const lib = { format: 'nodal-library', version: 1, app: 'Nodal', name: 'x', symbols: { resistor: { ...BUILTIN.resistor, name: 'Fake resistor' } } };
    expect(importLibraryText(JSON.stringify(lib))).toBe(0);
    expect(getUserLibrary().resistor).toBeUndefined();
  });

  it('refuses to change the circuit in View mode, but still takes a symbol library', async () => {
    const { S, set } = await import('../store/store');
    const { createDoc, makeComponent } = await import('../model/doc');
    const { compileSource } = await import('../model/symbols/dsl');
    const { importFileText } = await import('../io/importFiles');
    const circuit = createDoc('Dropped');
    const r = makeComponent(circuit, 'resistor', 0, 0);
    circuit.items[r.id] = r;
    const open = createDoc('Open circuit');
    set({ doc: open, dirty: false, viewMode: true, viewOnly: false, toasts: [] });
    try {
      await importFileText('c.nodal', JSON.stringify(circuit));
      expect(S().doc.items).toBe(open.items);
      expect(S().toasts).toHaveLength(1);
      expect(S().toasts[0]).toMatchObject({ kind: 'info', text: expect.stringContaining('View mode') });

      const thing = compileSource({ id: 'user-view', name: 'V', category: 'My symbols', w: 40, h: 20, draw: 'L 0 10 40 10', ports: '1:0,10', prefix: 'U', value: '', fields: '', keywords: '' });
      set({ userLibrary: {} });
      await importFileText('lib.json', JSON.stringify({ format: 'nodal-library', version: 1, app: 'Nodal', name: 'x', symbols: { [thing.id]: thing } }));
      expect(S().userLibrary[thing.id]).toBeTruthy();
    } finally {
      set({ viewMode: false });
    }
  });
});

describe('writePictureClipboard', () => {
  it('reports failure when there is no clipboard at all', async () => {
    const { createDoc } = await import('../model/doc');
    const { writePictureClipboard } = await import('../io/clipboardCopy');
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('ClipboardItem', undefined);
    const ok = await writePictureClipboard(createDoc('Empty'), { theme: 'light', background: false, padding: 10, scale: 1 });
    expect(ok).toBe(false);
  });

  it('falls back to text when only writeText exists', async () => {
    const { createDoc } = await import('../model/doc');
    const { writePictureClipboard } = await import('../io/clipboardCopy');
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('ClipboardItem', undefined);
    const ok = await writePictureClipboard(createDoc('Empty'), { theme: 'light', background: false, padding: 10, scale: 1 });
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
  });
});

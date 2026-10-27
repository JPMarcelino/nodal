import { beforeEach, describe, expect, it, vi } from 'vitest';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const picker = vi.hoisted(() => ({ file: null as { file: File; path: string | null } | null }));
const asked = vi.hoisted(() => ({ titles: [] as string[], answer: undefined as unknown }));

vi.mock('../io/files', async (orig) => ({
  ...(await orig<typeof import('../io/files')>()),
  openAnyFile: vi.fn(async () => picker.file),
}));
vi.mock('../ui/Ask', async (orig) => ({
  ...(await orig<typeof import('../ui/Ask')>()),
  ask: vi.fn(async (title: string, _m: unknown, _b: unknown, dismiss: unknown) => {
    asked.titles.push(title);
    return asked.answer ?? dismiss;
  }),
}));

async function editedCircuit() {
  const { set } = await import('../store/store');
  const { createDoc, makeComponent } = await import('../model/doc');
  const open = createDoc('Open circuit');
  const c = makeComponent(open, 'capacitor', 0, 0);
  open.items[c.id] = c;
  set({ doc: open, dirty: true, filePath: null, viewMode: false, viewOnly: false, toasts: [] });
  return open;
}

const fileOf = (name: string, text: string) => ({ file: new File([text], name, { type: 'application/json' }), path: null });

describe('File → Open', () => {
  beforeEach(() => {
    picker.file = null;
    asked.titles = [];
    asked.answer = undefined;
  });

  it('asks nothing when the picker is cancelled', async () => {
    const { S } = await import('../store/store');
    const { fileOpen } = await import('../io/fileActions');
    const open = await editedCircuit();
    await fileOpen();
    expect(asked.titles).toEqual([]);
    expect(S().doc).toBe(open);
  });

  it('leaves the circuit alone, without asking, when the file is damaged', async () => {
    const { S } = await import('../store/store');
    const { fileOpen } = await import('../io/fileActions');
    const open = await editedCircuit();
    picker.file = fileOf('broken.nodal', '{"format":"nodal",');
    await fileOpen();
    expect(asked.titles).toEqual([]);
    expect(S().doc).toBe(open);
    expect(S().toasts[S().toasts.length - 1]).toMatchObject({ kind: 'error', text: expect.stringContaining('Could not open “broken.nodal”: ') });
  });

  it('asks about unsaved changes only once the file is read, and opens a BOM circuit', async () => {
    const { S } = await import('../store/store');
    const { createDoc } = await import('../model/doc');
    const { fileOpen } = await import('../io/fileActions');
    await editedCircuit();
    picker.file = fileOf('other.nodal', '\uFEFF' + JSON.stringify(createDoc('Other')));
    asked.answer = 'discard';
    await fileOpen();
    expect(asked.titles).toEqual(['Save changes to “Open circuit”?']);
    expect(S().doc.name).toBe('Other');
  });

  it('offers to import a library instead of replacing the circuit', async () => {
    const { S, set } = await import('../store/store');
    const { compileSource } = await import('../model/symbols/dsl');
    const { fileOpen } = await import('../io/fileActions');
    const open = await editedCircuit();
    set({ userLibrary: {} });
    const thing = compileSource({ id: 'user-open', name: 'O', category: 'My symbols', w: 40, h: 20, draw: 'L 0 10 40 10', ports: '1:0,10', prefix: 'U', value: '', fields: '', keywords: '' });
    picker.file = fileOf('mine.nodal-lib.json', JSON.stringify({ format: 'nodal-library', version: 1, app: 'Nodal', name: 'x', symbols: { [thing.id]: thing } }));
    asked.answer = true;
    await fileOpen();
    expect(asked.titles).toEqual(['“mine.nodal-lib.json” is a symbol library, not a circuit']);
    expect(S().doc).toBe(open);
    expect(S().userLibrary[thing.id]).toBeTruthy();
  });

  it('opens the circuit inside a picture as unsaved, named after the circuit', async () => {
    const { S } = await import('../store/store');
    const { createDoc, makeComponent } = await import('../model/doc');
    const { pngWithScene, sceneJson } = await import('../io/embeddedScene');
    const { fileOpen } = await import('../io/fileActions');
    await editedCircuit();
    const circuit = createDoc('Pictured');
    const r = makeComponent(circuit, 'inductor', 0, 0);
    circuit.items[r.id] = r;
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const withScene = await pngWithScene(new Blob([png], { type: 'image/png' }), sceneJson(circuit));
    picker.file = { file: new File([withScene], 'shot.png', { type: 'image/png' }), path: '/tmp/shot.png' };
    asked.answer = 'discard';
    await fileOpen();
    expect(S().doc.name).toBe('Pictured');
    expect(S().filePath).toBeNull();
    expect(S().dirty).toBe(true);
    expect(S().toasts[S().toasts.length - 1]?.text).toContain('Pictured');
  });
});

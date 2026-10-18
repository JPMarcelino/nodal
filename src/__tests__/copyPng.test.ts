import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../io/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../io/export')>();
  return { ...actual, exportPng: vi.fn() };
});

vi.mock('../model/latex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../model/latex')>();
  return { ...actual, prepareMath: vi.fn(async () => undefined) };
});

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const FAKE_BLOB = new Blob(['png'], { type: 'image/png' });

interface RecordedItem {
  data: Record<string, unknown>;
}

let recordedItems: RecordedItem[];
let writeImpl: (items: unknown[]) => Promise<void>;

// Node's global navigator (if any) may be read-only, so replace the whole
// property instead of mutating it.
const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function restoreNavigator() {
  if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
  else delete (globalThis as Record<string, unknown>).navigator;
}

function stubClipboard(impl?: (items: unknown[]) => Promise<void>) {
  recordedItems = [];
  writeImpl =
    impl ??
    (async (items: unknown[]) => {
      // resolve the promised blob, mirroring what the browser does
      for (const it of items as { data: Record<string, Promise<Blob>> }[]) {
        for (const v of Object.values(it.data)) await v;
      }
    });
  class FakeClipboardItem {
    data: Record<string, unknown>;
    constructor(data: Record<string, unknown>) {
      this.data = data;
      recordedItems.push({ data });
    }
  }
  g.ClipboardItem = FakeClipboardItem;
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { write: (items: unknown[]) => writeImpl(items) } },
    configurable: true,
    writable: true,
  });
}

async function setup(sel: string[]) {
  const { S, set } = await import('../store/store');
  const { createDoc } = await import('../model/doc');
  const { exportPng } = await import('../io/export');
  vi.mocked(exportPng).mockReset().mockResolvedValue(FAKE_BLOB);
  set({ doc: createDoc(), past: [], future: [], selection: sel, toasts: [] });
  return { S, set, exportPng: vi.mocked(exportPng) };
}

const lastToast = (S: () => { toasts: { text: string; kind: string }[] }) => S().toasts[S().toasts.length - 1];

describe('copyAsPng', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete g.ClipboardItem;
    restoreNavigator();
  });

  it('with a selection, exports those ids with background and scale, clipboard holds a promised image/png', async () => {
    stubClipboard();
    const { S, exportPng } = await setup(['a', 'b']);
    const { copyAsPng } = await import('../io/fileActions');
    await copyAsPng();
    // let the blob promise settle through the write stub
    await new Promise((r) => setTimeout(r, 0));
    expect(exportPng).toHaveBeenCalledTimes(1);
    const opts = exportPng.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(opts.ids).toEqual(['a', 'b']);
    expect(opts.background).toBe(true);
    expect(opts.scale).toBe(2);
    expect(recordedItems).toHaveLength(1);
    const png = recordedItems[0].data['image/png'];
    expect(png).toBeTruthy();
    expect(png instanceof Blob).toBe(false);
    expect(typeof (png as Promise<Blob>).then).toBe('function');
    await expect(png as Promise<Blob>).resolves.toBe(FAKE_BLOB);
    expect(lastToast(S)?.text).toBe('Image copied to clipboard');
    expect(lastToast(S)?.kind).toBe('success');
  });

  it('with no selection, exports the whole circuit (ids undefined)', async () => {
    stubClipboard();
    const { S, exportPng } = await setup([]);
    const { copyAsPng } = await import('../io/fileActions');
    await copyAsPng();
    await new Promise((r) => setTimeout(r, 0));
    expect(exportPng).toHaveBeenCalledTimes(1);
    expect((exportPng.mock.calls[0][1] as unknown as Record<string, unknown>).ids).toBeUndefined();
    expect(lastToast(S)?.kind).toBe('success');
  });

  it('without ClipboardItem/clipboard.write shows the error toast and never throws', async () => {
    const { S, exportPng } = await setup(['a']);
    const { copyAsPng } = await import('../io/fileActions');
    await expect(copyAsPng()).resolves.toBeUndefined();
    expect(exportPng).not.toHaveBeenCalled();
    expect(lastToast(S)?.kind).toBe('error');
    expect(lastToast(S)?.text).toMatch(/Export as PNG/);
  });

  it('a rejected clipboard.write gives the error toast and no success toast', async () => {
    stubClipboard(async () => {
      throw new Error('denied');
    });
    const { S } = await setup(['a']);
    const { copyAsPng } = await import('../io/fileActions');
    await expect(copyAsPng()).resolves.toBeUndefined();
    const texts = S().toasts.map((t) => t.text);
    expect(texts.some((t) => /Export as PNG/.test(t))).toBe(true);
    expect(texts).not.toContain('Image copied to clipboard');
  });
});

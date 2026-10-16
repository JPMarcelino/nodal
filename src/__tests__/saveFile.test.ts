import { beforeEach, describe, expect, it } from 'vitest';
import { saveFile } from '../io/files';

const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
const w = g.window as Record<string, unknown>;

const FILTERS = [{ name: 'Nodal circuit', extensions: ['nodal', 'json'] }];

function pickWith(writable: { write(b: unknown): Promise<void>; close(): Promise<void> }) {
  w.showSaveFilePicker = async () => ({ createWritable: async () => writable });
}

const okWritable = () => ({ write: async () => {}, close: async () => {} });

describe('saveFile file picker', () => {
  beforeEach(() => {
    delete w.showSaveFilePicker;
  });

  it('resolves null when the picker write succeeds', async () => {
    pickWith(okWritable());
    await expect(saveFile('data', 'c.nodal', FILTERS)).resolves.toBe(null);
  });

  it('resolves false when the user cancels the picker', async () => {
    w.showSaveFilePicker = async () => {
      throw new DOMException('cancelled', 'AbortError');
    };
    await expect(saveFile('data', 'c.nodal', FILTERS)).resolves.toBe(false);
  });

  it('rejects instead of falling back when the write fails', async () => {
    pickWith({ write: async () => { throw new DOMException('disk full', 'QuotaExceededError'); }, close: async () => {} });
    await expect(saveFile('data', 'c.nodal', FILTERS)).rejects.toThrow('disk full');
  });

  it('rejects instead of falling back when the close fails', async () => {
    pickWith({ write: async () => {}, close: async () => { throw new Error('close failed'); } });
    await expect(saveFile('data', 'c.nodal', FILTERS)).rejects.toThrow('close failed');
  });
});

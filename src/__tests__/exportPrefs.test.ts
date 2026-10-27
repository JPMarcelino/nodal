import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc } from '../model/doc';
import { addPage } from '../model/pages';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

describe('image export prefs', () => {
  it('follows the app theme until the Export dialog picks one, then every export uses it', async () => {
    const { S, set, imageExportOptions } = await import('../store/store');
    set({ prefs: { ...S().prefs, theme: 'light', exportTheme: undefined } });
    expect(imageExportOptions().theme).toBe('light');
    set({ prefs: { ...S().prefs, exportTheme: 'dark' } });
    expect(imageExportOptions().theme).toBe('dark');
    // a later app theme change does not override the chosen export theme
    set({ prefs: { ...S().prefs, theme: 'light' } });
    expect(imageExportOptions()).toEqual({ theme: 'dark', background: S().prefs.exportBackground ?? true, scale: S().prefs.exportScale ?? 3, scene: S().prefs.exportScene ?? true });
  });
});

describe('export state hygiene', () => {
  it('opening a document drops an armed area export and a stale scope', async () => {
    const { S, set, replaceDoc } = await import('../store/store');
    set({ exportArea: { kind: 'png' }, exportScope: { ids: ['x'] } });
    replaceDoc(createDoc());
    expect(S().exportArea).toBeNull();
    expect(S().exportScope).toBeNull();
  });

  it('switching pages drops them too', async () => {
    const { S, set, setPage } = await import('../store/store');
    let p2 = '';
    const doc = produce(createDoc(), (d) => {
      p2 = addPage(d);
    });
    set({ doc, page: undefined, past: [], future: [] });
    set({ exportArea: { kind: 'svg' }, exportScope: { clip: { x: 0, y: 0, w: 10, h: 10 } } });
    setPage(p2);
    expect(S().page).toBe(p2);
    expect(S().exportArea).toBeNull();
    expect(S().exportScope).toBeNull();
  });
});

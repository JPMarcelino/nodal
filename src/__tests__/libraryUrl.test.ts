import { describe, expect, it } from 'vitest';
import { buildLibraryLink, checkLibraryUrl, cleanSymbol, fetchLibraryText, parseAddLibraryHash, parseRemoteLibrary } from '../io/libraryUrl';

const sym = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'Thing',
  category: 'My symbols',
  w: 40,
  h: 20,
  prims: [{ t: 'line', pts: [0, 10, 40, 10] }, { t: 'rect', x: 5, y: 5, w: 30, h: 10, fill: 'none', color: '#ff0000' }],
  ports: [{ id: '1', name: '1', x: 0, y: 10, side: 'left' }],
  prefix: 'U',
  ...extra,
});

const lib = (symbols: Record<string, unknown>) => JSON.stringify({ format: 'nodal-library', version: 1, app: 'Nodal', name: 'Shared', symbols });

describe('#addLibrary links', () => {
  it('reads the URL from the hash, with or without a token after it', () => {
    const url = 'https://example.com/libs/my lib.json?x=1&y=2#frag';
    expect(parseAddLibraryHash(`#addLibrary=${encodeURIComponent(url)}`)).toBe(url);
    expect(parseAddLibraryHash(`#addLibrary=${encodeURIComponent(url)}&token=abc`)).toBe(url);
    expect(parseAddLibraryHash('#room=abcdefgh,0123456789abcdef')).toBeNull();
    expect(parseAddLibraryHash('')).toBeNull();
    expect(parseAddLibraryHash('#addLibrary=')).toBeNull();
    expect(parseAddLibraryHash('#addLibrary=%E0%A4%A')).toBeNull();
  });

  it('only accepts https (and http on localhost)', () => {
    expect(checkLibraryUrl('https://example.com/a.json').host).toBe('example.com');
    expect(checkLibraryUrl('http://localhost:5173/a.json').hostname).toBe('localhost');
    expect(() => checkLibraryUrl('http://example.com/a.json')).toThrow(/https/);
    expect(() => checkLibraryUrl('javascript:alert(1)')).toThrow(/https/);
    expect(() => checkLibraryUrl('data:application/json,{}')).toThrow(/https/);
    expect(() => checkLibraryUrl('file:///etc/passwd')).toThrow(/https/);
    expect(() => checkLibraryUrl('https://user:pw@example.com/a.json')).toThrow(/password/);
    expect(() => checkLibraryUrl('not a url')).toThrow(/valid/);
  });

  it('builds a link that reads back', () => {
    const link = buildLibraryLink(' https://example.com/a b.json ', 'https://app.example/nodal/#room=x');
    expect(link.startsWith('https://app.example/nodal/#addLibrary=')).toBe(true);
    expect(parseAddLibraryHash(link.slice(link.indexOf('#')))).toBe('https://example.com/a%20b.json');
    expect(() => buildLibraryLink('http://example.com/a.json', 'https://app.example/')).toThrow();
  });

  it('rejects oversize and failed downloads, and reads good ones', async () => {
    const url = checkLibraryUrl('https://example.com/a.json');
    const big = 'x'.repeat(2000);
    const respond = (body: string, init?: ResponseInit) => (async () => new Response(body, init)) as unknown as typeof fetch;
    await expect(fetchLibraryText(url, { fetchImpl: respond(big), maxBytes: 1000 })).rejects.toThrow(/larger/);
    await expect(fetchLibraryText(url, { fetchImpl: respond('{}', { headers: { 'content-length': '999999' } }), maxBytes: 1000 })).rejects.toThrow(/larger/);
    await expect(fetchLibraryText(url, { fetchImpl: respond('nope', { status: 404 }) })).rejects.toThrow(/404/);
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(fetchLibraryText(url, { fetchImpl: failing })).rejects.toThrow(/reach example.com/);
    const hanging = ((_: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    await expect(fetchLibraryText(url, { fetchImpl: hanging, timeoutMs: 20 })).rejects.toThrow(/too long/);
    expect(await fetchLibraryText(url, { fetchImpl: respond(lib({})) })).toBe(lib({}));
  });

  it('accepts only Nodal libraries, rebuilt from known fields', () => {
    expect(() => parseRemoteLibrary('<html>')).toThrow(/not JSON/);
    expect(() => parseRemoteLibrary(JSON.stringify({ format: 'nodal-template', fragment: {} }))).toThrow(/symbol library/);
    expect(() => parseRemoteLibrary(JSON.stringify({ format: 'nodal-library' }))).toThrow(/symbol library/);

    const out = parseRemoteLibrary(
      lib({
        'user-good': sym('user-good', { onclick: 'alert(1)', extra: { deep: true } }),
        // a built-in id would replace the real resistor everywhere
        resistor: sym('resistor'),
        'user-css': sym('user-css', { prims: [{ t: 'rect', x: 0, y: 0, w: 1, h: 1, fill: 'solid', fc: 'url(https://evil.example/x)' }] }),
        'user-path': sym('user-path', { prims: [{ t: 'path', d: 'M0 0 L10 10"/><script>', fill: 'none' }] }),
        'user-prim': sym('user-prim', { prims: [{ t: 'foreignObject', html: '<b>x</b>' }] }),
        'user-nums': sym('user-nums', { w: 'wide' }),
        'bad id"<': sym('x'),
      }),
    );
    expect(Object.keys(out.symbols)).toEqual(['user-good']);
    expect(out.skipped).toBe(6);
    expect(out.name).toBe('Shared');
    const good = out.symbols['user-good'] as unknown as Record<string, unknown>;
    expect(good.onclick).toBeUndefined();
    expect(good.extra).toBeUndefined();
    expect(good.id).toBe('user-good');
  });

  it('keeps everything a symbol made in Nodal carries', () => {
    const def = cleanSymbol('user-full', sym('user-full', { keywords: 'a b', value: '10k', hideLabels: true, fields: [{ key: 'mpn', label: 'Part number' }], source: 'L 0 0 1 1', prims: [{ t: 'text', x: 1, y: 2, size: 8, anchor: 'middle', text: '$V_{cc}$', color: 'rgb(10, 20, 30)' }, { t: 'path', d: 'M0 0 C 1 1 2 2 3 3 Z', fill: 'solid', dash: true }] }));
    expect(def).toMatchObject({ id: 'user-full', keywords: 'a b', value: '10k', hideLabels: true, fields: [{ key: 'mpn', label: 'Part number' }], source: 'L 0 0 1 1' });
    expect(def!.prims).toHaveLength(2);
  });
});

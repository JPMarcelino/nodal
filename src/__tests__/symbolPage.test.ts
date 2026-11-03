import { describe, expect, it } from 'vitest';
import type { CircuitDoc, ShapeItem } from '../model/types';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
const mem = new Map<string, string>();
g.localStorage ??= { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };

describe('symbol page conversion', () => {
  it('turns a symbol into shapes and pins, and back into the same drawing', async () => {
    const { BUILTIN } = await import('../model/symbols');
    const { symbolDoc, pageToSymbol, pagePins } = await import('../model/symbolPage');
    const r = BUILTIN.resistor;
    const doc = symbolDoc('R', r.prims, r.ports);
    expect(pagePins(doc).map((p) => p.ref).sort()).toEqual(r.ports.map((p) => p.id).sort());
    const out = pageToSymbol(doc)!;
    expect(out.ports.map((p) => [p.id, p.x + out.origin.x, p.y + out.origin.y]).sort()).toEqual(r.ports.map((p) => [p.id, p.x, p.y]).sort());
    expect(out.prims.length).toBe(r.prims.length);
    expect(out.w).toBe(r.w);
    expect(out.h).toBe(r.h);
  });

  it('keeps colours, fills and dashes', async () => {
    const { createDoc } = await import('../model/doc');
    const { primsToShapes, pageToSymbol } = await import('../model/symbolPage');
    const doc = createDoc();
    const shapes = primsToShapes(doc, [
      { t: 'rect', x: 0, y: 0, w: 40, h: 20, fill: 'bg' },
      { t: 'circle', cx: 60, cy: 10, r: 5, fill: 'solid', fc: '#ff0000', color: '#00ff00' },
      { t: 'line', pts: [0, 30, 40, 30], dash: true, w: 1 },
      { t: 'text', x: 20, y: 15, size: 9, anchor: 'middle', text: 'IC' },
    ]);
    for (const s of shapes) doc.items[s.id] = s;
    const prims = pageToSymbol(doc)!.prims;
    expect(prims[0]).toMatchObject({ t: 'rect', fill: 'bg' });
    expect(prims[0]).not.toHaveProperty('color');
    expect(prims[1]).toMatchObject({ t: 'ellipse', fill: 'solid', fc: '#ff0000', color: '#00ff00' });
    expect(prims[2]).toMatchObject({ t: 'line', dash: true, w: 1 });
    expect(prims[3]).toMatchObject({ t: 'text', anchor: 'middle', text: 'IC', size: 9 });
    expect((prims[3] as { x: number }).x).toBeCloseTo(20, 0);
  });

  it('draws parts placed on the page into the symbol', async () => {
    const { createDoc, makeComponent } = await import('../model/doc');
    const { makePin, pageToSymbol } = await import('../model/symbolPage');
    const { BUILTIN } = await import('../model/symbols');
    const doc = createDoc();
    const c = makeComponent(doc, 'resistor', 100, 100);
    doc.items[c.id] = c;
    const pin = makePin(doc, { x: 100 - BUILTIN.resistor.w / 2, y: 100 });
    doc.items[pin.id] = pin;
    const out = pageToSymbol(doc)!;
    expect(out.prims.length).toBe(BUILTIN.resistor.prims.length);
    expect(out.ports).toEqual([expect.objectContaining({ id: '1', x: 0, side: 'left' })]);
  });

  it('keeps pins on the grid once the symbol is placed by its centre', async () => {
    const { createDoc, makeShape } = await import('../model/doc');
    const { makePin, pageToSymbol } = await import('../model/symbolPage');
    const { toWorld } = await import('../model/geometry');
    const doc = createDoc();
    // a drawing 190 wide, pins at the top and bottom of x = 90
    const line = makeShape(doc, 'line', 0, 40, 190, 0);
    doc.items[line.id] = line;
    for (const y of [0, 80]) {
      const pin = makePin(doc, { x: 90, y });
      doc.items[pin.id] = pin;
    }
    const out = pageToSymbol(doc)!;
    expect(out.w % 20).toBe(0);
    expect(out.h % 20).toBe(0);
    for (const rot of [0, 90, 180, 270] as const) {
      for (const p of out.ports) {
        const at = toWorld({ x: 300, y: 300, rot, flipX: false }, out, p.x, p.y);
        expect(at.x % 10).toBe(0);
        expect(at.y % 10).toBe(0);
      }
    }
  });

  it('refuses two pins with one name', async () => {
    const { createDoc } = await import('../model/doc');
    const { makePin, pageToSymbol } = await import('../model/symbolPage');
    const doc = createDoc();
    for (const x of [0, 40]) {
      const p = makePin(doc, { x, y: 0 }, 'A');
      doc.items[p.id] = p;
    }
    expect(() => pageToSymbol(doc)).toThrow(/Two pins/);
  });

  it('numbers new pins and snaps them onto lead ends', async () => {
    const { createDoc, makeShape } = await import('../model/doc');
    const { makePin, nextPinName, snapPin } = await import('../model/symbolPage');
    const doc = createDoc();
    const line = makeShape(doc, 'line', 0, 0, 37, 0) as ShapeItem;
    doc.items[line.id] = line;
    expect(nextPinName(doc)).toBe('1');
    const p = makePin(doc, { x: 0, y: 0 });
    doc.items[p.id] = p;
    expect(nextPinName(doc)).toBe('2');
    // the free end (37, 0) is off the grid, but a drop near it lands on it
    expect(snapPin(doc, { x: 35, y: 3 }, { x: 40, y: 0 }, 10)).toEqual({ x: 37, y: 0 });
    // the end already holding a pin is skipped
    expect(snapPin(doc, { x: 2, y: 2 }, { x: 0, y: 0 }, 10)).toEqual({ x: 0, y: 0 });
    // far from any end: the grid
    expect(snapPin(doc, { x: 18, y: 22 }, { x: 20, y: 20 }, 10)).toEqual({ x: 20, y: 20 });
  });
});

describe('symbol editor session', () => {
  it('sets the circuit aside, saves the symbol with its page and brings the circuit back', async () => {
    const { S, set, mutate, replaceDoc } = await import('../store/store');
    const { createDoc, makeShape } = await import('../model/doc');
    const { openSymbolEditor, saveSymbolEditor, setSymbolMeta, symbolDirty } = await import('../store/symbolSession');
    const { sourceOf } = await import('../model/symbols/dsl');
    const circuit = createDoc('Mine');
    replaceDoc(circuit);
    expect(openSymbolEditor()).toBe(true);
    expect(S().symbolSession).not.toBeNull();
    expect(S().doc).not.toBe(circuit);
    expect(symbolDirty()).toBe(false);
    setSymbolMeta({ name: 'Widget' });
    mutate((d) => {
      const s = makeShape(d as CircuitDoc, 'ellipse', 20, 0, 40, 40);
      d.items[s.id] = s;
    });
    expect(symbolDirty()).toBe(true);
    const count = Object.keys(S().doc.items).length;
    expect(saveSymbolEditor()).toBeNull();
    expect(S().symbolSession).toBeNull();
    expect(S().doc).toBe(circuit);
    const saved = Object.values(S().userLibrary).find((d) => d.name === 'Widget')!;
    expect(saved).toBeTruthy();
    expect(saved.ports.length).toBe(2);
    // reopening shows the page as it was left
    openSymbolEditor({ editing: saved.id });
    expect(Object.keys(S().doc.items).length).toBe(count);
    expect(S().symbolSession!.meta.name).toBe('Widget');
    expect(sourceOf(saved).page).toBeTruthy();
    set({ symbolSession: null });
    replaceDoc(createDoc());
  });

  it('cancelling leaves the circuit untouched, and live edits go to the circuit set aside', async () => {
    const { S, applyExternal, replaceDoc } = await import('../store/store');
    const { createDoc } = await import('../model/doc');
    const { openSymbolEditor, closeSymbolEditor } = await import('../store/symbolSession');
    const circuit = createDoc('Mine');
    replaceDoc(circuit);
    openSymbolEditor();
    const page = S().doc;
    applyExternal((d) => ({ ...d, name: 'Renamed remotely' }));
    expect(S().doc).toBe(page);
    closeSymbolEditor();
    expect(S().doc.name).toBe('Renamed remotely');
    expect(S().symbolSession).toBeNull();
  });

  it('a symbol made from a selection replaces it, and keeps its parts editable', async () => {
    const { S, replaceDoc } = await import('../store/store');
    const { createDoc, makeComponent } = await import('../model/doc');
    const { openSymbolEditor, saveSymbolEditor } = await import('../store/symbolSession');
    const { makePin } = await import('../model/symbolPage');
    const { mutate } = await import('../store/store');
    const circuit = createDoc();
    const a = makeComponent(circuit, 'resistor', 100, 100);
    const b = makeComponent(circuit, 'capacitor', 200, 100);
    circuit.items[a.id] = a;
    circuit.items[b.id] = b;
    replaceDoc(circuit);
    openSymbolEditor({ fromSelection: [a.id, b.id] });
    // the parts themselves are on the page, where they were
    expect(S().doc.items[a.id]).toMatchObject({ type: 'component', symbol: 'resistor', x: 100 });
    mutate((d) => {
      const p = makePin(d as CircuitDoc, { x: 60, y: 100 });
      d.items[p.id] = p;
    });
    expect(saveSymbolEditor()).toBeNull();
    const items = Object.values(S().doc.items);
    expect(items.length).toBe(1);
    expect(items[0].type).toBe('component');
  });
});

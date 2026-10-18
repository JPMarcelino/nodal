import { produce } from 'immer';
import { beforeEach, describe, expect, it } from 'vitest';
import { changedKeys, SyncState, writeEntries } from '../collab/sync';
import { createDoc, makeComponent, makeShape, normalizeDoc, uid } from '../model/doc';
import { computeNets } from '../model/netlist';
import { deletePage, duplicatePage, moveItemsToPage } from '../model/pageOps';
import { addPage, docPages, editPage, itemPage, movePage, pageItemIds, viewDoc } from '../model/pages';
import type { CircuitDoc, ComponentItem, WireItem } from '../model/types';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

function place(doc: CircuitDoc, symbol: string, x: number, y: number, page?: string) {
  const c = makeComponent(doc, symbol, x, y);
  if (page) c.page = page;
  doc.items[c.id] = c;
  return c;
}
function wire(doc: CircuitDoc, a: ComponentItem, pa: string, b: ComponentItem, pb: string, extra: Partial<WireItem> = {}) {
  const id = uid('w');
  const w: WireItem = { id, type: 'wire', a: { kind: 'port', comp: a.id, port: pa }, b: { kind: 'port', comp: b.id, port: pb }, pts: [], ...extra };
  doc.items[id] = w;
  return w;
}

/** A two-page document: R1–R2 wired on page 1, R3 on page 2. */
function twoPages() {
  const doc = createDoc();
  const p2 = addPage(doc, 'Power');
  const p1 = docPages(doc)[0].id;
  const r1 = place(doc, 'resistor', 0, 0);
  const r2 = place(doc, 'resistor', 200, 0);
  const w = wire(doc, r1, '2', r2, '1');
  const r3 = place(doc, 'resistor', 0, 0, p2);
  return { doc, p1, p2, r1, r2, r3, w };
}

describe('page views', () => {
  it('shows only the items of one page', () => {
    const { doc, p1, p2, r1, r2, r3, w } = twoPages();
    expect(Object.keys(viewDoc(doc, p1).items).sort()).toEqual([r1.id, r2.id, w.id].sort());
    expect(Object.keys(viewDoc(doc, p2).items)).toEqual([r3.id]);
    // memoised, and an unknown page is the first one
    expect(viewDoc(doc, p2)).toBe(viewDoc(doc, p2));
    expect(viewDoc(doc, 'nope')).toBe(viewDoc(doc, p1));
    // a document with one page is its own view
    const one = createDoc();
    expect(viewDoc(one, undefined)).toBe(one);
  });

  it('folds a page edit back into the whole document, putting new items on that page', () => {
    const { doc, p2, r1, r3 } = twoPages();
    let added = '';
    const next = editPage(doc, p2, (d) => {
      const c = makeComponent(d as CircuitDoc, 'resistor', 50, 50);
      d.items[c.id] = c;
      added = c.id;
      (d.items[r3.id] as ComponentItem).x = 30;
    });
    expect(next.items[added].page).toBe(p2);
    expect((next.items[r3.id] as ComponentItem).x).toBe(30);
    // the other page is untouched (same objects)
    expect(next.items[r1.id]).toBe(doc.items[r1.id]);
    // references stay unique across pages (R1–R3 are taken)
    expect((next.items[added] as ComponentItem).ref).toBe('R4');
  });

  it('settles edits on their own page only: a part dropped where another page has a wire stays unconnected', async () => {
    const { S, set, mutate, setPage } = await import('../store/store');
    const { doc, p2, w } = twoPages();
    set({ doc, page: undefined, past: [], future: [] });
    setPage(p2);
    let id = '';
    mutate((d) => {
      // right on top of page 1's wire
      const c = makeComponent(d as CircuitDoc, 'resistor', 100, 0);
      d.items[c.id] = c;
      id = c.id;
    });
    expect(S().doc.items[id].page).toBe(p2);
    expect(S().doc.items[w.id]).toBe(doc.items[w.id]);
  });
});

describe('store pages', () => {
  beforeEach(async () => {
    const { set } = await import('../store/store');
    set({ doc: createDoc(), page: undefined, past: [], future: [], selection: [] });
  });

  it('adds new items to the active page, and page switches are not undoable', async () => {
    const { S, mutate, setPage, undo } = await import('../store/store');
    const { newPage } = await import('../store/actions');
    newPage();
    const pages = docPages(S().doc);
    expect(pages).toHaveLength(2);
    expect(S().page).toBe(pages[1].id);
    let id = '';
    mutate((d) => {
      const c = makeComponent(d as CircuitDoc, 'resistor', 0, 0);
      d.items[c.id] = c;
      id = c.id;
    });
    expect(itemPage(S().doc, S().doc.items[id])).toBe(pages[1].id);
    setPage(pages[0].id);
    // undo takes back the part (showing its page again), then the new page
    undo();
    expect(S().doc.items[id]).toBeUndefined();
    expect(S().page).toBe(pages[1].id);
    undo();
    expect(docPages(S().doc)).toHaveLength(1);
  });

  it('moves the selection to another page', async () => {
    const { S, set } = await import('../store/store');
    const { moveSelectionToPage } = await import('../store/actions');
    const { doc, p2, r1 } = twoPages();
    set({ doc, page: undefined, selection: [r1.id] });
    moveSelectionToPage(p2);
    expect(S().doc.items[r1.id].page).toBe(p2);
    expect(S().selection).toEqual([]);
  });
});

describe('page edits', () => {
  it('deletes a page with everything on it', () => {
    const { doc, p1, p2, r1, r3 } = twoPages();
    const next = produce(doc, (d) => void deletePage(d as CircuitDoc, p2));
    expect(next.items[r3.id]).toBeUndefined();
    expect(next.items[r1.id]).toBeTruthy();
    expect(docPages(next).map((p) => p.id)).toEqual([p1]);
    // the last page can't go
    expect(produce(next, (d) => void deletePage(d as CircuitDoc, p1))).toBe(next);
  });

  it('duplicates a page with fresh ids, wires, glued connectors and groups following the copies', () => {
    const { doc, p1, r1, r2, w } = twoPages();
    const box = makeShape(doc, 'rect', 0, 100, 40, 40);
    doc.items[box.id] = box;
    const line = makeShape(doc, 'line', 0, 0, 10, 10);
    line.from = { id: box.id };
    line.to = { id: r1.id };
    doc.items[line.id] = line;
    doc.groups.g1 = { id: 'g1', name: 'Pair' };
    r1.group = 'g1';
    r2.group = 'g1';
    let copy = '';
    const next = produce(doc, (d) => void (copy = duplicatePage(d as CircuitDoc, p1)));
    expect(docPages(next).map((p) => p.name)).toEqual(['Page 1', 'Page 1 copy', 'Power']);
    const ids = pageItemIds(next, copy);
    expect(ids).toHaveLength(5);
    const originals = new Set(pageItemIds(doc, p1));
    expect(ids.some((id) => originals.has(id))).toBe(false);
    const items = ids.map((id) => next.items[id]);
    const comps = items.filter((i): i is ComponentItem => i.type === 'component');
    const w2 = items.find((i): i is WireItem => i.type === 'wire')!;
    expect(w2.id).not.toBe(w.id);
    expect(w2.a.kind === 'port' && comps.some((c) => c.id === (w2.a as { comp: string }).comp)).toBe(true);
    expect(w2.b.kind === 'port' && comps.some((c) => c.id === (w2.b as { comp: string }).comp)).toBe(true);
    const line2 = items.find((i) => i.type === 'shape' && i.kind === 'line')!;
    expect(line2.type === 'shape' && ids.includes(line2.from!.id) && ids.includes(line2.to!.id)).toBe(true);
    // the copies form their own group
    const gid = comps[0].group!;
    expect(gid).toBeTruthy();
    expect(gid).not.toBe('g1');
    expect(comps.every((c) => c.group === gid)).toBe(true);
    expect(next.groups[gid]).toBeTruthy();
    // parts take free references, so the netlist stays valid
    expect(new Set(Object.values(next.items).flatMap((i) => (i.type === 'component' ? [i.ref] : []))).size).toBe(5);
  });

  it('reorders pages without moving untagged items', () => {
    const { doc, p1, p2, r1 } = twoPages();
    const next = produce(doc, (d) => movePage(d as CircuitDoc, p2, 0));
    expect(docPages(next).map((p) => p.id)).toEqual([p2, p1]);
    expect(itemPage(next, next.items[r1.id])).toBe(p1);
  });

  it('moves parts with the wires between them; wires to parts left behind let go', () => {
    const doc = createDoc();
    const p2 = addPage(doc);
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    const c = place(doc, 'resistor', 400, 0);
    const ab = wire(doc, a, '2', b, '1');
    const bc = wire(doc, b, '2', c, '1');
    let moved: string[] = [];
    const next = produce(doc, (d) => void (moved = moveItemsToPage(d as CircuitDoc, [a.id, b.id], p2)));
    expect(moved.sort()).toEqual([a.id, b.id, ab.id].sort());
    expect(next.items[ab.id].page).toBe(p2);
    // the wire to c stays on page 1, its end at b now loose where the pin was
    const left = next.items[bc.id] as WireItem;
    expect(itemPage(next, left)).not.toBe(p2);
    expect(left.a.kind).toBe('free');
    expect(left.b).toEqual({ kind: 'port', comp: c.id, port: '1' });
  });
});

describe('netlist across pages', () => {
  it('joins nets by label name across pages, but pins only touch on the same page', () => {
    const doc = createDoc();
    const p2 = addPage(doc);
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    const c = place(doc, 'resistor', 0, 300, p2);
    const d = place(doc, 'resistor', 200, 300, p2);
    wire(doc, a, '2', b, '1', { label: 'SDA' });
    wire(doc, c, '2', d, '1', { label: 'SDA' });
    const sda = computeNets(doc).filter((n) => n.name === 'SDA');
    expect(sda).toHaveLength(1);
    expect(sda[0].pins).toHaveLength(4);
    // a part on page 2 exactly over a's pins doesn't touch them
    const e = place(doc, 'resistor', 0, 0, p2);
    const net = computeNets(doc).find((n) => n.pins.some((p) => p.comp === e.id && p.port === '1'))!;
    expect(net.pins.some((p) => p.comp === a.id)).toBe(false);
  });
});

describe('loading pages', () => {
  it('repairs duplicate pages and items pointing at missing pages', () => {
    const raw = createDoc();
    const r = place(raw, 'resistor', 0, 0);
    r.page = 'gone';
    const s = place(raw, 'resistor', 100, 0);
    s.page = 'b';
    const t = place(raw, 'resistor', 200, 0);
    t.page = 'a';
    raw.pages = [{ id: 'a', name: 'One' }, { id: 'a', name: 'Dup' }, { id: 'b', name: '' }];
    const doc = normalizeDoc(JSON.parse(JSON.stringify(raw)));
    expect(doc.pages).toEqual([{ id: 'a', name: 'One' }, { id: 'b', name: 'Page 2' }]);
    expect(doc.items[r.id].page).toBeUndefined();
    expect(doc.items[t.id].page).toBeUndefined();
    expect(doc.items[s.id].page).toBe('b');
    expect(itemPage(doc, doc.items[r.id])).toBe('a');
  });

  it('syncs the page list in a live session', () => {
    const a = createDoc();
    const b = produce(a, (d) => void addPage(d as CircuitDoc, 'Two'));
    expect(changedKeys(a, b)).toContain('pages');
    const sync = new SyncState();
    const entries = sync.local(b, ['pages']);
    const other = writeEntries(createDoc(), entries);
    expect(docPages(other).map((p) => p.name)).toEqual(['Page 1', 'Two']);
  });
});

import { produce } from 'immer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedKeys, SyncState, writeEntries } from '../collab/sync';
import { createDoc, makeComponent, makeShape, normalizeDoc, uid } from '../model/doc';
import { runErc } from '../model/erc';
import { computeNets } from '../model/netlist';
import { extractFragment, insertFragment } from '../model/ops';
import { deletePage, duplicatePage, moveItemsToPage } from '../model/pageOps';
import { addPage, docPages, editPage, itemPage, movePage, pageItemIds, samePage, viewDoc } from '../model/pages';
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
    // each page names its parts on its own: page 2 only has R3
    expect((next.items[added] as ComponentItem).ref).toBe('R1');
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

describe('page switches during a gesture', () => {
  afterEach(async () => {
    const { endGesture, inGesture } = await import('../store/store');
    if (inGesture()) endGesture(false);
  });

  /** A two-page doc with a lone shape on the first page (nothing for settle to touch). */
  async function gestureDoc() {
    const store = await import('../store/store');
    const { createDoc, makeShape } = await import('../model/doc');
    const { addPage, docPages } = await import('../model/pages');
    const doc = createDoc('T');
    const p2 = addPage(doc, 'Two');
    const p1 = docPages(doc)[0].id;
    const a = makeShape(doc, 'rect', 0, 0, 20, 20);
    doc.items[a.id] = a;
    store.set({ doc, page: undefined, past: [], future: [], selection: ['x'] });
    return { store, p1, p2, aid: a.id };
  }
  const xOf = (doc: CircuitDoc, id: string) => (doc.items[id] as unknown as { x: number }).x;
  const moveTo = (id: string, x: number) => (d: { items: Record<string, unknown> }) =>
    void (((d.items[id] as unknown as { x: number }).x = x));

  it('blocks setPage mid-drag: the page stays and later movement still applies', async () => {
    const { store, p1, p2, aid } = await gestureDoc();
    const { S, activePage, beginGesture, gestureUpdate, endGesture, setPage } = store;
    const { stepPage } = await import('../store/actions');
    expect(activePage()).toBe(p1);
    beginGesture();
    gestureUpdate(moveTo(aid, 50));
    // Mod/Alt+PageDown mid-drag goes nowhere: no switch, no selection loss
    expect(setPage(p2)).toBe(false);
    stepPage(1);
    expect(activePage()).toBe(p1);
    expect(S().selection).toEqual(['x']);
    // the drag is not discarded: further movement still lands on its page
    gestureUpdate(moveTo(aid, 70));
    endGesture(true);
    expect(xOf(S().doc, aid)).toBe(70);
    expect(S().past).toHaveLength(1);
    // released: switching works again
    setPage(p2);
    expect(S().page).toBe(p2);
  });

  it('ignores doc edits (delete, duplicate, paste, nudge) mid-drag', async () => {
    const { store, aid } = await gestureDoc();
    const { S, set, beginGesture, gestureUpdate, endGesture, vdoc } = store;
    const { deleteSelection, duplicateSelection, nudge, pasteFragment } = await import('../store/actions');
    const { extractFragment } = await import('../model/ops');
    set({ selection: [aid] });
    beginGesture();
    gestureUpdate(moveTo(aid, 50));
    deleteSelection();
    expect(S().doc.items[aid]).toBeTruthy();
    duplicateSelection();
    expect(Object.keys(S().doc.items)).toHaveLength(1);
    pasteFragment(extractFragment(vdoc(), new Set([aid])));
    expect(Object.keys(S().doc.items)).toHaveLength(1);
    nudge(100, 0);
    expect(xOf(S().doc, aid)).toBe(50);
    // nothing happened, so there is nothing to record or reselect
    expect(S().past).toHaveLength(0);
    expect(S().selection).toEqual([aid]);
    gestureUpdate(moveTo(aid, 70));
    endGesture(true);
    expect(xOf(S().doc, aid)).toBe(70);
    expect(S().past).toHaveLength(1);
  });

  it('withGestureMutate lets the gesture owner edit mid-drag', async () => {
    const { store, aid } = await gestureDoc();
    const { S, mutate, beginGesture, gestureUpdate, endGesture, withGestureMutate } = store;
    beginGesture();
    gestureUpdate(moveTo(aid, 50));
    withGestureMutate(() => mutate((d) => void (((d.items[aid] as unknown as { x: number }).x = 90))));
    expect(xOf(S().doc, aid)).toBe(90);
    expect(S().past).toHaveLength(0);
    endGesture(true);
    expect(xOf(S().doc, aid)).toBe(90);
    expect(S().past).toHaveLength(1);
  });

  it('ignores undo and redo mid-drag', async () => {
    const { store, aid } = await gestureDoc();
    const { S, mutate, beginGesture, gestureUpdate, endGesture, undo, redo } = store;
    mutate((d) => void (((d.items[aid] as unknown as { x: number }).x = 10)));
    expect(S().past).toHaveLength(1);
    beginGesture();
    gestureUpdate(moveTo(aid, 50));
    undo();
    redo();
    expect(xOf(S().doc, aid)).toBe(50);
    expect(S().past).toHaveLength(1);
    endGesture(true);
    expect(xOf(S().doc, aid)).toBe(50);
    expect(S().past).toHaveLength(2);
  });

  it('replaceDoc drops a running gesture instead of being clobbered by it', async () => {
    const { store, aid } = await gestureDoc();
    const { S, beginGesture, gestureUpdate, endGesture, replaceDoc, inGesture } = store;
    const { createDoc } = await import('../model/doc');
    beginGesture();
    gestureUpdate(moveTo(aid, 50));
    const other = createDoc('Other');
    replaceDoc(other);
    expect(inGesture()).toBe(false);
    expect(S().doc).toBe(other);
    // a late pointer move / pointer up must not resurrect the old document
    gestureUpdate(moveTo(aid, 70));
    endGesture(true);
    expect(S().doc).toBe(other);
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

  it('duplicates a page of a document that an earlier edit has frozen', () => {
    const { doc, p1 } = twoPages();
    // any edit passes the document through immer, which freezes every item
    const edited = produce(doc, (d) => void (d.name = 'Edited'));
    let copy = '';
    const next = produce(edited, (d) => void (copy = duplicatePage(d as CircuitDoc, p1)));
    expect(pageItemIds(next, copy)).toHaveLength(pageItemIds(edited, p1).length);
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
    // the copies keep their names: each page names its parts on its own
    expect(comps.map((c) => c.ref).sort()).toEqual([r1.ref, r2.ref].sort());
    expect(runErc(next).some((i) => i.rule === 'duplicate-ref')).toBe(false);
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

  it('leaves locked parts behind when moving to another page', () => {
    const { doc, p1, p2, r1, r2, w } = twoPages();
    (doc.items[r1.id] as ComponentItem).locked = true;
    let moved: string[] = [];
    const next = produce(doc, (d) => void (moved = moveItemsToPage(d as CircuitDoc, [r1.id, r2.id], p2)));
    // the locked part stays on page 1; the unlocked one moves alone
    expect(itemPage(next, next.items[r1.id])).toBe(p1);
    expect(next.items[r2.id].page).toBe(p2);
    expect(moved).toEqual([r2.id]);
    // the wire between them stays and keeps its locked end, letting go of the moved part
    const left = next.items[w.id] as WireItem;
    expect(itemPage(next, left)).toBe(p1);
    expect(left.a).toEqual({ kind: 'port', comp: r1.id, port: '2' });
    expect(left.b.kind).toBe('free');
  });

  it('does not auto-move a locked wire between moved parts; its moved ends go loose', () => {
    const doc = createDoc();
    const p2 = addPage(doc);
    const p1 = docPages(doc)[0].id;
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    const ab = wire(doc, a, '2', b, '1', { locked: true });
    let moved: string[] = [];
    const next = produce(doc, (d) => void (moved = moveItemsToPage(d as CircuitDoc, [a.id, b.id], p2)));
    expect(moved.sort()).toEqual([a.id, b.id].sort());
    // the locked wire stays on page 1 with both ends loose where the pins were,
    // so no connection spans pages and every view keeps resolving
    const left = next.items[ab.id] as WireItem;
    expect(itemPage(next, left)).toBe(p1);
    expect(left.a.kind).toBe('free');
    expect(left.b.kind).toBe('free');
  });

  it('does not auto-move a locked junction when its wires move', () => {
    const doc = createDoc();
    const p2 = addPage(doc);
    const p1 = docPages(doc)[0].id;
    const a = place(doc, 'resistor', 0, 0);
    const b = place(doc, 'resistor', 200, 0);
    const jid = uid('j');
    doc.items[jid] = { id: jid, type: 'junction', x: 100, y: 0, locked: true };
    const aj: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: a.id, port: '2' }, b: { kind: 'junction', id: jid }, pts: [] };
    const bj: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'junction', id: jid }, b: { kind: 'port', comp: b.id, port: '1' }, pts: [] };
    doc.items[aj.id] = aj;
    doc.items[bj.id] = bj;
    let moved: string[] = [];
    const next = produce(doc, (d) => void (moved = moveItemsToPage(d as CircuitDoc, [aj.id, bj.id], p2)));
    expect(moved.sort()).toEqual([aj.id, bj.id].sort());
    // the locked junction stays on page 1; the moved wires let go of it (and of the staying parts)
    expect(itemPage(next, next.items[jid])).toBe(p1);
    expect((next.items[aj.id] as WireItem).b.kind).toBe('free');
    expect((next.items[bj.id] as WireItem).a.kind).toBe('free');
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

describe('presence on pages', () => {
  it('matches peers by page, an unset or stale page meaning the first', () => {
    const doc = createDoc();
    const second = addPage(doc);
    const first = docPages(doc)[0].id;
    expect(samePage(doc, undefined, first)).toBe(true);
    expect(samePage(doc, 'gone', undefined)).toBe(true);
    expect(samePage(doc, second, first)).toBe(false);
    expect(samePage(doc, second, second)).toBe(true);
  });
});

describe('names per page', () => {
  it('keeps references when pasting onto another page, and still renames a clash on the same page', () => {
    const { doc, p1, p2, r1 } = twoPages();
    const frag = extractFragment(viewDoc(doc, p1), new Set([r1.id]));
    let pasted = '';
    const next = editPage(doc, p2, (d) => void ([pasted] = insertFragment(d as CircuitDoc, frag, 0, 0)));
    expect((next.items[pasted] as ComponentItem).ref).toBe(r1.ref);
    let again = '';
    const twice = editPage(next, p2, (d) => void ([again] = insertFragment(d as CircuitDoc, frag, 0, 0)));
    expect((twice.items[again] as ComponentItem).ref).not.toBe(r1.ref);
  });

  it('flags a duplicate reference only within one page', () => {
    const { doc, r1, r3 } = twoPages();
    r3.ref = r1.ref;
    expect(runErc(doc).some((i) => i.rule === 'duplicate-ref')).toBe(false);
    const { doc: d2, p2, r3: s3 } = twoPages();
    const extra = place(d2, 'resistor', 300, 0, p2);
    extra.ref = s3.ref;
    const dup = runErc(d2).find((i) => i.rule === 'duplicate-ref');
    expect(dup?.items.sort()).toEqual([s3.id, extra.id].sort());
    expect(dup?.key).toBe(`duplicate-ref:${p2}:${s3.ref}`);
  });
});

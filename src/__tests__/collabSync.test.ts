import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { SyncState, changedKeys, docFromEntries, writeEntries, type Entry } from '../collab/sync';
import { createDoc, makeShape } from '../model/doc';
import type { CircuitDoc } from '../model/types';

function docWith(n: number): CircuitDoc {
  return produce(createDoc('Shared'), (d) => {
    for (let i = 0; i < n; i++) {
      const s = makeShape(d as CircuitDoc, 'rect', i * 40, 0, 20, 20);
      s.id = `r${i}`;
      d.items[s.id] = s;
    }
  });
}

/** One simulated client: a document plus its version table. */
class Client {
  sync = new SyncState();
  constructor(public doc: CircuitDoc) {}
  edit(recipe: (d: CircuitDoc) => void): Entry[] {
    const next = produce(this.doc, recipe);
    const out = this.sync.local(next, changedKeys(this.doc, next));
    this.doc = next;
    return out;
  }
  receive(entries: Entry[]) {
    this.doc = writeEntries(this.doc, this.sync.accept(JSON.parse(JSON.stringify(entries))));
  }
}

function pair(): [Client, Client] {
  const a = new Client(docWith(3));
  const seed = a.sync.seed(a.doc);
  const b = new Client(docFromEntries(JSON.parse(JSON.stringify(seed))));
  b.sync.accept(seed);
  return [a, b];
}

describe('collab sync', () => {
  it('lists only the entries that changed', () => {
    const a = docWith(3);
    const b = produce(a, (d) => {
      (d.items.r1 as { x: number }).x = 99;
      delete d.items.r2;
      d.name = 'Renamed';
    });
    expect(changedKeys(a, b).sort()).toEqual(['i:r1', 'i:r2', 'name']);
    expect(changedKeys(a, a)).toEqual([]);
  });

  it('rebuilds the same document from a seeded room state', () => {
    const [a, b] = pair();
    expect(b.doc.items).toEqual(a.doc.items);
    expect(b.doc.name).toBe('Shared');
  });

  it('applies edits and deletions from the other client', () => {
    const [a, b] = pair();
    b.receive(a.edit((d) => void ((d.items.r0 as { x: number }).x = 500)));
    b.receive(a.edit((d) => void delete d.items.r2));
    expect((b.doc.items.r0 as { x: number }).x).toBe(500);
    expect(b.doc.items.r2).toBeUndefined();
  });

  it('converges when both clients edit the same item at once', () => {
    const [a, b] = pair();
    const fromA = a.edit((d) => void ((d.items.r1 as { x: number }).x = 111));
    const fromB = b.edit((d) => void ((d.items.r1 as { x: number }).x = 222));
    a.receive(fromB);
    b.receive(fromA);
    expect(a.doc.items.r1).toEqual(b.doc.items.r1);
  });

  it('ignores stale and repeated entries', () => {
    const [a, b] = pair();
    const first = a.edit((d) => void ((d.items.r0 as { x: number }).x = 1));
    const second = a.edit((d) => void ((d.items.r0 as { x: number }).x = 2));
    b.receive(second);
    b.receive(first);
    b.receive(second);
    expect((b.doc.items.r0 as { x: number }).x).toBe(2);
  });

  it('keeps a deletion when an older edit arrives later', () => {
    const [a, b] = pair();
    const edit = a.edit((d) => void ((d.items.r0 as { x: number }).x = 7));
    const del = a.edit((d) => void delete d.items.r0);
    b.receive(del);
    b.receive(edit);
    expect(b.doc.items.r0).toBeUndefined();
  });

  it('merges a full snapshot into a client that edited offline', () => {
    const [a, b] = pair();
    a.edit((d) => void ((d.items.r0 as { x: number }).x = 10));
    b.edit((d) => void ((d.items.r2 as { x: number }).x = 20));
    a.receive(b.sync.snapshot(b.doc));
    b.receive(a.sync.snapshot(a.doc));
    expect(a.doc.items).toEqual(b.doc.items);
    expect((a.doc.items.r0 as { x: number }).x).toBe(10);
    expect((a.doc.items.r2 as { x: number }).x).toBe(20);
  });
});

import { createDoc, normalizeDoc } from '../model/doc';
import type { CircuitDoc } from '../model/types';

/*
 * Live-collaboration sync, modelled on Excalidraw: the document is split into
 * independent entries (every item, group and symbol, plus the settings, the
 * name and the page list; an item's page travels with the item). Each entry carries a version and a random nonce. Edits bump the
 * version; a received entry wins when its version is higher, and ties go to
 * the lower nonce, so every client settles on the same state without a server
 * that understands the document. Deletions are kept as tombstones (no value).
 *
 * Keys: `i:<id>` item, `g:<id>` group, `s:<id>` symbol, `settings`, `name`, `pages`.
 */

export interface Entry {
  k: string;
  v: number;
  n: number;
  /** Absent when the entry was deleted. */
  val?: unknown;
}

interface Meta {
  v: number;
  n: number;
}

type Coll = 'items' | 'groups' | 'symbols';
const COLL: Record<string, Coll> = { i: 'items', g: 'groups', s: 'symbols' };
const PREFIX: Record<Coll, string> = { items: 'i', groups: 'g', symbols: 's' };

const nonce = () => Math.floor(Math.random() * 2 ** 31);

function valueOf(doc: CircuitDoc, k: string): unknown {
  if (k === 'settings') return doc.settings;
  if (k === 'name') return doc.name;
  // an empty list (not a tombstone) stands for "one implicit page"
  if (k === 'pages') return doc.pages ?? [];
  const coll = COLL[k[0]];
  return coll && k[1] === ':' ? (doc[coll] as Record<string, unknown>)[k.slice(2)] : undefined;
}

/** Keys whose values differ between two documents (by reference, which Immer keeps stable). */
export function changedKeys(a: CircuitDoc, b: CircuitDoc): string[] {
  const out: string[] = [];
  if (a.settings !== b.settings) out.push('settings');
  if (a.name !== b.name) out.push('name');
  if (a.pages !== b.pages) out.push('pages');
  for (const coll of ['items', 'groups', 'symbols'] as const) {
    const x = a[coll] as Record<string, unknown>;
    const y = b[coll] as Record<string, unknown>;
    if (x === y) continue;
    for (const id in y) if (x[id] !== y[id]) out.push(`${PREFIX[coll]}:${id}`);
    for (const id in x) if (!(id in y)) out.push(`${PREFIX[coll]}:${id}`);
  }
  return out;
}

/** Returns a copy of `doc` with the given entries written in (no version checks). */
export function writeEntries(doc: CircuitDoc, entries: Entry[]): CircuitDoc {
  if (!entries.length) return doc;
  const next = { ...doc };
  const copied = new Set<Coll>();
  for (const e of entries) {
    if (e.k === 'settings') {
      if (e.val) next.settings = e.val as CircuitDoc['settings'];
    } else if (e.k === 'name') {
      if (typeof e.val === 'string') next.name = e.val;
    } else if (e.k === 'pages') {
      if (Array.isArray(e.val) && e.val.length) next.pages = e.val as CircuitDoc['pages'];
      else delete next.pages;
    } else {
      const coll = COLL[e.k[0]];
      if (!coll || e.k[1] !== ':') continue;
      if (!copied.has(coll)) {
        (next as Record<Coll, unknown>)[coll] = { ...next[coll] };
        copied.add(coll);
      }
      const rec = next[coll] as Record<string, unknown>;
      const id = e.k.slice(2);
      if (e.val === undefined) delete rec[id];
      else if (coll === 'items' && e.val && typeof e.val === 'object' && 'layer' in e.val) {
        // a peer on an older version still sends shape layers; stacking is z alone now
        const it = { ...(e.val as Record<string, unknown>) };
        delete it.layer;
        rec[id] = it;
      } else rec[id] = e.val;
    }
  }
  return next;
}

/** Version bookkeeping for one client in one room. */
export class SyncState {
  private meta = new Map<string, Meta>();

  /** Records local changes to `keys` (now holding their values in `doc`) and returns them as entries to send. */
  local(doc: CircuitDoc, keys: string[]): Entry[] {
    return keys.map((k) => {
      const v = (this.meta.get(k)?.v ?? 0) + 1;
      const m = { v, n: nonce() };
      this.meta.set(k, m);
      const val = valueOf(doc, k);
      return val === undefined ? { k, ...m } : { k, ...m, val };
    });
  }

  /** Keeps the received entries that win against what this client has, and records their versions. */
  accept(entries: Entry[]): Entry[] {
    const won: Entry[] = [];
    for (const e of entries) {
      if (!e || typeof e.k !== 'string' || typeof e.v !== 'number' || typeof e.n !== 'number') continue;
      const cur = this.meta.get(e.k);
      if (cur && (e.v < cur.v || (e.v === cur.v && e.n >= cur.n))) continue;
      this.meta.set(e.k, { v: e.v, n: e.n });
      won.push(e);
    }
    return won;
  }

  /** Every entry this client knows about, tombstones included: the full room state. */
  snapshot(doc: CircuitDoc): Entry[] {
    const out: Entry[] = [];
    for (const [k, m] of this.meta) {
      const val = valueOf(doc, k);
      out.push(val === undefined ? { k, ...m } : { k, ...m, val });
    }
    return out;
  }

  /** Starts tracking every part of `doc` at version 1 (used by whoever opens the room). */
  seed(doc: CircuitDoc): Entry[] {
    this.meta.clear();
    const keys = ['settings', 'name', 'pages'];
    for (const coll of ['items', 'groups', 'symbols'] as const) for (const id in doc[coll]) keys.push(`${PREFIX[coll]}:${id}`);
    return this.local(doc, keys);
  }

  clear() {
    this.meta.clear();
  }
}

/** Builds a document from a full room state. */
export function docFromEntries(entries: Entry[]): CircuitDoc {
  const base = createDoc();
  const doc = writeEntries({ ...base, items: {}, groups: {}, symbols: {} }, entries);
  return normalizeDoc(JSON.parse(JSON.stringify(doc)));
}

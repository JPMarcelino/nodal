import type { CircuitDoc } from './types';

/** A saved restore point of one document. */
export interface Version {
  id: string;
  /** `CircuitDoc.id` of the document it belongs to. */
  docId: string;
  /** Time it was taken (ms since epoch). */
  t: number;
  /** User-given name; empty for automatic versions. */
  label: string;
  auto: boolean;
  doc: CircuitDoc;
}

export interface VersionDiff {
  added: number;
  removed: number;
  changed: number;
}

/** Item-level difference going from `from` to `to`. */
export function diffDocs(from: CircuitDoc, to: CircuitDoc): VersionDiff {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const id in to.items) {
    const a = from.items[id];
    if (!a) added++;
    else if (a !== to.items[id] && JSON.stringify(a) !== JSON.stringify(to.items[id])) changed++;
  }
  for (const id in from.items) if (!to.items[id]) removed++;
  return { added, removed, changed };
}

/** Whether two documents have the same content (ignores identity and the undo-irrelevant id). */
export function sameContent(a: CircuitDoc, b: CircuitDoc): boolean {
  if (a === b) return true;
  return (
    a.name === b.name &&
    JSON.stringify(a.settings) === JSON.stringify(b.settings) &&
    JSON.stringify(a.items) === JSON.stringify(b.items) &&
    JSON.stringify(a.groups) === JSON.stringify(b.groups) &&
    JSON.stringify(a.symbols) === JSON.stringify(b.symbols) &&
    JSON.stringify(a.pages ?? []) === JSON.stringify(b.pages ?? [])
  );
}

export function countParts(doc: CircuitDoc): { parts: number; wires: number } {
  let parts = 0;
  let wires = 0;
  for (const it of Object.values(doc.items)) {
    if (it.type === 'component') parts++;
    else if (it.type === 'wire') wires++;
  }
  return { parts, wires };
}

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/**
 * Automatic versions to drop. Named versions are always kept; of the automatic
 * ones, the newest `keepRecent` stay, then one per hour for a day, then one per
 * day for `keepDays` days.
 */
export function pruneAutos(versions: Pick<Version, 'id' | 't' | 'auto'>[], now: number, keepRecent = 12, keepDays = 30): string[] {
  const autos = versions.filter((v) => v.auto).sort((a, b) => b.t - a.t);
  const drop: string[] = [];
  const buckets = new Set<string>();
  autos.forEach((v, i) => {
    if (i < keepRecent) return;
    const age = now - v.t;
    const bucket = age < DAY ? `h${Math.floor(v.t / HOUR)}` : age < keepDays * DAY ? `d${Math.floor(v.t / DAY)}` : null;
    if (bucket && !buckets.has(bucket)) buckets.add(bucket);
    else drop.push(v.id);
  });
  return drop;
}

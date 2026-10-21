import { normalizePages } from '../model/pages';
import { migrateItems, uid } from '../model/doc';
import type { CircuitDoc } from '../model/types';
import { pruneAutos, sameContent, type Version } from '../model/versions';
import { S, inGesture, mutate, set, toast, useStore } from '../store/store';

/*
 * Version history: restore points of each document, kept in IndexedDB on this
 * device. Automatic versions are taken every few minutes while editing and
 * whenever a document is closed; named versions are saved by the user and never
 * pruned. Restoring is an ordinary (undoable, shared) edit.
 */

const DB = 'nodal';
const STORE = 'versions';
/** Minimum time between automatic versions of a document. */
const AUTO_EVERY = 5 * 60e3;
/** Editing pause after which an automatic version is considered. */
const IDLE = 4000;

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('Version history is not available here'));
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const os = req.result.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('docId', 'docId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req ? req.result : (undefined as T));
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/* ------------------------------ listeners ------------------------------ */

const listeners = new Set<() => void>();
/** Called whenever the stored versions change. */
export function onVersionsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());

/* -------------------------------- queries -------------------------------- */

/** Brings a stored version's items up to the current model (e.g. shape layers → z); reads are fresh copies. */
function upgrade(v: Version): Version {
  if (v?.doc?.items) migrateItems(v.doc.items);
  return v;
}

/** Versions of a document, newest first. */
export async function listVersions(docId: string): Promise<Version[]> {
  const all = await run<Version[]>('readonly', (os) => os.index('docId').getAll(docId));
  return all.map(upgrade).sort((a, b) => b.t - a.t);
}

/** Latest version of every other circuit kept on this device, newest first. */
export async function listOtherCircuits(exclude?: string, limit = 25): Promise<Version[]> {
  const all = (await run<Version[]>('readonly', (os) => os.getAll())).map(upgrade);
  const latest = new Map<string, Version>();
  for (const v of all) {
    if (v.docId === exclude || !Object.keys(v.doc.items).length) continue;
    const cur = latest.get(v.docId);
    if (!cur || v.t > cur.t) latest.set(v.docId, v);
  }
  return [...latest.values()].sort((a, b) => b.t - a.t).slice(0, limit);
}

export async function deleteVersion(id: string) {
  await run('readwrite', (os) => os.delete(id));
  changed();
}

export async function renameVersion(v: Version, label: string) {
  await run('readwrite', (os) => os.put({ ...v, label: label.trim(), auto: v.auto && !label.trim() }));
  changed();
}

/** Last version saved per document during this session (skips identical saves cheaply). */
const lastSaved = new Map<string, { t: number; doc: CircuitDoc }>();

/**
 * Saves `doc` as a version. Automatic saves are skipped when nothing changed
 * since the previous version (or the document is empty).
 */
export async function saveVersion(doc: CircuitDoc, label = '', auto = false): Promise<Version | null> {
  const docId = doc.id;
  if (!docId) return null;
  // a live session someone else shares is theirs: viewers keep no copies of it
  if (S().viewOnly && docId.startsWith('room:')) return null;
  if (auto) {
    if (!Object.keys(doc.items).length) return null;
    let prev = lastSaved.get(docId)?.doc;
    if (!prev) prev = (await listVersions(docId).catch(() => []))[0]?.doc;
    if (prev && sameContent(prev, doc)) {
      lastSaved.set(docId, { t: Date.now(), doc });
      return null;
    }
  }
  const v: Version = { id: uid('v'), docId, t: Date.now(), label: label.trim(), auto, doc };
  await run('readwrite', (os) => os.put(v));
  lastSaved.set(docId, { t: v.t, doc });
  await prune(docId);
  changed();
  return v;
}

async function prune(docId: string) {
  const drop = pruneAutos(await listVersions(docId), Date.now());
  if (drop.length) await run('readwrite', (os) => void drop.forEach((id) => os.delete(id)));
}

/** Saves a named version of the open document. */
export async function saveNamedVersion(label: string) {
  try {
    const v = await saveVersion(S().doc, label || defaultLabel(), false);
    if (v) toast(`Saved version “${v.label}”`, 'success');
  } catch (e) {
    toast(`Could not save the version: ${(e as Error).message}`, 'error');
  }
}

export function defaultLabel(t = Date.now()): string {
  return `Version of ${new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

/** Puts a version's content back into the open document; the current state is kept as a version first. */
export async function restoreVersion(v: Version) {
  // restoring under a running drag would be discarded by its next update
  if (inGesture()) return toast('Finish the drag first, then restore the version', 'info');
  const cur = S().doc;
  try {
    await saveVersion(cur, `Before restoring “${v.label || 'autosave'}”`, true);
  } catch {
    /* restoring matters more than the backup */
  }
  mutate((d) => {
    d.name = v.doc.name;
    d.settings = v.doc.settings;
    // versions saved before shapes shared the one stacking order
    d.items = migrateItems(structuredClone(v.doc.items));
    d.groups = v.doc.groups;
    d.symbols = v.doc.symbols;
    d.pages = normalizePages({ ...v.doc, items: {} }).pages;
  }, [], { allPages: true });
  // the group you were inside may not exist in the restored version
  set({ scope: undefined });
  toast('Version restored · Undo brings back what was there', 'success');
}

/* ---------------------------- automatic versions ---------------------------- */

let idleTimer: ReturnType<typeof setTimeout> | undefined;

function autoTick() {
  if (inGesture()) {
    idleTimer = setTimeout(autoTick, IDLE);
    return;
  }
  const doc = S().doc;
  if (!doc.id) return;
  const last = lastSaved.get(doc.id);
  if (last && Date.now() - last.t < AUTO_EVERY) {
    idleTimer = setTimeout(autoTick, last.t + AUTO_EVERY - Date.now());
    return;
  }
  void saveVersion(doc, '', true).catch(() => {});
}

let started = false;
/** Starts taking automatic versions (call once at startup). */
export function startVersionHistory() {
  if (started || typeof indexedDB === 'undefined') return;
  started = true;
  // the document as it was opened is the first restore point
  void saveVersion(S().doc, '', true).catch(() => {});
  // switching away (another tab or app, closing, the iPad going to sleep): keep a restore point
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saveVersion(S().doc, '', true).catch(() => {});
  });
  useStore.subscribe((s, prev) => {
    if (s.doc === prev.doc) return;
    if (s.doc.id !== prev.doc.id) {
      // a different document was opened: keep the one being closed, and the one opened as it arrived
      void saveVersion(prev.doc, '', true)
        .then(() => saveVersion(s.doc, '', true))
        .catch(() => {});
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(autoTick, IDLE);
  });
}

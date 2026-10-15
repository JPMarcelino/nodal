import { afterAll, describe, expect, it, vi } from 'vitest';

/*
 * End-to-end check of live sessions against a running relay:
 *   cd collab-server && npm run dev        (listens on :8788)
 *   NODAL_RELAY=1 VITE_COLLAB_URL=ws://127.0.0.1:8788 npx vitest run src/__tests__/collabLive.test.ts
 * Each simulated person gets fresh copies of the store and session modules.
 */

const RUN = !!(globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.NODAL_RELAY;

const mem = new Map<string, string>();
Object.assign(globalThis, {
  window: globalThis,
  addEventListener: () => {},
  localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
  location: { origin: 'http://test', pathname: '/', hash: '', search: '' },
  history: { replaceState: () => {} },
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
});

type Store = typeof import('../store/store');
type Session = typeof import('../collab/session');

async function person(): Promise<{ store: Store; session: Session }> {
  vi.resetModules();
  const store = await import('../store/store');
  const session = await import('../collab/session');
  return { store, session };
}

async function until(what: string, ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const people: { session: Session }[] = [];
afterAll(async () => {
  for (const p of people) await p.session.leaveSession();
});

describe.skipIf(!RUN)('live session (needs a relay)', () => {
  it('syncs the host’s edits and cursors to a view-only guest, and keeps the room', async () => {
    const a = await person();
    people.push(a);
    const link = await a.session.startSession();
    await until('A live', () => a.session.useCollab.getState().status === 'live');

    // someone else's browser: no edit token for the room
    mem.delete('nodal.collab.owned');
    const b = await person();
    people.push(b);
    await b.session.joinSession(link);
    await until('B live', () => b.session.useCollab.getState().status === 'live');
    await until('B converged', () => JSON.stringify(b.store.S().doc.items) === JSON.stringify(a.store.S().doc.items));

    const ids = Object.keys(a.store.S().doc.items).filter((id) => a.store.S().doc.items[id].type === 'component');
    const [moved, removed] = ids;
    const x0 = (a.store.S().doc.items[moved] as { x: number }).x;

    a.store.mutate((d) => void ((d.items[moved] as { x: number }).x = x0 + 100));
    await until('move reaches B', () => (b.store.S().doc.items[moved] as { x: number }).x === x0 + 100);

    // the guest can't delete
    expect(b.store.S().viewOnly).toBe(true);
    b.store.mutate((d) => void delete d.items[removed]);
    expect(b.store.S().doc.items[removed]).toBeDefined();

    a.store.mutate((d) => void delete d.items[removed]);
    await until('delete reaches B', () => !b.store.S().doc.items[removed]);
    a.store.undo();
    await until('undo reaches B', () => !!b.store.S().doc.items[removed]);

    a.store.set({ cursor: { x: 123, y: 456 } });
    await until('cursor reaches B', () => Object.values(b.session.useCollab.getState().peers).some((p) => p.cursor?.x === 123 && p.cursor?.y === 456));
    const peerA = Object.values(b.session.useCollab.getState().peers)[0];
    expect(peerA.name).toBe(a.session.useCollab.getState().me.name);

    await b.session.leaveSession();
    await until('A sees B leave', () => Object.keys(a.session.useCollab.getState().peers).length === 0);
    const final = a.store.S().doc.items;
    await a.session.leaveSession();

    // the room keeps the circuit after everyone has left
    mem.delete('nodal.collab.owned');
    const c = await person();
    people.push(c);
    await c.session.joinSession(link);
    await until('C live', () => c.session.useCollab.getState().status === 'live');
    expect(c.store.S().doc.items).toEqual(final);
  }, 30000);
});

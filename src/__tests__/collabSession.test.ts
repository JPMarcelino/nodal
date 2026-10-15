import { produce } from 'immer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDoc, makeShape } from '../model/doc';
import type { CircuitDoc } from '../model/types';

/*
 * Relay-free tests for live-session orchestration (src/collab/session.ts) and
 * store.applyExternal. The skipped E2E test (collabLive.test.ts) is the only
 * thing exercising this code, so none of it runs in CI. Here each simulated
 * person gets fresh store/session modules (like the E2E test), but the
 * WebSocket is faked and a scripted in-memory relay forwards messages between
 * peers and keeps the room snapshot, mirroring collab-server/src/index.ts:
 * `b`/`p` are broadcast to the others, `save` replaces the stored snapshot,
 * newcomers get `init` and everyone else gets `join`/`leave`. The first edit
 * token (`?w=`) a room sees owns it; `b`/`save` from anyone else are dropped.
 */

const mem = new Map<string, string>();
Object.assign(globalThis, {
  window: globalThis,
  addEventListener: () => {},
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
  location: { origin: 'http://test', pathname: '/', hash: '', search: '' },
  history: { replaceState: () => {} },
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
});

type StoreMod = typeof import('../store/store');
type SessionMod = typeof import('../collab/session');
type Person = { store: StoreMod; session: SessionMod };

async function person(): Promise<Person> {
  vi.resetModules();
  const store = await import('../store/store');
  const session = await import('../collab/session');
  return { store, session };
}

/** Someone else's browser: no edit tokens from rooms "this" browser started. */
async function guest(): Promise<Person> {
  mem.delete('nodal.collab.owned');
  return person();
}

async function until(what: string, ok: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/* ------------------------------------------------------------------ */
/* Fake relay                                                          */
/* ------------------------------------------------------------------ */

interface RoomState {
  sockets: Set<FakeSocket>;
  ids: Map<FakeSocket, string>;
  snapshot: string | null;
  owner?: string;
}

const rooms = new Map<string, RoomState>();
const dropRooms = new Set<string>();
const connectLog: { room: string; at: number }[] = [];
let nextPeer = 1;
let droppedEdits = 0;

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeSocket.OPEN;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  id = '';
  room = '';
  edit = false;
  constructor(url: string) {
    const m = String(url).match(/\/room\/([A-Za-z0-9_-]{8,64})/);
    this.room = m ? m[1] : 'bad-room';
    connectLog.push({ room: this.room, at: Date.now() });
    if (dropRooms.has(this.room)) {
      // simulate an unreachable server: the socket dies before init arrives
      this.readyState = FakeSocket.CLOSED;
      setTimeout(() => this.onclose?.(), 0);
      return;
    }
    let r = rooms.get(this.room);
    if (!r) {
      r = { sockets: new Set(), ids: new Map(), snapshot: null };
      rooms.set(this.room, r);
    }
    const token = String(url).match(/[?&]w=([^&]+)/)?.[1];
    if (token && !r.owner) r.owner = token;
    this.edit = !!token && token === r.owner;
    this.id = `p${nextPeer++}`;
    r.sockets.add(this);
    r.ids.set(this, this.id);
    const others = [...r.sockets].filter((s) => s !== this);
    const peers = others.map((s) => r!.ids.get(s)!);
    const editors = others.filter((s) => s.edit).map((s) => r!.ids.get(s)!);
    const snapshot = r.snapshot;
    const edit = this.edit;
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ t: 'init', you: this.id, peers, editors, edit, snapshot }) }), 0);
    for (const s of r.sockets) {
      if (s === this) continue;
      const msg = JSON.stringify({ t: 'join', id: this.id, edit });
      setTimeout(() => s.onmessage?.({ data: msg }), 0);
    }
  }
  send(raw: string) {
    const r = rooms.get(this.room);
    if (!r || !r.sockets.has(this)) return;
    let msg: { t?: unknown; d?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if ((msg.t === 'b' || msg.t === 'save') && !this.edit) {
      droppedEdits++;
      return;
    }
    if (msg.t === 'save' && typeof msg.d === 'string') {
      r.snapshot = msg.d;
      return;
    }
    if ((msg.t === 'b' || msg.t === 'p') && typeof msg.d === 'string') {
      const out = JSON.stringify({ t: msg.t, from: r.ids.get(this), d: msg.d });
      for (const s of [...r.sockets]) {
        if (s !== this) setTimeout(() => s.onmessage?.({ data: out }), 0);
      }
    }
  }
  close() {
    this.drop(true);
  }
  /** Server-side drop: the room forgets the socket and the client sees onclose. */
  drop(notifyOthers: boolean) {
    const r = rooms.get(this.room);
    if (r?.sockets.has(this)) {
      r.sockets.delete(this);
      r.ids.delete(this);
      if (notifyOthers) {
        const msg = JSON.stringify({ t: 'leave', id: this.id });
        for (const s of [...r.sockets]) setTimeout(() => s.onmessage?.({ data: msg }), 0);
      }
    }
    if (this.readyState !== FakeSocket.CLOSED) {
      this.readyState = FakeSocket.CLOSED;
      setTimeout(() => this.onclose?.(), 0);
    }
  }
}

const snapshotOf = (room: string): string | null => rooms.get(room)?.snapshot ?? null;
const connectCount = (room: string): number => connectLog.filter((c) => c.room === room).length;
function socketById(room: string, id: string): FakeSocket | undefined {
  const r = rooms.get(room);
  if (!r) return undefined;
  for (const [sock, sid] of r.ids) if (sid === id) return sock;
  return undefined;
}

const NativeWebSocket = globalThis.WebSocket;
const people: Person[] = [];

beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>).WebSocket = FakeSocket;
});

beforeEach(() => {
  droppedEdits = 0;
  rooms.clear();
  dropRooms.clear();
  connectLog.length = 0;
});

afterEach(async () => {
  for (const p of people.splice(0)) await p.session.leaveSession();
  rooms.clear();
  dropRooms.clear();
  connectLog.length = 0;
});

afterAll(async () => {
  for (const p of people.splice(0)) await p.session.leaveSession();
  (globalThis as unknown as Record<string, unknown>).WebSocket = NativeWebSocket;
});

/* ------------------------------------------------------------------ */
/* Session orchestration                                               */
/* ------------------------------------------------------------------ */

describe('session orchestration (fake relay)', () => {
  it('seeds the room as host; guests replace their doc with the stored snapshot', async () => {
    const a = await person();
    people.push(a);
    a.store.mutate((d) => void (d.name = 'Host circuit'));
    const link = await a.session.startSession();
    await until('A live', () => a.session.useCollab.getState().status === 'live');
    const parsed = a.session.parseLink(link);
    expect(parsed).not.toBeNull();
    const room = parsed!.room;
    // the host sends a full save snapshot on init
    await until('host snapshot saved', () => snapshotOf(room) !== null);
    // edits refresh the stored snapshot (debounced save)
    const before = snapshotOf(room)!;
    a.store.mutate((d) => void (d.name = 'Host circuit v2'));
    await until('snapshot refreshed', () => snapshotOf(room) !== null && snapshotOf(room) !== before);

    const b = await guest();
    people.push(b);
    await b.session.joinSession(link);
    await until('B live', () => b.session.useCollab.getState().status === 'live');
    await until('B converged', () => b.store.S().doc.name === 'Host circuit v2');
    expect(b.store.S().doc.items).toEqual(a.store.S().doc.items);

    // the stored snapshot decrypts to the shared circuit
    const { importRoomKey, open } = await import('../collab/crypto');
    const key = await importRoomKey(parsed!.key);
    const entries = await open<{ k: string; val?: unknown }[]>(key, snapshotOf(room)!);
    expect(entries.find((e) => e.k === 'name')?.val).toBe('Host circuit v2');
  }, 30000);

  it('syncs edits, deletions, undo and presence between two people', async () => {
    const a = await person();
    people.push(a);
    const link = await a.session.startSession();
    await until('A live', () => a.session.useCollab.getState().status === 'live');

    const b = await guest();
    people.push(b);
    await b.session.joinSession(link);
    await until('B live', () => b.session.useCollab.getState().status === 'live');
    expect(b.store.S().doc.items).toEqual(a.store.S().doc.items);

    const items = a.store.S().doc.items;
    const ids = Object.keys(items).filter((id) => typeof (items[id] as { x?: unknown }).x === 'number');
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const [moved, removed] = ids;
    const x0 = (a.store.S().doc.items[moved] as unknown as { x: number }).x;

    a.store.mutate((d) => void ((d.items[moved] as unknown as { x: number }).x = x0 + 100));
    await until(
      'move reaches B',
      () => (b.store.S().doc.items[moved] as unknown as { x: number } | undefined)?.x === x0 + 100,
    );

    a.store.mutate((d) => void delete d.items[removed]);
    await until('delete reaches B', () => !b.store.S().doc.items[removed]);

    // A's undo reverts the deletion, then the move
    a.store.undo();
    await until('undo reaches B', () => !!b.store.S().doc.items[removed]);
    a.store.undo();
    await until('second undo reaches B', () => (b.store.S().doc.items[moved] as unknown as { x: number })?.x === x0);

    a.store.set({ cursor: { x: 123, y: 456 } });
    await until('cursor reaches B', () =>
      Object.values(b.session.useCollab.getState().peers).some((p) => p.cursor?.x === 123 && p.cursor?.y === 456),
    );
    const peerA = Object.values(b.session.useCollab.getState().peers)[0];
    expect(peerA.name).toBe(a.session.useCollab.getState().me.name);
  }, 30000);

  it('guests can only watch, and get their own circuit back when they leave', async () => {
    const a = await person();
    people.push(a);
    a.store.mutate((d) => void (d.name = 'Shared'));
    const link = await a.session.startSession();
    await until('A live', () => a.session.useCollab.getState().status === 'live');
    expect(a.store.S().viewOnly).toBe(false);

    const b = await guest();
    people.push(b);
    b.store.replaceDoc({ ...createDoc('Mine'), id: 'mine' });
    await b.session.joinSession(link);
    await until('B live', () => b.session.useCollab.getState().status === 'live');
    await until('B has the shared circuit', () => b.store.S().doc.name === 'Shared');
    expect(b.store.S().viewOnly).toBe(true);
    const peerA = Object.values(b.session.useCollab.getState().peers)[0];
    expect(peerA.edit).toBe(true);
    await until('A sees B as a viewer', () => Object.values(a.session.useCollab.getState().peers).some((p) => p.edit === false));

    // the store refuses B's edits ...
    const shared = b.store.S().doc;
    b.store.mutate((d) => void (d.name = 'Hijacked'));
    expect(b.store.S().doc).toBe(shared);
    // ... anything that slips past is put back ...
    b.store.set({ doc: { ...shared, name: 'Hijacked' } });
    expect(b.store.S().doc.name).toBe('Shared');
    // ... and the relay drops edits sent without the owner's token
    const room = a.session.parseLink(link)!.room;
    const sockB = [...rooms.get(room)!.sockets].find((s) => !s.edit)!;
    sockB.send(JSON.stringify({ t: 'b', d: 'x' }));
    sockB.send(JSON.stringify({ t: 'save', d: 'x' }));
    expect(droppedEdits).toBe(2);
    expect(snapshotOf(room)).not.toBe('x');

    // A's edits still reach B
    a.store.mutate((d) => void (d.name = 'Shared v2'));
    await until('edit reaches B', () => b.store.S().doc.name === 'Shared v2');
    expect(a.store.S().doc.name).toBe('Shared v2');

    await b.session.leaveSession();
    people.splice(people.indexOf(b), 1);
    expect(b.store.S().doc.name).toBe('Mine');
    expect(b.store.S().doc.id).toBe('mine');
    expect(b.store.S().viewOnly).toBe(false);
    b.store.mutate((d) => void (d.name = 'Mine, edited'));
    expect(b.store.S().doc.name).toBe('Mine, edited');
  }, 30000);

  it('the host can edit again after a reload; a token-less newcomer still only watches', async () => {
    const a = await person();
    people.push(a);
    const link = await a.session.startSession();
    await until('A live', () => a.session.useCollab.getState().status === 'live');
    await a.session.leaveSession();
    people.splice(0);

    // same browser (token kept): joining the link edits
    const a2 = await person();
    people.push(a2);
    await a2.session.joinSession(link);
    await until('A2 live', () => a2.session.useCollab.getState().status === 'live');
    expect(a2.store.S().viewOnly).toBe(false);
    a2.store.mutate((d) => void (d.name = 'Back again'));

    const c = await guest();
    people.push(c);
    await c.session.joinSession(link);
    await until('C live', () => c.session.useCollab.getState().status === 'live');
    await until('C converged', () => c.store.S().doc.name === 'Back again');
    expect(c.store.S().viewOnly).toBe(true);
  }, 30000);

  it('mirrors the followed peer view; a local view change unfollows', async () => {
    const a = await person();
    people.push(a);
    const link = await a.session.startSession();
    await until('A live', () => a.session.useCollab.getState().status === 'live');

    const b = await guest();
    people.push(b);
    await b.session.joinSession(link);
    await until('B live', () => b.session.useCollab.getState().status === 'live');
    await until('B sees A', () => Object.keys(b.session.useCollab.getState().peers).length === 1);
    const peerA = Object.keys(b.session.useCollab.getState().peers)[0];

    b.session.follow(peerA);
    expect(b.session.useCollab.getState().following).toBe(peerA);
    a.store.set({ view: { x: 10, y: 20, zoom: 2 } });
    await until('B view follows A', () => {
      const v = b.store.S().view;
      return v.x === 10 && v.y === 20 && v.zoom === 2;
    });
    // a remote-driven view change keeps the follow active ...
    expect(b.session.useCollab.getState().following).toBe(peerA);
    // ... but touching the view locally stops following
    b.store.set({ view: { x: 0, y: 0, zoom: 1 } });
    expect(b.session.useCollab.getState().following).toBeNull();
  }, 30000);

  it('reconnects after a drop and delivers edits made while offline', async () => {
    const a = await person();
    people.push(a);
    const link = await a.session.startSession();
    await until('A live', () => a.session.useCollab.getState().status === 'live');

    const b = await guest();
    people.push(b);
    await b.session.joinSession(link);
    await until('B live', () => b.session.useCollab.getState().status === 'live');
    await until('B sees A', () => Object.keys(b.session.useCollab.getState().peers).length === 1);
    const peerA = Object.keys(b.session.useCollab.getState().peers)[0];
    const room = a.session.parseLink(link)!.room;

    socketById(room, peerA)?.drop(true);
    await until('A reconnecting', () => a.session.useCollab.getState().status === 'reconnecting');
    // edit while the socket is down: lastSynced already covers it, so the
    // reconnecting client must bring the room up to date on its next init
    a.store.mutate((d) => void (d.name = 'Edited while offline'));
    await until('A live again', () => a.session.useCollab.getState().status === 'live');
    await until('offline edit reaches B', () => b.store.S().doc.name === 'Edited while offline');
  }, 30000);

  it('gives up after 4 failed connects with growing backoff', async () => {
    const c = await person();
    people.push(c);
    const room = 'dropdead';
    dropRooms.add(room);
    const delays: number[] = [];
    const realST = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]): number => {
      if (typeof ms === 'number') delays.push(ms);
      return realST(fn, ms, ...rest);
    }) as typeof setTimeout;
    try {
      const ok = await c.session.joinSession(`http://test/#room=${room},AAAAAAAAAAAAAAAAAAAAAA`);
      expect(ok).toBe(true);
      await until('session gives up', () => c.session.useCollab.getState().status === 'off', 20000);
    } finally {
      globalThis.setTimeout = realST;
    }
    expect(connectCount(room)).toBe(4);
    expect(c.session.useCollab.getState().link).toBeNull();
    expect(c.store.S().toasts.some((t) => t.text.includes('Could not reach'))).toBe(true);
    expect(delays.filter((d) => d === 1000 || d === 2000 || d === 4000)).toEqual([1000, 2000, 4000]);
  }, 30000);
});

/* ------------------------------------------------------------------ */
/* applyExternal                                                       */
/* ------------------------------------------------------------------ */

function docAB(): CircuitDoc {
  return produce(createDoc('T'), (d) => {
    const a = makeShape(d as CircuitDoc, 'rect', 0, 0, 20, 20);
    a.id = 'a';
    d.items[a.id] = a;
    const b = makeShape(d as CircuitDoc, 'rect', 40, 0, 20, 20);
    b.id = 'b';
    d.items[b.id] = b;
  });
}

describe('applyExternal', () => {
  it('patches the doc without marking it dirty, and drops selections of removed items', async () => {
    const p = await person();
    people.push(p);
    p.store.replaceDoc(docAB());
    p.store.set({ selection: ['a', 'b'] });
    p.store.applyExternal((doc) =>
      produce(doc, (d) => {
        delete d.items['b'];
      }),
    );
    const s = p.store.S();
    expect(s.doc.items['b']).toBeUndefined();
    expect(s.doc.items['a']).toBeTruthy();
    expect(s.dirty).toBe(false);
    expect(s.past).toEqual([]);
    expect(s.selection).toEqual(['a']);
  });

  it('makes undo revert only local edits and redo keep remote changes', async () => {
    const p = await person();
    people.push(p);
    p.store.replaceDoc(docAB());
    p.store.mutate((d) => void ((d.items['a'] as unknown as { x: number }).x = 100));
    expect(p.store.S().past).toHaveLength(1);
    // remote deletion lands in the doc and in the undo history
    p.store.applyExternal((doc) =>
      produce(doc, (d) => {
        delete d.items['b'];
      }),
    );
    expect(p.store.S().past).toHaveLength(1);
    expect(p.store.S().past[0].items['b']).toBeUndefined();

    p.store.undo();
    expect((p.store.S().doc.items['a'] as unknown as { x: number }).x).toBe(0);
    expect(p.store.S().doc.items['b']).toBeUndefined();

    p.store.redo();
    expect((p.store.S().doc.items['a'] as unknown as { x: number }).x).toBe(100);
    expect(p.store.S().doc.items['b']).toBeUndefined();
  });

  it('patches the redo stack too', async () => {
    const p = await person();
    people.push(p);
    p.store.replaceDoc(docAB());
    p.store.mutate((d) => void ((d.items['a'] as unknown as { x: number }).x = 100));
    p.store.undo();
    expect(p.store.S().future).toHaveLength(1);
    p.store.applyExternal((doc) =>
      produce(doc, (d) => {
        delete d.items['b'];
      }),
    );
    expect(p.store.S().future[0].items['b']).toBeUndefined();
    p.store.redo();
    expect((p.store.S().doc.items['a'] as unknown as { x: number }).x).toBe(100);
    expect(p.store.S().doc.items['b']).toBeUndefined();
  });

  it('patches the gesture base, so undoing a drag keeps remote changes', async () => {
    const p = await person();
    people.push(p);
    p.store.replaceDoc(docAB());
    p.store.beginGesture();
    // a remote deletion arrives mid-drag
    p.store.applyExternal((doc) =>
      produce(doc, (d) => {
        delete d.items['b'];
      }),
    );
    p.store.gestureUpdate((d) => void ((d.items['a'] as unknown as { x: number }).x = 50));
    p.store.endGesture(true);
    expect((p.store.S().doc.items['a'] as unknown as { x: number }).x).toBe(50);
    expect(p.store.S().doc.items['b']).toBeUndefined();
    expect(p.store.S().past).toHaveLength(1);
    // undoing the drag restores the pre-drag position but not the remote item
    p.store.undo();
    expect((p.store.S().doc.items['a'] as unknown as { x: number }).x).toBe(0);
    expect(p.store.S().doc.items['b']).toBeUndefined();
  });
});

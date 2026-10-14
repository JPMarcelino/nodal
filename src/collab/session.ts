import { create } from 'zustand';
import { isDesktop } from '../io/files';
import { createDoc } from '../model/doc';
import type { CircuitDoc, Point } from '../model/types';
import * as A from '../store/actions';
import { X, useExplain } from '../store/explain';
import { S, applyExternal, pauseAutosave, replaceDoc, set as setApp, toast, useStore } from '../store/store';
import { importRoomKey, newRoomKey, open, randomId, seal } from './crypto';
import { SyncState, changedKeys, docFromEntries, writeEntries, type Entry } from './sync';

/*
 * A live session: the WebSocket to the room relay, encryption, document sync
 * and presence (cursors, selections, viewports). See sync.ts for the merge
 * rules and collab-server/ for the relay.
 */

export const COLLAB_URL: string = import.meta.env.VITE_COLLAB_URL ?? 'wss://nodal-collab.nodal-collab.workers.dev';
/** Links made from the desktop app point at the web app, so anyone can open them. */
const PUBLIC_APP_URL = 'https://jpmarcelino.github.io/nodal/';

export interface PeerView {
  /** World point at the centre of their canvas. */
  cx: number;
  cy: number;
  zoom: number;
}

export interface Peer {
  id: string;
  name: string;
  color: string;
  cursor?: Point;
  selection: string[];
  view?: PeerView;
  /** Laser pointer: 1 = laser tool on, 2 = button held (draws a trail). */
  laser?: number;
}

export interface Me {
  name: string;
  color: string;
}

export interface CollabState {
  status: 'off' | 'connecting' | 'live' | 'reconnecting';
  link: string | null;
  me: Me;
  peers: Record<string, Peer>;
  /** Peer whose viewport this client mirrors. */
  following: string | null;
}

export const PEER_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#c2255c', '#7048e8', '#0c8599', '#e67700', '#5c940d', '#ae3ec9', '#d6336c'];
const ADJECTIVES = ['Swift', 'Bright', 'Quiet', 'Clever', 'Steady', 'Lucky', 'Bold', 'Calm', 'Keen', 'Nimble', 'Sunny', 'Brave'];
const PARTS = ['Capacitor', 'Resistor', 'Inductor', 'Diode', 'Transistor', 'Relay', 'Crystal', 'Fuse', 'Op-amp', 'Mosfet', 'Varistor', 'Thermistor'];
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

const ME_KEY = 'nodal.collab.me';
function loadMe(): Me {
  try {
    const raw = JSON.parse(localStorage.getItem(ME_KEY) ?? 'null') as Me | null;
    if (raw && typeof raw.name === 'string' && typeof raw.color === 'string') return raw;
  } catch {
    /* fall through */
  }
  const me = { name: `${pick(ADJECTIVES)} ${pick(PARTS)}`, color: pick(PEER_COLORS) };
  localStorage.setItem(ME_KEY, JSON.stringify(me));
  return me;
}

export const useCollab = create<CollabState>(() => ({ status: 'off', link: null, me: loadMe(), peers: {}, following: null }));
const C = () => useCollab.getState();
const setC = (p: Partial<CollabState> | ((s: CollabState) => Partial<CollabState>)) => useCollab.setState(p);

/* ------------------------------------------------------------------ */
/* Session state                                                       */
/* ------------------------------------------------------------------ */

let ws: WebSocket | null = null;
let room = '';
let key: CryptoKey | null = null;
let myId = '';
let sync = new SyncState();
/** The document as last sent / received; local edits are the diff against it. */
let lastSynced: CircuitDoc | null = null;
/** Guests replace their document with the room's on their first connect. */
let awaitingRoom = false;
let connectedOnce = false;
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** Set while this module writes to the store, so those writes aren't sent back out. */
let applying = false;
let followApplying = false;
let inbox: Promise<void> = Promise.resolve();
let outbox: Promise<void> = Promise.resolve();

const live = () => C().status !== 'off';

function quietly(fn: () => void) {
  applying = true;
  try {
    fn();
  } finally {
    applying = false;
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function linkFor(r: string, k: string): string {
  const base = isDesktop() ? PUBLIC_APP_URL : `${location.origin}${location.pathname}`;
  return `${base}#room=${r},${k}`;
}

/** Extracts room id and key from a share link (or just its #fragment). */
export function parseLink(text: string): { room: string; key: string } | null {
  const m = text.trim().match(/#room=([A-Za-z0-9_-]{8,64}),([A-Za-z0-9_-]{16,64})/);
  return m ? { room: m[1], key: m[2] } : null;
}

/** Opens a new room with the current circuit and returns its share link. */
export async function startSession(): Promise<string> {
  const r = randomId(12);
  const k = newRoomKey();
  await connect(r, k, false);
  return linkFor(r, k);
}

/** Joins the room in a share link, replacing the open circuit with the shared one. */
export async function joinSession(link: string): Promise<boolean> {
  const parsed = parseLink(link);
  if (!parsed) {
    toast('That is not a Nodal session link', 'error');
    return false;
  }
  if (live() && parsed.room === room) return true;
  await connect(parsed.room, parsed.key, true);
  return true;
}

export async function leaveSession() {
  if (!live()) return;
  flushLocal();
  if (saveTimer) await saveNow();
  await outbox;
  shutdown();
  toast('Left the live session. The circuit stays open here.', 'info');
}

export function setMyName(name: string) {
  const me = { ...C().me, name: name.trim().slice(0, 40) || C().me.name };
  setC({ me });
  localStorage.setItem(ME_KEY, JSON.stringify(me));
  sendPresence();
}

export function setMyColor(color: string) {
  const me = { ...C().me, color };
  setC({ me });
  localStorage.setItem(ME_KEY, JSON.stringify(me));
  sendPresence();
}

export function follow(id: string | null) {
  setC({ following: id && id !== C().following ? id : null });
  const p = id ? C().peers[id] : undefined;
  if (p?.view) followView(p.view);
}

/** Joins the session in the page URL, if there is one (web). */
export function joinFromUrl() {
  if (isDesktop()) return;
  const check = () => {
    if (parseLink(location.hash)) void joinSession(location.hash);
  };
  check();
  window.addEventListener('hashchange', check);
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

async function connect(r: string, k: string, guest: boolean) {
  if (live()) shutdown();
  try {
    key = await importRoomKey(k);
  } catch {
    toast('That session link is damaged (bad key)', 'error');
    return;
  }
  room = r;
  sync = new SyncState();
  awaitingRoom = guest;
  connectedOnce = false;
  failures = 0;
  if (!guest) {
    sync.seed(S().doc);
    lastSynced = S().doc;
  }
  pauseAutosave(true);
  const link = linkFor(r, k);
  setC({ status: 'connecting', link, peers: {}, following: null });
  if (!isDesktop()) history.replaceState(null, '', `#room=${r},${k}`);
  openSocket();
}

function openSocket() {
  const sock = new WebSocket(`${COLLAB_URL}/room/${room}`);
  ws = sock;
  sock.onmessage = (e) => {
    if (sock !== ws || typeof e.data !== 'string') return;
    const msg = JSON.parse(e.data);
    inbox = inbox.then(() => handle(msg)).catch((err) => console.warn('[collab]', err));
  };
  sock.onclose = () => {
    if (sock !== ws) return;
    ws = null;
    if (!live()) return;
    failures++;
    if (!connectedOnce && failures >= 4) {
      shutdown();
      toast('Could not reach the collaboration server. Check your connection and try again.', 'error');
      return;
    }
    setC({ status: connectedOnce ? 'reconnecting' : 'connecting', peers: {} });
    retryTimer = setTimeout(openSocket, Math.min(15000, 1000 * 2 ** Math.min(failures - 1, 4)));
  };
}

function shutdown() {
  clearTimeout(retryTimer);
  clearTimeout(flushTimer);
  clearTimeout(saveTimer);
  clearTimeout(presenceTimer);
  flushTimer = saveTimer = presenceTimer = undefined;
  const sock = ws;
  ws = null;
  sock?.close(1000);
  key = null;
  lastSynced = null;
  sync = new SyncState();
  pauseAutosave(false);
  setC({ status: 'off', link: null, peers: {}, following: null });
  if (!isDesktop() && parseLink(location.hash)) history.replaceState(null, '', location.pathname + location.search);
}

function send(t: 'b' | 'p' | 'save', data: unknown) {
  const k = key;
  if (!k) return;
  outbox = outbox
    .then(async () => {
      const d = await seal(k, data);
      if (ws && ws.readyState === WebSocket.OPEN && key === k) ws.send(JSON.stringify({ t, d }));
    })
    .catch((err) => console.warn('[collab]', err));
}

type ServerMsg =
  | { t: 'init'; you: string; peers: string[]; snapshot: string | null }
  | { t: 'join' | 'leave'; id: string }
  | { t: 'b' | 'p'; from: string; d: string };

async function handle(msg: ServerMsg) {
  const k = key;
  if (!k) return;
  switch (msg.t) {
    case 'init': {
      myId = msg.you;
      const peers: Record<string, Peer> = {};
      for (const id of msg.peers) peers[id] = { id, name: '…', color: '#868e96', selection: [] };
      const snapshot = msg.snapshot ? await open<Entry[]>(k, msg.snapshot).catch(() => null) : null;
      if (msg.snapshot && !snapshot) {
        shutdown();
        toast('Could not open this session: the link key does not match', 'error');
        return;
      }
      if (awaitingRoom) {
        awaitingRoom = false;
        sync.clear();
        const doc = snapshot ? docFromEntries(sync.accept(snapshot)) : createDoc('Shared circuit');
        // everyone in a room shares one version history key
        quietly(() => replaceDoc({ ...doc, id: `room:${room}` }));
        lastSynced = S().doc;
        if (!snapshot && !msg.peers.length) toast('This session is empty: nobody has shared a circuit in it yet', 'info');
        setApp({ selection: [] });
        requestAnimationFrame(() => A.fitView());
      } else {
        if (snapshot) mergeRemote(snapshot);
        // whoever opened the room, or reconnects after editing offline, brings the stored copy and the others up to date
        send('save', sync.snapshot(S().doc));
        if (connectedOnce && msg.peers.length) send('b', sync.snapshot(S().doc));
      }
      connectedOnce = true;
      failures = 0;
      setC({ status: 'live', peers });
      sendPresence();
      break;
    }
    case 'join': {
      setC((s) => ({ peers: { ...s.peers, [msg.id]: { id: msg.id, name: '…', color: '#868e96', selection: [] } } }));
      sendPresence();
      // the longest-connected peer (lowest id is as good as any stable choice) catches the newcomer up
      const others = Object.keys(C().peers).filter((id) => id !== msg.id);
      if ([myId, ...others].sort()[0] === myId) send('b', sync.snapshot(S().doc));
      break;
    }
    case 'leave':
      setC((s) => {
        const peers = { ...s.peers };
        delete peers[msg.id];
        return { peers, following: s.following === msg.id ? null : s.following };
      });
      break;
    case 'b': {
      const entries = await open<Entry[]>(k, msg.d).catch(() => null);
      if (entries && Array.isArray(entries)) mergeRemote(entries);
      break;
    }
    case 'p': {
      const p = await open<Partial<Peer>>(k, msg.d).catch(() => null);
      if (!p) return;
      const peer: Peer = {
        id: msg.from,
        name: typeof p.name === 'string' ? p.name.slice(0, 40) : '…',
        color: typeof p.color === 'string' ? p.color : '#868e96',
        cursor: p.cursor,
        selection: Array.isArray(p.selection) ? p.selection : [],
        view: p.view,
        laser: p.laser === 1 || p.laser === 2 ? p.laser : 0,
      };
      setC((s) => ({ peers: { ...s.peers, [msg.from]: peer } }));
      if (C().following === msg.from && peer.view) followView(peer.view);
      break;
    }
  }
}

function mergeRemote(entries: Entry[]) {
  flushLocal();
  const won = sync.accept(entries);
  if (!won.length) return;
  quietly(() => applyExternal((d) => writeEntries(d, won)));
  lastSynced = S().doc;
}

/* ------------------------------------------------------------------ */
/* Outgoing edits                                                      */
/* ------------------------------------------------------------------ */

let flushTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveDue = 0;

function flushLocal() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!lastSynced || awaitingRoom) return;
  const doc = S().doc;
  if (doc === lastSynced) return;
  const keys = changedKeys(lastSynced, doc);
  lastSynced = doc;
  if (!keys.length) return;
  send('b', sync.local(doc, keys));
  scheduleSave();
}

/** The room's stored copy is refreshed by whoever edits, at most every few seconds. */
function scheduleSave() {
  const now = Date.now();
  if (!saveTimer) saveDue = now + 8000;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveNow(), Math.max(0, Math.min(1500, saveDue - now)));
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  send('save', sync.snapshot(S().doc));
  await outbox;
}

useStore.subscribe((s, prev) => {
  if (!live() || applying) return;
  if (s.doc !== prev.doc && !flushTimer) flushTimer = setTimeout(flushLocal, 50);
  if (s.view !== prev.view && !followApplying && C().following) setC({ following: null });
  if (s.cursor !== prev.cursor || s.selection !== prev.selection || s.view !== prev.view || s.canvasSize !== prev.canvasSize || s.tool !== prev.tool) schedulePresence();
});

useExplain.subscribe((s, prev) => {
  if (live() && s.laserDown !== prev.laserDown) schedulePresence();
});

window.addEventListener('beforeunload', () => {
  if (!live()) return;
  flushLocal();
  if (saveTimer) void saveNow();
});

/* ------------------------------------------------------------------ */
/* Presence                                                            */
/* ------------------------------------------------------------------ */

let presenceTimer: ReturnType<typeof setTimeout> | undefined;
let lastPresence = 0;
const PRESENCE_MS = 66;

function schedulePresence() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(sendPresence, Math.max(0, PRESENCE_MS - (Date.now() - lastPresence)));
}

function sendPresence() {
  clearTimeout(presenceTimer);
  presenceTimer = undefined;
  if (C().status !== 'live') return;
  lastPresence = Date.now();
  const { cursor, selection, view, canvasSize } = S();
  const { name, color } = C().me;
  send('p', {
    name,
    color,
    cursor,
    laser: S().tool === 'laser' ? (X().laserDown ? 2 : 1) : 0,
    selection: selection.slice(0, 500),
    view: { cx: (canvasSize.w / 2 - view.x) / view.zoom, cy: (canvasSize.h / 2 - view.y) / view.zoom, zoom: view.zoom },
  });
}

function followView(v: PeerView) {
  if (!Number.isFinite(v.cx) || !Number.isFinite(v.cy) || !(v.zoom > 0)) return;
  const { w, h } = S().canvasSize;
  followApplying = true;
  try {
    setApp({ view: { x: w / 2 - v.cx * v.zoom, y: h / 2 - v.cy * v.zoom, zoom: v.zoom } });
  } finally {
    followApplying = false;
  }
}

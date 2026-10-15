import { DurableObject } from 'cloudflare:workers';

/*
 * Relay for Nodal live sessions. One Durable Object per room forwards messages
 * between the people in it and keeps the latest saved room state. Everything
 * it handles is end-to-end encrypted by the clients (the key never leaves the
 * share link's #fragment), so it can't read any of it.
 *
 * Share links are view-only. Whoever opens a room connects with a secret
 * edit token (`?w=`) that never goes into the link; the room keeps its hash,
 * and only connections presenting it may change the circuit.
 *
 * Client → server (JSON text frames):
 *   { t: 'b', d }     scene update, relayed to everyone else (editors only)
 *   { t: 'p', d }     presence (cursor, selection, viewport), relayed
 *   { t: 'save', d }  replace the stored room state (editors only)
 *   { t: 'end' }      the host closes the room for good (editors only)
 * Server → client:
 *   { t: 'init', you, peers, editors, edit, snapshot }   on connect
 *   { t: 'ended' }    the room was closed; sent instead of init to latecomers
 *   { t: 'join', id, edit } | { t: 'leave', id }
 *   { t: 'b' | 'p', from, d }
 */

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
}

const MAX_PEERS = 32;
const MAX_MESSAGE = 4 * 1024 * 1024;
// storage.put takes at most 128 keys at once: 12 MB in 100 kB chunks stays under that
const MAX_SNAPSHOT = 12 * 1024 * 1024;
const CHUNK = 100_000;
/** Rooms nobody has saved to for this long are deleted (and an ended room's marker is forgotten). */
const EXPIRE_MS = 24 * 3600 * 1000;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{8,64})$/);
    if (!m) return new Response(url.pathname === '/' ? 'Nodal collaboration relay\n' : 'Not found\n', { status: url.pathname === '/' ? 200 : 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade\n', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  },
};

export class Room extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PEERS) return new Response('This session is full\n', { status: 429 });
    const edit = await this.canEdit(new URL(req.url).searchParams.get('w'));
    const { 0: client, 1: server } = new WebSocketPair();
    if (await this.ctx.storage.get<boolean>('ended')) {
      server.accept();
      server.send(JSON.stringify({ t: 'ended' }));
      server.close(1000, 'ended');
      return new Response(null, { status: 101, webSocket: client });
    }
    const id = crypto.randomUUID().slice(0, 8);
    // hibernatable: the object can sleep between messages without dropping connections
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, edit } satisfies Attachment);
    const editors = sockets.filter((ws) => attachment(ws).edit).map(peerId);
    server.send(JSON.stringify({ t: 'init', you: id, peers: sockets.map(peerId), editors, edit, snapshot: await this.loadSnapshot() }));
    this.broadcast(JSON.stringify({ t: 'join', id, edit }), server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The first edit token a room sees becomes its owner's; later connections must present the same one. */
  private async canEdit(token: string | null): Promise<boolean> {
    if (!token || token.length < 16 || token.length > 128) return false;
    const hash = await sha256(token);
    const owner = await this.ctx.storage.get<string>('owner');
    if (owner) return owner === hash;
    await this.ctx.storage.put('owner', hash);
    return true;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    let m: { t?: unknown; d?: unknown };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === 'end' && attachment(ws).edit) return this.end();
    if (typeof m.d !== 'string') return;
    if (m.t === 'p') this.broadcast(JSON.stringify({ t: m.t, from: peerId(ws), d: m.d }), ws);
    else if (!attachment(ws).edit) return;
    else if (m.t === 'b') this.broadcast(JSON.stringify({ t: m.t, from: peerId(ws), d: m.d }), ws);
    else if (m.t === 'save' && m.d.length <= MAX_SNAPSHOT) await this.saveSnapshot(m.d);
  }

  async webSocketClose(ws: WebSocket) {
    this.left(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.left(ws);
  }

  async alarm() {
    const ended = await this.ctx.storage.get<boolean>('ended');
    if (!ended && this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + EXPIRE_MS);
    else await this.ctx.storage.deleteAll();
  }

  /** Deletes the circuit and tells everyone; the link answers "ended" until the marker expires. */
  private async end() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put('ended', true);
    await this.ctx.storage.setAlarm(Date.now() + EXPIRE_MS);
    const msg = JSON.stringify({ t: 'ended' });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
        ws.close(1000, 'ended');
      } catch {
        /* already closing */
      }
    }
  }

  private left(ws: WebSocket) {
    this.broadcast(JSON.stringify({ t: 'leave', id: peerId(ws) }), ws);
    try {
      ws.close(1000);
    } catch {
      /* already closed */
    }
  }

  private broadcast(msg: string, except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(msg);
      } catch {
        /* closing */
      }
    }
  }

  // storage values are size-limited, so the snapshot is stored in chunks
  private async loadSnapshot(): Promise<string | null> {
    const count = await this.ctx.storage.get<number>('snap:n');
    if (!count) return null;
    const keys = Array.from({ length: count }, (_, i) => `snap:${i}`);
    const parts = await this.ctx.storage.get<string>(keys);
    return keys.map((k) => parts.get(k) ?? '').join('');
  }

  private async saveSnapshot(data: string) {
    const parts: Record<string, string | number> = {};
    const count = Math.ceil(data.length / CHUNK);
    for (let i = 0; i < count; i++) parts[`snap:${i}`] = data.slice(i * CHUNK, (i + 1) * CHUNK);
    parts['snap:n'] = count;
    const old = (await this.ctx.storage.get<number>('snap:n')) ?? 0;
    await this.ctx.storage.put(parts);
    if (old > count) await this.ctx.storage.delete(Array.from({ length: old - count }, (_, i) => `snap:${count + i}`));
    await this.ctx.storage.setAlarm(Date.now() + EXPIRE_MS);
  }
}

interface Attachment {
  id: string;
  edit: boolean;
}

function attachment(ws: WebSocket): Attachment {
  const a = ws.deserializeAttachment() as Partial<Attachment> | null;
  return { id: a?.id ?? '', edit: a?.edit === true };
}

function peerId(ws: WebSocket): string {
  return attachment(ws).id;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

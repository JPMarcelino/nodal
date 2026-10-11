import { DurableObject } from 'cloudflare:workers';

/*
 * Relay for Nodal live sessions. One Durable Object per room forwards messages
 * between the people in it and keeps the latest saved room state. Everything
 * it handles is end-to-end encrypted by the clients (the key never leaves the
 * share link's #fragment), so it can't read any of it.
 *
 * Client → server (JSON text frames):
 *   { t: 'b', d }     scene update, relayed to everyone else
 *   { t: 'p', d }     presence (cursor, selection, viewport), relayed
 *   { t: 'save', d }  replace the stored room state
 * Server → client:
 *   { t: 'init', you, peers, snapshot }   on connect
 *   { t: 'join' | 'leave', id }
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
/** Rooms nobody has saved to for this long are deleted. */
const EXPIRE_MS = 90 * 24 * 3600 * 1000;

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
  async fetch(): Promise<Response> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PEERS) return new Response('This session is full\n', { status: 429 });
    const { 0: client, 1: server } = new WebSocketPair();
    const id = crypto.randomUUID().slice(0, 8);
    // hibernatable: the object can sleep between messages without dropping connections
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id });
    server.send(JSON.stringify({ t: 'init', you: id, peers: sockets.map(peerId), snapshot: await this.loadSnapshot() }));
    this.broadcast(JSON.stringify({ t: 'join', id }), server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    let m: { t?: unknown; d?: unknown };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof m.d !== 'string') return;
    if (m.t === 'b' || m.t === 'p') this.broadcast(JSON.stringify({ t: m.t, from: peerId(ws), d: m.d }), ws);
    else if (m.t === 'save' && m.d.length <= MAX_SNAPSHOT) await this.saveSnapshot(m.d);
  }

  async webSocketClose(ws: WebSocket) {
    this.left(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.left(ws);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + EXPIRE_MS);
    else await this.ctx.storage.deleteAll();
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

function peerId(ws: WebSocket): string {
  return (ws.deserializeAttachment() as { id: string } | null)?.id ?? '';
}

import { DurableObject } from 'cloudflare:workers';
import {
  EXPIRE_MS,
  MAX_MESSAGE,
  gateMessage,
  isRoomFull,
  isWellFormedToken,
  resolveOwnership,
  shouldReapOnAlarm,
} from './policy';

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

const CHUNK = 100_000;

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
    if (isRoomFull(sockets.length)) return new Response('This session is full\n', { status: 429 });
    // The ended tombstone is checked before claiming ownership, so a
    // latecomer's token is never persisted into a closed room. (Rules live
    // in ./policy.ts and are unit-tested; keep this wiring in the same order.)
    if (await this.ctx.storage.get<boolean>('ended')) {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      server.send(JSON.stringify({ t: 'ended' }));
      server.close(1000, 'ended');
      return new Response(null, { status: 101, webSocket: client });
    }
    const edit = await this.canEdit(new URL(req.url).searchParams.get('w'));
    const { 0: client, 1: server } = new WebSocketPair();
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
    if (!isWellFormedToken(token)) return false;
    const hash = await sha256(token);
    const verdict = resolveOwnership((await this.ctx.storage.get<string>('owner')) ?? null, hash);
    if (verdict.claim) await this.ctx.storage.put('owner', verdict.claim);
    return verdict.edit;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    let m: { t?: unknown; d?: unknown };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    // Enforcement lives in policy.gateMessage (unit-tested); this only acts on its verdict.
    const decision = gateMessage(m.t, m.d, attachment(ws).edit);
    if (decision === 'end') return this.end();
    if (decision === 'relay') this.broadcast(JSON.stringify({ t: m.t, from: peerId(ws), d: m.d }), ws);
    else if (decision === 'save') await this.saveSnapshot(m.d as string);
  }

  async webSocketClose(ws: WebSocket) {
    this.left(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.left(ws);
  }

  async alarm() {
    const ended = (await this.ctx.storage.get<boolean>('ended')) ?? false;
    if (!shouldReapOnAlarm(ended, this.ctx.getWebSockets().length)) await this.ctx.storage.setAlarm(Date.now() + EXPIRE_MS);
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

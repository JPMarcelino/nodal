#!/usr/bin/env node
/**
 * Nodal agent bridge — lets AI agents drive a running Nodal (web or desktop).
 *
 *   node nodal-agent.mjs [serve]          run the bridge (HTTP + the app's WebSocket) on 127.0.0.1:47821
 *   node nodal-agent.mjs mcp              MCP server over stdio (starts the bridge too, or uses a running one)
 *   node nodal-agent.mjs call <method> [json-params | @file.json | -]
 *   node nodal-agent.mjs methods          list every method
 *   node nodal-agent.mjs events           stream the activity feed
 *   node nodal-agent.mjs token            print the HTTP token
 *
 * In Nodal: File → AI agent link (or open the app with ?agent / #agent). The
 * app connects to ws://127.0.0.1:<port>/app and runs each call it is sent.
 *
 * HTTP (127.0.0.1 only; every route but /health and /methods needs
 * "Authorization: Bearer <token>", the token is in ~/.config/nodal-agent/token):
 *   GET  /health                      { ok, app }
 *   GET  /methods                     the catalog (guide + methods)
 *   POST /rpc  {method, params}       → {result} | {error:{code,message}}
 *   GET  /events                      server-sent events: the app's activity feed
 *
 * No dependencies; Node 18+.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NODAL_AGENT_PORT || argValue('--port') || 47821);
const HOST = '127.0.0.1';
const CONFIG_DIR = process.env.NODAL_AGENT_HOME || join(homedir(), '.config', 'nodal-agent');
const TOKEN_FILE = join(CONFIG_DIR, 'token');
const CALL_TIMEOUT = 120_000;
const MAX_BODY = 64 * 1024 * 1024;
const VERSION = '1.0.0';

/** Pages allowed to connect as the app: local dev servers, the desktop app, the published web app, and NODAL_AGENT_ORIGINS. */
const ORIGINS = [
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/,
  /^tauri:\/\/localhost$/,
  /^https?:\/\/tauri\.localhost$/,
  /^https:\/\/jpmarcelino\.github\.io$/,
  ...(process.env.NODAL_AGENT_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((o) => new RegExp(`^${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)),
];

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const log = (...a) => process.stderr.write(`[nodal-agent] ${a.join(' ')}\n`);

/* ------------------------------------------------------------------ */
/* Catalog and JSON schemas                                            */
/* ------------------------------------------------------------------ */

function loadCatalog() {
  for (const p of [join(HERE, '..', 'src', 'agent', 'catalog.json'), join(HERE, 'catalog.json')]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  return { version: 0, guide: '', methods: [] };
}
/** The catalog baked in by the web app's build (the downloadable single-file bridge); null in the repo. */
const EMBEDDED_CATALOG = null;
let catalog = EMBEDDED_CATALOG ?? loadCatalog();

/** "number — what it is" → JSON schema. Types: string, number, integer, boolean, object, any, T[], or a|b|c. */
export function paramSchema(spec) {
  const [type, ...rest] = String(spec).split(' — ');
  const description = rest.join(' — ') || undefined;
  const t = type.trim();
  let s;
  if (t.endsWith('[]')) s = { type: 'array', items: paramSchema(t.slice(0, -2)) };
  else if (t.includes('|')) {
    const vals = t.split('|');
    s = vals.every((v) => /^-?\d+(\.\d+)?$/.test(v)) ? { type: 'number', enum: vals.map(Number) } : { type: 'string', enum: vals };
  } else if (t === 'any') s = {};
  else s = { type: t };
  if (description) s.description = description;
  return s;
}

export function methodSchema(m) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(m.params || {})) {
    const opt = key.endsWith('?');
    const name = opt ? key.slice(0, -1) : key;
    properties[name] = paramSchema(spec);
    if (!opt) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: true };
}

export const toolName = (method) => method.replace(/\./g, '_');

/* ------------------------------------------------------------------ */
/* Token                                                               */
/* ------------------------------------------------------------------ */

function readToken() {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

function ensureToken() {
  const have = readToken();
  if (have) return have;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const t = randomBytes(24).toString('hex');
  writeFileSync(TOKEN_FILE, `${t}\n`, { mode: 0o600 });
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    /* not on this file system */
  }
  return t;
}

/* ------------------------------------------------------------------ */
/* Minimal WebSocket server (RFC 6455, text frames)                    */
/* ------------------------------------------------------------------ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsFrame(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (n < 126) head[1] = n;
  else if (n < 65536) {
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Wraps an upgraded socket: onMessage(text), onClose(); returns { send, close, ping }. */
function wsConnection(socket, onMessage, onClose) {
  let buf = Buffer.alloc(0);
  let parts = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      socket.end(wsFrame(Buffer.alloc(0), 8));
    } catch {
      /* gone */
    }
    socket.destroy();
    onClose();
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_BODY) return close();
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const data = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + maskLen + len);
      if (op === 8) return close();
      if (op === 9) {
        socket.write(wsFrame(data, 10));
        continue;
      }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) {
        parts.push(data);
        if (fin) {
          const text = Buffer.concat(parts).toString('utf8');
          parts = [];
          onMessage(text);
        }
      }
    }
  });
  socket.on('close', () => {
    if (!closed) {
      closed = true;
      onClose();
    }
  });
  socket.on('error', () => socket.destroy());
  return {
    send: (text) => !closed && socket.write(wsFrame(text)),
    ping: () => !closed && socket.write(wsFrame(Buffer.alloc(0), 9)),
    close,
  };
}

/* ------------------------------------------------------------------ */
/* The bridge                                                          */
/* ------------------------------------------------------------------ */

class Bridge {
  constructor() {
    this.app = null;
    this.appInfo = null;
    this.pending = new Map();
    this.nextId = 1;
    this.sse = new Set();
    this.local = 0;
    this.waiters = [];
    this.token = ensureToken();
  }

  clients() {
    return this.sse.size + this.local;
  }

  tellClients() {
    this.app?.send(JSON.stringify({ type: 'clients', count: this.clients() }));
  }

  emit(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sse) res.write(line);
  }

  attachApp(conn) {
    if (this.app) {
      this.app.send(JSON.stringify({ type: 'standby' }));
      this.app.close();
    }
    this.app = conn;
    log('Nodal connected');
    this.tellClients();
    for (const w of this.waiters.splice(0)) w();
  }

  detachApp(conn) {
    if (this.app !== conn) return;
    this.app = null;
    this.appInfo = null;
    log('Nodal disconnected');
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ error: { code: 'app_gone', message: 'Nodal disconnected before answering' } });
      this.pending.delete(id);
    }
    this.emit({ kind: 'system', text: 'Nodal disconnected' });
  }

  onAppMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      this.appInfo = msg;
      this.emit({ kind: 'system', text: `Nodal ${msg.version} connected (${msg.doc?.name ?? 'untitled'})` });
    } else if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg.error ? { error: msg.error } : { result: msg.result });
    } else if (msg.type === 'event') {
      this.emit(msg.entry);
    }
  }

  /** Waits (up to ms) for a Nodal window to connect. */
  waitForApp(ms) {
    if (this.app) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        resolve(true);
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      this.waiters.push(done);
    });
  }

  async call(method, params = {}) {
    if (method === 'bridge.status') return { result: { app: !!this.app, appInfo: this.appInfo, clients: this.clients(), port: PORT } };
    if (!(await this.waitForApp(Number(process.env.NODAL_AGENT_WAIT_MS || 15000)))) {
      return { error: { code: 'no_app', message: `No Nodal window is linked. Open Nodal and turn on File → AI agent link (or open it with ?agent) — it connects to ws://${HOST}:${PORT}/app.` } };
    }
    const id = this.nextId++;
    const ms = method === 'session.waitForUser' ? Math.min(610000, Number(params?.timeoutMs ?? 120000) + 10000) : CALL_TIMEOUT;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { code: 'timeout', message: `${method} got no answer from Nodal within ${ms / 1000}s` } });
      }, ms);
      this.pending.set(id, { resolve, timer });
      this.app.send(JSON.stringify({ type: 'call', id, method, params }));
    });
  }

  listen() {
    const server = createServer((req, res) => this.http(req, res));
    server.on('upgrade', (req, socket) => this.upgrade(req, socket));
    setInterval(() => this.app?.ping(), 25000).unref();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, HOST, () => {
        server.off('error', reject);
        log(`bridge on http://${HOST}:${PORT} (app socket ws://${HOST}:${PORT}/app)`);
        resolve(server);
      });
    });
  }

  upgrade(req, socket) {
    const url = new URL(req.url, 'http://x');
    const origin = req.headers.origin;
    if (url.pathname !== '/app' || req.headers.upgrade?.toLowerCase() !== 'websocket' || (origin && !ORIGINS.some((o) => o.test(origin)))) {
      if (origin && !ORIGINS.some((o) => o.test(origin))) log(`refused app connection from ${origin} (add it to NODAL_AGENT_ORIGINS to allow)`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    const conn = wsConnection(
      socket,
      (text) => this.onAppMessage(text),
      () => this.detachApp(conn),
    );
    this.attachApp(conn);
  }

  authed(req, url) {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
    return t === this.token;
  }

  async http(req, res) {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // browsers may only read /health and /methods (no token, nothing private)
    const origin = req.headers.origin;
    if (url.pathname === '/health') return json(200, { ok: true, bridge: VERSION, app: !!this.app, appInfo: this.appInfo && { version: this.appInfo.version, doc: this.appInfo.doc } });
    if (url.pathname === '/methods') return json(200, this.appInfo?.catalog ?? catalog);
    if (origin && !ORIGINS.some((o) => o.test(origin))) return json(403, { error: { code: 'forbidden', message: 'origin not allowed' } });
    if (!this.authed(req, url)) return json(401, { error: { code: 'unauthorized', message: `Send "Authorization: Bearer <token>" (the token is in ${TOKEN_FILE})` } });
    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ kind: 'system', text: this.app ? 'Nodal is linked' : 'Waiting for Nodal' })}\n\n`);
      this.sse.add(res);
      this.tellClients();
      const keep = setInterval(() => res.write(': keep-alive\n\n'), 20000);
      req.on('close', () => {
        clearInterval(keep);
        this.sse.delete(res);
        this.tellClients();
      });
      return;
    }
    if (url.pathname === '/rpc' && req.method === 'POST') {
      let size = 0;
      const chunks = [];
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) return json(413, { error: { code: 'too_large', message: 'request too large' } });
        chunks.push(c);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return json(400, { error: { code: 'bad_json', message: 'body must be JSON {method, params}' } });
      }
      if (typeof body.method !== 'string') return json(400, { error: { code: 'bad_request', message: 'method is required' } });
      return json(200, await this.call(body.method, body.params ?? {}));
    }
    json(404, { error: { code: 'not_found', message: 'routes: GET /health, GET /methods, POST /rpc, GET /events' } });
  }
}

/* ------------------------------------------------------------------ */
/* Talking to a bridge: in this process, or one already running        */
/* ------------------------------------------------------------------ */

/** Starts a bridge here, or (port taken) returns a client of the running one. */
async function connectBridge() {
  const bridge = new Bridge();
  try {
    await bridge.listen();
    return { call: (m, p) => bridge.call(m, p), local: bridge, events: (fn) => (bridge.sse.add({ write: (l) => fn(JSON.parse(l.slice(6))) }), bridge.tellClients()) };
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
  }
  const token = readToken();
  const base = `http://${HOST}:${PORT}`;
  const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
  if (!health?.bridge) throw new Error(`Port ${PORT} is taken by something that is not a Nodal agent bridge (set NODAL_AGENT_PORT)`);
  log(`using the bridge already running on ${base}`);
  const call = async (method, params) => {
    try {
      const r = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ method, params }) });
      return await r.json();
    } catch (e) {
      return { error: { code: 'bridge_gone', message: `The bridge stopped: ${e.message}` } };
    }
  };
  const events = async (fn) => {
    for (;;) {
      try {
        const r = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${token}` } });
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (line.startsWith('data: ')) fn(JSON.parse(line.slice(6)));
          }
        }
      } catch {
        /* reconnect */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  return { call, local: null, events };
}

/* ------------------------------------------------------------------ */
/* MCP over stdio                                                      */
/* ------------------------------------------------------------------ */

const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function mcpTools() {
  return catalog.methods.map((m) => ({
    name: toolName(m.name),
    description: `${m.summary}${m.mutates ? ' (edits the circuit)' : ''}`,
    inputSchema: methodSchema(m),
  }));
}

/** An MCP tool result from a call result: JSON text, plus the picture for screenshots / PNG exports. */
export function toolResult(res) {
  if (res.error) return { content: [{ type: 'text', text: `Error (${res.error.code}): ${res.error.message}` }], isError: true };
  const r = res.result;
  if (r && typeof r === 'object' && r.mime === 'image/png' && typeof r.base64 === 'string') {
    const { base64, ...rest } = r;
    return { content: [{ type: 'image', data: base64, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(rest) }] };
  }
  const text = r === undefined ? 'ok' : JSON.stringify(r, null, 1);
  return { content: [{ type: 'text', text }] };
}

async function runMcp() {
  let bridge = await connectBridge();
  const register = (b) => (b.local ? (b.local.local++, b.local.tellClients()) : b.events(() => {})); // counts this agent at the bridge
  register(bridge);
  // the process that ran the bridge may go away: take it over and try again
  const call = async (m, p) => {
    const res = await bridge.call(m, p);
    if (res.error?.code !== 'bridge_gone') return res;
    bridge = await connectBridge();
    register(bridge);
    return bridge.call(m, p);
  };
  const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const byTool = new Map(catalog.methods.map((m) => [toolName(m.name), m.name]));
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const { id, method, params } = msg;
    const reply = (result) => id !== undefined && out({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && out({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const want = params?.protocolVersion;
        reply({
          protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'nodal', version: VERSION },
          instructions: catalog.guide,
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: mcpTools() });
      case 'tools/call': {
        const name = params?.name;
        const m = byTool.get(name);
        if (!m) return reply({ content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true });
        const res = await call(m, params?.arguments ?? {});
        return reply(toolResult(res));
      }
      case 'resources/list':
        return reply({ resources: [] });
      case 'prompts/list':
        return reply({ prompts: [] });
      default:
        if (id !== undefined) fail(-32601, `Method not found: ${method}`);
    }
  });
  rl.on('close', () => process.exit(0));
}

/* ------------------------------------------------------------------ */
/* Command line                                                        */
/* ------------------------------------------------------------------ */

async function main() {
  const [cmd = 'serve', ...rest] = process.argv.slice(2).filter((a, i, all) => a !== '--port' && all[i - 1] !== '--port');
  switch (cmd) {
    case 'serve': {
      const b = new Bridge();
      await b.listen().catch((e) => {
        log(e.code === 'EADDRINUSE' ? `port ${PORT} is in use (a bridge already running? set NODAL_AGENT_PORT)` : e.message);
        process.exit(1);
      });
      log(`token file: ${TOKEN_FILE}`);
      log('in Nodal: File → AI agent link');
      return;
    }
    case 'mcp':
      return runMcp();
    case 'call': {
      const [method, raw] = rest;
      if (!method) throw new Error('usage: nodal-agent call <method> [json-params | @file.json | -]');
      // params inline, from a file, or from stdin ("-"): shells such as PowerShell mangle quotes in inline JSON
      const text = raw === '-' ? readFileSync(0, 'utf8') : raw?.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
      const params = text ? JSON.parse(text) : {};
      const b = await connectBridge();
      const res = await b.call(method, params);
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      process.exit(res.error ? 1 : 0);
      return;
    }
    case 'methods':
      for (const m of catalog.methods) process.stdout.write(`${m.name.padEnd(24)} ${m.summary}\n`);
      return;
    case 'schema':
      process.stdout.write(`${JSON.stringify(mcpTools(), null, 2)}\n`);
      return;
    case 'events': {
      const b = await connectBridge();
      b.events((e) => process.stdout.write(`${JSON.stringify(e)}\n`));
      return;
    }
    case 'token':
      process.stdout.write(`${ensureToken()}\n`);
      return;
    default:
      process.stderr.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(2);
  }
}

const isMain = () => {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};

if (isMain()) {
  main().catch((e) => {
    log(e.message);
    process.exit(1);
  });
}

import catalog from './catalog.json';
import { sharedDoc } from '../store/store';
import { installGuard } from './guard';
import { runCall } from './run';
import { A, logAgent, setAgent, useAgent } from './state';

/**
 * The app's end of the agent link: a WebSocket to the agent bridge
 * (agent-bridge/nodal-agent.mjs), a small local program that agents reach
 * over MCP, HTTP or its command line. The bridge forwards each call here; the
 * app runs it (agent/run.ts) and answers. Nothing is listened on in the app
 * itself, so a web page can't drive it: the bridge decides who may call.
 *
 *   bridge → app  { type: 'call', id, method, params }
 *   app → bridge  { type: 'result', id, result } | { type: 'result', id, error }
 *   app → bridge  { type: 'hello', … } on connect, { type: 'event', entry } for the activity feed
 *   bridge → app  { type: 'clients', count } agents connected; { type: 'standby' } another window took the link
 */

let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let backoff = 1000;
/** Calls run one after another, in the order they came. */
let queue: Promise<void> = Promise.resolve();

function send(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  clearTimeout(retry);
  const { url, enabled } = A();
  if (!enabled || ws) return;
  let sock: WebSocket;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    setAgent({ linkError: (e as Error).message });
    return schedule();
  }
  ws = sock;
  sock.onopen = () => {
    backoff = 1000;
    setAgent({ connected: true, linkError: null });
    const doc = sharedDoc();
    send({ type: 'hello', role: 'app', app: 'nodal', version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev', catalogVersion: catalog.version, methods: catalog.methods.length, doc: { id: doc.id ?? null, name: doc.name } });
    logAgent({ kind: 'system', text: 'Connected to the agent bridge' });
  };
  sock.onmessage = (ev) => {
    let msg: { type?: string; id?: unknown; method?: string; params?: Record<string, unknown>; count?: number };
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === 'call' && typeof msg.method === 'string') {
      const { id, method, params } = msg;
      queue = queue.then(async () => {
        const res = await runCall(method, params ?? {});
        send({ type: 'result', id, ...res });
      });
    } else if (msg.type === 'clients') {
      setAgent({ clients: msg.count ?? 0 });
    } else if (msg.type === 'standby') {
      setAgent({ linkError: 'Another Nodal window has the agent link' });
    }
  };
  sock.onerror = () => {
    setAgent({ linkError: `No agent bridge at ${url}` });
  };
  sock.onclose = () => {
    const was = A().connected;
    ws = null;
    setAgent({ connected: false });
    if (was) logAgent({ kind: 'system', text: 'Agent bridge disconnected' });
    schedule();
  };
}

function schedule() {
  clearTimeout(retry);
  if (!A().enabled) return;
  retry = setTimeout(connect, backoff);
  backoff = Math.min(10000, backoff * 1.6);
}

function disconnect() {
  clearTimeout(retry);
  const sock = ws;
  ws = null;
  sock?.close();
  setAgent({ connected: false });
}

/** Turns the agent link on or off (remembered across visits). */
export function setAgentLink(on: boolean, url?: string) {
  if (url) setAgent({ url });
  setAgent({ enabled: on, linkError: null });
  disconnect();
  if (on) {
    backoff = 1000;
    connect();
  }
}

/** The user ends the agent's session from the panel: the guard lifts. */
export function releaseAgent() {
  const a = A();
  if (a.status !== 'working') return;
  setAgent({ status: 'done', progress: null });
  logAgent({ kind: 'user', text: 'Marked the agent done (guard lifted)' });
  send({ type: 'event', entry: { kind: 'user', text: 'The user marked your work done; the guard is lifted.' } });
}

let started = false;
/** Starts the link (once, at startup): `?agent` / `#agent` in the address turns it on, with an optional bridge URL. */
export function startAgentLink() {
  if (started) return;
  started = true;
  installGuard();
  try {
    const q = new URLSearchParams(location.search);
    const fromHash = /(?:^#|[&#])agent(?:=([^&]*))?/.exec(location.hash);
    if (q.has('agent') || fromHash) {
      const raw = q.get('agent') || (fromHash?.[1] ? decodeURIComponent(fromHash[1]) : '');
      setAgent({ enabled: true, ...(raw && /^wss?:\/\//.test(raw) ? { url: raw } : /^\d+$/.test(raw) ? { url: `ws://127.0.0.1:${raw}/app` } : {}) });
    }
  } catch {
    /* no location (tests) */
  }
  // the activity log goes out to the bridge too, for agents watching the feed
  useAgent.subscribe((s, prev) => {
    if (s.log !== prev.log && s.log.length) {
      const last = s.log[s.log.length - 1];
      if (last !== prev.log[prev.log.length - 1] && (last.kind === 'user' || last.kind === 'system')) send({ type: 'event', entry: { kind: last.kind, text: last.text, t: last.t } });
    }
  });
  if (A().enabled) connect();
}

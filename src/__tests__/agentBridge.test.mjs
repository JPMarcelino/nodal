// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Runs the real bridge (agent-bridge/nodal-agent.mjs) as a child process on a
 * spare port and checks the parts that guard the link: who may connect as the
 * app, and what happens to calls when the app is replaced or too slow.
 */

// plain JS: the app's tsconfig has no Node types
const proc_ = process;
const BRIDGE = fileURLToPath(new URL('../../agent-bridge/nodal-agent.mjs', import.meta.url));
const PORT = 47900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://localhost:5173';
let proc;
let home;
let token;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'nodal-agent-test-'));
  proc = spawn(proc_.execPath, [BRIDGE, 'serve'], {
    env: { ...proc_.env, NODAL_AGENT_HOME: home, NODAL_AGENT_PORT: String(PORT), NODAL_AGENT_CALL_TIMEOUT_MS: '400', NODAL_AGENT_WAIT_MS: '300' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  token = readFileSync(join(home, 'token'), 'utf8').trim();
});

afterAll(() => {
  proc?.kill();
  rmSync(home, { recursive: true, force: true });
});

/** A fake Nodal window. Node's WebSocket sends no Origin unless given one. */
function app(headers = { origin: ORIGIN }) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/app`, { headers });
  const got = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  const opened = new Promise((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
  return { ws, got, opened };
}

function rpc(method, params = {}) {
  return fetch(`${BASE}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) }).then((r) => r.json());
}

const until = async (ok) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(ok()).toBe(true);
};

describe('agent bridge', () => {
  it('refuses an app connection with no Origin or a foreign one', async () => {
    expect(await app({}).opened).toBe(false);
    expect(await app({ origin: 'https://evil.example' }).opened).toBe(false);
  });

  it('fails a pending call at once when another window takes the link', async () => {
    const a = app();
    expect(await a.opened).toBe(true);
    const t0 = Date.now();
    const res = rpc('doc.info');
    await until(() => a.got.some((m) => m.type === 'call'));
    const b = app();
    expect(await b.opened).toBe(true);
    const out = await res;
    expect(out.error?.code).toBe('app_gone');
    expect(Date.now() - t0).toBeLessThan(400);
    b.ws.close();
  });

  it('tells the app to skip a call it timed out', async () => {
    const a = app();
    expect(await a.opened).toBe(true);
    const out = await rpc('doc.info');
    expect(out.error?.code).toBe('timeout');
    const call = a.got.find((m) => m.type === 'call');
    await until(() => a.got.some((m) => m.type === 'cancel' && m.id === call?.id));
    a.ws.close();
  });
});

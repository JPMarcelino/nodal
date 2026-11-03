import { PUBLIC_APP_URL } from '../collab/session';
import { isDesktop } from '../io/files';
import { A, DEFAULT_AGENT_URL } from './state';

/**
 * How someone with only the app (no copy of the repository) gets an agent
 * connected: the web app serves the bridge as one file (built by
 * vite.config.ts, catalog baked in), and these are the steps to fetch and run
 * it — shown in the agent panel and copied as a prompt to paste to an agent.
 */

export type HostOs = 'windows' | 'unix';

export const hostOs = (): HostOs => (typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent) ? 'windows' : 'unix');

/** Where the single-file bridge can be downloaded. */
export function bridgeFileUrl(): string {
  if (isDesktop() || typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return `${PUBLIC_APP_URL}nodal-agent.mjs`;
  return new URL('nodal-agent.mjs', `${location.origin}${location.pathname}`).href;
}

/** The port the app expects the bridge on, when it isn't the default. */
function portFlag(): string {
  const url = A().url || DEFAULT_AGENT_URL;
  const m = /:(\d+)\//.exec(url);
  return m && m[1] !== '47821' ? ` --port ${m[1]}` : '';
}

export function setupSteps(os: HostOs = hostOs()) {
  const url = bridgeFileUrl();
  const port = portFlag();
  if (os === 'windows') {
    const file = '"$env:USERPROFILE\\nodal-agent.mjs"';
    return {
      file,
      download: `iwr ${url} -OutFile ${file}`,
      run: `Start-Process node -ArgumentList "$env:USERPROFILE\\nodal-agent.mjs"${port ? `,"--port","${port.trim().split(' ')[1]}"` : ''} -WindowStyle Hidden`,
      runForeground: `node ${file}${port}`,
      call: `node ${file}${port} call`,
      token: `node ${file}${port} token`,
      mcp: `node ${file} mcp${port}`,
    };
  }
  const file = '~/nodal-agent.mjs';
  return {
    file,
    download: `curl -fsSL ${url} -o ${file}`,
    run: `nohup node ${file}${port} >/dev/null 2>&1 &`,
    runForeground: `node ${file}${port}`,
    call: `node ${file}${port} call`,
    token: `node ${file}${port} token`,
    mcp: `node ${file} mcp${port}`,
  };
}

/** Instructions to paste to an AI agent (ChatGPT / Codex, Claude Code, …) so it can connect on its own. */
export function agentSetupPrompt(os: HostOs = hostOs()): string {
  const s = setupSteps(os);
  const shell = os === 'windows' ? 'PowerShell' : 'a shell';
  const port = (/:(\d+)\//.exec(A().url || DEFAULT_AGENT_URL) ?? [])[1] ?? '47821';
  return [
    'Nodal (a circuit / schematic designer) is open in my browser and waiting for an AI agent. Connect to it and work through it.',
    '',
    `1. Download the agent bridge — one file, needs Node.js 18+ (run in ${shell}):`,
    `   ${s.download}`,
    '2. Start it in the background and leave it running. Nodal connects to it by itself (the agent panel turns from "Waiting for the bridge" to "Bridge ready"):',
    `   ${s.run}`,
    '3. Call Nodal through it; each call prints JSON. Read the guide and the method list first:',
    `   ${s.call} nodal.describe`,
    `   ${s.call} components.place "@params.json"   (params from a JSON file — avoids shell quoting; "-" reads them from stdin)`,
    `   Or HTTP: POST http://127.0.0.1:${port}/rpc with body {"method": "...", "params": {...}} and header "Authorization: Bearer <token>" (token: ${s.token}).`,
    '   Or register it as an MCP server: command "node", args ["<full path of nodal-agent.mjs>", "mcp"] (then you need not start it yourself).',
    '4. Begin with session.start {"name": "<your name>", "goal": "<what you will do>"}, and end with session.done {"summary": "..."}. Use session.say to tell me what you are doing, doc.screenshot to look at the drawing, and check.run to verify the wiring.',
  ].join('\n');
}

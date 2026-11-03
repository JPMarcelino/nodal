import catalog from './catalog.json';
import { docBounds } from '../model/doc';
import { itemPage, resolvePage, viewDoc } from '../model/pages';
import { inGesture, S, setPage, sharedDoc, useStore } from '../store/store';
import { glideView } from '../store/actions';
import { METHODS, agentPage, type Ctx } from './api';
import { A, logAgent, setAgent } from './state';
import { AgentError, commitDiff, diffDocs, diffEmpty, recordStep, Tx, agentPast, agentFuture } from './tx';

/**
 * Runs agent calls: each one (or a whole batch) in its own transaction,
 * folded into the app as one step, logged for the user, with the agent's
 * cursor and the follow camera brought along.
 */

export interface CallResult {
  result?: unknown;
  error?: { code: string; message: string };
}

const SUMMARY = new Map(catalog.methods.map((m) => [m.name, m.summary.split(/(?<=\.)\s/)[0]]));
/** Calls too chatty to log (status polls; progress shows in the panel itself). */
const QUIET = new Set(['nodal.ping', 'session.status', 'session.log', 'nodal.describe', 'app.state', 'history.steps', 'session.progress', 'session.say', 'session.pointAt', 'session.done', 'session.waitForUser']);

/** How reads show in the log. */
const READS: Record<string, string> = {
  'doc.get': 'Read the circuit',
  'doc.summary': 'Read the circuit overview',
  'doc.settings': 'Read the settings',
  'doc.stats': 'Counted the circuit',
  'doc.export': 'Exported the circuit',
  'items.list': 'Listed items',
  'items.get': 'Read items',
  'items.getStyle': 'Read a style',
  'components.ports': 'Read a part’s pins',
  'nets.list': 'Read the nets',
  'nets.of': 'Traced a net',
  'pages.list': 'Listed the pages',
  'symbols.get': 'Read a symbol',
  'symbols.categories': 'Browsed the library',
  'groups.list': 'Listed the groups',
  'shapes.presets': 'Browsed the shape presets',
  'versions.list': 'Listed the versions',
  'app.prefs': 'Read the preferences',
  'app.commands': 'Listed the app’s commands',
};

/** One line for the activity log. */
function describe(method: string, p: Record<string, unknown>, r: unknown): string {
  const res = (r ?? {}) as Record<string, unknown>;
  const q = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  const tgt = (t: unknown) => {
    const o = (t ?? {}) as Record<string, unknown>;
    if (o.ref !== undefined || o.comp !== undefined) return `${o.ref ?? o.comp}.${o.port}`;
    if (o.junction !== undefined) return `junction`;
    if (o.x !== undefined) return `(${o.x}, ${o.y})`;
    return '?';
  };
  switch (method) {
    case 'session.start':
      return p.goal ? `Started: ${p.goal}` : 'Started working';
    case 'components.place':
      return `Placed ${res.ref ?? ''} (${p.symbol})${p.value ? ` = ${p.value}` : ''}`;
    case 'components.placeMany':
      return `Placed ${Array.isArray(r) ? r.map((c) => (c as { ref: string }).ref).join(', ') : 'parts'}`;
    case 'wires.connect':
      return `Wired ${tgt(p.from)} → ${tgt(p.to)}${p.label ? ` (${p.label})` : ''}`;
    case 'wires.connectMany':
      return `Drew ${(p.wires as unknown[])?.length ?? 0} wires`;
    case 'shapes.add':
      return `Added ${p.kind}${p.text ? ` “${String(p.text).slice(0, 40)}”` : ''}`;
    case 'shapes.note':
      return `Note: “${String(p.text).slice(0, 60)}”`;
    case 'items.delete':
      return `Deleted ${(res.deleted as unknown[])?.length ?? 0} items`;
    case 'items.update':
      return `Changed ${Object.keys((p.patch as object) ?? {}).join(', ')} of ${q(p.ids ?? p.id)}`;
    case 'items.move':
      return `Moved ${q(p.ids)} by ${p.dx}, ${p.dy}`;
    case 'batch':
      return `${p.label ? `${p.label}: ` : ''}${(p.calls as unknown[])?.length ?? 0} steps in one go`;
    case 'pages.add':
      return `Added page ${res.name ?? ''}`;
    case 'symbols.create':
      return `Made symbol “${p.name}”`;
    case 'doc.screenshot':
      return 'Looked at the drawing';
    case 'check.run':
      return `Checked the circuit: ${res.errors ?? 0} errors, ${res.warnings ?? 0} warnings`;
    case 'symbols.list':
      return p.query ? `Searched the library for “${p.query}”` : 'Browsed the library';
    case 'items.find':
      return `Searched for “${p.text}”`;
    default:
      return READS[method] ?? SUMMARY.get(method) ?? method;
  }
}

/** The user moved the view themselves lately (a view change right after their own input): follow holds back for a moment. */
let userViewAt = 0;
let inputAt = 0;
let following = false;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart']) window.addEventListener(ev, () => (inputAt = Date.now()), { capture: true, passive: true });
}
useStore.subscribe((s, prev) => {
  if (s.view !== prev.view && !following && Date.now() - inputAt < 1500) userViewAt = Date.now();
});

/** Room the agent panel takes at the top right of the canvas. */
const PANEL_W = 350;

/**
 * Brings the user's view to the agent's work when follow is on (and the user
 * isn't busy with the view): its page, and everything it has drawn there so
 * far, clear of the agent panel. Only moves when that work is not all in view.
 */
function followTo(page: string, ids: string[]) {
  const a = A();
  if (!a.follow || inGesture() || Date.now() - userViewAt < 4000) return;
  following = true;
  try {
    if (page !== resolvePage(sharedDoc(), S().page)) setPage(page);
    const view0 = viewDoc(sharedDoc(), page);
    const work = [...new Set([...ids, ...a.owned])].filter((id) => view0.items[id]);
    const b = docBounds(view0, work.length ? work : ids);
    if (!b) return;
    const { view, canvasSize } = S();
    const pad = 50;
    const right = a.collapsed ? pad : PANEL_W;
    const sx = b.x * view.zoom + view.x;
    const sy = b.y * view.zoom + view.y;
    const inside = sx > pad && sy > pad && sx + b.w * view.zoom < canvasSize.w - right && sy + b.h * view.zoom < canvasSize.h - pad;
    if (inside) return;
    const w = Math.max(200, canvasSize.w - pad - right);
    const fit = Math.min(w / Math.max(b.w, 1), (canvasSize.h - pad * 2) / Math.max(b.h, 1));
    const zoom = Math.min(Math.max(0.15, fit), 1.6);
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    glideView({ zoom, x: pad + w / 2 - c.x * zoom, y: canvasSize.h / 2 - c.y * zoom }, 420);
  } finally {
    // the glide's own frames are the agent's too
    setTimeout(() => (following = false), 500);
  }
}

/** Folds a finished transaction into the app as one agent step. */
function finish(tx: Tx, label: string): string[] {
  if (tx.doc === tx.base) return [];
  const { after, before } = diffDocs(tx.base, tx.doc);
  if (diffEmpty(after)) return [];
  commitDiff(after);
  recordStep({ label, after, before });
  const owned = new Set(A().owned);
  const live: string[] = [];
  for (const [id, it] of Object.entries(after.items)) {
    if (it) {
      owned.add(id);
      live.push(id);
    } else owned.delete(id);
  }
  const doc = sharedDoc();
  const focus = [...new Set([...tx.focus, ...live])].filter((id) => doc.items[id]);
  const page = tx.page ?? (focus.length ? itemPage(doc, doc.items[focus[0]]) : undefined);
  const patch: Parameters<typeof setAgent>[0] = { owned, steps: agentPast.length, redoable: agentFuture.length };
  if (page && focus.length) {
    const b = docBounds(viewDoc(doc, page), focus);
    if (b) patch.cursor = { x: b.x + b.w / 2, y: b.y + b.h / 2, page };
    patch.flash = { ids: focus, page, t: Date.now() };
    followTo(page, focus);
  }
  setAgent(patch);
  return focus;
}

/** Runs one method inside a transaction (shared by a batch's calls). */
async function invoke(method: string, params: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const fn = METHODS[method];
  if (!fn) throw new AgentError('unknown_method', `No method "${method}" (nodal.describe lists them)`);
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) throw new AgentError('bad_params', 'params must be an object');
  return fn(params ?? {}, ctx);
}

/** Runs a call from the agent and reports it in the activity log. */
export async function runCall(method: string, params: Record<string, unknown> = {}): Promise<CallResult> {
  const t0 = performance.now();
  const tx = new Tx(agentPage);
  const ctx: Ctx = { tx };
  ctx.call = (m, p) => invoke(m, p, { ...ctx, inBatch: true });
  try {
    const result = await invoke(method, params, ctx);
    const ids = finish(tx, describe(method, params, result));
    if (!QUIET.has(method)) logAgent({ kind: 'call', method, text: describe(method, params, result), ms: Math.round(performance.now() - t0), ids: ids.length ? ids.slice(0, 200) : undefined, page: tx.page });
    // a call that edits means the agent is at work, even if it skipped session.start
    if (ids.length && A().status !== 'working') setAgent({ status: 'working' });
    return { result };
  } catch (e) {
    const err = e instanceof AgentError ? { code: e.code, message: e.message } : { code: 'internal', message: (e as Error)?.message ?? String(e) };
    logAgent({ kind: 'error', method, text: `${method}: ${err.message}` });
    if (!(e instanceof AgentError)) console.error('[agent]', method, e);
    return { error: err };
  }
}

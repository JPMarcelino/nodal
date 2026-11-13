import { current, type Draft } from 'immer';
import catalog from './catalog.json';
import { circuitToText } from '../io/fileActions';
import { clipAreaDoc, exportBox, exportDxf, exportPng, exportSvg, selectionDoc, type SvgOptions } from '../io/export';
import { isDesktop, sanitizeName, saveFile } from '../io/files';
import { svgToPrims } from '../io/svgImport';
import { buildLibraryFile, importLibraryText } from '../io/sharing';
import { canConvertToPath, convertToPath } from '../model/path';
import { resolveConnector } from '../model/connectors';
import { listVersions, saveVersion } from '../io/versionStore';
import { calloutAnchor, makeAnchor, nextStep } from '../model/callout';
import { createDoc, docBounds, itemBounds, makeComponent, makeShape, migrateItems, normalizeDoc, safeColour, uid } from '../model/doc';
import { runErc, splitIgnored } from '../model/erc';
import { selectionToDrawing, replaceWithInstance } from '../model/fromSelection';
import { eq, measureText, projectOnSegment } from '../model/geometry';
import { packInk } from '../model/ink';
import { prepareMath } from '../model/latex';
import { computeNets, netPages, toBomCsv, toKicadNetlist, toSpiceNetlist, type Net } from '../model/netlist';
import {
  alignItems,
  annotate,
  distributeItems,
  extractFragment,
  flipItems,
  followParts,
  groupItems,
  insertFragment,
  matchSizes,
  restackItems,
  rotateItems,
  rotateShapeBy,
  routeWireAround,
  scaleItems,
  selectionPivot,
  solderWires,
  translateDetached,
  translateItems,
  turnPivot,
  ungroupItems,
  unsolderJunction,
  unsolderPort,
  deleteItems,
  deleteWirePart,
  type AlignMode,
  type Fragment,
  type SizeMode,
  type StackMove,
} from '../model/ops';
import { deletePage, duplicatePage, moveItemsToPage } from '../model/pageOps';
import { addPage, docPages, itemPage, movePage, normalizePages, pageItemIds, renamePage, viewDoc } from '../model/pages';
import { getSymbol, instanceSymbol, librarySymbols } from '../model/registry';
import { rectCentre, shapeBox } from '../model/rotation';
import { getPreset, makePresetShape, PRESET_SIZE, SHAPE_PRESETS, searchPresets } from '../model/shapePresets';
import { applyLook, commonLook, type Look } from '../model/style';
import { compileSource, parsePorts, primsToDsl, sourceOf, type SymbolSource } from '../model/symbols/dsl';
import { MISSING_SYMBOL } from '../model/symbols';
import type { Attach, CircuitDoc, ComponentItem, Endpoint, Item, Point, Rect, ShapeItem, ShapeKind, WireItem, WireStyle } from '../model/types';
import { commitWire, type WireTarget } from '../model/wireCommit';
import { hitWire, portPosition, wirePolyline } from '../model/wires';
import { goToItems, replaceDoc, S, select, setPage, setPrefs, setTheme, sharedDoc, toast, deleteUserSymbol, saveUserSymbol, inGesture, type Prefs } from '../store/store';
import { glideView, revealItems } from '../store/actions';
import { closeSymbolEditor, openSymbolEditor } from '../store/symbolSession';
import { useCollab } from '../collab/session';
import { A, AGENT_COLOR, logAgent, setAgent } from './state';
import { AgentError, agentFuture, agentPast, asAgent, clearSteps, commitDiff, conflicts, type Tx } from './tx';

/* eslint-disable @typescript-eslint/no-explicit-any */
type P = Record<string, any>;

export interface Ctx {
  tx: Tx;
  /** Inside a batch: no nested batches, no waiting. */
  inBatch?: boolean;
  /** Runs another method in the same transaction (batch). */
  call?: (method: string, params: P) => Promise<unknown>;
}

export type Handler = (p: P, ctx: Ctx) => unknown | Promise<unknown>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const fail = (code: string, message: string): never => {
  throw new AgentError(code, message);
};

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) fail('bad_params', `Missing ${what}`);
  return v as T;
}

const num = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail('bad_params', `${what} must be a number`));
const pt = (v: any, what: string): Point => ({ x: num(v?.x, `${what}.x`), y: num(v?.y, `${what}.y`) });
const list = (v: unknown, what: string): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : fail('bad_params', `${what} must be a list of ids`));
const r1 = (v: number) => Math.round(v * 100) / 100;

/** An item id, or a part's reference (R1) — preferring parts on `page`. */
function resolveId(doc: CircuitDoc, key: string, page?: string): string {
  if (doc.items[key]) return key;
  const refs = Object.values(doc.items).filter((i): i is ComponentItem => i.type === 'component' && i.ref === key);
  if (refs.length) return (refs.find((c) => !page || itemPage(doc, c) === page) ?? refs[0]).id;
  return fail('not_found', `No item or part "${key}"`);
}

const resolveIds = (doc: CircuitDoc, keys: unknown, what = 'ids') => list(keys, what).map((k) => resolveId(doc, k));

/** Ids grouped by the page they are on. */
function byPage(doc: CircuitDoc, ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of ids) {
    const p = itemPage(doc, doc.items[id]);
    out.set(p, [...(out.get(p) ?? []), id]);
  }
  return out;
}

/** Runs a page edit for each page the items are on. */
function editItems(ctx: Ctx, ids: string[], recipe: (d: Draft<CircuitDoc>, ids: string[], base: CircuitDoc) => void) {
  for (const [page, on] of byPage(ctx.tx.doc, ids)) {
    ctx.tx.edit(page, (d) => recipe(d, on, current(d) as CircuitDoc));
    ctx.tx.touch(on, page);
  }
}

function sideName(dir: Point): string {
  return dir.x < 0 ? 'left' : dir.x > 0 ? 'right' : dir.y < 0 ? 'top' : 'bottom';
}

/** A part's pins in world coordinates, with what is wired to each. */
function pinsOf(doc: CircuitDoc, c: ComponentItem, nets?: Net[]) {
  const def = instanceSymbol(doc, c);
  const wires = Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire');
  return def.ports.map((p) => {
    const pos = portPosition(doc, c, p.id)!;
    const on = wires.filter((w) => [w.a, w.b].some((e) => e.kind === 'port' && e.comp === c.id && e.port === p.id)).map((w) => w.id);
    const net = nets?.find((n) => n.pins.some((q) => q.comp === c.id && q.port === p.id));
    return { id: p.id, name: p.name, x: r1(pos.pt.x), y: r1(pos.pt.y), side: sideName(pos.dir), wires: on, ...(nets ? { net: net?.name ?? null } : {}) };
  });
}

function findPort(doc: CircuitDoc, c: ComponentItem, port: unknown): string {
  const def = instanceSymbol(doc, c);
  const key = String(need(port, 'port'));
  const hit =
    def.ports.find((p) => p.id === key) ??
    def.ports.find((p) => p.name.toLowerCase() === key.toLowerCase()) ??
    (/^\d+$/.test(key) ? def.ports[Number(key) - 1] : undefined);
  return hit?.id ?? fail('not_found', `${c.ref} has no pin "${key}" (pins: ${def.ports.map((p) => (p.name && p.name !== p.id ? `${p.id}/${p.name}` : p.id)).join(', ')})`);
}

/** A compact view of an item for listings. */
function brief(doc: CircuitDoc, it: Item) {
  const page = itemPage(doc, it);
  const b = itemBounds(doc, it);
  const bounds = b ? { x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) } : null;
  switch (it.type) {
    case 'component':
      return { id: it.id, type: it.type, ref: it.ref, symbol: it.symbol, value: it.value, x: it.x, y: it.y, rot: it.rot, ...(it.flipX ? { flipX: true } : {}), page, bounds };
    case 'wire': {
      const ep = (e: Endpoint) => {
        if (e.kind === 'port') {
          const c = doc.items[e.comp];
          return `${c?.type === 'component' ? c.ref : e.comp}.${e.port}`;
        }
        return e.kind === 'junction' ? `junction ${e.id}` : `(${r1(e.x)}, ${r1(e.y)})`;
      };
      return { id: it.id, type: it.type, from: ep(it.a), to: ep(it.b), points: wirePolyline(doc, it).map((p) => ({ x: r1(p.x), y: r1(p.y) })), ...(it.label ? { label: it.label } : {}), page };
    }
    case 'junction':
      return { id: it.id, type: it.type, x: it.x, y: it.y, page };
    case 'shape':
      return { id: it.id, type: it.type, kind: it.kind, ...(it.text ? { text: it.text } : {}), bounds, page };
  }
}

/** An item with its bounds (and pins for parts). */
function full(doc: CircuitDoc, it: Item) {
  const b = itemBounds(doc, it);
  const extra: P = { page: itemPage(doc, it), bounds: b && { x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) } };
  if (it.type === 'component') extra.pins = pinsOf(doc, it);
  if (it.type === 'wire') extra.points = wirePolyline(doc, it);
  if (it.type === 'shape' && it.src && it.src.length > 2000) return { ...it, src: `${it.src.slice(0, 64)}… (${it.src.length} chars)`, ...extra };
  return { ...it, ...extra };
}

/** Parses an object or its JSON text. */
function objectOf(v: unknown, what: string): any {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch (e) {
      return fail('bad_params', `${what} is not valid JSON: ${(e as Error).message}`);
    }
  }
  return v && typeof v === 'object' ? v : fail('bad_params', `${what} must be an object or JSON text`);
}

/** Copies a symbol from the user's library into the document (files stay self-contained), with its base type. */
function bringSymbol(d: Draft<CircuitDoc>, id: string) {
  const lib = S().userLibrary;
  if (getSymbol(d as CircuitDoc, id) === MISSING_SYMBOL) fail('not_found', `No symbol "${id}" (symbols.list shows the library)`);
  if (lib[id] && !d.symbols[id]) d.symbols[id] = lib[id];
  const base = lib[id]?.variantOf;
  if (base && lib[base] && !d.symbols[base]) d.symbols[base] = lib[base];
}

const ROTS = [0, 90, 180, 270] as const;
const rotOf = (v: unknown): ComponentItem['rot'] => {
  if (v === undefined) return 0;
  const r = ((Math.round(Number(v)) % 360) + 360) % 360;
  return (ROTS as readonly number[]).includes(r) ? (r as ComponentItem['rot']) : fail('bad_params', 'rot must be 0, 90, 180 or 270');
};

const COMPONENT_STYLE = ['color', 'fill', 'fillOpacity', 'lineWidth', 'dash', 'labelColor', 'scale', 'labelDx', 'labelDy', 'valueDx', 'valueDy', 'labelSpot', 'refStyle', 'valueStyle', 'closed', 'hidden', 'locked'] as const;

/** Adds a part to a draft page from place parameters. */
function placeOne(d: Draft<CircuitDoc>, p: P): ComponentItem {
  const symbol = String(need(p.symbol, 'symbol'));
  bringSymbol(d, symbol);
  const at = p.at ? pt(p.at, 'at') : { x: num(p.x ?? 0, 'x'), y: num(p.y ?? 0, 'y') };
  const c = makeComponent(d as CircuitDoc, symbol, at.x, at.y, rotOf(p.rot), !!p.flipX);
  if (p.ref !== undefined) c.ref = String(p.ref);
  if (p.value !== undefined) c.value = String(p.value);
  if (p.props && typeof p.props === 'object') c.props = { ...c.props, ...Object.fromEntries(Object.entries(p.props).map(([k, v]) => [k, String(v)])) };
  if (p.showRef !== undefined) c.showRef = !!p.showRef;
  if (p.showValue !== undefined) c.showValue = !!p.showValue;
  // a value given is meant to be seen
  else if (p.value !== undefined && String(p.value)) c.showValue = true;
  const style = { ...(p.style ?? {}) };
  for (const k of COMPONENT_STYLE) if (p[k] !== undefined && style[k] === undefined) style[k] = p[k];
  for (const k of COMPONENT_STYLE) if (style[k] !== undefined) (c as any)[k] = style[k];
  d.items[c.id] = c;
  return c;
}

/** A wire target from agent terms: pin, junction, point on a wire, or a loose point (which snaps to whatever is there). */
function wireTarget(doc: CircuitDoc, t: any, what: string, page: string): WireTarget {
  if (!t || typeof t !== 'object') fail('bad_params', `${what} must be an object`);
  if (t.ref !== undefined || t.comp !== undefined) {
    const id = resolveId(doc, String(t.comp ?? t.ref), page);
    const c = doc.items[id];
    if (c?.type !== 'component') fail('bad_params', `${what}: ${t.comp ?? t.ref} is not a part`);
    const port = findPort(doc, c as ComponentItem, t.port);
    const pos = portPosition(doc, c as ComponentItem, port)!;
    return { kind: 'port', comp: id, port, pt: pos.pt, dir: pos.dir };
  }
  if (t.junction !== undefined) {
    const j = doc.items[String(t.junction)];
    if (j?.type !== 'junction') fail('not_found', `${what}: no junction "${t.junction}"`);
    return { kind: 'junction', id: j!.id, pt: { x: (j as any).x, y: (j as any).y } };
  }
  const p = pt(t, what);
  if (t.wire !== undefined) {
    const w = doc.items[String(t.wire)];
    if (w?.type !== 'wire') fail('not_found', `${what}: no wire "${t.wire}"`);
    return onWire(doc, w as WireItem, p);
  }
  return targetAt(doc, p);
}

/** The point on a wire nearest p, as a target (an end of it, or a spot along it). */
function onWire(doc: CircuitDoc, w: WireItem, p: Point): WireTarget {
  const pts = wirePolyline(doc, w);
  let best: { seg: number; pt: Point; d: number } | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const h = projectOnSegment(p, pts[i], pts[i + 1]);
    if (!best || h.d < best.d) best = { seg: i, pt: h.pt, d: h.d };
  }
  if (!best) return { kind: 'grid', pt: p };
  if (eq(best.pt, pts[0])) return { kind: 'wireEnd', wire: w.id, end: 'a', pt: pts[0] };
  if (eq(best.pt, pts[pts.length - 1])) return { kind: 'wireEnd', wire: w.id, end: 'b', pt: pts[pts.length - 1] };
  return { kind: 'wire', wire: w.id, seg: best.seg, pt: best.pt };
}

/** What lies at a point: a pin, a junction, a wire, or nothing (a loose end). */
function targetAt(doc: CircuitDoc, p: Point): WireTarget {
  for (const it of Object.values(doc.items)) {
    if (it.type === 'junction' && eq(it, p, 0.5)) return { kind: 'junction', id: it.id, pt: { x: it.x, y: it.y } };
  }
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'component') continue;
    for (const port of instanceSymbol(doc, it).ports) {
      const pos = portPosition(doc, it, port.id)!;
      if (eq(pos.pt, p, 0.5)) return { kind: 'port', comp: it.id, port: port.id, pt: pos.pt, dir: pos.dir };
    }
  }
  const polys = new Map<string, Point[]>();
  for (const it of Object.values(doc.items)) if (it.type === 'wire' && !it.hidden) polys.set(it.id, wirePolyline(doc, it));
  const hit = hitWire(polys, p, 0.5);
  if (hit) return onWire(doc, doc.items[hit.wire] as WireItem, p);
  return { kind: 'grid', pt: p };
}

/** The page a wire between these targets is on: the page given, else that of the first part / junction / wire named. */
function wirePage(ctx: Ctx, page: unknown, ...targets: any[]): string {
  if (page) return ctx.tx.resolvePage(String(page));
  const doc = ctx.tx.doc;
  for (const t of targets) {
    const key = t?.comp ?? t?.ref ?? t?.junction ?? t?.wire;
    if (key === undefined) continue;
    try {
      return itemPage(doc, doc.items[resolveId(doc, String(key))]);
    } catch {
      /* reported when the target is resolved */
    }
  }
  return ctx.tx.resolvePage();
}

function wireStyle(v: unknown): Partial<WireStyle> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as P;
  const out: Partial<WireStyle> = {};
  if (s.color !== undefined) out.color = String(s.color);
  if (s.width !== undefined) out.width = num(s.width, 'style.width');
  if (s.radius !== undefined) out.radius = num(s.radius, 'style.radius');
  if (s.dash !== undefined) out.dash = s.dash;
  return out;
}

/** Draws one wire on a page; returns its id (null when it would be degenerate). */
function connectOne(ctx: Ctx, w: P, pageArg?: unknown): string | null {
  const page = wirePage(ctx, w.page ?? pageArg, w.from, w.to);
  let id: string | null = null;
  ctx.tx.edit(page, (d) => {
    const doc = d as CircuitDoc;
    const view = current(d) as CircuitDoc;
    const start = wireTarget(view, w.from, 'from', page);
    const end = wireTarget(view, w.to, 'to', page);
    const via = Array.isArray(w.via) ? w.via.map((v: unknown, i: number) => pt(v, `via[${i}]`)) : [];
    const angle = w.angle === '45' || w.angle === 'any' ? w.angle : 'ortho';
    id = commitWire(doc, start, end, {
      via,
      hFirst: w.hFirst ?? true,
      angle,
      style: wireStyle(w.style),
      routeGrid: w.route === false || via.length ? undefined : doc.settings.grid,
    });
    if (id && w.label) (doc.items[id] as WireItem).label = String(w.label);
  });
  if (id) ctx.tx.touch([id], page);
  return id;
}

function shapeDefaults(kind: ShapeKind) {
  return kind === 'text' ? { w: 0, h: 0 } : kind === 'callout' ? { w: 24, h: 24 } : { w: 120, h: 80 };
}

const SHAPE_KINDS: ShapeKind[] = ['rect', 'zone', 'ellipse', 'polygon', 'line', 'arrow', 'text', 'image', 'ink', 'callout', 'frame'];

/** An end of a line or arrow: a point, or an item it is glued to. */
function connectorEnd(doc: CircuitDoc, v: any, what: string): { at: Point; attach?: Attach } {
  if (v?.id !== undefined) {
    const id = resolveId(doc, String(v.id));
    const b = itemBounds(doc, doc.items[id]);
    if (!b) fail('bad_params', `${what}: ${v.id} has no outline to glue to`);
    const attach: Attach = { id };
    if (v.fx !== undefined && v.fy !== undefined) [attach.fx, attach.fy] = [num(v.fx, `${what}.fx`), num(v.fy, `${what}.fy`)];
    const at = attach.fx !== undefined ? { x: b!.x + b!.w * attach.fx, y: b!.y + b!.h * attach.fy! } : rectCentre(b!);
    return { at, attach };
  }
  return { at: pt(v, what) };
}

const SHAPE_LOCKED_KEYS = new Set(['id', 'type', 'page']);

/** Adds a shape to a draft page from shapes.add parameters. */
function addShape(d: Draft<CircuitDoc>, p: P): ShapeItem {
  const doc = d as CircuitDoc;
  const view = current(d) as CircuitDoc;
  const kind = String(need(p.kind, 'kind')) as ShapeKind;
  if (!SHAPE_KINDS.includes(kind)) fail('bad_params', `kind must be one of ${SHAPE_KINDS.join(', ')}`);
  const def = shapeDefaults(kind);
  let s: ShapeItem;
  const points: Point[] | null = Array.isArray(p.points) ? p.points.map((q: unknown, i: number) => pt(q, `points[${i}]`)) : null;
  if (kind === 'line' || kind === 'arrow') {
    const pts = points ?? [];
    const a = p.from !== undefined ? connectorEnd(view, p.from, 'from') : pts.length ? { at: pts[0] } : fail('bad_params', 'line / arrow need from and to (or points)');
    const b = p.to !== undefined ? connectorEnd(view, p.to, 'to') : pts.length > 1 ? { at: pts[pts.length - 1] } : fail('bad_params', 'line / arrow need from and to (or points)');
    s = makeShape(doc, kind, a.at.x, a.at.y, b.at.x - a.at.x, b.at.y - a.at.y);
    const bends = Array.isArray(p.bends) ? p.bends.map((q: unknown, i: number) => pt(q, `bends[${i}]`)) : p.from === undefined && pts.length > 2 ? pts.slice(1, -1) : [];
    if (bends.length) s.pts = bends;
    if (a.attach) s.from = a.attach;
    if (b.attach) s.to = b.attach;
  } else if (kind === 'polygon') {
    if (!points || points.length < 2) fail('bad_params', 'polygon needs points (at least 3; 2 with props.open)');
    const b = boundsOf(points!);
    s = makeShape(doc, kind, b.x, b.y, b.w, b.h);
    s.poly = points!.flatMap((q) => [b.w ? (q.x - b.x) / b.w : 0, b.h ? (q.y - b.y) / b.h : 0]);
  } else if (kind === 'ink') {
    if (!points || points.length < 2) fail('bad_params', 'ink needs points');
    const packed = packInk((p.points as P[]).map((q) => ({ x: q.x, y: q.y, p: typeof q.p === 'number' ? q.p : 0.5 })));
    s = makeShape(doc, kind, packed.x, packed.y, packed.w, packed.h);
    Object.assign(s, packed);
  } else {
    const x = num(p.x ?? 0, 'x');
    const y = num(p.y ?? 0, 'y');
    s = makeShape(doc, kind, x, y, num(p.w ?? def.w, 'w'), num(p.h ?? def.h, 'h'));
  }
  if (p.text !== undefined) s.text = String(p.text);
  if (kind === 'text' && (p.w === undefined || p.h === undefined)) {
    const m = measureText(s.text ?? '', s.fontSize ?? 16);
    if (p.w === undefined) s.w = Math.ceil(m.w);
    if (p.h === undefined) s.h = Math.ceil(m.h);
  }
  if (kind === 'callout') {
    s.step = nextStep(doc);
    if (p.anchor) {
      const target = p.anchor.id !== undefined ? view.items[resolveId(view, String(p.anchor.id))] : null;
      const tb = target ? itemBounds(view, target) : null;
      const at = p.anchor.x !== undefined ? pt(p.anchor, 'anchor') : tb ? rectCentre(tb) : fail('bad_params', 'anchor needs x, y or id');
      s.anchor = makeAnchor(view, target ?? null, at);
    }
  }
  if (kind === 'image' && p.src !== undefined) {
    const src = String(p.src);
    if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.test(src)) fail('bad_params', 'src must be a data:image/…;base64 URL');
    s.src = src;
  }
  if (p.props && typeof p.props === 'object') for (const [k, v] of Object.entries(p.props)) if (!SHAPE_LOCKED_KEYS.has(k)) (s as any)[k] = v;
  d.items[s.id] = s;
  return s;
}

function boundsOf(points: Point[]): Rect {
  const xs = points.map((q) => q.x);
  const ys = points.map((q) => q.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Normalises a raw item for items.create. */
function rawItem(d: Draft<CircuitDoc>, raw: P, i: number): Item {
  const doc = d as CircuitDoc;
  const view = current(d) as CircuitDoc;
  if (!raw || typeof raw !== 'object') fail('bad_params', `items[${i}] must be an object`);
  const { id, page: _page, ...rest } = raw;
  void _page;
  if (id !== undefined && doc.items[String(id)]) fail('bad_params', `items[${i}]: id "${id}" is taken`);
  let it: Item;
  switch (raw.type) {
    case 'component': {
      bringSymbol(d, String(need(raw.symbol, `items[${i}].symbol`)));
      const c = makeComponent(doc, raw.symbol, num(raw.x ?? 0, 'x'), num(raw.y ?? 0, 'y'), rotOf(raw.rot), !!raw.flipX);
      it = Object.assign(c, rest, { rot: c.rot, props: { ...c.props, ...(raw.props ?? {}) } });
      break;
    }
    case 'wire': {
      const ep = (e: any, what: string): Endpoint => {
        if (e?.kind === 'port' || e?.ref !== undefined || e?.comp !== undefined) {
          const cid = resolveId(view, String(e.comp ?? e.ref));
          const c = view.items[cid];
          if (c?.type !== 'component') fail('bad_params', `${what}: not a part`);
          return { kind: 'port', comp: cid, port: findPort(view, c as ComponentItem, e.port) };
        }
        if (e?.kind === 'junction' || e?.junction !== undefined) return { kind: 'junction', id: String(e.id ?? e.junction) };
        const q = pt(e, what);
        return { kind: 'free', x: q.x, y: q.y };
      };
      it = { ...rest, id: '', type: 'wire', a: ep(raw.a, `items[${i}].a`), b: ep(raw.b, `items[${i}].b`), pts: Array.isArray(raw.pts) ? raw.pts.map((q: unknown, k: number) => pt(q, `pts[${k}]`)) : [] } as WireItem;
      break;
    }
    case 'junction':
      it = { ...rest, id: '', type: 'junction', x: num(raw.x, 'x'), y: num(raw.y, 'y') } as Item;
      break;
    case 'shape': {
      const kind = String(need(raw.kind, `items[${i}].kind`)) as ShapeKind;
      const s = makeShape(doc, kind, num(raw.x ?? 0, 'x'), num(raw.y ?? 0, 'y'), num(raw.w ?? 100, 'w'), num(raw.h ?? 60, 'h'));
      it = Object.assign(s, rest);
      break;
    }
    default:
      return fail('bad_params', `items[${i}].type must be component, wire, junction or shape`);
  }
  it.id = id !== undefined ? String(id) : uid(it.type[0]);
  d.items[it.id] = it;
  return it;
}

/** Merges a patch into an item: nested style objects merge, 'unset' keys go. */
const NESTED = new Set(['style', 'labelStyle', 'refStyle', 'valueStyle', 'props', 'gradient', 'anchor']);
function patchItem(it: P, patch: P, unset: string[]) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || k === 'type') fail('bad_params', `${k} can't be changed`);
    if (k === 'page') fail('bad_params', 'use items.moveToPage to change an item’s page');
    if (k === 'rot' && it.type === 'component') {
      it.rot = rotOf(v);
      continue;
    }
    if (NESTED.has(k) && v && typeof v === 'object' && !Array.isArray(v) && it[k] && typeof it[k] === 'object') it[k] = { ...it[k], ...v };
    else it[k] = v;
  }
  for (const k of unset) if (k !== 'id' && k !== 'type') delete it[k];
}

function readDoc(ctx: Ctx, page?: unknown): CircuitDoc {
  return page === 'all' ? ctx.tx.doc : viewDoc(ctx.tx.doc, ctx.tx.resolvePage(page ? String(page) : undefined));
}

function matches(it: Item, q: string): boolean {
  const s = q.toLowerCase();
  const has = (v: unknown) => typeof v === 'string' && v.toLowerCase().includes(s);
  if (it.type === 'component') return has(it.ref) || has(it.value) || has(it.symbol) || Object.values(it.props).some(has);
  if (it.type === 'wire') return has(it.label);
  if (it.type === 'shape') return has(it.text);
  return false;
}

function blobToBase64(b: Blob): Promise<string> {
  return b.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
}

/** The document to draw for an export / screenshot: a page, items of it, or an area of it. */
function drawingDoc(ctx: Ctx, p: P): CircuitDoc {
  const doc = ctx.tx.doc;
  if (p.ids) {
    const ids = resolveIds(doc, p.ids);
    const page = p.page ? ctx.tx.resolvePage(p.page) : itemPage(doc, doc.items[ids[0]]);
    return selectionDoc(viewDoc(doc, page), ids);
  }
  const view = viewDoc(doc, ctx.tx.resolvePage(p.page));
  if (p.rect) return clipAreaDoc(view, { x: num(p.rect.x, 'rect.x'), y: num(p.rect.y, 'rect.y'), w: num(p.rect.w, 'rect.w'), h: num(p.rect.h, 'rect.h') });
  return view;
}

function svgOpts(p: P): SvgOptions {
  return { theme: p.theme === 'dark' ? 'dark' : p.theme === 'light' ? 'light' : S().prefs.theme, background: p.background ?? true, padding: 20 };
}

/** Saves the open circuit as a version before the agent replaces it. */
async function keepVersion(label: string) {
  try {
    await saveVersion(sharedDoc(), label, false);
  } catch {
    /* replacing matters more than the backup */
  }
}

/** The agent's working page, checked against the document (it may have been deleted). */
export function agentPage(): string | undefined {
  return A().page;
}

/* ------------------------------------------------------------------ */
/* User answers (session.waitForUser)                                   */
/* ------------------------------------------------------------------ */

let questionId = 0;
const waiting = new Map<number, (answer: string | null) => void>();

/** The user's reply to the agent's question (from the panel). */
export function answerQuestion(text: string | null) {
  const q = A().question;
  if (!q) return;
  setAgent({ question: null });
  logAgent({ kind: 'user', text: text === null ? 'Dismissed the question' : `Replied: ${text}` });
  waiting.get(q.id)?.(text);
  waiting.delete(q.id);
}

/* ------------------------------------------------------------------ */
/* Methods                                                             */
/* ------------------------------------------------------------------ */

export const METHODS: Record<string, Handler> = {
  /* ---------------- meta ---------------- */
  'nodal.describe': (p) => {
    if (p.method) return catalog.methods.find((m) => m.name === p.method) ?? fail('not_found', `No method "${p.method}"`);
    return catalog;
  },
  'nodal.ping': () => {
    const doc = sharedDoc();
    return { ok: true, app: 'Nodal', version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev', desktop: isDesktop(), doc: { id: doc.id ?? null, name: doc.name } };
  },

  /* ---------------- session ---------------- */
  'session.start': (p) => {
    const was = A().status;
    setAgent({
      status: 'working',
      name: p.name ? String(p.name).slice(0, 40) : A().name,
      goal: p.goal ? String(p.goal).slice(0, 300) : '',
      color: p.color ? String(p.color) : A().color || AGENT_COLOR,
      progress: null,
      // a new session starts with nothing protected; one picked up again keeps its work
      ...(was === 'working' ? {} : { owned: new Set<string>() }),
    });
    if (was !== 'working') clearSteps();
    setAgent({ steps: agentPast.length, redoable: agentFuture.length });
    return METHODS['session.status']({}, undefined as never);
  },
  'session.status': () => {
    const a = A();
    const s = S();
    return {
      status: a.status,
      name: a.name,
      goal: a.goal,
      guard: a.guard,
      guardMeaning: a.guard === 'off' ? 'the user can edit anything' : a.guard === 'items' ? 'while you work, the user cannot change items you made or changed' : 'while you work, the user cannot change the circuit at all',
      follow: a.follow,
      page: a.page ?? docPages(sharedDoc())[0].id,
      ownedItems: a.owned.size,
      steps: agentPast.length,
      writable: !s.viewOnly && !s.viewMode,
      ...(s.viewOnly ? { readOnlyReason: 'view-only live session' } : s.viewMode ? { readOnlyReason: 'the user has View mode on' } : {}),
    };
  },
  'session.say': (p) => {
    const text = String(need(p.text, 'text')).slice(0, 2000);
    const tone = ['info', 'success', 'warning', 'error'].includes(p.kind) ? p.kind : 'info';
    setAgent({ bubble: { text, tone, t: Date.now() } });
    logAgent({ kind: 'say', text, tone });
    return { ok: true };
  },
  'session.progress': (p) => {
    setAgent({ progress: { text: p.text ? String(p.text) : (A().progress?.text ?? ''), ...(typeof p.fraction === 'number' ? { fraction: Math.max(0, Math.min(1, p.fraction)) } : {}) } });
    return { ok: true };
  },
  'session.done': (p) => {
    const a = A();
    setAgent({ status: 'done', progress: null, bubble: p.summary ? { text: String(p.summary), tone: 'success', t: Date.now() } : a.bubble });
    logAgent({ kind: 'system', text: p.summary ? `Done: ${p.summary}` : 'Done' });
    toast(`${a.name} is done${p.summary ? ` — ${String(p.summary).slice(0, 140)}` : ''}`, 'success');
    return { ok: true, status: 'done' };
  },
  'session.setPage': (p, ctx) => {
    const page = ctx.tx.resolvePage(String(need(p.page, 'page')));
    setAgent({ page });
    return { page };
  },
  'session.pointAt': (p, ctx) => {
    const doc = ctx.tx.doc;
    if (p.ids) {
      const ids = resolveIds(doc, p.ids);
      const page = itemPage(doc, doc.items[ids[0]]);
      const b = docBounds(viewDoc(doc, page), ids);
      if (!b) fail('bad_params', 'nothing to point at');
      setAgent({ cursor: { ...rectCentre(b!), page }, flash: { ids, page, t: Date.now() } });
      return { ok: true };
    }
    const page = ctx.tx.resolvePage(p.page);
    setAgent({ cursor: { ...pt(p, 'point'), page } });
    return { ok: true };
  },
  'session.log': (p) => A().log.slice(-(Number(p.limit) || 50)).map(({ t, kind, method, text, tone }) => ({ t, kind, method, text, tone })),
  'session.waitForUser': (p, ctx) => {
    if (ctx.inBatch) fail('bad_params', 'session.waitForUser can’t run inside a batch');
    const text = String(need(p.question, 'question'));
    const id = ++questionId;
    const choices = Array.isArray(p.choices) ? p.choices.map(String).slice(0, 6) : [];
    // a newer question replaces an unanswered one
    const prev = A().question;
    if (prev) waiting.get(prev.id)?.(null);
    setAgent({ question: { id, text, choices }, collapsed: false });
    logAgent({ kind: 'say', text: `Asks: ${text}`, tone: 'warning' });
    toast(`${A().name} asks: ${text.slice(0, 120)}`, 'info');
    const ms = Math.min(600000, Math.max(1000, Number(p.timeoutMs) || 120000));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        if (A().question?.id === id) setAgent({ question: null });
        resolve({ answered: false, answer: null, reason: 'timeout' });
      }, ms);
      waiting.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer === null ? { answered: false, answer: null, reason: 'dismissed' } : { answered: true, answer });
      });
    });
  },

  /* ---------------- app ---------------- */
  'app.state': () => {
    const s = S();
    const doc = sharedDoc();
    const collab = useCollab.getState();
    return {
      page: docPages(doc).find((pg) => pg.id === (s.page ?? docPages(doc)[0].id)) ?? docPages(doc)[0],
      selection: s.selection,
      tool: s.tool,
      view: s.view,
      canvasSize: s.canvasSize,
      theme: s.prefs.theme,
      dialog: s.dialog,
      viewOnly: s.viewOnly,
      viewMode: s.viewMode,
      filePath: s.filePath,
      dirty: s.dirty,
      symbolEditorOpen: !!s.symbolSession,
      liveSession: collab.status,
      doc: { id: doc.id ?? null, name: doc.name, items: Object.keys(doc.items).length, pages: docPages(doc).length },
      desktop: isDesktop(),
    };
  },
  'app.prefs': () => {
    const { keymap, keymapCadence, ...rest } = S().prefs;
    void keymap;
    void keymapCadence;
    return rest;
  },
  'app.setPrefs': (p) => {
    const patch = objectOf(p.patch, 'patch') as Partial<Prefs>;
    const { theme, ...rest } = patch;
    if (theme === 'dark' || theme === 'light') setTheme(theme);
    const known = Object.keys(S().prefs);
    const bad = Object.keys(rest).filter((k) => !known.includes(k) && k !== 'exportBackground' && k !== 'exportScale' && k !== 'exportScene' && k !== 'exportTheme' && k !== 'toolStyles' && k !== 'wireMatchStart');
    if (bad.length) fail('bad_params', `Unknown prefs: ${bad.join(', ')}`);
    if (Object.keys(rest).length) setPrefs(rest);
    return METHODS['app.prefs']({}, undefined as never);
  },
  'app.toast': (p) => {
    toast(String(need(p.text, 'text')), p.kind === 'error' || p.kind === 'success' ? p.kind : 'info');
    return { ok: true };
  },
  'app.commands': async (p) => {
    const { COMMANDS } = await import('../store/commands');
    const q = p.query ? String(p.query).toLowerCase() : '';
    return COMMANDS.filter((c) => !q || `${c.id} ${c.label} ${c.category} ${c.keywords ?? ''}`.toLowerCase().includes(q)).map((c) => ({
      id: c.id,
      label: c.label,
      category: c.category,
      keys: c.keys,
      available: c.when ? c.when() : true,
      ...(c.checked ? { on: c.checked() } : {}),
    }));
  },
  'app.runCommand': async (p) => {
    const { COMMANDS } = await import('../store/commands');
    const cmd = COMMANDS.find((c) => c.id === p.id) ?? fail('not_found', `No command "${p.id}" (app.commands lists them)`);
    if (cmd.when && !cmd.when()) fail('unavailable', `“${cmd.label}” is not available right now`);
    cmd.run();
    return { ok: true, ran: cmd.label };
  },

  /* ---------------- the user's view ---------------- */
  'user.select': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    const shown = goToItems(ids);
    select(shown);
    return { selected: S().selection };
  },
  'user.show': (p, ctx) => {
    if (inGesture()) return { ok: false, reason: 'the user is dragging' };
    if (p.ids) {
      const ids = goToItems(resolveIds(ctx.tx.doc, p.ids));
      revealItems(ids);
      return { ok: true };
    }
    if (p.page) setPage(ctx.tx.resolvePage(p.page));
    if (p.rect) {
      const r = p.rect as Rect;
      const { canvasSize } = S();
      const zoom = Math.min(3, Math.max(0.1, Math.min((canvasSize.w - 120) / Math.max(r.w, 1), (canvasSize.h - 120) / Math.max(r.h, 1))));
      glideView({ zoom, x: canvasSize.w / 2 - (r.x + r.w / 2) * zoom, y: canvasSize.h / 2 - (r.y + r.h / 2) * zoom });
    }
    return { ok: true };
  },
  'user.setPage': (p, ctx) => {
    const page = ctx.tx.resolvePage(String(need(p.page, 'page')));
    return { ok: setPage(page) || S().page === page, page };
  },
  'user.setFollow': (p) => {
    setAgent({ follow: !!p.on });
    return { follow: !!p.on };
  },

  /* ---------------- document ---------------- */
  'doc.get': (p, ctx) => {
    const doc = p.page ? viewDoc(ctx.tx.doc, ctx.tx.resolvePage(p.page)) : ctx.tx.doc;
    const out: P = normalizePages(doc);
    return p.symbols === false ? { ...out, symbols: undefined } : out;
  },
  'doc.summary': (p, ctx) => {
    const doc = ctx.tx.doc;
    const pages = p.page ? [ctx.tx.resolvePage(p.page)] : docPages(doc).map((pg) => pg.id);
    return {
      id: doc.id ?? null,
      name: doc.name,
      grid: doc.settings.grid,
      pages: pages.map((id) => {
        const view = viewDoc(doc, id);
        const items = Object.values(view.items);
        const b = docBounds(view);
        return {
          id,
          name: docPages(doc).find((pg) => pg.id === id)?.name,
          bounds: b && { x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) },
          parts: items.filter((i): i is ComponentItem => i.type === 'component').map((c) => ({ id: c.id, ref: c.ref, symbol: c.symbol, value: c.value, x: c.x, y: c.y, rot: c.rot })),
          wires: items.filter((i) => i.type === 'wire').length,
          junctions: items.filter((i) => i.type === 'junction').length,
          shapes: items.filter((i): i is ShapeItem => i.type === 'shape').map((s) => ({ id: s.id, kind: s.kind, ...(s.text ? { text: s.text.slice(0, 80) } : {}) })),
        };
      }),
      nets: computeNets(doc).length,
      customSymbols: Object.keys(doc.symbols),
    };
  },
  'doc.new': async (p) => {
    await keepVersion('Before the agent started a new circuit');
    const doc = createDoc(p.name ? String(p.name) : undefined);
    asAgent(() => replaceDoc(doc));
    clearSteps();
    setAgent({ owned: new Set(), page: undefined });
    return { id: doc.id, name: doc.name };
  },
  'doc.load': async (p) => {
    const raw = objectOf(p.doc, 'doc');
    let doc: CircuitDoc;
    try {
      doc = normalizeDoc(raw);
    } catch (e) {
      return fail('bad_params', `Not a Nodal document: ${(e as Error).message}`);
    }
    await keepVersion('Before the agent loaded a circuit');
    asAgent(() => replaceDoc(doc));
    clearSteps();
    setAgent({ owned: new Set(Object.keys(doc.items)), page: undefined });
    return { id: doc.id ?? null, name: doc.name, items: Object.keys(doc.items).length, pages: docPages(doc).length };
  },
  'doc.rename': (p, ctx) => {
    const name = String(need(p.name, 'name')).trim();
    ctx.tx.edit(null, (d) => void (d.name = name), { allPages: true });
    return { name };
  },
  'doc.settings': (_p, ctx) => ctx.tx.doc.settings,
  'doc.setSettings': (p, ctx) => {
    const patch = objectOf(p.patch, 'patch');
    ctx.tx.edit(
      null,
      (d) => {
        for (const [k, v] of Object.entries(patch)) {
          const cur = (d.settings as P)[k];
          if (!(k in d.settings) && !['gridStyle', 'hideRefs', 'hideValues', 'hideWireLabels', 'ercIgnored', 'sheet'].includes(k)) fail('bad_params', `Unknown setting "${k}"`);
          if (k === 'background') (d.settings as P)[k] = safeColour(v);
          else if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object') (d.settings as P)[k] = { ...cur, ...v };
          else (d.settings as P)[k] = v;
        }
      },
      { allPages: true },
    );
    return ctx.tx.doc.settings;
  },
  'doc.insert': (p, ctx) => {
    const raw = objectOf(p.doc, 'doc');
    let frag: Fragment;
    if (raw.format === 'nodal-fragment') frag = raw as Fragment;
    else if (raw.format === 'nodal-template' && raw.fragment) frag = raw.fragment as Fragment;
    else {
      const src = normalizeDoc(raw);
      frag = extractFragment(src, new Set(Object.keys(src.items)));
      frag.symbols = { ...src.symbols, ...frag.symbols };
    }
    if (!Array.isArray(frag.items)) fail('bad_params', 'doc has no items');
    let ids: string[] = [];
    const page = ctx.tx.resolvePage(p.page);
    ctx.tx.edit(page, (d) => {
      ids = insertFragment(d as CircuitDoc, frag, Number(p.dx) || 0, Number(p.dy) || 0);
    });
    ctx.tx.touch(ids, page);
    return { ids };
  },
  'doc.save': async (p) => {
    const doc = sharedDoc();
    const text = circuitToText(doc);
    const name = `${sanitizeName(doc.name)}.nodal`;
    if (isDesktop()) {
      const path = p.path ? String(p.path) : S().filePath;
      if (!path) fail('bad_params', 'This circuit has no file yet: pass a path');
      const res = await saveFile(text, name, [{ name: 'Nodal circuit', extensions: ['nodal', 'json'] }], path);
      if (res) S().filePath !== res && (await import('../store/store')).set({ filePath: res });
      (await import('../store/store')).set({ dirty: S().doc !== doc });
      return { saved: true, path: res };
    }
    // the browser: hand the file to its downloads (no save dialog without a click)
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return { saved: true, downloaded: name, note: 'The web app cannot write files; it was offered as a download. Use doc.get for the content.' };
  },
  'doc.export': async (p, ctx) => {
    const fmt = String(need(p.format, 'format'));
    const doc = ctx.tx.doc;
    switch (fmt) {
      case 'svg':
      case 'png': {
        const d = drawingDoc(ctx, p);
        await prepareMath(d);
        if (fmt === 'svg') return { format: fmt, mime: 'image/svg+xml', text: exportSvg(d, svgOpts(p)).svg };
        const blob = await exportPng(d, { ...svgOpts(p), scale: Math.min(6, Math.max(0.25, Number(p.scale) || 2)) });
        return { format: fmt, mime: 'image/png', base64: await blobToBase64(blob) };
      }
      case 'dxf':
        return { format: fmt, mime: 'application/dxf', text: exportDxf(drawingDoc(ctx, p)) };
      case 'spice':
        return { format: fmt, mime: 'text/plain', text: toSpiceNetlist(p.ids ? selectionDoc(doc, resolveIds(doc, p.ids)) : doc) };
      case 'kicad':
        return { format: fmt, mime: 'text/plain', text: toKicadNetlist(p.ids ? selectionDoc(doc, resolveIds(doc, p.ids)) : doc) };
      case 'bom':
        return { format: fmt, mime: 'text/csv', text: toBomCsv(p.ids ? selectionDoc(doc, resolveIds(doc, p.ids)) : doc) };
      case 'json':
        return { format: fmt, mime: 'application/json', text: circuitToText(doc) };
      default:
        return fail('bad_params', 'format must be svg, png, dxf, spice, kicad, bom or json');
    }
  },
  'doc.screenshot': async (p, ctx) => {
    const d = drawingDoc(ctx, p);
    const opts = svgOpts(p);
    await prepareMath(d);
    const box = exportBox(d, opts);
    const max = Math.min(4096, Math.max(200, Number(p.maxSize) || 1600));
    const scale = Math.min(3, max / Math.max(box.w, box.h, 1));
    const blob = await exportPng(d, { ...opts, scale });
    return { mime: 'image/png', base64: await blobToBase64(blob), bounds: { x: r1(box.x), y: r1(box.y), w: r1(box.w), h: r1(box.h) }, scale: r1(scale) };
  },
  'doc.stats': (_p, ctx) => {
    const doc = ctx.tx.doc;
    const items = Object.values(doc.items);
    return {
      parts: items.filter((i) => i.type === 'component').length,
      wires: items.filter((i) => i.type === 'wire').length,
      junctions: items.filter((i) => i.type === 'junction').length,
      shapes: items.filter((i) => i.type === 'shape').length,
      nets: computeNets(doc).length,
      pages: docPages(doc).length,
      groups: Object.keys(doc.groups).length,
      customSymbols: Object.keys(doc.symbols).length,
    };
  },

  /* ---------------- pages ---------------- */
  'pages.list': (_p, ctx) => {
    const doc = ctx.tx.doc;
    const mine = ctx.tx.resolvePage();
    const users = ctx.tx.resolvePage(S().page ?? undefined);
    return docPages(doc).map((pg, i) => ({ id: pg.id, name: pg.name, index: i, items: pageItemIds(doc, pg.id).length, agentPage: pg.id === mine, userPage: pg.id === users }));
  },
  'pages.add': (p, ctx) => {
    let id = '';
    ctx.tx.edit(null, (d) => void (id = addPage(d as CircuitDoc, p.name ? String(p.name) : undefined, p.after ? ctx.tx.resolvePage(p.after) : undefined)), { allPages: true });
    return { id, name: docPages(ctx.tx.doc).find((pg) => pg.id === id)?.name };
  },
  'pages.rename': (p, ctx) => {
    const id = ctx.tx.resolvePage(String(need(p.page, 'page')));
    ctx.tx.edit(null, (d) => renamePage(d as CircuitDoc, id, String(need(p.name, 'name'))), { allPages: true });
    return { id, name: String(p.name) };
  },
  'pages.delete': (p, ctx) => {
    const id = ctx.tx.resolvePage(String(need(p.page, 'page')));
    if (docPages(ctx.tx.doc).length < 2) fail('bad_params', 'The last page can’t be deleted');
    ctx.tx.edit(null, (d) => void deletePage(d as CircuitDoc, id), { allPages: true });
    if (A().page === id) setAgent({ page: undefined });
    return { deleted: id };
  },
  'pages.duplicate': (p, ctx) => {
    const src = ctx.tx.resolvePage(String(need(p.page, 'page')));
    let id = '';
    ctx.tx.edit(null, (d) => void (id = duplicatePage(d as CircuitDoc, src, p.name ? String(p.name) : undefined)), { allPages: true });
    ctx.tx.touch(pageItemIds(ctx.tx.doc, id), id);
    return { id };
  },
  'pages.move': (p, ctx) => {
    const id = ctx.tx.resolvePage(String(need(p.page, 'page')));
    ctx.tx.edit(null, (d) => movePage(d as CircuitDoc, id, num(p.to, 'to')), { allPages: true });
    return { order: docPages(ctx.tx.doc).map((pg) => pg.id) };
  },

  /* ---------------- items ---------------- */
  'items.list': (p, ctx) => {
    const doc = readDoc(ctx, p.page);
    const rect = p.rect ? { x: num(p.rect.x, 'rect.x'), y: num(p.rect.y, 'rect.y'), w: num(p.rect.w, 'rect.w'), h: num(p.rect.h, 'rect.h') } : null;
    const limit = Math.max(1, Number(p.limit) || 500);
    const out = [];
    for (const it of Object.values(doc.items)) {
      if (p.type && it.type !== p.type) continue;
      if (p.kind && (it.type !== 'shape' || it.kind !== p.kind)) continue;
      if (p.symbol && (it.type !== 'component' || it.symbol !== p.symbol)) continue;
      if (p.text && !matches(it, String(p.text))) continue;
      if (rect) {
        const b = itemBounds(doc, it);
        if (!b || b.x > rect.x + rect.w || b.y > rect.y + rect.h || b.x + b.w < rect.x || b.y + b.h < rect.y) continue;
      }
      out.push(brief(ctx.tx.doc, it));
      if (out.length >= limit) break;
    }
    return { items: out, total: out.length, truncated: out.length >= limit };
  },
  'items.get': (p, ctx) => {
    const doc = ctx.tx.doc;
    return resolveIds(doc, p.ids).map((id) => full(viewDoc(doc, itemPage(doc, doc.items[id])), doc.items[id]));
  },
  'items.create': (p, ctx) => {
    if (!Array.isArray(p.items) || !p.items.length) fail('bad_params', 'items must be a non-empty list');
    const page = ctx.tx.resolvePage(p.page);
    let ids: string[] = [];
    ctx.tx.edit(page, (d) => {
      ids = (p.items as P[]).map((raw, i) => rawItem(d, raw, i).id);
    });
    ids = ids.filter((id) => ctx.tx.doc.items[id]);
    ctx.tx.touch(ids, page);
    return { ids };
  },
  'items.update': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids ?? p.id);
    const patch = objectOf(p.patch ?? {}, 'patch');
    const unset = Array.isArray(p.unset) ? p.unset.map(String) : [];
    editItems(ctx, ids, (d, on, base) => {
      for (const id of on) patchItem(d.items[id] as P, patch, unset);
      // parts moved, turned or resized by a field take their wires along
      followParts(base, d as CircuitDoc, new Set(on));
    });
    return { ids };
  },
  'items.delete': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    editItems(ctx, ids, (d, on) => deleteItems(d as CircuitDoc, on));
    return { deleted: ids.filter((id) => !ctx.tx.doc.items[id]) };
  },
  'items.move': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    const dx = num(p.dx, 'dx');
    const dy = num(p.dy, 'dy');
    editItems(ctx, ids, (d, on, base) => (p.detach ? translateDetached : translateItems)(base, d as CircuitDoc, new Set(on), dx, dy));
    return { ids };
  },
  'items.moveTo': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids ?? p.id);
    const first = ctx.tx.doc.items[ids[0]];
    const at = first.type === 'wire' ? wirePolyline(ctx.tx.doc, first)[0] : first.type === 'component' || first.type === 'junction' ? first : { x: first.x, y: first.y };
    return METHODS['items.move']({ ids, dx: num(p.x, 'x') - at.x, dy: num(p.y, 'y') - at.y }, ctx);
  },
  'items.rotate': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    const deg = Number(p.deg);
    if (![90, -90, 180, 270, -180].includes(deg)) fail('bad_params', 'deg must be 90, -90 or 180');
    editItems(ctx, ids, (d, on, base) => {
      const set = new Set(on);
      const pivot = p.pivot ? pt(p.pivot, 'pivot') : turnPivot(base, set);
      if (deg === 180 || deg === -180) {
        rotateItems(d as CircuitDoc, set, 90, pivot);
        rotateItems(d as CircuitDoc, set, 90, pivot);
      } else rotateItems(d as CircuitDoc, set, deg === 270 ? -90 : (deg as 90 | -90), pivot);
    });
    return { ids };
  },
  'items.rotateShape': (p, ctx) => {
    const id = resolveId(ctx.tx.doc, String(need(p.id, 'id')));
    const it = ctx.tx.doc.items[id];
    if (it.type !== 'shape') fail('bad_params', 'items.rotateShape turns shapes; use items.rotate for parts');
    editItems(ctx, [id], (d, _on, base) => rotateShapeBy(base, d as CircuitDoc, id, num(p.deg, 'deg'), p.pivot ? pt(p.pivot, 'pivot') : rectCentre(shapeBox(it as ShapeItem))));
    return { id };
  },
  'items.flip': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    const axis = p.axis === 'y' ? 'y' : 'x';
    editItems(ctx, ids, (d, on) => flipItems(d as CircuitDoc, new Set(on), axis));
    return { ids };
  },
  'items.scale': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    const factor = num(p.factor, 'factor');
    if (factor <= 0) fail('bad_params', 'factor must be above 0');
    editItems(ctx, ids, (d, on, base) => void scaleItems(base, d as CircuitDoc, new Set(on), factor, p.pivot ? pt(p.pivot, 'pivot') : selectionPivot(base, on)));
    return { ids };
  },
  'items.align': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    editItems(ctx, ids, (d, on) => alignItems(d as CircuitDoc, on, String(need(p.mode, 'mode')) as AlignMode));
    return { ids };
  },
  'items.distribute': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    editItems(ctx, ids, (d, on) => distributeItems(d as CircuitDoc, on, p.axis === 'y' ? 'y' : 'x'));
    return { ids };
  },
  'items.matchSize': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    let n = 0;
    editItems(ctx, ids, (d, on) => void (n += matchSizes(d as CircuitDoc, on, (p.mode ?? 'both') as SizeMode)));
    return { resized: n };
  },
  'items.restack': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    editItems(ctx, ids, (d, on) => void restackItems(d as CircuitDoc, on, String(need(p.dir, 'dir')) as StackMove));
    return { ids };
  },
  'items.duplicate': (p, ctx) => {
    const doc = ctx.tx.doc;
    const ids = resolveIds(doc, p.ids);
    const from = itemPage(doc, doc.items[ids[0]]);
    const frag = extractFragment(viewDoc(doc, from), new Set(ids.filter((id) => itemPage(doc, doc.items[id]) === from)));
    const g = doc.settings.grid * 2;
    const page = p.page ? ctx.tx.resolvePage(p.page) : from;
    let out: string[] = [];
    ctx.tx.edit(page, (d) => void (out = insertFragment(d as CircuitDoc, frag, p.dx ?? (page === from ? g : 0), p.dy ?? (page === from ? g : 0))));
    ctx.tx.touch(out, page);
    return { ids: out };
  },
  'items.moveToPage': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    const page = ctx.tx.resolvePage(String(need(p.page, 'page')));
    let moved: string[] = [];
    ctx.tx.edit(null, (d) => void (moved = moveItemsToPage(d as CircuitDoc, ids, page)), { allPages: true });
    ctx.tx.touch(moved, page);
    return { ids: moved, page };
  },
  'items.lock': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    editItems(ctx, ids, (d, on) => on.forEach((id) => (p.locked === false ? delete d.items[id].locked : (d.items[id].locked = true))));
    return { ids, locked: p.locked !== false };
  },
  'items.hide': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    editItems(ctx, ids, (d, on) => on.forEach((id) => (p.hidden === false ? delete d.items[id].hidden : (d.items[id].hidden = true))));
    return { ids, hidden: p.hidden !== false };
  },
  'items.style': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    const look = objectOf(p.look, 'look') as Partial<Look>;
    editItems(ctx, ids, (d, on) => on.forEach((id) => applyLook(d.items[id] as Item, look)));
    return { ids };
  },
  'items.getStyle': (p, ctx) => {
    const doc = ctx.tx.doc;
    const ids = resolveIds(doc, p.ids);
    const r = commonLook(doc, ids.map((id) => doc.items[id]));
    return { look: r.value, keys: [...r.keys], mixed: [...r.mixed] };
  },
  'items.find': (p, ctx) => {
    const doc = ctx.tx.doc;
    const q = String(need(p.text, 'text'));
    const limit = Number(p.limit) || 100;
    return Object.values(doc.items)
      .filter((it) => matches(it, q))
      .slice(0, limit)
      .map((it) => brief(doc, it));
  },

  'items.template': (p, ctx) => {
    const doc = ctx.tx.doc;
    const ids = resolveIds(doc, p.ids);
    const frag = extractFragment(doc, new Set(ids));
    return { format: 'nodal-template', version: 1, app: 'Nodal', name: p.name ? String(p.name) : `${doc.name} template`, fragment: frag };
  },

  /* ---------------- groups ---------------- */
  'groups.list': (_p, ctx) => {
    const doc = ctx.tx.doc;
    return Object.values(doc.groups).map((g) => ({ ...g, members: Object.values(doc.items).filter((i) => i.group === g.id).map((i) => i.id) }));
  },
  'groups.create': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    let gid: string | null = null;
    const pages = byPage(ctx.tx.doc, ids);
    if (pages.size > 1) fail('bad_params', 'Items of a group must be on one page');
    editItems(ctx, ids, (d, on) => void (gid = groupItems(d as CircuitDoc, on, undefined, p.name ? String(p.name) : undefined)));
    return { group: gid };
  },
  'groups.ungroup': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    let n = 0;
    editItems(ctx, ids, (d, on) => void (n += ungroupItems(d as CircuitDoc, on)));
    return { ungrouped: n };
  },
  'groups.rename': (p, ctx) => {
    const g = String(need(p.group, 'group'));
    if (!ctx.tx.doc.groups[g]) fail('not_found', `No group "${g}"`);
    ctx.tx.edit(null, (d) => void (d.groups[g].name = String(need(p.name, 'name'))), { allPages: true });
    return { group: g };
  },

  /* ---------------- components ---------------- */
  'components.place': (p, ctx) => {
    const page = ctx.tx.resolvePage(p.page);
    let id = '';
    ctx.tx.edit(page, (d) => void (id = placeOne(d, p).id));
    ctx.tx.touch([id], page);
    const doc = ctx.tx.doc;
    const c = doc.items[id] as ComponentItem;
    return { id, ref: c.ref, symbol: c.symbol, x: c.x, y: c.y, rot: c.rot, pins: pinsOf(viewDoc(doc, page), c) };
  },
  'components.placeMany': (p, ctx) => {
    if (!Array.isArray(p.parts) || !p.parts.length) fail('bad_params', 'parts must be a non-empty list');
    const page = ctx.tx.resolvePage(p.page);
    let ids: string[] = [];
    ctx.tx.edit(page, (d) => void (ids = (p.parts as P[]).map((q) => placeOne(d, q).id)));
    ctx.tx.touch(ids, page);
    const view = viewDoc(ctx.tx.doc, page);
    return ids.map((id) => {
      const c = view.items[id] as ComponentItem;
      return { id, ref: c.ref, symbol: c.symbol, x: c.x, y: c.y, rot: c.rot, pins: pinsOf(view, c) };
    });
  },
  'components.ports': (p, ctx) => {
    const doc = ctx.tx.doc;
    const id = resolveId(doc, String(need(p.id, 'id')));
    const c = doc.items[id];
    if (c.type !== 'component') fail('bad_params', `${p.id} is not a part`);
    return { id, ref: (c as ComponentItem).ref, pins: pinsOf(doc, c as ComponentItem, computeNets(doc)) };
  },
  'components.setSymbol': (p, ctx) => {
    const id = resolveId(ctx.tx.doc, String(need(p.id, 'id')));
    if (ctx.tx.doc.items[id].type !== 'component') fail('bad_params', `${p.id} is not a part`);
    const symbol = String(need(p.symbol, 'symbol'));
    editItems(ctx, [id], (d, on, base) => {
      bringSymbol(d, symbol);
      (d.items[id] as ComponentItem).symbol = symbol;
      followParts(base, d as CircuitDoc, new Set(on));
    });
    return { id, symbol };
  },
  'components.annotate': (_p, ctx) => {
    ctx.tx.edit(null, (d) => annotate(d as CircuitDoc), { allPages: true });
    return Object.values(ctx.tx.doc.items).flatMap((i) => (i.type === 'component' ? [{ id: i.id, ref: i.ref }] : []));
  },

  /* ---------------- wires ---------------- */
  'wires.connect': (p, ctx) => {
    const id = connectOne(ctx, p);
    if (!id) fail('degenerate', 'Nothing to draw: both ends are at the same spot');
    const w = ctx.tx.doc.items[id!] as WireItem;
    return { id, points: wirePolyline(ctx.tx.doc, w), a: w.a, b: w.b };
  },
  'wires.connectMany': (p, ctx) => {
    if (!Array.isArray(p.wires) || !p.wires.length) fail('bad_params', 'wires must be a non-empty list');
    return { ids: (p.wires as P[]).map((w) => connectOne(ctx, w, p.page)) };
  },
  'wires.path': (p, ctx) => {
    if (!Array.isArray(p.points) || p.points.length < 2) fail('bad_params', 'points needs at least 2 points');
    const points = (p.points as unknown[]).map((q, i) => pt(q, `points[${i}]`));
    const square = points.every((q, i) => i === 0 || q.x === points[i - 1].x || q.y === points[i - 1].y);
    const id = connectOne(ctx, { from: points[0], to: points[points.length - 1], via: points.slice(1, -1), angle: square ? 'ortho' : 'any', route: false, style: p.style, label: p.label, page: p.page, hFirst: points.length > 1 && points[1].y === points[0].y });
    if (!id) fail('degenerate', 'Nothing to draw');
    return { id };
  },
  'wires.reroute': (p, ctx) => {
    const doc = ctx.tx.doc;
    const ids = p.ids ? resolveIds(doc, p.ids) : Object.values(viewDoc(doc, ctx.tx.resolvePage(p.page)).items).filter((i) => i.type === 'wire').map((i) => i.id);
    editItems(ctx, ids, (d, on) => {
      const pending = new Set(on);
      for (const id of on) {
        const w = d.items[id];
        pending.delete(id);
        if (w?.type !== 'wire' || w.locked) continue;
        if (!routeWireAround(d as CircuitDoc, w as WireItem, pending)) {
          w.pts = [];
          delete w.routing;
        }
      }
    });
    return { ids };
  },
  'wires.junction': (p, ctx) => {
    const at = pt(p, 'point');
    const doc = ctx.tx.doc;
    const page = p.wires ? itemPage(doc, doc.items[resolveId(doc, list(p.wires, 'wires')[0])]) : ctx.tx.resolvePage(p.page);
    let jid: string | null = null;
    ctx.tx.edit(page, (d) => {
      const view = current(d) as CircuitDoc;
      let wires = p.wires ? resolveIds(view, p.wires) : [];
      if (!wires.length) {
        for (const it of Object.values(view.items)) {
          if (it.type !== 'wire') continue;
          const pts = wirePolyline(view, it);
          if (pts.some((q, i) => i > 0 && projectOnSegment(at, pts[i - 1], q).d < 0.5)) wires.push(it.id);
        }
      }
      wires = wires.filter((w) => view.items[w]?.type === 'wire');
      if (wires.length) jid = solderWires(d as CircuitDoc, wires, at);
      else {
        jid = uid('j');
        d.items[jid] = { id: jid, type: 'junction', x: at.x, y: at.y };
      }
    });
    if (jid) ctx.tx.touch([jid], page);
    return { junction: jid };
  },
  'wires.unsolder': (p, ctx) => {
    const doc = ctx.tx.doc;
    if (p.junction) {
      const j = String(p.junction);
      if (doc.items[j]?.type !== 'junction') fail('not_found', `No junction "${j}"`);
      let r: unknown = null;
      editItems(ctx, [j], (d) => void (r = unsolderJunction(d as CircuitDoc, j)));
      return r ?? { through: 0, detached: 0 };
    }
    const comp = resolveId(doc, String(need(p.comp, 'comp or junction')));
    const c = doc.items[comp];
    if (c.type !== 'component') fail('bad_params', 'comp must be a part');
    const port = findPort(doc, c as ComponentItem, p.port);
    let r: unknown = null;
    editItems(ctx, [comp], (d) => void (r = unsolderPort(d as CircuitDoc, comp, port)));
    return r ?? { through: 0, detached: 0 };
  },
  'wires.label': (p, ctx) => {
    const id = resolveId(ctx.tx.doc, String(need(p.id, 'id')));
    if (ctx.tx.doc.items[id].type !== 'wire') fail('bad_params', `${p.id} is not a wire`);
    editItems(ctx, [id], (d) => {
      const w = d.items[id] as WireItem;
      w.label = String(p.label ?? '');
      if (p.at !== undefined) w.labelAt = Math.max(0, Math.min(1, num(p.at, 'at')));
      if (p.side !== undefined) w.labelSide = p.side;
      if (p.hidden !== undefined) w.labelHidden = !!p.hidden;
    });
    return { id };
  },

  'wires.deletePart': (p, ctx) => {
    const id = resolveId(ctx.tx.doc, String(need(p.id, 'id')));
    if (ctx.tx.doc.items[id].type !== 'wire') fail('bad_params', `${p.id} is not a wire`);
    const kind = p.kind === 'node' ? 'node' : 'segment';
    editItems(ctx, [id], (d) => deleteWirePart(d as CircuitDoc, { wire: id, kind, index: num(p.index, 'index') }));
    return { id, exists: !!ctx.tx.doc.items[id] };
  },

  /* ---------------- shapes ---------------- */
  'shapes.add': (p, ctx) => {
    const page = ctx.tx.resolvePage(p.page);
    let id = '';
    ctx.tx.edit(page, (d) => void (id = addShape(d, p).id));
    ctx.tx.touch([id], page);
    return { id };
  },
  'shapes.presets': (p) => (p.query ? searchPresets(String(p.query)) : SHAPE_PRESETS).map((s) => ({ id: s.id, name: s.name, category: s.category, keywords: s.keywords })),
  'shapes.addPreset': (p, ctx) => {
    const preset = getPreset(String(need(p.preset, 'preset'))) ?? fail('not_found', `No preset "${p.preset}" (shapes.presets lists them)`);
    const page = ctx.tx.resolvePage(p.page);
    let id = '';
    ctx.tx.edit(page, (d) => {
      const s = makePresetShape(d as CircuitDoc, preset, num(p.x, 'x'), num(p.y, 'y'), Number(p.w) || PRESET_SIZE.w, Number(p.h) || PRESET_SIZE.h, S().prefs.theme);
      if (p.text !== undefined) s.text = String(p.text);
      d.items[s.id] = s;
      id = s.id;
    });
    ctx.tx.touch([id], page);
    return { id };
  },
  'shapes.connect': (p, ctx) => {
    const doc = ctx.tx.doc;
    const a = resolveId(doc, String(need(p.from, 'from')));
    const b = resolveId(doc, String(need(p.to, 'to')));
    const page = itemPage(doc, doc.items[a]);
    let id = '';
    ctx.tx.edit(page, (d) => {
      const s = addShape(d, { kind: p.kind === 'line' ? 'line' : 'arrow', from: { id: a }, to: { id: b }, text: p.text, props: { ...(p.route ? { route: p.route } : {}), ...(p.props ?? {}) } });
      id = s.id;
    });
    ctx.tx.touch([id], page);
    return { id };
  },
  'shapes.note': (p, ctx) => {
    const doc = ctx.tx.doc;
    const ids = p.ids ? resolveIds(doc, p.ids) : [];
    const page = ids.length ? itemPage(doc, doc.items[ids[0]]) : ctx.tx.resolvePage(p.page);
    let id = '';
    ctx.tx.edit(page, (d) => {
      const view = current(d) as CircuitDoc;
      const target = ids.length ? view.items[ids[0]] : null;
      const box = target ? itemBounds(view, target) : null;
      const at = box ? rectCentre(box) : pt(p, 'point');
      const s = makeShape(d as CircuitDoc, 'callout', (box ? box.x + box.w : at.x) + 24, (box ? box.y : at.y) - 36, 24, 24);
      s.text = String(need(p.text, 'text'));
      s.step = nextStep(d as CircuitDoc);
      s.anchor = makeAnchor(view, target ?? null, at);
      d.items[s.id] = s;
      id = s.id;
    });
    ctx.tx.touch([id, ...ids], page);
    return { id, anchor: calloutAnchor(ctx.tx.doc, ctx.tx.doc.items[id] as ShapeItem) };
  },

  'shapes.toPath': (p, ctx) => {
    const ids = resolveIds(ctx.tx.doc, p.ids);
    const done: string[] = [];
    editItems(ctx, ids, (d, on) => {
      for (const id of on) {
        const s = d.items[id] as ShapeItem;
        if (s.type !== 'shape' || !canConvertToPath(s)) continue;
        if (convertToPath(s, s.kind === 'line' || s.kind === 'arrow' ? resolveConnector(d as CircuitDoc, s) : undefined)) done.push(id);
      }
    });
    if (!done.length) fail('bad_params', 'Only rectangles, ellipses and unattached lines without arrowheads can become paths');
    return { ids: done };
  },

  /* ---------------- symbols ---------------- */
  'symbols.list': (p, ctx) => {
    const q = p.query ? String(p.query).toLowerCase().split(/\s+/).filter(Boolean) : [];
    const cat = p.category ? String(p.category).toLowerCase() : '';
    const limit = Number(p.limit) || 100;
    const all = librarySymbols(ctx.tx.doc);
    const hits = all.filter((d) => {
      if (cat && d.category.toLowerCase() !== cat) return false;
      const hay = `${d.id} ${d.name} ${d.category} ${d.keywords ?? ''}`.toLowerCase();
      return q.every((w) => hay.includes(w));
    });
    return {
      total: hits.length,
      symbols: hits.slice(0, limit).map((d) => ({
        id: d.id,
        name: d.name,
        category: d.category,
        prefix: d.prefix,
        pins: d.ports.map((pp) => (pp.name && pp.name !== pp.id ? `${pp.id}:${pp.name}` : pp.id)).join(' '),
        size: `${d.w}x${d.h}`,
        ...(d.variants?.length ? { types: d.variants.map((v) => v.id) } : {}),
        ...(d.custom ? { custom: true } : {}),
      })),
    };
  },
  'symbols.categories': (_p, ctx) => {
    const counts = new Map<string, number>();
    for (const d of librarySymbols(ctx.tx.doc)) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
    return [...counts].map(([category, count]) => ({ category, count }));
  },
  'symbols.get': (p, ctx) => {
    const def = getSymbol(ctx.tx.doc, String(need(p.id, 'id')));
    if (def === MISSING_SYMBOL) fail('not_found', `No symbol "${p.id}"`);
    const src = sourceOf(def);
    return { ...def, source: undefined, prims: undefined, closedPrims: undefined, dsl: { draw: src.draw, ports: src.ports, fields: src.fields } };
  },
  'symbols.create': (p, ctx) => {
    const name = String(need(p.name, 'name'));
    const id = p.id ? String(p.id) : `user-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'symbol'}-${uid('').slice(-5)}`;
    const src: SymbolSource = {
      id,
      name,
      category: p.category ? String(p.category) : 'My symbols',
      w: num(p.w, 'w'),
      h: num(p.h, 'h'),
      draw: String(need(p.draw, 'draw')),
      ports: String(p.ports ?? ''),
      prefix: p.prefix ? String(p.prefix) : 'U',
      value: p.value ? String(p.value) : '',
      fields: p.fields ? String(p.fields) : '',
      keywords: p.keywords ? String(p.keywords) : '',
      ...(p.hideLabels ? { hideLabels: true } : {}),
    };
    let def;
    try {
      def = compileSource(src);
    } catch (e) {
      return fail('bad_params', `Symbol DSL: ${(e as Error).message}`);
    }
    ctx.tx.edit(null, (d) => void (d.symbols[id] = def), { allPages: true });
    if (p.saveToLibrary !== false) saveUserSymbol(def);
    return { id, pins: def.ports.map((pp) => ({ id: pp.id, name: pp.name, x: pp.x, y: pp.y, side: pp.side })) };
  },
  'symbols.fromSvg': (p, ctx) => {
    let drawn;
    try {
      drawn = svgToPrims(String(need(p.svg, 'svg')), Number(p.size) || 80);
    } catch (e) {
      return fail('bad_params', `SVG: ${(e as Error).message}`);
    }
    if (p.ports) parsePorts(String(p.ports), drawn.w, drawn.h);
    return METHODS['symbols.create']({ name: p.name, w: drawn.w, h: drawn.h, draw: primsToDsl(drawn.prims), ports: p.ports ?? '', prefix: p.prefix, saveToLibrary: p.saveToLibrary }, ctx);
  },
  'symbols.fromItems': (p, ctx) => {
    const doc = ctx.tx.doc;
    const ids = resolveIds(doc, p.ids);
    const page = itemPage(doc, doc.items[ids[0]]);
    const drawing = selectionToDrawing(viewDoc(doc, page), ids) ?? fail('bad_params', 'Nothing visible to draw');
    const made = METHODS['symbols.create']({ name: p.name, w: drawing.w, h: drawing.h, draw: primsToDsl(drawing.prims), ports: p.ports ?? '', prefix: p.prefix, saveToLibrary: p.saveToLibrary }, ctx) as { id: string };
    if (p.replace === false) return made;
    let comp = '';
    ctx.tx.edit(page, (d) => void (comp = replaceWithInstance(d as CircuitDoc, ids, (d as CircuitDoc).symbols[made.id], drawing.origin)));
    ctx.tx.touch([comp], page);
    return { ...made, instance: comp };
  },
  'symbols.delete': (p) => {
    const id = String(need(p.id, 'id'));
    if (!S().userLibrary[id]) fail('not_found', `"${id}" is not in the user's library`);
    deleteUserSymbol(id);
    return { deleted: id };
  },

  'symbols.importLibrary': (p) => {
    const lib = objectOf(p.library, 'library');
    if (lib.format !== 'nodal-library' || !lib.symbols) fail('bad_params', 'Not a Nodal library file');
    return { added: importLibraryText(JSON.stringify(lib), { overwrite: !!p.overwrite }) };
  },
  'symbols.exportLibrary': () => buildLibraryFile(),

  /* ---------------- analysis ---------------- */
  'nets.list': (p, ctx) => {
    const doc = ctx.tx.doc;
    const page = p.page ? ctx.tx.resolvePage(p.page) : null;
    return computeNets(doc)
      .filter((n) => !page || netPages(doc, n).includes(page))
      .map((n) => ({ name: n.name, names: n.names, wires: n.wires, pins: n.pins.map((q) => `${q.ref}.${q.portName || q.port}`) }));
  },
  'nets.of': (p, ctx) => {
    const doc = ctx.tx.doc;
    const nets = computeNets(doc);
    let net: Net | undefined;
    if (p.wire) net = nets.find((n) => n.wires.includes(resolveId(doc, String(p.wire))));
    else {
      const comp = resolveId(doc, String(need(p.comp, 'comp or wire')));
      const c = doc.items[comp];
      if (c.type !== 'component') fail('bad_params', 'comp must be a part');
      const port = findPort(doc, c as ComponentItem, p.port);
      net = nets.find((n) => n.pins.some((q) => q.comp === comp && q.port === port));
    }
    return net ? { name: net.name, names: net.names, wires: net.wires, pins: net.pins.map((q) => `${q.ref}.${q.portName || q.port}`) } : null;
  },
  'check.run': (p, ctx) => {
    const doc = ctx.tx.doc;
    const page = p.page ? ctx.tx.resolvePage(p.page) : null;
    const onPage = (ids: string[]) => !page || !ids.length || ids.some((id) => doc.items[id] && itemPage(doc, doc.items[id]) === page);
    const { active, ignored } = splitIgnored(runErc(doc), doc.settings.ercIgnored);
    const shape = (i: (typeof active)[number]) => ({ key: i.key, rule: i.rule, severity: i.severity, message: i.message, items: i.items, at: i.at });
    const act = active.filter((i) => onPage(i.items));
    return { errors: act.filter((i) => i.severity === 'error').length, warnings: act.filter((i) => i.severity === 'warning').length, issues: act.map(shape), ignored: ignored.filter((i) => onPage(i.items)).map(shape) };
  },
  'check.ignore': (p, ctx) => {
    const keys = list(p.keys, 'keys');
    const on = p.ignored !== false;
    ctx.tx.edit(
      null,
      (d) => {
        const cur = new Set(d.settings.ercIgnored ?? []);
        keys.forEach((k) => (on ? cur.add(k) : cur.delete(k)));
        d.settings.ercIgnored = [...cur];
      },
      { allPages: true },
    );
    return { ignored: ctx.tx.doc.settings.ercIgnored };
  },

  /* ---------------- history ---------------- */
  'history.undo': (p) => {
    const step = agentPast[agentPast.length - 1] ?? fail('nothing', 'Nothing of yours to undo');
    const clash = conflicts(sharedDoc(), step.after);
    if (clash.length && !p.force) fail('conflict', `Changed since by someone else: ${clash.slice(0, 10).join(', ')} (pass force to undo anyway)`);
    agentPast.pop();
    commitDiff(step.before);
    agentFuture.push(step);
    noteOwned(step.before);
    setAgent({ steps: agentPast.length, redoable: agentFuture.length });
    logAgent({ kind: 'call', method: 'history.undo', text: `Undid: ${step.label}` });
    return { undone: step.label };
  },
  'history.redo': () => {
    const step = agentFuture[agentFuture.length - 1] ?? fail('nothing', 'Nothing to redo');
    const clash = conflicts(sharedDoc(), step.before);
    if (clash.length) fail('conflict', `Changed since by someone else: ${clash.slice(0, 10).join(', ')}`);
    agentFuture.pop();
    commitDiff(step.after);
    agentPast.push(step);
    noteOwned(step.after);
    setAgent({ steps: agentPast.length, redoable: agentFuture.length });
    logAgent({ kind: 'call', method: 'history.redo', text: `Redid: ${step.label}` });
    return { redone: step.label };
  },
  'history.steps': () => agentPast.map((s) => ({ label: s.label, items: Object.keys(s.after.items).length })),
  'versions.save': async (p) => {
    const v = await saveVersion(sharedDoc(), p.label ? String(p.label) : `Saved by ${A().name}`, false);
    if (!v) fail('unavailable', 'This circuit can’t keep versions (no id, or a guest in a live session)');
    return { id: v!.id, label: v!.label, t: v!.t };
  },
  'versions.list': async () => {
    const doc = sharedDoc();
    if (!doc.id) return [];
    return (await listVersions(doc.id)).map((v) => ({ id: v.id, label: v.label, t: v.t, auto: v.auto, items: Object.keys(v.doc.items).length }));
  },
  'versions.restore': async (p, ctx) => {
    const doc = sharedDoc();
    const v = doc.id ? (await listVersions(doc.id)).find((x) => x.id === p.id) : undefined;
    if (!v) fail('not_found', `No version "${p.id}" of this circuit`);
    await keepVersion(`Before ${A().name} restored “${v!.label || 'autosave'}”`);
    ctx.tx.edit(
      null,
      (d) => {
        const restored = normalizePages({ ...v!.doc, items: migrateItems(structuredClone(v!.doc.items)) });
        d.name = v!.doc.name;
        d.settings = { ...v!.doc.settings, background: safeColour(v!.doc.settings.background) };
        d.items = restored.items;
        d.groups = v!.doc.groups;
        d.symbols = v!.doc.symbols;
        d.pages = restored.pages;
      },
      { allPages: true },
    );
    return { restored: v!.id };
  },

  /* ---------------- symbol editor (UI) ---------------- */
  'symbolEditor.open': (p) => ({ opened: openSymbolEditor({ editing: p.symbol ? String(p.symbol) : null }) }),
  'symbolEditor.close': () => {
    closeSymbolEditor();
    return { ok: true };
  },

  /* ---------------- batch ---------------- */
  batch: async (p, ctx) => {
    if (ctx.inBatch) fail('bad_params', 'batches can’t be nested');
    if (!Array.isArray(p.calls)) fail('bad_params', 'calls must be a list');
    const results: unknown[] = [];
    for (const [i, c] of (p.calls as P[]).entries()) {
      const method = String(c?.method ?? '');
      if (method === 'batch') fail('bad_params', 'batches can’t be nested');
      const params = refs(c?.params ?? {}, results);
      try {
        results.push(await ctx.call!(method, params));
      } catch (e) {
        const err = e as AgentError;
        throw new AgentError(err.code ?? 'error', `calls[${i}] ${method}: ${err.message}`);
      }
    }
    return { results };
  },
};


/** Fills "$n.path" strings with values from earlier batch results. */
function refs(v: unknown, results: unknown[]): any {
  if (typeof v === 'string') {
    const m = /^\$(\d+)((?:\.[\w-]+)*)$/.exec(v);
    if (!m) return v;
    let out: any = results[Number(m[1])];
    if (out === undefined) fail('bad_params', `${v}: no result #${m[1]} yet`);
    for (const k of m[2].split('.').filter(Boolean)) out = out?.[k];
    if (out === undefined) fail('bad_params', `${v}: nothing at that path`);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => refs(x, results));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, refs(x, results)]));
  return v;
}

/** After an undo / redo: items brought back are the agent's again, items taken away are not. */
function noteOwned(d: { items: Record<string, Item | null> }) {
  const owned = new Set(A().owned);
  for (const [id, it] of Object.entries(d.items)) (it ? owned.add(id) : owned.delete(id));
  setAgent({ owned });
}

/** Methods that never change the circuit (no step recorded). */
export const READ_ONLY = new Set(catalog.methods.filter((m) => !(m as { mutates?: boolean }).mutates).map((m) => m.name));


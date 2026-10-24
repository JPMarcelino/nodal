import { calloutLayout } from './callout';
import { connectorBounds } from './connectors';
import { componentBounds, polylineBounds, unionRects } from './geometry';
import { measureTextShape } from './shapeText';
import { rotatedBounds, shapeBox, shapeRot } from './rotation';
import { normalizePages } from './pages';
import { getSymbol, instanceSymbol } from './registry';
import type { CircuitDoc, ComponentItem, DocSettings, Endpoint, GridStyle, Item, Rect, ShapeItem, ShapeKind, SymbolDef } from './types';
import { wirePolyline } from './wires';

let counter = 0;
export function uid(prefix = 'i'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const GRID_STYLES: GridStyle[] = ['dots', 'lines', 'crosses', 'major'];
export const GRID_STYLE_NAMES: Record<GridStyle, string> = { dots: 'Dots', lines: 'Lines', crosses: 'Crosses', major: 'Major lines' };

export const DEFAULT_SETTINGS: DocSettings = {
  grid: 10,
  showGrid: true,
  snap: true,
  wire: { color: '#000000', width: 2, radius: 0, dash: 'solid' },
  hops: 'arc',
  hopSize: 5,
  junctionSize: 4,
  componentColor: '',
  labelColor: '',
  background: '',
  titleBlock: false,
  author: '',
  revision: 'A',
};

export function createDoc(name = 'Untitled circuit'): CircuitDoc {
  return {
    format: 'nodal',
    version: 1,
    id: uid('d'),
    name,
    settings: structuredClone(DEFAULT_SETTINGS),
    items: {},
    groups: {},
    symbols: {},
  };
}

/** Upgrades older item fields in place (hopOver true/false → hopLayer +1/-1; shape layers → z). */
export function migrateItems(items: Record<string, Item>): Record<string, Item> {
  for (const it of Object.values(items)) {
    const legacy = it as Item & { hopOver?: boolean };
    if (legacy.type === 'wire' && typeof legacy.hopOver === 'boolean') {
      if (legacy.hopLayer === undefined) legacy.hopLayer = legacy.hopOver ? 1 : -1;
      delete legacy.hopOver;
    }
    if (it.type === 'shape' && it.kind === 'polygon') normalizePath(it);
  }
  return migrateShapeLayers(items);
}

const finiteList = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** Polygon outlines from a file or a peer: odd or broken lists are trimmed or dropped, so drawing never trips on them. */
function normalizePath(s: ShapeItem) {
  if (!finiteList(s.poly)) s.poly = [];
  else if (s.poly.length % 2) s.poly = s.poly.slice(0, -1);
  if (s.curve !== undefined && (!finiteList(s.curve) || s.curve.length !== s.poly.length * 2)) delete s.curve;
  if (s.open !== undefined && s.open !== true) delete s.open;
}

/**
 * Older documents drew shapes in two bands ('below' behind the circuit,
 * 'above' over it) with z only ordering shapes within a band. Folds that into
 * the one shared order without changing the picture: below shapes (by their
 * old z), then everything else in its current draw order, then above shapes.
 * Every item's z becomes its rank and `layer` is dropped. Items without a
 * `layer` stay in the middle band, so a legacy fragment pasted into a new
 * document lands behind / in front of the circuit as it used to. Idempotent:
 * once no shape carries `layer`, nothing changes.
 */
export function migrateShapeLayers(items: Record<string, Item>): Record<string, Item> {
  const layerOf = (it: Item) => (it.type === 'shape' ? (it as ShapeItem & { layer?: unknown }).layer : undefined);
  const all = Object.values(items);
  if (!all.some((it) => layerOf(it) !== undefined)) return items;
  const rank = drawOrder({ items } as CircuitDoc);
  all.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const band = (it: Item) => (layerOf(it) === undefined ? 1 : layerOf(it) === 'above' ? 2 : 0);
  [...all.filter((it) => band(it) === 0), ...all.filter((it) => band(it) === 1), ...all.filter((it) => band(it) === 2)].forEach((it, i) => {
    it.z = i;
    delete (it as ShapeItem & { layer?: unknown }).layer;
  });
  return items;
}

/** Makes loaded documents safe to use (fills in settings added in later versions). */
export function normalizeDoc(raw: unknown): CircuitDoc {
  const d = raw as Partial<CircuitDoc>;
  if (!d || typeof d !== 'object' || d.format !== 'nodal' || typeof d.items !== 'object') {
    throw new Error('This file is not a Nodal circuit.');
  }
  const items = migrateItems(d.items ?? {});
  freeDanglingWireEnds(items);
  return normalizePages({
    format: 'nodal',
    version: 1,
    id: typeof d.id === 'string' && d.id ? d.id : uid('d'),
    name: d.name || 'Untitled circuit',
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...d.settings, wire: { ...DEFAULT_SETTINGS.wire, ...d.settings?.wire }, ercIgnored: Array.isArray(d.settings?.ercIgnored) ? d.settings.ercIgnored : undefined },
    items,
    groups: d.groups ?? {},
    symbols: d.symbols ?? {},
    pages: d.pages,
  });
}

/**
 * A shared or older file can name a part that no longer exists as a wire end.
 * Make that end loose at its nearest bend, so the wire still draws and the ERC
 * reports the break instead of treating the missing part as a pin.
 */
function freeDanglingWireEnds(items: Record<string, Item>) {
  for (const it of Object.values(items)) {
    if (it.type !== 'wire') continue;
    for (const end of ['a', 'b'] as const) {
      const ep = it[end];
      if (ep.kind !== 'port') continue;
      const c = items[ep.comp];
      if (c && c.type === 'component') continue;
      const pts = Array.isArray(it.pts) ? it.pts : [];
      const p = (end === 'a' ? pts[0] : pts[pts.length - 1]) ?? { x: 0, y: 0 };
      it[end] = { kind: 'free', x: Number.isFinite(p.x) ? p.x : 0, y: Number.isFinite(p.y) ? p.y : 0 };
    }
  }
}

export function itemBounds(doc: CircuitDoc, it: Item): Rect | null {
  switch (it.type) {
    case 'component':
      return componentBounds(it, instanceSymbol(doc, it));
    case 'junction':
      return { x: it.x - 3, y: it.y - 3, w: 6, h: 6 };
    case 'shape':
      // free text is sized by its content, so the outline always follows the text
      // turned shapes take the bounds of their turned box
      if (shapeRot(it)) return rotatedBounds(shapeBox(it), shapeRot(it));
      if (it.kind === 'text') return { x: it.x, y: it.y, ...measureTextShape(it) };
      if (it.kind === 'callout') return calloutLayout(it).box;
      // lines and arrows: their drawn path, bends and glued ends included
      if (it.kind === 'line' || it.kind === 'arrow') return connectorBounds(doc, it);
      if (it.kind === 'ink') {
        const pad = it.strokeWidth / 2;
        return { x: Math.min(it.x, it.x + it.w) - pad, y: Math.min(it.y, it.y + it.h) - pad, w: Math.abs(it.w) + 2 * pad, h: Math.abs(it.h) + 2 * pad };
      }
      return { x: Math.min(it.x, it.x + it.w), y: Math.min(it.y, it.y + it.h), w: Math.abs(it.w), h: Math.abs(it.h) };
    case 'wire': {
      const pts = wirePolyline(doc, it);
      return pts.length ? polylineBounds(pts) : null;
    }
  }
}

export function docBounds(doc: CircuitDoc, ids?: Iterable<string>): Rect | null {
  const list = ids ? [...ids].map((id) => doc.items[id]).filter(Boolean) : Object.values(doc.items);
  return unionRects(list.filter((i) => !i.hidden).map((i) => itemBounds(doc, i)).filter((r): r is Rect => !!r));
}

export function nextRef(doc: CircuitDoc, prefix: string, taken?: Set<string>): string {
  const used = taken ?? new Set(Object.values(doc.items).flatMap((i) => (i.type === 'component' ? [i.ref] : [])));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function makeComponent(doc: CircuitDoc, symbolId: string, x: number, y: number, rot: ComponentItem['rot'] = 0, flipX = false): ComponentItem {
  const def = getSymbol(doc, symbolId);
  const props: Record<string, string> = {};
  for (const f of def.fields ?? []) props[f.key] = f.default ?? '';
  return {
    id: uid('c'),
    type: 'component',
    symbol: symbolId,
    x,
    y,
    rot,
    flipX,
    ref: nextRef(doc, def.prefix),
    value: def.value ?? '',
    props,
    showRef: !def.hideLabels,
    // values start hidden (net names on labels and rails always show)
    showValue: !!def.valueIsLabel,
  };
}

export const SHAPE_DEFAULTS: Record<ShapeKind, Partial<ShapeItem>> = {
  rect: { stroke: '#7aa2f7', strokeWidth: 2, fill: '#7aa2f7', fillOpacity: 0, dash: 'dashed', radius: 6 },
  zone: { stroke: '#7aa2f7', strokeWidth: 1, fill: '#7aa2f7', fillOpacity: 0.12, dash: 'solid', radius: 8 },
  ellipse: { stroke: '#000000', strokeWidth: 2, fill: '#000000', fillOpacity: 0, dash: 'solid', radius: 0 },
  polygon: { stroke: '#000000', strokeWidth: 2, fill: '#000000', fillOpacity: 0, dash: 'solid', radius: 0 },
  line: { stroke: '#000000', strokeWidth: 2, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, headStart: 'none', headEnd: 'none' },
  arrow: { stroke: '#000000', strokeWidth: 2, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, headStart: 'none', headEnd: 'open' },
  image: { stroke: '#000000', strokeWidth: 0, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0 },
  ink: { stroke: '#000000', strokeWidth: 3, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0 },
  callout: { stroke: '#f03e3e', strokeWidth: 1.5, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, fontSize: 14, text: '' },
  text: { stroke: 'none', strokeWidth: 0, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, fontSize: 16, text: 'Text' },
  // presentation frame: an editor-only outline (never drawn when presenting or exporting)
  frame: { stroke: '#a855f7', strokeWidth: 1.5, fill: 'none', fillOpacity: 0, dash: 'dashed', radius: 0, fontSize: 13, text: '' },
};

/** Colours new zones cycle through, so neighbouring zones stand apart. */
export const ZONE_COLOURS = ['#7aa2f7', '#9ece6a', '#ff9e64', '#bb9af7', '#2ac3de', '#f7768e', '#e0af68', '#3ddc97'];

/** The zone colour used least so far (the first such in the cycle). */
export function nextZoneColour(doc: CircuitDoc): string {
  const used = new Map(ZONE_COLOURS.map((c) => [c, 0]));
  for (const it of Object.values(doc.items)) {
    const c = it.type === 'shape' && it.kind === 'zone' ? it.fill.toLowerCase() : '';
    if (used.has(c)) used.set(c, used.get(c)! + 1);
  }
  const least = Math.min(...used.values());
  return ZONE_COLOURS.find((c) => used.get(c) === least)!;
}

/** Kinds that start behind everything (areas and pictures); the rest start in front. */
export const BACK_KINDS: ReadonlySet<ShapeKind> = new Set(['rect', 'zone', 'ellipse', 'polygon', 'image']);

/**
 * A z that puts an item behind everything currently in the document, except
 * pictures: a new picture goes under it all, while anything else drawn later
 * (areas, highlighter) lands just in front of the topmost picture, so it shows
 * over an image it is drawn on rather than vanishing behind it.
 */
export function backZ(doc: Pick<CircuitDoc, 'items'>, image = false): number {
  const items = Object.values(doc.items);
  const bottom = Math.min(0, ...items.map((i) => i.z ?? 0)) - 1;
  // (a picture with no z is already in front of everything, so out of reach here)
  const pics = items.filter((i) => i.type === 'shape' && i.kind === 'image' && i.z !== undefined);
  if (image || !pics.length) return bottom;
  const top = Math.max(...pics.map((i) => i.z!));
  const above = items.filter((i) => i.z !== undefined && i.z > top).map((i) => i.z!);
  return above.length ? (top + Math.min(...above)) / 2 : top + 1;
}

/**
 * New shape. Area kinds (and highlighter ink, see the explain tools) start at
 * the back of the single stacking order; the rest leave z unset, which puts
 * them in front of everything, newest on top (see drawOrder).
 */
export function makeShape(doc: CircuitDoc, kind: ShapeKind, x: number, y: number, w: number, h: number): ShapeItem {
  const shape = {
    id: uid('s'),
    type: 'shape',
    kind,
    x,
    y,
    w,
    h,
    stroke: '#7aa2f7',
    strokeWidth: 2,
    fill: 'none',
    fillOpacity: 0,
    dash: 'solid',
    radius: 0,
    ...SHAPE_DEFAULTS[kind],
  } as ShapeItem;
  if (BACK_KINDS.has(kind)) shape.z = backZ(doc, kind === 'image');
  if (kind === 'zone') shape.stroke = shape.fill = nextZoneColour(doc);
  return shape;
}

/** Wires attached to an item (component ports or junction). */
export function attachedWires(doc: CircuitDoc, id: string): string[] {
  const out: string[] = [];
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    if (refersTo(it.a, id) || refersTo(it.b, id)) out.push(it.id);
  }
  return out;
}

export function refersTo(ep: Endpoint, id: string) {
  return (ep.kind === 'port' && ep.comp === id) || (ep.kind === 'junction' && ep.id === id);
}

/** Group chain from innermost to outermost. */
export function groupChain(doc: CircuitDoc, groupId: string | undefined): string[] {
  const chain: string[] = [];
  let g = groupId;
  const seen = new Set<string>();
  while (g && doc.groups[g] && !seen.has(g)) {
    seen.add(g);
    chain.push(g);
    g = doc.groups[g].group;
  }
  return chain;
}

/** The outermost group of an item that sits directly inside `scope` (undefined = root). */
export function topGroup(doc: CircuitDoc, it: Item, scope?: string): string | undefined {
  const chain = groupChain(doc, it.group);
  if (scope) {
    const idx = chain.indexOf(scope);
    if (idx < 0) return chain[chain.length - 1];
    return idx > 0 ? chain[idx - 1] : undefined;
  }
  return chain[chain.length - 1];
}

/** Groups sitting directly in `scope` (the root when unset), with their names at the top-left of what they hold. */
export function groupTags(doc: CircuitDoc, scope?: string): { id: string; name: string; x: number; y: number }[] {
  const out: { id: string; name: string; x: number; y: number }[] = [];
  for (const g of Object.values(doc.groups)) {
    if ((g.group ?? undefined) !== (scope ?? undefined) || !g.name) continue;
    const rects = groupMembers(doc, g.id).flatMap((id) => {
      const it = doc.items[id];
      const r = it && !it.hidden ? itemBounds(doc, it) : null;
      return r ? [r] : [];
    });
    if (!rects.length) continue;
    out.push({ id: g.id, name: g.name, x: Math.min(...rects.map((r) => r.x)), y: Math.min(...rects.map((r) => r.y)) });
  }
  return out;
}

/** The group a selection is exactly (all of its members and nothing else), if any. */
export function selectedGroup(doc: CircuitDoc, selection: string[], scope?: string): string | undefined {
  const first = doc.items[selection[0]];
  const gid = first && topGroup(doc, first, scope);
  if (!gid) return undefined;
  const members = groupMembers(doc, gid);
  const sel = new Set(selection);
  return members.length === sel.size && members.every((id) => sel.has(id)) ? gid : undefined;
}

export function groupMembers(doc: CircuitDoc, groupId: string): string[] {
  return Object.values(doc.items)
    .filter((i) => groupChain(doc, i.group).includes(groupId))
    .map((i) => i.id);
}

/**
 * Stacking rank of every item (0 = back, higher = in front): by z; items
 * without one (added since the last reorder) sit in front, newest on top.
 * Ranks are dense and unique, so every view agrees on a single order.
 */
export function drawOrder(doc: CircuitDoc): Map<string, number> {
  const items = Object.values(doc.items);
  const top = Math.max(0, ...items.map((it) => it.z ?? 0)) + 1;
  const all = items.map((it, i) => ({ id: it.id, key: it.z ?? top + i, i }));
  all.sort((a, b) => a.key - b.key || a.i - b.i);
  return new Map(all.map((e, rank) => [e.id, rank]));
}

const orderCache = new WeakMap<CircuitDoc, Map<string, number>>();

export function drawOrderCached(doc: CircuitDoc): Map<string, number> {
  const hit = orderCache.get(doc);
  if (hit) return hit;
  const order = drawOrder(doc);
  orderCache.set(doc, order);
  return order;
}

/** Which of a part's labels are drawn, after the document-wide hide switches. */
export function labelsShown(settings: Pick<DocSettings, 'hideRefs' | 'hideValues'>, c: Pick<ComponentItem, 'showRef' | 'showValue'>, def: Pick<SymbolDef, 'valueIsLabel'>) {
  return { ref: c.showRef && !settings.hideRefs, value: c.showValue && (!settings.hideValues || !!def.valueIsLabel) };
}

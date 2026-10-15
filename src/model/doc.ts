import { calloutLayout } from './callout';
import { componentBounds, polylineBounds, unionRects } from './geometry';
import { measureRich } from './richText';
import { getSymbol, instanceSymbol } from './registry';
import type { CircuitDoc, ComponentItem, DocSettings, Endpoint, Item, Rect, ShapeItem, ShapeKind, SymbolDef } from './types';
import { wirePolyline } from './wires';

let counter = 0;
export function uid(prefix = 'i'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

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

/** Makes loaded documents safe to use (fills in settings added in later versions). */
/** Upgrades older item fields in place (hopOver true/false → hopLayer +1/-1). */
function migrateItems(items: Record<string, Item>): Record<string, Item> {
  for (const it of Object.values(items)) {
    const legacy = it as Item & { hopOver?: boolean };
    if (legacy.type === 'wire' && typeof legacy.hopOver === 'boolean') {
      if (legacy.hopLayer === undefined) legacy.hopLayer = legacy.hopOver ? 1 : -1;
      delete legacy.hopOver;
    }
  }
  return items;
}

export function normalizeDoc(raw: unknown): CircuitDoc {
  const d = raw as Partial<CircuitDoc>;
  if (!d || typeof d !== 'object' || d.format !== 'nodal' || typeof d.items !== 'object') {
    throw new Error('This file is not a Nodal circuit.');
  }
  return {
    format: 'nodal',
    version: 1,
    id: typeof d.id === 'string' && d.id ? d.id : uid('d'),
    name: d.name || 'Untitled circuit',
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...d.settings, wire: { ...DEFAULT_SETTINGS.wire, ...d.settings?.wire }, ercIgnored: Array.isArray(d.settings?.ercIgnored) ? d.settings.ercIgnored : undefined },
    items: migrateItems(d.items ?? {}),
    groups: d.groups ?? {},
    symbols: d.symbols ?? {},
  };
}

export function itemBounds(doc: CircuitDoc, it: Item): Rect | null {
  switch (it.type) {
    case 'component':
      return componentBounds(it, instanceSymbol(doc, it));
    case 'junction':
      return { x: it.x - 3, y: it.y - 3, w: 6, h: 6 };
    case 'shape':
      // free text is sized by its content, so the outline always follows the text
      if (it.kind === 'text') return { x: it.x, y: it.y, ...measureRich(it.text ?? '', it.fontSize ?? 16, it.bold ? 700 : 400) };
      if (it.kind === 'callout') return calloutLayout(it).box;
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
  rect: { stroke: '#7aa2f7', strokeWidth: 2, fill: '#7aa2f7', fillOpacity: 0, dash: 'dashed', radius: 6, layer: 'below' },
  zone: { stroke: '#7aa2f7', strokeWidth: 1, fill: '#7aa2f7', fillOpacity: 0.12, dash: 'solid', radius: 8, layer: 'below' },
  ellipse: { stroke: '#000000', strokeWidth: 2, fill: '#000000', fillOpacity: 0, dash: 'solid', radius: 0, layer: 'below' },
  polygon: { stroke: '#000000', strokeWidth: 2, fill: '#000000', fillOpacity: 0, dash: 'solid', radius: 0, layer: 'below' },
  line: { stroke: '#000000', strokeWidth: 2, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, headStart: 'none', headEnd: 'none', layer: 'above' },
  arrow: { stroke: '#000000', strokeWidth: 2, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, headStart: 'none', headEnd: 'open', layer: 'above' },
  image: { stroke: '#000000', strokeWidth: 0, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, layer: 'below' },
  ink: { stroke: '#000000', strokeWidth: 3, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, layer: 'above' },
  callout: { stroke: '#f03e3e', strokeWidth: 1.5, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, layer: 'above', fontSize: 14, text: '' },
  text: { stroke: 'none', strokeWidth: 0, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, layer: 'above', fontSize: 16, text: 'Text' },
  // presentation frame: an editor-only outline (never drawn when presenting or exporting)
  frame: { stroke: '#a855f7', strokeWidth: 1.5, fill: 'none', fillOpacity: 0, dash: 'dashed', radius: 0, layer: 'above', fontSize: 13, text: '' },
};

export function makeShape(doc: CircuitDoc, kind: ShapeKind, x: number, y: number, w: number, h: number): ShapeItem {
  const z = Math.max(0, ...Object.values(doc.items).map((i) => i.z ?? 0)) + 1;
  return {
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
    layer: 'below',
    z,
    ...SHAPE_DEFAULTS[kind],
  } as ShapeItem;
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

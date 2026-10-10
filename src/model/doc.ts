import { componentBounds, polylineBounds, unionRects } from './geometry';
import { getSymbol } from './registry';
import type { CircuitDoc, ComponentItem, DocSettings, Endpoint, Item, Rect, ShapeItem, ShapeKind } from './types';
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
  wire: { color: '#3ddc97', width: 2, radius: 0, dash: 'solid' },
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
    name,
    settings: structuredClone(DEFAULT_SETTINGS),
    items: {},
    groups: {},
    symbols: {},
  };
}

/** Makes loaded documents safe to use (fills in settings added in later versions). */
export function normalizeDoc(raw: unknown): CircuitDoc {
  const d = raw as Partial<CircuitDoc>;
  if (!d || typeof d !== 'object' || d.format !== 'nodal' || typeof d.items !== 'object') {
    throw new Error('This file is not a Nodal circuit.');
  }
  return {
    format: 'nodal',
    version: 1,
    name: d.name || 'Untitled circuit',
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...d.settings, wire: { ...DEFAULT_SETTINGS.wire, ...d.settings?.wire } },
    items: d.items ?? {},
    groups: d.groups ?? {},
    symbols: d.symbols ?? {},
  };
}

export function itemBounds(doc: CircuitDoc, it: Item): Rect | null {
  switch (it.type) {
    case 'component':
      return componentBounds(it, getSymbol(doc, it.symbol));
    case 'junction':
      return { x: it.x - 3, y: it.y - 3, w: 6, h: 6 };
    case 'shape':
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
    showValue: !def.hideLabels || !!def.valueIsLabel,
  };
}

export const SHAPE_DEFAULTS: Record<ShapeKind, Partial<ShapeItem>> = {
  rect: { stroke: '#7aa2f7', strokeWidth: 2, fill: '#7aa2f7', fillOpacity: 0, dash: 'dashed', radius: 6, layer: 'below' },
  zone: { stroke: '#7aa2f7', strokeWidth: 1, fill: '#7aa2f7', fillOpacity: 0.12, dash: 'solid', radius: 8, layer: 'below' },
  ellipse: { stroke: '#e0af68', strokeWidth: 2, fill: '#e0af68', fillOpacity: 0, dash: 'solid', radius: 0, layer: 'below' },
  line: { stroke: '#a9b1d6', strokeWidth: 2, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, layer: 'above' },
  arrow: { stroke: '#f7768e', strokeWidth: 2, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, layer: 'above' },
  text: { stroke: 'none', strokeWidth: 0, fill: 'none', fillOpacity: 0, dash: 'solid', radius: 0, layer: 'above', fontSize: 16, text: 'Text' },
};

export function makeShape(doc: CircuitDoc, kind: ShapeKind, x: number, y: number, w: number, h: number): ShapeItem {
  const z = Math.max(0, ...Object.values(doc.items).map((i) => (i.type === 'shape' ? i.z : 0))) + 1;
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

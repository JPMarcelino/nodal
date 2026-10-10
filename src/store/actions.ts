import { docBounds, makeComponent, topGroup } from '../model/doc';
import { snap } from '../model/geometry';
import {
  alignItems,
  annotate,
  deleteItems,
  distributeItems,
  extractFragment,
  flipItems,
  groupItems,
  insertFragment,
  rotateItems,
  translateItems,
  ungroupItems,
  type AlignMode,
  type Fragment,
} from '../model/ops';
import { getSymbol } from '../model/registry';
import type { CircuitDoc, Item, ShapeItem, Tool } from '../model/types';
import { S, mutate, pushRecent, select, set, toast } from './store';

const sel = () => new Set(S().selection);
const editable = () => S().selection.filter((id) => S().doc.items[id] && !S().doc.items[id].locked);

/* ------------------------------------------------------------------ */
/* Tools & placement                                                   */
/* ------------------------------------------------------------------ */

export function setTool(tool: Tool) {
  set({ tool, altMove: false, placing: null, contextMenu: null });
}

/** Select tool in alt-move mode: only the selection moves, connections to it are left behind. */
export function setAltMove() {
  set({ tool: 'select', altMove: true, placing: null, contextMenu: null });
}

export function startPlacing(symbol: string) {
  set({ placing: { symbol, rot: 0, flipX: false, repeat: true }, tool: 'select', contextMenu: null });
  pushRecent(symbol);
}

export function placeComponent(symbol: string, x: number, y: number, rot: 0 | 90 | 180 | 270 = 0, flipX = false) {
  const { scope, userLibrary } = S();
  let id = '';
  mutate((d) => {
    // copy user symbols into the document so files are self-contained
    if (userLibrary[symbol] && !d.symbols[symbol]) d.symbols[symbol] = userLibrary[symbol];
    const c = makeComponent(d as CircuitDoc, symbol, x, y, rot, flipX);
    c.group = scope;
    d.items[c.id] = c;
    id = c.id;
  });
  set({ selection: [id] });
  pushRecent(symbol);
  return id;
}

/** Places a symbol at the centre of the visible canvas. */
export function placeAtCenter(symbol: string) {
  const { view, canvasSize, doc } = S();
  const g = doc.settings.grid;
  const x = snap((canvasSize.w / 2 - view.x) / view.zoom, g * 2);
  const y = snap((canvasSize.h / 2 - view.y) / view.zoom, g * 2);
  placeComponent(symbol, x, y);
}

/* ------------------------------------------------------------------ */
/* Edit                                                                */
/* ------------------------------------------------------------------ */

export function deleteSelection() {
  const ids = editable();
  if (!ids.length) return;
  mutate((d) => deleteItems(d as CircuitDoc, ids), []);
}

let clipboard: Fragment | null = null;
let pasteCount = 0;

export function copySelection() {
  if (!S().selection.length) return;
  clipboard = extractFragment(S().doc, sel());
  pasteCount = 0;
  const text = JSON.stringify(clipboard);
  navigator.clipboard?.writeText(text).catch(() => undefined);
  toast(`Copied ${S().selection.length} item${S().selection.length > 1 ? 's' : ''}`);
}

export function cutSelection() {
  copySelection();
  deleteSelection();
}

export async function paste(at?: { x: number; y: number }) {
  let frag = clipboard;
  try {
    const text = await navigator.clipboard?.readText();
    if (text && text.includes('"nodal-fragment"')) frag = JSON.parse(text) as Fragment;
  } catch {
    /* clipboard permission denied: use internal clipboard */
  }
  if (!frag || !frag.items.length) return;
  pasteFragment(frag, at);
}

export function pasteFragment(frag: Fragment, at?: { x: number; y: number }) {
  const g = S().doc.settings.grid;
  let dx: number, dy: number;
  const tmp = { ...S().doc, items: Object.fromEntries(frag.items.map((i) => [i.id, i])) } as CircuitDoc;
  const b = docBounds(tmp);
  if (at && b) {
    dx = snap(at.x - (b.x + b.w / 2), g);
    dy = snap(at.y - (b.y + b.h / 2), g);
  } else {
    pasteCount++;
    dx = dy = g * 2 * pasteCount;
  }
  let ids: string[] = [];
  mutate((d) => {
    ids = insertFragment(d as CircuitDoc, frag, dx, dy, S().scope);
  });
  set({ selection: ids });
}

export function duplicateSelection() {
  if (!S().selection.length) return;
  const frag = extractFragment(S().doc, sel());
  const g = S().doc.settings.grid * 2;
  let ids: string[] = [];
  mutate((d) => {
    ids = insertFragment(d as CircuitDoc, frag, g, g, S().scope);
  });
  set({ selection: ids });
}

export function selectAll() {
  const { doc, scope } = S();
  const ids = Object.values(doc.items)
    .filter((i) => !i.hidden && !i.locked && (!scope || topGroup(doc, i, undefined) !== undefined))
    .map((i) => i.id);
  select(ids);
}

export function nudge(dx: number, dy: number) {
  const ids = new Set(editable());
  if (!ids.size) {
    set((s) => ({ view: { ...s.view, x: s.view.x - dx * 4, y: s.view.y - dy * 4 } }));
    return;
  }
  const base = S().doc;
  mutate((d) => translateItems(base, d as CircuitDoc, ids, dx, dy));
}

/* ------------------------------------------------------------------ */
/* Arrange                                                             */
/* ------------------------------------------------------------------ */

export function rotateSelection(deg: 90 | -90) {
  const p = S().placing;
  if (p) {
    set({ placing: { ...p, rot: ((((p.rot + deg) % 360) + 360) % 360) as 0 | 90 | 180 | 270 } });
    return;
  }
  const ids = new Set(editable());
  if (ids.size) mutate((d) => rotateItems(d as CircuitDoc, ids, deg));
}

export function flipSelection(axis: 'x' | 'y') {
  const p = S().placing;
  if (p) {
    set({
      placing:
        axis === 'x'
          ? { ...p, flipX: !p.flipX }
          : { ...p, flipX: !p.flipX, rot: ((p.rot + 180) % 360) as 0 | 90 | 180 | 270 },
    });
    return;
  }
  const ids = new Set(editable());
  if (ids.size) mutate((d) => flipItems(d as CircuitDoc, ids, axis));
}

export function groupSelection() {
  const ids = S().selection;
  if (ids.length < 2) return toast('Select at least two items to group');
  let gid: string | null = null;
  mutate((d) => {
    gid = groupItems(d as CircuitDoc, ids, S().scope);
  });
  if (gid) toast('Grouped', 'success');
}

export function ungroupSelection() {
  let n = 0;
  mutate((d) => {
    n = ungroupItems(d as CircuitDoc, S().selection, S().scope);
  });
  toast(n ? `Ungrouped ${n} group${n > 1 ? 's' : ''}` : 'Nothing to ungroup');
}

export function enterGroup(itemId: string) {
  const { doc, scope } = S();
  const it = doc.items[itemId];
  if (!it) return;
  const g = topGroup(doc, it, scope);
  if (!g) return;
  set({ scope: g });
  select([itemId]);
}

export function exitGroup() {
  const { doc, scope } = S();
  if (!scope) return false;
  const parent = doc.groups[scope]?.group;
  set({ scope: parent });
  return true;
}

export function align(mode: AlignMode) {
  const ids = editable();
  if (ids.length < 2) return toast('Select at least two items to align');
  mutate((d) => alignItems(d as CircuitDoc, ids, mode));
}

export function distribute(axis: 'x' | 'y') {
  const ids = editable();
  if (ids.length < 3) return toast('Select at least three items to distribute');
  mutate((d) => distributeItems(d as CircuitDoc, ids, axis));
}

function shapeIds() {
  return S().selection.filter((id) => S().doc.items[id]?.type === 'shape');
}

export function reorder(dir: 'forward' | 'backward' | 'front' | 'back') {
  const ids = shapeIds();
  if (!ids.length) return toast('Ordering applies to rectangles, zones, text and lines');
  mutate((d) => {
    const shapes = Object.values(d.items).filter((i): i is ShapeItem => i.type === 'shape').sort((a, b) => a.z - b.z);
    const selSet = new Set(ids);
    let order = shapes.map((s) => s.id);
    if (dir === 'front') order = [...order.filter((id) => !selSet.has(id)), ...order.filter((id) => selSet.has(id))];
    else if (dir === 'back') order = [...order.filter((id) => selSet.has(id)), ...order.filter((id) => !selSet.has(id))];
    else if (dir === 'forward') {
      for (let i = order.length - 2; i >= 0; i--)
        if (selSet.has(order[i]) && !selSet.has(order[i + 1])) [order[i], order[i + 1]] = [order[i + 1], order[i]];
    } else {
      for (let i = 1; i < order.length; i++)
        if (selSet.has(order[i]) && !selSet.has(order[i - 1])) [order[i], order[i - 1]] = [order[i - 1], order[i]];
    }
    order.forEach((id, i) => ((d.items[id] as ShapeItem).z = i + 1));
  });
}

export function toggleLayer() {
  const ids = shapeIds();
  if (!ids.length) return toast('Select a zone or shape to move it above/below wires');
  const first = S().doc.items[ids[0]] as ShapeItem;
  const layer = first.layer === 'below' ? 'above' : 'below';
  mutate((d) => ids.forEach((id) => ((d.items[id] as ShapeItem).layer = layer)));
  toast(layer === 'above' ? 'Shape now drawn above wires' : 'Shape now drawn behind wires');
}

export function toggleLock() {
  const ids = S().selection;
  if (!ids.length) return;
  const lock = !ids.every((id) => S().doc.items[id]?.locked);
  mutate((d) => ids.forEach((id) => d.items[id] && (d.items[id].locked = lock)));
  toast(lock ? 'Locked' : 'Unlocked');
}

export function toggleHidden(ids: string[]) {
  const hide = !ids.every((id) => S().doc.items[id]?.hidden);
  mutate((d) => ids.forEach((id) => d.items[id] && (d.items[id].hidden = hide)));
}

export function rerouteWires() {
  const ids = S().selection.filter((id) => S().doc.items[id]?.type === 'wire');
  if (!ids.length) return toast('Select wires to re-route');
  mutate((d) => ids.forEach((id) => d.items[id].type === 'wire' && ((d.items[id] as Extract<Item, { type: 'wire' }>).pts = [])));
}

export function annotateAll() {
  mutate((d) => annotate(d as CircuitDoc));
  toast('Reference designators renumbered', 'success');
}

export function updateItems(ids: string[], patch: (it: Item) => void) {
  mutate((d) => ids.forEach((id) => d.items[id] && patch(d.items[id] as Item)));
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function zoomBy(factor: number, cx?: number, cy?: number) {
  const { view, canvasSize } = S();
  const px = cx ?? canvasSize.w / 2;
  const py = cy ?? canvasSize.h / 2;
  const zoom = Math.min(8, Math.max(0.1, view.zoom * factor));
  const k = zoom / view.zoom;
  set({ view: { zoom, x: px - (px - view.x) * k, y: py - (py - view.y) * k } });
}

export function zoomTo(zoom: number) {
  zoomBy(zoom / S().view.zoom);
}

export function fitView(ids?: string[]) {
  const { doc, canvasSize } = S();
  const b = docBounds(doc, ids && ids.length ? ids : undefined);
  if (!b) {
    set({ view: { x: canvasSize.w / 2, y: canvasSize.h / 2, zoom: 1 } });
    return;
  }
  const pad = 60;
  const zoom = Math.min(3, Math.max(0.1, Math.min((canvasSize.w - pad * 2) / Math.max(b.w, 1), (canvasSize.h - pad * 2) / Math.max(b.h, 1))));
  set({
    view: {
      zoom,
      x: canvasSize.w / 2 - (b.x + b.w / 2) * zoom,
      y: canvasSize.h / 2 - (b.y + b.h / 2) * zoom,
    },
  });
}

export function symbolOfSelection() {
  const c = S().selection.map((id) => S().doc.items[id]).find((i) => i?.type === 'component');
  return c && c.type === 'component' ? getSymbol(S().doc, c.symbol) : null;
}

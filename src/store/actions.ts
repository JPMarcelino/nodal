import { produce } from 'immer';
import { docBounds, makeComponent, makeShape, topGroup } from '../model/doc';
import { nextPresentationStep } from '../model/presentation';
import { snap, unionRects } from '../model/geometry';
import { sheetRect } from '../model/sheet';
import {
  alignItems,
  annotate,
  deleteItems,
  deleteWirePart,
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
import { deletePolyCorner } from '../model/polygon';
import type { CircuitDoc, Item, Point, Rect, ShapeItem, Tool, WireAngle, WireItem } from '../model/types';
import { PASTE_IMAGE_RE, pasteClipboardContent } from '../io/clipboardPaste';
import { viewCentre } from '../io/importFiles';
import { S, mutate, pushRecent, select, set, setPrefs, toast } from './store';
import { X, isExplainTool, setX } from './explain';

const sel = () => new Set(S().selection);
const editable = () => S().selection.filter((id) => S().doc.items[id] && !S().doc.items[id].locked);

/* ------------------------------------------------------------------ */
/* Tools & placement                                                   */
/* ------------------------------------------------------------------ */

export function setTool(tool: Tool) {
  set({ tool, altMove: false, placing: null, contextMenu: null });
  if (isExplainTool(tool)) setX({ lastTool: tool });
}

/** Explain mode on/off: back to the last explain tool, or back to editing. */
export function toggleExplain() {
  setTool(isExplainTool(S().tool) ? 'select' : X().lastTool);
}

/** Select tool in alt-move mode: only the selection moves, connections to it are left behind. */
export function setAltMove() {
  set({ tool: 'select', altMove: true, placing: null, contextMenu: null });
}

export const WIRE_ANGLES: { value: WireAngle; label: string; title: string }[] = [
  { value: 'ortho', label: '90°', title: 'Orthogonal wires (square elbows)' },
  { value: '45', label: '45°', title: '45° wires: straight runs and diagonals that keep bends on the grid' },
  { value: 'any', label: 'Any', title: 'Free-angle wires: straight lines between grid points' },
];

/** Sets (or cycles to the next) angle new wires are drawn at. */
export function setWireAngle(to?: WireAngle) {
  const i = WIRE_ANGLES.findIndex((a) => a.value === S().prefs.wireAngle);
  const next = to ?? WIRE_ANGLES[(i + 1) % WIRE_ANGLES.length].value;
  setPrefs({ wireAngle: next });
  toast(WIRE_ANGLES.find((a) => a.value === next)!.title);
}

/** Switches the wire tool between drawing plain wires and buses (and picks the wire tool). */
export function setDrawBus(on = !S().prefs.drawBus) {
  setPrefs({ drawBus: on });
  if (S().tool !== 'wire') setTool('wire');
  toast(on ? 'Drawing buses: name one like D[0..7], then tap it with wires named D0, D1…' : 'Drawing plain wires');
}

/** Turns the selected wires into a bus, or back into plain wires when they all are buses already. */
export function toggleBusSelection() {
  const ids = S().selection.filter((id) => S().doc.items[id]?.type === 'wire');
  if (!ids.length) return;
  const on = !ids.every((id) => (S().doc.items[id] as WireItem).bus);
  mutate((d) => {
    for (const id of ids) {
      const w = d.items[id] as WireItem;
      if (on) w.bus = true;
      else delete w.bus;
    }
  });
  toast(on ? `${ids.length > 1 ? `${ids.length} wires are` : 'Wire is'} now a bus` : `${ids.length > 1 ? `${ids.length} buses are` : 'Bus is'} now a plain wire`);
}

export function renameGroup(gid: string, name: string) {
  const v = name.trim();
  if (!v || !S().doc.groups[gid] || S().doc.groups[gid].name === v) return;
  mutate((d) => void (d.groups[gid].name = v));
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
    // a user-defined "type" also brings its base override along, so its type picker works elsewhere
    const placed = userLibrary[symbol];
    if (placed?.variantOf && userLibrary[placed.variantOf] && !d.symbols[placed.variantOf]) {
      d.symbols[placed.variantOf] = userLibrary[placed.variantOf];
    }
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
  // a selected wire node/segment deletes just that part
  const wp = S().wirePart;
  if (wp && S().selection.length === 1 && S().selection[0] === wp.wire && S().doc.items[wp.wire]) {
    // a polygon corner picked in the edit points tool: remove it (a polygon keeps three); elsewhere Del removes the polygon
    if (S().doc.items[wp.wire].type === 'shape') {
      set({ wirePart: null });
      if (S().tool === 'node') {
        if (wp.kind === 'node') mutate((d) => void deletePolyCorner(d.items[wp.wire] as ShapeItem, wp.index));
        return;
      }
    } else {
      mutate((d) => deleteWirePart(d as CircuitDoc, wp));
      set({ wirePart: null });
      return;
    }
  }
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
  let text: string | null = null;
  try {
    text = (await navigator.clipboard?.readText()) ?? null;
  } catch {
    /* clipboard permission denied: fall back below */
  }
  // A Nodal fragment in the text always wins, so skip the permission-gated
  // read() when one is already present.
  let imageBlob: Blob | null = null;
  let svgText: string | null = null;
  if (!(text && text.includes('"nodal-fragment"'))) {
    const cb = navigator.clipboard as unknown as { read?: () => Promise<ClipboardItem[]> } | undefined;
    if (typeof cb?.read === 'function') {
      try {
        for (const item of await cb.read()) {
          const types: readonly string[] = item.types ?? [];
          if (!imageBlob) {
            const raster = types.find((t) => PASTE_IMAGE_RE.test(t));
            if (raster) {
              try {
                imageBlob = await item.getType(raster);
              } catch {
                /* unreadable item: try the rest */
              }
            }
          }
          if (!svgText && types.includes('image/svg+xml')) {
            try {
              svgText = await (await item.getType('image/svg+xml')).text();
            } catch {
              /* unreadable item: try the rest */
            }
          }
          if (imageBlob && svgText) break;
        }
      } catch {
        /* denied or unsupported (Tauri/WebKitGTK/Firefox): fall back below */
      }
    }
  }
  if ((await pasteClipboardContent({ text, imageBlob, svgText }, at)) !== 'none') return;
  const frag = clipboard;
  if (!frag || !frag.items.length) return;
  pasteFragment(frag, at);
}

/** Where Ctrl+V pastes: under the mouse when it is over the canvas, else the middle of the view. */
export const pastePoint = () => (S().pointerOnCanvas ? S().cursor : viewCentre());

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

/** Stages an exact copy of the selection on top of the original (no undo step) and selects it; for placing with the pointer. */
export function copyInPlace(): string[] {
  if (!S().selection.length) return [];
  const frag = extractFragment(S().doc, sel());
  let ids: string[] = [];
  const next = produce(S().doc, (d) => {
    ids = insertFragment(d as CircuitDoc, frag, 0, 0, S().scope);
  });
  set({ doc: next, selection: ids });
  return ids;
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
  const whole = !ids || !ids.length;
  const b = whole ? unionRects([docBounds(doc), sheetRect(doc.settings)].filter((r): r is Rect => !!r)) : docBounds(doc, ids);
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

/** Brings items (or a point) into view at a readable zoom, without zooming in further than needed. */
export function revealItems(ids: string[], at?: Point | null) {
  const { doc, canvasSize, view } = S();
  const b = ids.length ? docBounds(doc, ids) : null;
  const box = b ?? (at ? { x: at.x - 40, y: at.y - 40, w: 80, h: 80 } : null);
  if (!box) return;
  const pad = 80;
  const fit = Math.min((canvasSize.w - pad * 2) / Math.max(box.w, 1), (canvasSize.h - pad * 2) / Math.max(box.h, 1));
  const zoom = Math.min(Math.max(view.zoom, 1), Math.max(0.15, fit), 2.5);
  const c = at && b && box.w * zoom > canvasSize.w - pad * 2 ? at : { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  set({ view: { zoom, x: canvasSize.w / 2 - c.x * zoom, y: canvasSize.h / 2 - c.y * zoom } });
}

export function symbolOfSelection() {
  const c = S().selection.map((id) => S().doc.items[id]).find((i) => i?.type === 'component');
  return c && c.type === 'component' ? getSymbol(S().doc, c.symbol) : null;
}

/* ------------------------------------------------------------------ */
/* Presentation frames                                                 */
/* ------------------------------------------------------------------ */

/** What is on screen right now, slightly inset (a click with the frame tool frames this). */
export function visibleFrameRect(): Rect {
  const { view, canvasSize } = S();
  const inset = 0.06;
  const w = canvasSize.w / view.zoom;
  const h = canvasSize.h / view.zoom;
  return { x: -view.x / view.zoom + w * inset, y: -view.y / view.zoom + h * inset, w: w * (1 - 2 * inset), h: h * (1 - 2 * inset) };
}

/** Adds a presentation frame as the last step; returns its id. */
export function addFrame(r: Rect): string {
  let id = '';
  mutate((d) => {
    const s = makeShape(d as CircuitDoc, 'frame', r.x, r.y, r.w, r.h);
    s.group = S().scope;
    s.step = nextPresentationStep(d as CircuitDoc);
    d.items[s.id] = s;
    id = s.id;
  });
  return id;
}

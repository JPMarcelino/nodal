import { docBounds, groupChain, makeComponent, makeShape, topGroup } from '../model/doc';
import { withContents } from '../model/containers';
import { PRESET_SIZE, getPreset, makePresetShape } from '../model/shapePresets';
import { nextPresentationStep } from '../model/presentation';
import { snap, unionRects } from '../model/geometry';
import { sheetRect } from '../model/sheet';
import { QUICK_DIRS, planQuickAdd, quickAddFields, type QuickDir } from '../model/quickAdd';
import { commitWire } from '../model/wireCommit';
import {
  alignItems,
  annotate,
  deleteItems,
  deleteWirePart,
  distributeItems,
  matchSizes,
  extractFragment,
  flipItems,
  groupItems,
  insertFragment,
  restackItems,
  rotateItems,
  translateItems,
  ungroupItems,
  type AlignMode,
  type SizeMode,
  type Fragment,
  type StackMove,
} from '../model/ops';
import { getSymbol } from '../model/registry';
import { incrementLabels } from '../model/increment';
import { deletePolyCorner } from '../model/polygon';
import { canConvertToPath, convertToPath, hasHeads, pathNodes, setNodeKind, setPathNodes } from '../model/path';
import { resolveConnector } from '../model/connectors';
import type { CircuitDoc, Item, Point, Rect, ShapeItem, Tool, WireAngle } from '../model/types';
import { PASTE_IMAGE_RE, pasteClipboardContent } from '../io/clipboardPaste';
import { fragmentFromText, writePictureClipboard } from '../io/clipboardCopy';
import { viewCentre } from '../io/importFiles';
import { S, activePage, inGesture, mutate, pushRecent, select, set, setPage, setPrefs, toast, vdoc, imageExportOptions } from './store';
import { addPage, docPages, editPage, movePage, pageIndex, pageItemIds, renamePage } from '../model/pages';
import { deletePage, duplicatePage, moveItemsToPage } from '../model/pageOps';
import { confirmDelete } from '../ui/Ask';
import { X, isExplainTool, setX } from './explain';

const sel = () => new Set(S().selection);
const editable = () => S().selection.filter((id) => vdoc().items[id] && !vdoc().items[id].locked);

/* ------------------------------------------------------------------ */
/* Tools & placement                                                   */
/* ------------------------------------------------------------------ */

export function setTool(tool: Tool) {
  set({ tool, altMove: false, placing: null, shapePreset: null, contextMenu: null });
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

export function renameGroup(gid: string, name: string) {
  const v = name.trim();
  if (!v || !vdoc().groups[gid] || vdoc().groups[gid].name === v) return;
  mutate((d) => void (d.groups[gid].name = v));
}

/** Arms a library shape: click for the default size, drag for a box of your own. */
export function armShape(id: string) {
  set({ tool: 'rect', altMove: false, placing: null, shapePreset: id, contextMenu: null });
}

/** Adds a library shape centred on `at`, at `size` (default 80×60). Returns its id. */
export function addPresetShape(id: string, at: Point, size: { w: number; h: number } = PRESET_SIZE): string | null {
  const preset = getPreset(id);
  if (!preset) return null;
  const g = vdoc().settings.grid;
  const side = Math.min(size.w, size.h);
  const box = preset.square ? { w: side, h: side } : size;
  let out = '';
  mutate((d) => {
    const s = makePresetShape(d as CircuitDoc, preset, snap(at.x - box.w / 2, g), snap(at.y - box.h / 2, g), box.w, box.h, S().prefs.theme);
    s.group = S().scope;
    d.items[s.id] = s;
    out = s.id;
  });
  set({ selection: [out] });
  return out;
}

export function startPlacing(symbol: string) {
  set({ placing: { symbol, rot: 0, flipX: false, repeat: true }, tool: 'select', contextMenu: null });
  pushRecent(symbol);
}

/**
 * Whether placing goes on after a part is dropped: with the tool lock on,
 * with Shift held, or in the Cadence scheme (which places copies until Esc).
 * Otherwise one part is placed and the pointer returns to Select.
 */
export function keepsPlacing(shift = false): boolean {
  const p = S().prefs;
  return shift || p.toolLock || p.shortcuts === 'cadence';
}

/** Drops the part being placed at (x, y); placement then ends unless keepsPlacing. Returns the new part's id. */
export function placeArmed(x: number, y: number, shift = false): string | null {
  const pl = S().placing;
  if (!pl) return null;
  const id = placeComponent(pl.symbol, x, y, pl.rot, pl.flipX);
  if (!keepsPlacing(shift)) set({ placing: null });
  return id;
}

/** Tool lock on/off: keep the armed part after each click (drawing tools already stay active). */
export function toggleToolLock() {
  const on = !S().prefs.toolLock;
  setPrefs({ toolLock: on });
  toast(on ? 'Tool lock on: placing goes on after each click (Esc returns to Select)' : 'Tool lock off');
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

/** The one unlocked part selected (outside any group not entered), for quick add. */
function quickAddSource() {
  const s = S();
  if (s.viewOnly || s.placing || X().presenting !== null || s.selection.length !== 1) return null;
  const doc = vdoc();
  const c = doc.items[s.selection[0]];
  if (c?.type !== 'component' || c.locked || topGroup(doc, c, s.scope)) return null;
  return c;
}

/** Whether quick add applies: exactly one unlocked part is selected and the document can be edited. */
export const canQuickAdd = () => !!quickAddSource();

/**
 * Quick add: places a copy of the selected part one short wire away in a
 * direction, wired pin to pin (turned so a pin faces back), and selects it,
 * so pressing again builds a chain. One undo step for the part and its wire.
 */
export function quickAdd(dir: QuickDir) {
  const src = quickAddSource();
  if (!src) return;
  const doc = vdoc();
  const grid = doc.settings.grid;
  const d = QUICK_DIRS[dir];
  const plan = planQuickAdd(doc, src, d, grid);
  if (typeof plan === 'string') return toast(plan);
  const { scope, wireBrush } = S();
  let id = '';
  mutate((dd) => {
    const c = makeComponent(dd as CircuitDoc, src.symbol, plan.x, plan.y, plan.rot, !!src.flipX);
    Object.assign(c, quickAddFields(src, plan.rot));
    c.group = scope;
    dd.items[c.id] = c;
    id = c.id;
    commitWire(dd as CircuitDoc, { kind: 'port', comp: src.id, ...plan.from }, { kind: 'port', comp: c.id, ...plan.to }, {
      hFirst: d.x !== 0,
      group: scope,
      routeGrid: plan.route ? grid : undefined,
      ...(wireBrush ? { style: { ...wireBrush } } : {}),
    });
  });
  if (id && vdoc().items[id]) set({ selection: [id] });
}

/* ------------------------------------------------------------------ */
/* Edit                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------ paths ------------------------------ */

const selectedPolygons = () =>
  editable().filter((id) => {
    const it = vdoc().items[id];
    return it.type === 'shape' && it.kind === 'polygon';
  });

/** Convert to path: boxes, ellipses and loose lines / arrows in the selection become editable outlines that look the same. */
export function convertSelectionToPath() {
  const ids = editable().filter((id) => {
    const it = vdoc().items[id];
    return it.type === 'shape' && canConvertToPath(it);
  });
  if (!ids.length) {
    const headed = editable().some((id) => {
      const it = vdoc().items[id];
      return it.type === 'shape' && hasHeads(it);
    });
    toast(headed ? 'Remove the arrowheads first: a path can’t draw them' : 'Select a rectangle, ellipse or unattached line to convert');
    return;
  }
  mutate((d) => {
    for (const id of ids) {
      const s = d.items[id] as ShapeItem;
      convertToPath(s, s.kind === 'line' || s.kind === 'arrow' ? resolveConnector(d as CircuitDoc, s) : undefined);
    }
  });
}

/** Closes or opens the selected outlines (opening drops the stretch from the last node back to the first). */
export function setPathClosed(closed: boolean) {
  const ids = selectedPolygons();
  if (!ids.length) return;
  mutate((d) => {
    for (const id of ids) {
      const s = d.items[id] as ShapeItem;
      const nodes = pathNodes(s);
      if (closed ? !s.open || nodes.length < 3 : s.open) continue;
      setPathNodes(s, nodes, !closed);
    }
  });
}

/** Corner / smooth for the picked node (edit points tool), or every node of the selected outlines. */
export function setPathNodeKind(kind: 'corner' | 'smooth') {
  const ids = selectedPolygons();
  if (!ids.length) return;
  const wp = S().wirePart;
  const picked = wp && wp.kind === 'node' && ids.length === 1 && wp.wire === ids[0] ? wp.index : null;
  mutate((d) => {
    for (const id of ids) {
      const s = d.items[id] as ShapeItem;
      let nodes = pathNodes(s);
      for (let i = 0; i < nodes.length; i++) if (picked === null || picked === i) nodes = setNodeKind(nodes, s.open, i, kind);
      setPathNodes(s, nodes);
    }
  });
}

export function deleteSelection() {
  // a selected wire node/segment deletes just that part
  const wp = S().wirePart;
  if (wp && S().selection.length === 1 && S().selection[0] === wp.wire && vdoc().items[wp.wire]) {
    // a polygon corner picked in the edit points tool: remove it (a polygon keeps three); elsewhere Del removes the polygon
    if (vdoc().items[wp.wire].type === 'shape') {
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
  clipboard = extractFragment(vdoc(), sel());
  pasteCount = 0;
  // other apps get a picture of the selection; pasting back here restores the items
  const { theme, background } = imageExportOptions();
  void writePictureClipboard(vdoc(), { theme, background, padding: 10, ids: S().selection, scale: 2 }, clipboard);
  toast(`Copied ${S().selection.length} item${S().selection.length > 1 ? 's' : ''}`);
}

export function cutSelection() {
  // cut moves what it can remove: whole items (not just a picked wire part), never locked ones
  const ids = editable();
  if (!ids.length) return toast('Locked items can’t be cut — copy them instead');
  set({ selection: ids, wirePart: null });
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
  if (!fragmentFromText(text)) {
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
  const g = vdoc().settings.grid;
  let dx: number, dy: number;
  const tmp = { ...vdoc(), items: Object.fromEntries(frag.items.map((i) => [i.id, i])) } as CircuitDoc;
  const b = docBounds(tmp);
  if (at && b) {
    dx = snap(at.x - (b.x + b.w / 2), g);
    dy = snap(at.y - (b.y + b.h / 2), g);
  } else {
    pasteCount++;
    dx = dy = g * 2 * pasteCount;
  }
  let ids: string[] = [];
  if (
    !mutate((d) => {
      ids = insertFragment(d as CircuitDoc, frag, dx, dy, S().scope);
    })
  )
    return;
  set({ selection: ids });
}

export function duplicateSelection() {
  if (!S().selection.length) return;
  const frag = extractFragment(vdoc(), sel());
  const g = vdoc().settings.grid * 2;
  let ids: string[] = [];
  if (
    !mutate((d) => {
      ids = insertFragment(d as CircuitDoc, frag, g, g, S().scope);
    })
  )
    return;
  set({ selection: ids });
}

/** Duplicates the selection one row down, bumping trailing numbers (D0 → D1); one undo step. */
export function duplicateIncrementSelection() {
  if (!S().selection.length) return;
  const frag = extractFragment(vdoc(), sel());
  const g = vdoc().settings.grid * 2;
  let ids: string[] = [];
  let bumped = false;
  if (
    !mutate((d) => {
      ids = insertFragment(d as CircuitDoc, frag, 0, g, S().scope);
      bumped = incrementLabels(d, ids);
    })
  )
    return;
  set({ selection: ids });
  if (!bumped) toast('No numbered labels to increment — duplicated as is');
}

/** Stages an exact copy of the selection on top of the original (no undo step) and selects it; for placing with the pointer. */
export function copyInPlace(): string[] {
  if (!S().selection.length) return [];
  const frag = extractFragment(vdoc(), sel());
  let ids: string[] = [];
  const next = editPage(S().doc, S().page, (d) => {
    ids = insertFragment(d as CircuitDoc, frag, 0, 0, S().scope);
  });
  set({ doc: next, selection: ids });
  return ids;
}

export function selectAll() {
  const { scope } = S();
  const doc = vdoc();
  const ids = Object.values(doc.items)
    .filter((i) => !i.hidden && !i.locked && (!scope || groupChain(doc, i.group).includes(scope)))
    .map((i) => i.id);
  select(ids);
}

export function nudge(dx: number, dy: number) {
  const sel = editable();
  if (!sel.length) {
    set((s) => ({ view: { ...s.view, x: s.view.x - dx * 4, y: s.view.y - dy * 4 } }));
    return;
  }
  const base = vdoc();
  const ids = withContents(base, sel);
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
  const { scope } = S();
  const doc = vdoc();
  const it = doc.items[itemId];
  if (!it) return;
  const g = topGroup(doc, it, scope);
  if (!g) return;
  set({ scope: g });
  select([itemId]);
}

export function exitGroup() {
  const { scope } = S();
  const doc = vdoc();
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

/** Make same width / height / size: the selected shapes take the first one's size. */
export function matchSize(mode: SizeMode) {
  const ids = editable();
  const shapes = ids.filter((id) => vdoc().items[id].type === 'shape');
  if (shapes.length < 2) return toast('Select at least two shapes to match sizes');
  mutate((d) => void matchSizes(d as CircuitDoc, ids, mode));
}

export function reorder(dir: StackMove) {
  const ids = S().selection.filter((id) => vdoc().items[id] && vdoc().items[id].type !== 'junction');
  if (!ids.length) return toast('Select something to move it forward or back');
  mutate((d) => void restackItems(d as CircuitDoc, ids, dir));
}

export function toggleLock() {
  const ids = S().selection;
  if (!ids.length) return;
  const lock = !ids.every((id) => vdoc().items[id]?.locked);
  mutate((d) => ids.forEach((id) => d.items[id] && (d.items[id].locked = lock)));
  toast(lock ? 'Locked' : 'Unlocked');
}

export function toggleHidden(ids: string[]) {
  const hide = !ids.every((id) => vdoc().items[id]?.hidden);
  mutate((d) => ids.forEach((id) => d.items[id] && (d.items[id].hidden = hide)));
}

export function rerouteWires() {
  const ids = S().selection.filter((id) => vdoc().items[id]?.type === 'wire');
  if (!ids.length) return toast('Select wires to re-route');
  mutate((d) => ids.forEach((id) => d.items[id].type === 'wire' && ((d.items[id] as Extract<Item, { type: 'wire' }>).pts = [])));
}

export function annotateAll() {
  mutate((d) => annotate(d as CircuitDoc), undefined, { allPages: true });
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
  const { canvasSize } = S();
  const doc = vdoc();
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
  const { canvasSize, view } = S();
  const doc = vdoc();
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
  const c = S().selection.map((id) => vdoc().items[id]).find((i) => i?.type === 'component');
  return c && c.type === 'component' ? getSymbol(vdoc(), c.symbol) : null;
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

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

/** Hooks into the page bar (inline renaming lives there). */
export const pageBar: { rename: ((id: string) => void) | null } = { rename: null };

/** Shows a page; one not seen yet this session is zoomed to fit. Ignored mid-drag (setPage blocks it). */
export function showPage(id: string) {
  if (inGesture()) return;
  if (!setPage(id)) setTimeout(() => fitView(), 0);
}

/** Shows the next (+1) or previous (-1) page. */
export function stepPage(by: 1 | -1) {
  const pages = docPages(S().doc);
  const i = pageIndex(S().doc, S().page) + by;
  if (i >= 0 && i < pages.length) showPage(pages[i].id);
}

/** Adds an empty page at the end and shows it. */
export function newPage() {
  let id = '';
  mutate((d) => void (id = addPage(d as CircuitDoc)), undefined, { allPages: true });
  if (id) showPage(id);
}

export function renamePageTo(id: string, name: string) {
  const v = name.trim();
  if (!v || docPages(S().doc).find((p) => p.id === id)?.name === v) return;
  mutate((d) => renamePage(d as CircuitDoc, id, v), undefined, { allPages: true });
}

export function duplicatePageCmd(id = activePage()) {
  let copy = '';
  mutate((d) => void (copy = duplicatePage(d as CircuitDoc, id)), undefined, { allPages: true });
  if (copy) showPage(copy);
}

/** Deletes a page, asking first when something is on it; the last page can't go. */
export async function deletePageCmd(id = activePage()) {
  const doc = S().doc;
  const pages = docPages(doc);
  if (pages.length < 2) return toast('A circuit needs at least one page');
  const page = pages.find((p) => p.id === id);
  if (!page) return;
  const n = pageItemIds(doc, id).length;
  if (n && !(await confirmDelete(`Delete “${page.name}”?`, `Everything on it (${n} item${n === 1 ? '' : 's'}) is deleted too. Undo brings it back.`))) return;
  const i = pages.indexOf(page);
  if (id === activePage()) showPage(pages[i + 1]?.id ?? pages[i - 1].id);
  mutate((d) => void deletePage(d as CircuitDoc, id), undefined, { allPages: true });
}

/** Moves a page along the tab row: by -1 / +1, or to an index with `to`. */
export function movePageBy(id: string, by: number) {
  const i = pageIndex(S().doc, id);
  if (i < 0) return;
  mutate((d) => movePage(d as CircuitDoc, id, i + by), undefined, { allPages: true });
}

export function movePageTo(id: string, to: number) {
  mutate((d) => movePage(d as CircuitDoc, id, to), undefined, { allPages: true });
}

/** Moves the selection to another page (a new one with `page` null); see moveItemsToPage for what happens to wires. */
export function moveSelectionToPage(page: string | null) {
  const ids = S().selection;
  if (!ids.length) return toast('Select something to move first');
  // the selection may hold ids from another page, so count locks in the full doc
  const locked = ids.filter((id) => S().doc.items[id]?.locked);
  let target = page ?? '';
  let moved: string[] = [];
  const ok = mutate(
    (d) => {
      // an all-locked selection moves nothing: don't leave a blank page behind
      if (!target && !ids.some((id) => d.items[id] && !d.items[id].locked)) return;
      if (!target) target = addPage(d as CircuitDoc);
      moved = moveItemsToPage(d as CircuitDoc, ids, target);
    },
    [],
    { allPages: true },
  );
  if (!ok) return;
  const name = docPages(S().doc).find((p) => p.id === target)?.name ?? 'page';
  if (!moved.length) {
    if (locked.length) toast('Locked items stay on their page');
    return;
  }
  toast(`Moved ${moved.length} item${moved.length === 1 ? '' : 's'} to ${name}${locked.length ? ` (${locked.length} locked stayed)` : ''}`, 'success');
}

import { copyAsSvg, doExport, exportSelection, fileNew, fileOpen, filePrint, fileSave, startAreaExport } from '../io/fileActions';
import { computeNets, netOfWire } from '../model/netlist';
import type { WireItem } from '../model/types';
import * as A from './actions';
import { S, redo, set, setPrefs, toast, undo, mutate } from './store';

export interface Command {
  id: string;
  label: string;
  category: 'File' | 'Edit' | 'Tools' | 'Arrange' | 'View' | 'Wire' | 'Symbols' | 'Help';
  keys: string[];
  run: () => void;
  /** Shown in the palette only when this returns true. */
  when?: () => boolean;
}

const hasSel = () => S().selection.length > 0;
const g = () => S().doc.settings.grid;

export const COMMANDS: Command[] = [
  // File
  { id: 'file.new', label: 'New circuit', category: 'File', keys: ['Mod+Alt+N'], run: fileNew },
  { id: 'file.open', label: 'Open…', category: 'File', keys: ['Mod+O'], run: fileOpen },
  { id: 'file.save', label: 'Save', category: 'File', keys: ['Mod+S'], run: () => fileSave() },
  { id: 'file.saveAs', label: 'Save as…', category: 'File', keys: ['Mod+Shift+S'], run: () => fileSave(true) },
  { id: 'file.export', label: 'Export…', category: 'File', keys: ['Mod+E'], run: () => set({ dialog: 'export' }) },
  { id: 'file.exportSvg', label: 'Export as SVG', category: 'File', keys: [], run: () => doExport('svg') },
  { id: 'file.exportPng', label: 'Export as PNG', category: 'File', keys: ['Mod+Shift+E'], run: () => doExport('png') },
  { id: 'file.exportDxf', label: 'Export as DXF (CAD)', category: 'File', keys: [], run: () => doExport('dxf') },
  { id: 'file.exportSpice', label: 'Export SPICE netlist', category: 'File', keys: [], run: () => doExport('spice') },
  { id: 'file.exportBom', label: 'Export bill of materials (CSV)', category: 'File', keys: [], run: () => doExport('bom') },
  { id: 'file.copySvg', label: 'Copy selection as SVG', category: 'File', keys: ['Mod+Alt+C'], run: copyAsSvg },
  { id: 'file.exportSelection', label: 'Export selection as PNG', category: 'File', keys: ['Mod+Alt+E'], run: () => exportSelection('png') },
  { id: 'file.exportSelectionSvg', label: 'Export selection as SVG', category: 'File', keys: [], run: () => exportSelection('svg') },
  { id: 'file.exportArea', label: 'Export canvas area…', category: 'File', keys: ['Mod+Alt+A'], run: () => startAreaExport('png') },
  { id: 'file.print', label: 'Print…', category: 'File', keys: ['Mod+P'], run: filePrint },

  // Edit
  { id: 'edit.undo', label: 'Undo', category: 'Edit', keys: ['Mod+Z'], run: undo },
  { id: 'edit.redo', label: 'Redo', category: 'Edit', keys: ['Mod+Shift+Z', 'Mod+Y'], run: redo },
  { id: 'edit.cut', label: 'Cut', category: 'Edit', keys: ['Mod+X'], run: A.cutSelection, when: hasSel },
  { id: 'edit.copy', label: 'Copy', category: 'Edit', keys: ['Mod+C'], run: A.copySelection, when: hasSel },
  { id: 'edit.paste', label: 'Paste', category: 'Edit', keys: ['Mod+V'], run: () => void A.paste() },
  { id: 'edit.pasteHere', label: 'Paste at cursor', category: 'Edit', keys: ['Mod+Shift+V'], run: () => void A.paste(S().cursor) },
  { id: 'edit.duplicate', label: 'Duplicate', category: 'Edit', keys: ['Mod+D'], run: A.duplicateSelection, when: hasSel },
  { id: 'edit.delete', label: 'Delete', category: 'Edit', keys: ['Delete', 'Backspace'], run: A.deleteSelection, when: hasSel },
  { id: 'edit.selectAll', label: 'Select all', category: 'Edit', keys: ['Mod+A'], run: A.selectAll },
  { id: 'edit.deselect', label: 'Deselect / cancel', category: 'Edit', keys: ['Escape'], run: () => cancel() },
  { id: 'edit.annotate', label: 'Renumber reference designators', category: 'Edit', keys: ['Mod+Shift+A'], run: A.annotateAll },
  { id: 'edit.lock', label: 'Lock / unlock selection', category: 'Edit', keys: ['Mod+Shift+L'], run: A.toggleLock, when: hasSel },
  { id: 'edit.hide', label: 'Hide / show selection', category: 'Edit', keys: ['Mod+Shift+H'], run: () => A.toggleHidden(S().selection), when: hasSel },
  { id: 'edit.properties', label: 'Edit value of selection', category: 'Edit', keys: ['F2', 'Enter'], run: focusValue },
  { id: 'edit.nudgeLeft', label: 'Nudge left', category: 'Edit', keys: ['ArrowLeft'], run: () => A.nudge(-g(), 0) },
  { id: 'edit.nudgeRight', label: 'Nudge right', category: 'Edit', keys: ['ArrowRight'], run: () => A.nudge(g(), 0) },
  { id: 'edit.nudgeUp', label: 'Nudge up', category: 'Edit', keys: ['ArrowUp'], run: () => A.nudge(0, -g()) },
  { id: 'edit.nudgeDown', label: 'Nudge down', category: 'Edit', keys: ['ArrowDown'], run: () => A.nudge(0, g()) },
  { id: 'edit.nudgeLeftBig', label: 'Nudge left ×5', category: 'Edit', keys: ['Shift+ArrowLeft'], run: () => A.nudge(-g() * 5, 0) },
  { id: 'edit.nudgeRightBig', label: 'Nudge right ×5', category: 'Edit', keys: ['Shift+ArrowRight'], run: () => A.nudge(g() * 5, 0) },
  { id: 'edit.nudgeUpBig', label: 'Nudge up ×5', category: 'Edit', keys: ['Shift+ArrowUp'], run: () => A.nudge(0, -g() * 5) },
  { id: 'edit.nudgeDownBig', label: 'Nudge down ×5', category: 'Edit', keys: ['Shift+ArrowDown'], run: () => A.nudge(0, g() * 5) },
  { id: 'edit.nudgeLeftFine', label: 'Nudge left 1px', category: 'Edit', keys: ['Mod+ArrowLeft'], run: () => A.nudge(-1, 0) },
  { id: 'edit.nudgeRightFine', label: 'Nudge right 1px', category: 'Edit', keys: ['Mod+ArrowRight'], run: () => A.nudge(1, 0) },
  { id: 'edit.nudgeUpFine', label: 'Nudge up 1px', category: 'Edit', keys: ['Mod+ArrowUp'], run: () => A.nudge(0, -1) },
  { id: 'edit.nudgeDownFine', label: 'Nudge down 1px', category: 'Edit', keys: ['Mod+ArrowDown'], run: () => A.nudge(0, 1) },

  // Tools
  { id: 'tool.select', label: 'Select tool', category: 'Tools', keys: ['V'], run: () => A.setTool('select') },
  { id: 'tool.node', label: 'Edit points tool (drag wire bends & ends)', category: 'Tools', keys: ['E'], run: () => A.setTool('node') },
  { id: 'tool.solder', label: 'Solder tool (click crossings / pins to solder, junctions to unsolder)', category: 'Tools', keys: ['S'], run: () => A.setTool('solder') },
  { id: 'tool.wire', label: 'Wire tool', category: 'Tools', keys: ['W'], run: () => A.setTool('wire') },
  { id: 'tool.rect', label: 'Rectangle (outline)', category: 'Tools', keys: ['B'], run: () => A.setTool('rect') },
  { id: 'tool.zone', label: 'Filled zone', category: 'Tools', keys: ['Z'], run: () => A.setTool('zone') },
  { id: 'tool.ellipse', label: 'Ellipse', category: 'Tools', keys: ['O'], run: () => A.setTool('ellipse') },
  { id: 'tool.line', label: 'Line', category: 'Tools', keys: ['L'], run: () => A.setTool('line') },
  { id: 'tool.arrow', label: 'Arrow', category: 'Tools', keys: ['A'], run: () => A.setTool('arrow') },
  { id: 'tool.text', label: 'Text', category: 'Tools', keys: ['T'], run: () => A.setTool('text') },
  { id: 'tool.pan', label: 'Hand (pan) tool', category: 'Tools', keys: ['H'], run: () => A.setTool('pan') },
  { id: 'tool.placeLast', label: 'Place last used symbol', category: 'Tools', keys: ['P'], run: () => S().recent[0] && A.startPlacing(S().recent[0]) },
  { id: 'tool.netLabel', label: 'Place net label', category: 'Tools', keys: ['Shift+L'], run: () => A.startPlacing('net-label') },
  { id: 'tool.ground', label: 'Place ground', category: 'Tools', keys: ['Shift+G'], run: () => A.startPlacing('gnd') },
  { id: 'tool.vcc', label: 'Place supply rail', category: 'Tools', keys: ['Shift+V'], run: () => A.startPlacing('vcc') },
  { id: 'tool.resistor', label: 'Place resistor', category: 'Tools', keys: ['Shift+R'], run: () => A.startPlacing('resistor') },
  { id: 'tool.capacitor', label: 'Place capacitor', category: 'Tools', keys: ['Shift+C'], run: () => A.startPlacing('capacitor') },
  { id: 'tool.junction', label: 'Place no-connect flag', category: 'Tools', keys: ['Shift+X'], run: () => A.startPlacing('no-connect') },

  // Arrange
  { id: 'arrange.rotateCw', label: 'Rotate 90° clockwise', category: 'Arrange', keys: ['R'], run: () => A.rotateSelection(90) },
  { id: 'arrange.rotateCcw', label: 'Rotate 90° counter-clockwise', category: 'Arrange', keys: ['Alt+R'], run: () => A.rotateSelection(-90) },
  { id: 'arrange.flipH', label: 'Flip horizontally', category: 'Arrange', keys: ['X'], run: () => A.flipSelection('x') },
  { id: 'arrange.flipV', label: 'Flip vertically', category: 'Arrange', keys: ['Y'], run: () => A.flipSelection('y') },
  { id: 'arrange.group', label: 'Group', category: 'Arrange', keys: ['Mod+G'], run: A.groupSelection },
  { id: 'arrange.ungroup', label: 'Ungroup', category: 'Arrange', keys: ['Mod+Shift+G'], run: A.ungroupSelection },
  { id: 'arrange.forward', label: 'Bring forward', category: 'Arrange', keys: ['Mod+]'], run: () => A.reorder('forward') },
  { id: 'arrange.backward', label: 'Send backward', category: 'Arrange', keys: ['Mod+['], run: () => A.reorder('backward') },
  { id: 'arrange.front', label: 'Bring to front', category: 'Arrange', keys: ['Mod+Shift+]'], run: () => A.reorder('front') },
  { id: 'arrange.back', label: 'Send to back', category: 'Arrange', keys: ['Mod+Shift+['], run: () => A.reorder('back') },
  { id: 'arrange.layer', label: 'Toggle zone above / behind wires', category: 'Arrange', keys: ['Mod+Alt+L'], run: A.toggleLayer },
  { id: 'arrange.alignLeft', label: 'Align left', category: 'Arrange', keys: ['Alt+ArrowLeft'], run: () => A.align('left') },
  { id: 'arrange.alignRight', label: 'Align right', category: 'Arrange', keys: ['Alt+ArrowRight'], run: () => A.align('right') },
  { id: 'arrange.alignTop', label: 'Align top', category: 'Arrange', keys: ['Alt+ArrowUp'], run: () => A.align('top') },
  { id: 'arrange.alignBottom', label: 'Align bottom', category: 'Arrange', keys: ['Alt+ArrowDown'], run: () => A.align('bottom') },
  { id: 'arrange.alignHCenter', label: 'Align centres horizontally', category: 'Arrange', keys: ['Alt+H'], run: () => A.align('hcenter') },
  { id: 'arrange.alignVCenter', label: 'Align centres vertically', category: 'Arrange', keys: ['Alt+V'], run: () => A.align('vcenter') },
  { id: 'arrange.distH', label: 'Distribute horizontally', category: 'Arrange', keys: ['Alt+Shift+H'], run: () => A.distribute('x') },
  { id: 'arrange.distV', label: 'Distribute vertically', category: 'Arrange', keys: ['Alt+Shift+V'], run: () => A.distribute('y') },
  { id: 'arrange.enterGroup', label: 'Enter group', category: 'Arrange', keys: ['Mod+Enter'], run: () => S().selection[0] && A.enterGroup(S().selection[0]) },

  // Wire
  { id: 'wire.reroute', label: 'Re-route selected wires', category: 'Wire', keys: ['Shift+W'], run: A.rerouteWires },
  { id: 'wire.highlightNet', label: 'Highlight net of selected wire', category: 'Wire', keys: ['N'], run: highlightNet },
  { id: 'wire.hops', label: 'Cycle wire crossing style (arc / gap / none)', category: 'Wire', keys: ['Mod+Shift+J'], run: cycleHops },
  { id: 'wire.hopOver', label: 'Switch which wire hops at crossings', category: 'Wire', keys: ['Mod+Shift+U'], run: flipHopOver },
  { id: 'wire.corners', label: 'Toggle rounded wire corners', category: 'Wire', keys: ['Mod+Shift+K'], run: toggleCorners },

  // View
  { id: 'view.zoomIn', label: 'Zoom in', category: 'View', keys: ['=', 'Mod+=', '+'], run: () => A.zoomBy(1.25) },
  { id: 'view.zoomOut', label: 'Zoom out', category: 'View', keys: ['-', 'Mod+-'], run: () => A.zoomBy(0.8) },
  { id: 'view.fit', label: 'Zoom to fit', category: 'View', keys: ['Shift+1', 'F'], run: () => A.fitView() },
  { id: 'view.fitSel', label: 'Zoom to selection', category: 'View', keys: ['Shift+2'], run: () => A.fitView(S().selection) },
  { id: 'view.100', label: 'Zoom to 100%', category: 'View', keys: ['Mod+0', 'Shift+0'], run: () => A.zoomTo(1) },
  { id: 'view.grid', label: 'Toggle grid', category: 'View', keys: ['G'], run: () => mutateSettings((s) => (s.showGrid = !s.showGrid)) },
  { id: 'view.snap', label: 'Toggle snap to grid', category: 'View', keys: ["Mod+'"], run: () => mutateSettings((s) => (s.snap = !s.snap)) },
  { id: 'view.library', label: 'Toggle library panel', category: 'View', keys: ['Mod+B'], run: () => set((s) => ({ leftPanel: !s.leftPanel })) },
  { id: 'view.inspector', label: 'Toggle properties panel', category: 'View', keys: ['Mod+I'], run: () => set((s) => ({ rightPanel: !s.rightPanel })) },
  { id: 'view.layers', label: 'Show layers panel', category: 'View', keys: ['Mod+Shift+O'], run: () => set({ leftPanel: true, leftTab: 'layers' }) },
  { id: 'view.minimap', label: 'Toggle minimap', category: 'View', keys: ['M'], run: () => setPrefs({ showMinimap: !S().prefs.showMinimap }) },
  { id: 'view.theme', label: 'Toggle light / dark theme', category: 'View', keys: ['Mod+Shift+D'], run: () => setPrefs({ theme: S().prefs.theme === 'dark' ? 'light' : 'dark' }) },
  { id: 'view.focus', label: 'Focus mode (hide panels)', category: 'View', keys: ['Mod+.'], run: focusMode },
  { id: 'view.search', label: 'Search symbol library', category: 'View', keys: ['/'], run: focusSearch },

  // Symbols
  { id: 'symbols.new', label: 'Create new symbol…', category: 'Symbols', keys: ['Mod+Shift+N'], run: () => set({ dialog: 'symbol-editor', editingSymbol: null }) },
  {
    id: 'symbols.edit',
    label: 'Edit symbol of selected component…',
    category: 'Symbols',
    keys: ['Mod+Shift+Y'],
    run: () => {
      const def = A.symbolOfSelection();
      if (!def) return toast('Select a component first');
      set({ dialog: 'symbol-editor', editingSymbol: def.id });
    },
  },

  // Help
  { id: 'help.palette', label: 'Command palette', category: 'Help', keys: ['Mod+K', 'Mod+Shift+P'], run: () => set({ dialog: 'palette' }) },
  { id: 'help.shortcuts', label: 'Keyboard shortcuts', category: 'Help', keys: ['Shift+/', 'F1'], run: () => set({ dialog: 'shortcuts' }) },
  { id: 'help.settings', label: 'Settings', category: 'Help', keys: ['Mod+,'], run: () => set({ dialog: 'settings' }) },
  { id: 'help.about', label: 'About Nodal', category: 'Help', keys: [], run: () => set({ dialog: 'about' }) },
];

export const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.id, c]));

function mutateSettings(fn: (s: import('../model/types').DocSettings) => void) {
  mutate((d) => fn(d.settings));
}

function cycleHops() {
  const order = ['arc', 'gap', 'none'] as const;
  const next = order[(order.indexOf(S().doc.settings.hops) + 1) % 3];
  mutateSettings((s) => (s.hops = next));
  toast(`Wire crossings: ${next === 'arc' ? 'hop arcs' : next === 'gap' ? 'gaps' : 'plain'}`);
}

/** Cycles the selected wires' stacking layer: auto → over (+1) → under (-1) → auto. */
function flipHopOver() {
  const ids = S().selection.filter((id) => S().doc.items[id]?.type === 'wire');
  if (!ids.length) return toast('Select wires to switch their hop side');
  const cur = Math.sign((S().doc.items[ids[0]] as WireItem).hopLayer ?? 0);
  const next = cur === 0 ? 1 : cur > 0 ? -1 : 0;
  mutate((d) =>
    ids.forEach((id) => {
      const w = d.items[id] as WireItem;
      if (next) w.hopLayer = next;
      else delete w.hopLayer;
    }),
  );
  toast(next === 0 ? 'Hop sides back to automatic' : next > 0 ? 'These wires hop over at crossings' : 'These wires stay flat under crossings');
}

function toggleCorners() {
  const r = S().doc.settings.wire.radius > 0 ? 0 : 8;
  mutateSettings((s) => (s.wire.radius = r));
  toast(r ? 'Rounded wire corners' : 'Sharp wire corners');
}

function highlightNet() {
  const { selection, doc, highlight } = S();
  if (highlight) return set({ highlight: null });
  const w = selection.find((id) => doc.items[id]?.type === 'wire');
  if (!w) return toast('Select a wire to highlight its net');
  const net = netOfWire(computeNets(doc), w);
  if (net) {
    set({ highlight: new Set(net.wires) });
    toast(`Net ${net.name}: ${net.pins.length} pins`);
  }
}

let savedPanels: { l: boolean; r: boolean } | null = null;
function focusMode() {
  if (savedPanels) {
    set({ leftPanel: savedPanels.l, rightPanel: savedPanels.r });
    savedPanels = null;
  } else {
    savedPanels = { l: S().leftPanel, r: S().rightPanel };
    set({ leftPanel: false, rightPanel: false });
  }
}

function focusSearch() {
  set({ leftPanel: true, leftTab: 'library' });
  setTimeout(() => (document.getElementById('library-search') as HTMLInputElement | null)?.focus(), 30);
}

function focusValue() {
  if (!S().selection.length) return;
  set({ rightPanel: true });
  setTimeout(() => {
    const el = document.querySelector<HTMLInputElement>('[data-focus="value"]');
    el?.focus();
    el?.select();
  }, 30);
}

/** Escape cascade: cancel placement → close menus → exit group → clear selection → select tool. */
export function cancel() {
  const s = S();
  if (s.contextMenu) return set({ contextMenu: null });
  if (s.placing) return set({ placing: null });
  if (s.highlight) return set({ highlight: null });
  if (s.selection.length) return set({ selection: [] });
  if (A.exitGroup()) return;
  if (s.tool !== 'select') return A.setTool('select');
}

/* ------------------------------------------------------------------ */
/* Key handling                                                        */
/* ------------------------------------------------------------------ */

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Slash: '/',
  Backslash: '\\',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  Space: 'Space',
};

export function eventToCombo(e: KeyboardEvent): string {
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && key !== 'Shift') parts.push('Shift');
  if (!['Control', 'Meta', 'Alt', 'Shift'].includes(key)) parts.push(key);
  return parts.join('+');
}

export function keysFor(id: string): string[] {
  return S().prefs.keymap[id] ?? COMMAND_MAP.get(id)?.keys ?? [];
}

export function findCommand(combo: string): Command | undefined {
  const km = S().prefs.keymap;
  for (const c of COMMANDS) {
    const keys = km[c.id] ?? c.keys;
    if (keys.includes(combo)) return c;
  }
  return undefined;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

export function prettyKey(combo: string): string {
  return combo
    .split('+')
    .map((p) =>
      p === 'Mod'
        ? IS_MAC
          ? '⌘'
          : 'Ctrl'
        : p === 'Alt'
          ? IS_MAC
            ? '⌥'
            : 'Alt'
          : p === 'Shift'
            ? '⇧'
            : p === 'ArrowLeft'
              ? '←'
              : p === 'ArrowRight'
                ? '→'
                : p === 'ArrowUp'
                  ? '↑'
                  : p === 'ArrowDown'
                    ? '↓'
                    : p === 'Escape'
                      ? 'Esc'
                      : p === 'Delete'
                        ? 'Del'
                        : p === 'Backspace'
                          ? '⌫'
                          : p === 'Enter'
                            ? '↵'
                            : p === '/'
                              ? '/'
                              : p,
    )
    .join(IS_MAC ? '' : '+')
    .replace('⇧+/', '?');
}

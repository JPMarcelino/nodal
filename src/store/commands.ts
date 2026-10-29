import { copyAsPng, copyAsSvg, exportSelection, fileNew, fileOpen, filePrint, fileSave, openExport, startAreaExport } from '../io/fileActions';
import { importFile } from '../io/importFiles';
import { exportLibraryFile, exportTemplateFile } from '../io/sharing';
import { selectionToDrawing } from '../model/fromSelection';
import { GRID_STYLES, GRID_STYLE_NAMES, selectedGroup } from '../model/doc';
import { computeNets, netOfWire } from '../model/netlist';
import * as A from './actions';
import { clearExplainOverlays } from './explain';
import { startPresenting } from '../ui/Presenter';
import { renumberCallouts } from '../ui/ExplainDock';
import { toggleTimeline } from '../ui/Timeline';
import { S, activePage, readOnly, viewModeKey, redo, set, setPrefs, setTheme, nextTheme, toast, undo, mutate, vdoc } from './store';
import { docPages, pageIndex } from '../model/pages';
import { canvasActions } from './canvasActions';
import { copyStyle, pasteStyle } from '../ui/StyleSection';

export interface Command {
  id: string;
  label: string;
  category: 'File' | 'Edit' | 'Tools' | 'Arrange' | 'Page' | 'View' | 'Wire' | 'Symbols' | 'Help';
  keys: string[];
  /** Keys in the Cadence (Virtuoso schematic) scheme; when absent the Nodal keys apply minus any Cadence uses. */
  cadence?: string[];
  run: () => void;
  /** Shown in the palette only when this returns true (menus show it greyed out). */
  when?: () => boolean;
  /** For on/off commands: whether it is currently on (menus show a tick). */
  checked?: () => boolean;
  /** Extra words the command palette finds it by. */
  keywords?: string;
}

const hasSel = () => S().selection.length > 0;
const g = () => vdoc().settings.grid;

export const COMMANDS: Command[] = [
  // File
  { id: 'file.new', label: 'New circuit', category: 'File', keys: ['Mod+Alt+N'], run: fileNew },
  { id: 'file.open', label: 'Open…', category: 'File', keys: ['Mod+O'], run: fileOpen },
  { id: 'file.import', label: 'Import…', category: 'File', keys: [], run: importFile, keywords: 'circuit symbol library template svg pdf image png jpg picture' },
  { id: 'file.save', label: 'Save', category: 'File', keys: ['Mod+S'], run: () => fileSave() },
  { id: 'file.saveAs', label: 'Save as…', category: 'File', keys: ['Mod+Shift+S'], run: () => fileSave(true) },
  { id: 'file.saveVersion', label: 'Save version…', category: 'File', keys: ['Mod+Alt+V'], run: () => focusVersionName() },
  { id: 'file.history', label: 'Version history', category: 'File', keys: ['Mod+Alt+H'], run: () => set({ leftPanel: true, leftTab: 'history' }) },
  { id: 'edit.copyStyle', label: 'Copy style', category: 'Edit', keys: ['Mod+Alt+Shift+C'], run: () => copyStyle() },
  { id: 'edit.pasteStyle', label: 'Paste style onto the selection', category: 'Edit', keys: ['Mod+Alt+Shift+V'], run: () => pasteStyle() },
  // every export goes through the Export dialog, which previews it (images, data, templates, libraries, video)
  { id: 'file.export', label: 'Export…', category: 'File', keys: ['Mod+E', 'Mod+Shift+E'], run: () => openExport(), keywords: 'png svg image pdf print dxf cad spice kicad netlist bom csv json template library video area' },
  { id: 'file.copySvg', label: 'Copy selection as SVG', category: 'File', keys: ['Mod+Alt+C'], run: copyAsSvg },
  { id: 'file.copyPng', label: 'Copy selection as image (PNG)', category: 'File', keys: ['Mod+Alt+Shift+P'], run: copyAsPng },
  { id: 'file.exportSelection', label: 'Export selection…', category: 'File', keys: ['Mod+Alt+E'], run: () => exportSelection(), when: hasSel },
  { id: 'file.exportArea', label: 'Export canvas area…', category: 'File', keys: ['Mod+Alt+A'], run: () => startAreaExport('png') },
  { id: 'file.print', label: 'Print…', category: 'File', keys: ['Mod+P'], run: filePrint },
  { id: 'collab.share', label: 'Share & collaborate…', category: 'File', keys: ['Mod+Alt+S'], run: () => set({ dialog: 'share' }) },
  { id: 'collab.exportLib', label: 'Export my symbol library', category: 'File', keys: [], run: exportLibraryFile },
  { id: 'collab.exportTemplate', label: 'Export selection as a template', category: 'File', keys: [], run: () => exportTemplateFile(S().selection), when: hasSel },

  // Edit
  { id: 'edit.undo', label: 'Undo', category: 'Edit', keys: ['Mod+Z'], cadence: ['U', 'Mod+Z'], run: undo },
  { id: 'edit.redo', label: 'Redo', category: 'Edit', keys: ['Mod+Shift+Z', 'Mod+Y'], cadence: ['Shift+U', 'Mod+Shift+Z', 'Mod+Y'], run: redo },
  { id: 'edit.cut', label: 'Cut', category: 'Edit', keys: ['Mod+X'], run: A.cutSelection, when: hasSel },
  { id: 'edit.copy', label: 'Copy', category: 'Edit', keys: ['Mod+C'], run: A.copySelection, when: hasSel },
  { id: 'edit.paste', label: 'Paste (at the mouse pointer)', category: 'Edit', keys: ['Mod+V'], run: () => void A.paste(A.pastePoint()) },
  { id: 'edit.pasteHere', label: 'Paste in place (next to the original)', category: 'Edit', keys: ['Mod+Shift+V'], run: () => void A.paste() },
  { id: 'edit.duplicate', label: 'Duplicate', category: 'Edit', keys: ['Mod+D'], cadence: [], run: A.duplicateSelection, when: hasSel },
  { id: 'edit.duplicateIncrement', label: 'Duplicate and increment', category: 'Edit', keys: ['Mod+Alt+D', 'Insert'], run: A.duplicateIncrementSelection, when: hasSel },
  { id: 'edit.delete', label: 'Delete', category: 'Edit', keys: ['Delete', 'Backspace'], run: A.deleteSelection, when: hasSel },
  { id: 'edit.find', label: 'Find part, net or text…', category: 'Edit', keys: ['Mod+F', 'F3'], run: () => set({ dialog: 'find' }) },
  { id: 'edit.selectAll', label: 'Select all', category: 'Edit', keys: ['Mod+A'], run: A.selectAll },
  { id: 'edit.deselect', label: 'Deselect / cancel', category: 'Edit', keys: ['Escape'], cadence: ['Escape', 'Mod+D'], run: () => cancel() },
  { id: 'edit.annotate', label: 'Renumber part names', category: 'Edit', keys: ['Mod+Shift+A'], run: A.annotateAll },
  { id: 'edit.lock', label: 'Lock / unlock selection', category: 'Edit', keys: ['Mod+Shift+L'], run: A.toggleLock, when: hasSel },
  { id: 'edit.hide', label: 'Hide / show selection', category: 'Edit', keys: ['Mod+Shift+H'], run: () => A.toggleHidden(S().selection), when: hasSel },
  { id: 'edit.properties', label: 'Edit value of selection', category: 'Edit', keys: ['F2', 'Enter'], cadence: ['Q', 'F2', 'Enter'], run: focusValue },
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
  { id: 'edit.quickAddRight', label: 'Quick add: wire a copy of the part to the right', category: 'Edit', keys: ['Mod+Shift+ArrowRight'], run: () => A.quickAdd('right'), when: () => A.canQuickAdd(), keywords: 'chain connect series next' },
  { id: 'edit.quickAddLeft', label: 'Quick add: wire a copy of the part to the left', category: 'Edit', keys: ['Mod+Shift+ArrowLeft'], run: () => A.quickAdd('left'), when: () => A.canQuickAdd(), keywords: 'chain connect series next' },
  { id: 'edit.quickAddUp', label: 'Quick add: wire a copy of the part above', category: 'Edit', keys: ['Mod+Shift+ArrowUp'], run: () => A.quickAdd('up'), when: () => A.canQuickAdd(), keywords: 'chain connect series next' },
  { id: 'edit.quickAddDown', label: 'Quick add: wire a copy of the part below', category: 'Edit', keys: ['Mod+Shift+ArrowDown'], run: () => A.quickAdd('down'), when: () => A.canQuickAdd(), keywords: 'chain connect series next' },

  { id: 'edit.move', label: 'Move selection with the pointer (wires stay connected; click to drop)', category: 'Edit', keys: [], cadence: ['M', 'S'], run: () => canvasActions.floatMove?.({ detach: false, copy: false }) },
  { id: 'edit.moveDetached', label: 'Move selection with the pointer, leaving its wires behind', category: 'Edit', keys: [], cadence: ['Shift+M'], run: () => canvasActions.floatMove?.({ detach: true, copy: false }) },
  { id: 'edit.copyMove', label: 'Copy selection and place it with the pointer', category: 'Edit', keys: [], cadence: ['C'], run: () => canvasActions.floatMove?.({ detach: true, copy: true }) },

  // Tools
  { id: 'tool.select', label: 'Move / select tool (wires stay connected)', category: 'Tools', keys: ['M'], run: () => A.setTool('select') },
  { id: 'tool.altMove', label: 'Alt move (only the selection moves; wires to it are left behind)', category: 'Tools', keys: ['Shift+M'], run: () => A.setAltMove() },
  { id: 'tool.node', label: 'Edit points tool (drag wire bends & ends, shape nodes & handles)', category: 'Tools', keys: ['E'], run: () => A.setTool('node') },
  { id: 'tool.solder', label: 'Solder tool (click crossings / pins to solder, junctions to unsolder)', category: 'Tools', keys: ['S'], run: () => A.setTool('solder') },
  { id: 'tool.wire', label: 'Wire tool (again: cycle 90° / 45° / any)', category: 'Tools', keys: ['W'], cadence: ['W', 'Shift+W'], run: () => (S().tool === 'wire' ? A.setWireAngle() : A.setTool('wire')) },
  { id: 'tool.rect', label: 'Rectangle (outline)', category: 'Tools', keys: ['B'], run: () => A.setTool('rect') },
  { id: 'tool.zone', label: 'Filled zone', category: 'Tools', keys: ['Z'], run: () => A.setTool('zone') },
  { id: 'tool.ellipse', label: 'Ellipse', category: 'Tools', keys: ['O'], run: () => A.setTool('ellipse') },
  { id: 'tool.polygon', label: 'Polygon (click the corners; click the first one again to close)', category: 'Tools', keys: ['V'], run: () => A.setTool('polygon') },
  { id: 'tool.path', label: 'Path (click for corners, drag for curves; click the first node to close)', category: 'Tools', keys: ['J'], run: () => A.setTool('path') },
  { id: 'tool.line', label: 'Line', category: 'Tools', keys: ['L'], run: () => A.setTool('line') },
  { id: 'tool.arrow', label: 'Arrow', category: 'Tools', keys: ['A'], run: () => A.setTool('arrow') },
  { id: 'tool.text', label: 'Text', category: 'Tools', keys: ['T'], cadence: ['N', 'T'], run: () => A.setTool('text') },
  { id: 'tool.pan', label: 'Hand (pan) tool', category: 'Tools', keys: ['H'], run: () => A.setTool('pan') },
  { id: 'tool.lock', label: 'Tool lock (keep placing parts after each click)', category: 'Tools', keys: ['Shift+Q'], run: () => A.toggleToolLock(), checked: () => S().prefs.toolLock, keywords: 'keep repeat sticky padlock stay' },
  // Explain: talk a circuit through
  { id: 'explain.toggle', label: 'Explain tools', category: 'Tools', keys: [], run: A.toggleExplain },
  { id: 'tool.pen', label: 'Pen', category: 'Tools', keys: ['D'], run: () => A.setTool('pen') },
  { id: 'tool.highlighter', label: 'Highlighter', category: 'Tools', keys: ['I'], run: () => A.setTool('highlighter') },
  { id: 'tool.laser', label: 'Laser pointer', category: 'Tools', keys: ['K'], run: () => A.setTool('laser') },
  { id: 'tool.eraser', label: 'Eraser (ink and callouts)', category: 'Tools', keys: ['U'], run: () => A.setTool('eraser') },
  { id: 'tool.trace', label: 'Trace net', category: 'Tools', keys: ['Q'], run: () => A.setTool('trace') },
  { id: 'tool.callout', label: 'Numbered callout', category: 'Tools', keys: ['C'], run: () => A.setTool('callout') },
  { id: 'explain.present', label: 'Present (frames and callouts)', category: 'View', keys: ['F5', 'Shift+P'], run: () => startPresenting() },
  { id: 'tool.frame', label: 'Presentation frame (drag an area; click frames the view)', category: 'Tools', keys: ['Shift+F'], run: () => A.setTool('frame') },
  { id: 'present.timeline', label: 'Presentation timeline', category: 'View', keys: ['Alt+T'], run: () => toggleTimeline() },
  { id: 'present.video', label: 'Export presentation video…', category: 'File', keys: [], run: () => set({ dialog: 'video' }) },
  { id: 'explain.clear', label: 'Clear traced nets', category: 'View', keys: [], run: () => void clearExplainOverlays() },
  { id: 'explain.renumber', label: 'Renumber steps (callouts and frames) 1, 2, 3…', category: 'Edit', keys: [], run: () => renumberCallouts() },
  { id: 'tool.placeLast', label: 'Place last used symbol', category: 'Tools', keys: ['P'], cadence: ['Shift+I'], run: () => S().recent[0] && A.startPlacing(S().recent[0]) },
  { id: 'tool.netLabel', label: 'Place net label (wire name)', category: 'Tools', keys: ['Shift+L'], cadence: ['L'], run: () => A.startPlacing('net-label') },
  { id: 'tool.pin', label: 'Place pin (port)', category: 'Tools', keys: [], cadence: ['P'], run: () => A.startPlacing('port-in') },
  { id: 'tool.ground', label: 'Place ground', category: 'Tools', keys: ['Shift+G'], run: () => A.startPlacing('gnd') },
  { id: 'tool.vcc', label: 'Place supply rail', category: 'Tools', keys: ['Shift+V'], run: () => A.startPlacing('vcc') },
  { id: 'tool.resistor', label: 'Place resistor', category: 'Tools', keys: ['Shift+R'], run: () => A.startPlacing('resistor') },
  { id: 'tool.capacitor', label: 'Place capacitor', category: 'Tools', keys: ['Shift+C'], run: () => A.startPlacing('capacitor') },
  { id: 'tool.junction', label: 'Place no-connect flag', category: 'Tools', keys: ['Shift+X'], run: () => A.startPlacing('no-connect') },

  // Arrange
  { id: 'arrange.rotateCw', label: 'Rotate 90° clockwise', category: 'Arrange', keys: ['R'], run: () => A.rotateSelection(90) },
  { id: 'arrange.rotateCcw', label: 'Rotate 90° counter-clockwise', category: 'Arrange', keys: ['Alt+R'], run: () => A.rotateSelection(-90) },
  { id: 'arrange.flipH', label: 'Flip horizontally', category: 'Arrange', keys: ['X'], cadence: ['Shift+R'], run: () => A.flipSelection('x') },
  { id: 'arrange.flipV', label: 'Flip vertically', category: 'Arrange', keys: ['Y'], run: () => A.flipSelection('y') },
  { id: 'arrange.group', label: 'Group', category: 'Arrange', keys: ['Mod+G'], run: A.groupSelection },
  { id: 'arrange.renameGroup', label: 'Rename group', category: 'Arrange', keys: [], run: renameGroupCmd, when: () => !!(selectedGroup(vdoc(), S().selection, S().scope) ?? S().scope) },
  { id: 'arrange.ungroup', label: 'Ungroup', category: 'Arrange', keys: ['Mod+Shift+G'], run: A.ungroupSelection },
  { id: 'arrange.forward', label: 'Bring forward', category: 'Arrange', keys: ['Mod+]'], run: () => A.reorder('forward') },
  { id: 'arrange.backward', label: 'Send backward', category: 'Arrange', keys: ['Mod+['], run: () => A.reorder('backward') },
  { id: 'arrange.front', label: 'Bring to front', category: 'Arrange', keys: ['Mod+Shift+]'], run: () => A.reorder('front') },
  { id: 'arrange.back', label: 'Send to back', category: 'Arrange', keys: ['Mod+Shift+['], run: () => A.reorder('back') },
  { id: 'arrange.alignLeft', label: 'Align left', category: 'Arrange', keys: ['Alt+ArrowLeft'], run: () => A.align('left') },
  { id: 'arrange.alignRight', label: 'Align right', category: 'Arrange', keys: ['Alt+ArrowRight'], run: () => A.align('right') },
  { id: 'arrange.alignTop', label: 'Align top', category: 'Arrange', keys: ['Alt+ArrowUp'], run: () => A.align('top') },
  { id: 'arrange.alignBottom', label: 'Align bottom', category: 'Arrange', keys: ['Alt+ArrowDown'], run: () => A.align('bottom') },
  { id: 'arrange.alignHCenter', label: 'Align centres horizontally', category: 'Arrange', keys: ['Alt+H'], run: () => A.align('hcenter') },
  { id: 'arrange.alignVCenter', label: 'Align centres vertically', category: 'Arrange', keys: ['Alt+V'], run: () => A.align('vcenter') },
  { id: 'arrange.distH', label: 'Distribute horizontally', category: 'Arrange', keys: ['Alt+Shift+H'], run: () => A.distribute('x') },
  { id: 'arrange.distV', label: 'Distribute vertically', category: 'Arrange', keys: ['Alt+Shift+V'], run: () => A.distribute('y') },
  { id: 'arrange.sameWidth', label: 'Make same width', category: 'Arrange', keys: [], run: () => A.matchSize('width') },
  { id: 'arrange.sameHeight', label: 'Make same height', category: 'Arrange', keys: [], run: () => A.matchSize('height') },
  { id: 'arrange.sameSize', label: 'Make same size', category: 'Arrange', keys: [], run: () => A.matchSize('both') },
  { id: 'arrange.toPath', label: 'Convert to path', category: 'Arrange', keys: [], run: A.convertSelectionToPath, when: hasSel },
  { id: 'arrange.enterGroup', label: 'Enter group', category: 'Arrange', keys: ['Mod+Enter'], cadence: ['E', 'Shift+E', 'Mod+Enter'], run: () => S().selection[0] && A.enterGroup(S().selection[0]) },
  { id: 'arrange.exitGroup', label: 'Return from group', category: 'Arrange', keys: [], cadence: ['Shift+B'], run: () => void A.exitGroup() },

  // Page
  { id: 'page.new', label: 'New page', category: 'Page', keys: ['Mod+Alt+Shift+N'], run: A.newPage },
  { id: 'page.next', label: 'Next page', category: 'Page', keys: ['Mod+PageDown', 'Alt+PageDown'], run: () => A.stepPage(1) },
  { id: 'page.prev', label: 'Previous page', category: 'Page', keys: ['Mod+PageUp', 'Alt+PageUp'], run: () => A.stepPage(-1) },
  { id: 'page.rename', label: 'Rename page…', category: 'Page', keys: [], run: () => A.pageBar.rename?.(activePage()) },
  { id: 'page.duplicate', label: 'Duplicate page', category: 'Page', keys: [], run: () => A.duplicatePageCmd() },
  { id: 'page.delete', label: 'Delete page', category: 'Page', keys: [], run: () => void A.deletePageCmd(), when: () => docPages(S().doc).length > 1 },
  { id: 'page.moveLeft', label: 'Move page left', category: 'Page', keys: [], run: () => A.movePageBy(activePage(), -1), when: () => pageIndex(S().doc, S().page) > 0 },
  { id: 'page.moveRight', label: 'Move page right', category: 'Page', keys: [], run: () => A.movePageBy(activePage(), 1), when: () => pageIndex(S().doc, S().page) < docPages(S().doc).length - 1 },

  // Wire
  { id: 'wire.angle', label: 'Cycle wire angle: 90° / 45° / any (Tab while drawing)', category: 'Wire', keys: ['Shift+A'], run: () => A.setWireAngle() },
  { id: 'wire.reroute', label: 'Re-route selected wires', category: 'Wire', keys: ['Shift+W'], run: A.rerouteWires },
  { id: 'wire.highlightNet', label: 'Highlight net of selected wire', category: 'Wire', keys: ['N'], run: highlightNet },
  { id: 'wire.hops', label: 'Cycle wire crossing style (hop / gap / none)', category: 'Wire', keys: ['Mod+Shift+J'], run: cycleHops },
  { id: 'wire.corners', label: 'Toggle rounded wire corners', category: 'Wire', keys: ['Mod+Shift+K'], run: toggleCorners, checked: () => vdoc().settings.wire.radius > 0 },

  // View
  { id: 'view.zoomIn', label: 'Zoom in', category: 'View', keys: ['=', 'Mod+=', '+'], cadence: ['[', 'Mod+=', '='], run: () => A.zoomStep(1.25) },
  { id: 'view.zoomOut', label: 'Zoom out', category: 'View', keys: ['-', 'Mod+-'], cadence: [']', 'Shift+Z', 'Mod+-', '-'], run: () => A.zoomStep(0.8) },
  { id: 'view.fit', label: 'Zoom to fit', category: 'View', keys: ['Shift+1', 'F'], run: () => A.glideFit() },
  { id: 'view.fitSel', label: 'Zoom to selection', category: 'View', keys: ['Shift+2'], run: () => A.glideFit(S().selection) },
  { id: 'view.100', label: 'Zoom to 100%', category: 'View', keys: ['Mod+0', 'Shift+0'], run: () => A.zoomTo(1) },
  { id: 'view.refs', label: 'Show part names', category: 'View', keys: ['Alt+N'], run: () => toggleSetting('hideRefs', 'Part names'), checked: () => !vdoc().settings.hideRefs },
  { id: 'view.values', label: 'Show part values', category: 'View', keys: ['Alt+U'], run: () => toggleSetting('hideValues', 'Part values'), checked: () => !vdoc().settings.hideValues },
  { id: 'view.wireLabels', label: 'Show wire names', category: 'View', keys: ['Alt+W'], run: () => toggleSetting('hideWireLabels', 'Wire names'), checked: () => !vdoc().settings.hideWireLabels },
  { id: 'view.alignGuides', label: 'Alignment guides while moving', category: 'View', keys: ['Alt+G'], run: () => { setPrefs({ alignGuides: !S().prefs.alignGuides }); toast(S().prefs.alignGuides ? 'Alignment guides on' : 'Alignment guides off'); }, checked: () => S().prefs.alignGuides },
  { id: 'view.spacingGuides', label: 'Equal-spacing guides while moving', category: 'View', keys: ['Alt+Shift+G'], run: () => togglePref('spacingGuides', 'Spacing guides'), checked: () => S().prefs.spacingGuides, keywords: 'equispaced distribute gap smart' },
  { id: 'view.labelGuides', label: 'Guides for part names and values', category: 'View', keys: ['Alt+Shift+N'], run: () => togglePref('labelGuides', 'Label guides'), checked: () => S().prefs.labelGuides, keywords: 'text label ref value align' },
  { id: 'view.grid', label: 'Toggle grid', category: 'View', keys: ['G'], run: () => mutateSettings((s) => (s.showGrid = !s.showGrid)), checked: () => vdoc().settings.showGrid },
  { id: 'view.gridStyle', label: 'Grid style: dots → lines → crosses → major lines', category: 'View', keys: [], run: () => cycleGridStyle(), keywords: 'grid dots lines crosses major look' },
  { id: 'view.snap', label: 'Toggle snap to grid', category: 'View', keys: ["Mod+'"], run: () => mutateSettings((s) => (s.snap = !s.snap)), checked: () => vdoc().settings.snap },
  { id: 'view.library', label: 'Toggle library panel', category: 'View', keys: ['Mod+B'], run: () => set((s) => ({ leftPanel: !s.leftPanel })), checked: () => S().leftPanel },
  { id: 'view.inspector', label: 'Toggle properties panel', category: 'View', keys: ['Mod+I'], run: () => set((s) => ({ rightPanel: !s.rightPanel })), checked: () => S().rightPanel },
  { id: 'view.layers', label: 'Show layers panel', category: 'View', keys: ['Mod+Shift+O'], run: () => set({ leftPanel: true, leftTab: 'layers' }) },
  { id: 'view.minimap', label: 'Toggle minimap', category: 'View', keys: ['Alt+M'], run: () => setPrefs({ showMinimap: !S().prefs.showMinimap }), checked: () => S().prefs.showMinimap },
  { id: 'view.theme', label: 'Toggle light / dark theme', category: 'View', keys: ['Mod+Shift+D'], run: () => setTheme(nextTheme()) },
  { id: 'view.focus', label: 'Focus mode (hide panels)', category: 'View', keys: ['Mod+.'], run: focusMode },
  { id: 'view.search', label: 'Search symbol library', category: 'View', keys: ['/'], cadence: ['I', '/'], run: focusSearch },
  { id: 'view.viewMode', label: 'View mode (read-only: look, select, find, export)', category: 'View', keys: ['Alt+Shift+R'], run: () => A.setViewMode(), checked: () => S().viewMode, keywords: 'read only readonly lock locked protect view zen viewer' },
  { id: 'view.stats', label: 'Stats (selection size, parts, nets, wire length)', category: 'View', keys: ['Alt+/'], run: () => A.toggleStats(), checked: () => S().statsOpen, keywords: 'statistics info count measure bounding box dimensions length' },
  { id: 'view.check', label: 'Check circuit (electrical rules check)', category: 'View', keys: ['Mod+Alt+R'], cadence: ['X', 'Mod+Alt+R'], run: () => set({ leftPanel: true, leftTab: 'check' }) },
  { id: 'view.checkSave', label: 'Check and save', category: 'File', keys: [], cadence: ['Shift+X'], run: checkAndSave },

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

  {
    id: 'symbols.fromSelection',
    label: 'Create symbol from selection…',
    category: 'Symbols',
    keys: ['Mod+Alt+K'],
    run: () => {
      const ids = S().selection;
      const drawing = ids.length ? selectionToDrawing(vdoc(), ids) : null;
      if (!drawing) return toast('Select the parts, wires or shapes to turn into a symbol');
      set({ dialog: 'symbol-editor', editingSymbol: null, symbolSeed: { ...drawing, ids: [...ids] } });
    },
  },

  // Help
  { id: 'help.palette', label: 'Command palette', category: 'Help', keys: ['Mod+K', 'Mod+Shift+P'], run: () => set({ dialog: 'palette' }) },
  { id: 'help.shortcuts', label: 'Keyboard shortcuts', category: 'Help', keys: ['Shift+/', 'F1'], run: () => set({ dialog: 'shortcuts' }) },
  { id: 'help.settings', label: 'Settings', category: 'Help', keys: ['Mod+,'], cadence: ['O', 'Mod+,'], run: () => set({ dialog: 'settings' }) },
  { id: 'help.shortcutScheme', label: 'Switch shortcut scheme (Nodal / Cadence)', category: 'Help', keys: [], run: toggleScheme },
  { id: 'help.about', label: 'About Nodal', category: 'Help', keys: [], run: () => set({ dialog: 'about' }) },
];

/**
 * Commands that change the circuit. In View mode (or as a view-only session
 * guest) they are hidden from the palette, greyed in menus, and their keys
 * only say why nothing happened. The store refuses the edits anyway; this
 * keeps the UI honest about it.
 */
export const EDIT_COMMANDS: ReadonlySet<string> = new Set([
  'edit.pasteStyle',
  'edit.undo', 'edit.redo', 'edit.cut', 'edit.paste', 'edit.pasteHere', 'edit.duplicate', 'edit.duplicateIncrement', 'edit.delete',
  'edit.annotate', 'edit.lock', 'edit.hide', 'edit.properties',
  'edit.nudgeLeft', 'edit.nudgeRight', 'edit.nudgeUp', 'edit.nudgeDown', 'edit.nudgeLeftBig', 'edit.nudgeRightBig', 'edit.nudgeUpBig', 'edit.nudgeDownBig',
  'edit.nudgeLeftFine', 'edit.nudgeRightFine', 'edit.nudgeUpFine', 'edit.nudgeDownFine',
  'edit.quickAddRight', 'edit.quickAddLeft', 'edit.quickAddUp', 'edit.quickAddDown',
  'edit.move', 'edit.moveDetached', 'edit.copyMove',
  'tool.altMove', 'tool.node', 'tool.solder', 'tool.wire', 'tool.rect', 'tool.zone', 'tool.ellipse', 'tool.polygon', 'tool.path', 'tool.line', 'tool.arrow', 'tool.text',
  'tool.pen', 'tool.highlighter', 'tool.eraser', 'tool.callout', 'tool.frame', 'explain.renumber',
  'tool.placeLast', 'tool.netLabel', 'tool.pin', 'tool.ground', 'tool.vcc', 'tool.resistor', 'tool.capacitor', 'tool.junction',
  ...COMMANDS.filter((c) => c.category === 'Arrange' && c.id !== 'arrange.enterGroup' && c.id !== 'arrange.exitGroup').map((c) => c.id),
  'page.new', 'page.rename', 'page.duplicate', 'page.delete', 'page.moveLeft', 'page.moveRight',
  'wire.reroute', 'wire.hops', 'wire.corners',
  // these are stored in the circuit, so they are edits too
  'view.refs', 'view.values', 'view.wireLabels', 'view.grid', 'view.snap',
  'symbols.edit', 'symbols.fromSelection',
]);

for (const c of COMMANDS) {
  if (!EDIT_COMMANDS.has(c.id)) continue;
  const { run, when } = c;
  c.run = () => (readOnly() ? A.readOnlyNotice() : run());
  c.when = () => !readOnly() && (!when || when());
}

export const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.id, c]));

function mutateSettings(fn: (s: import('../model/types').DocSettings) => void) {
  mutate((d) => fn(d.settings));
}


function cycleGridStyle() {
  const cur = vdoc().settings.gridStyle ?? 'dots';
  const next = GRID_STYLES[(GRID_STYLES.indexOf(cur) + 1) % GRID_STYLES.length];
  mutateSettings((s) => {
    s.gridStyle = next;
    s.showGrid = true;
  });
  toast(`Grid: ${GRID_STYLE_NAMES[next].toLowerCase()}`);
}

function togglePref(key: 'spacingGuides' | 'labelGuides', what: string) {
  setPrefs({ [key]: !S().prefs[key] });
  toast(`${what} ${S().prefs[key] ? 'on' : 'off'}`);
}

function toggleSetting(key: 'hideRefs' | 'hideValues' | 'hideWireLabels', what: string) {
  const hide = !vdoc().settings[key];
  mutateSettings((s) => (s[key] = hide));
  toast(`${what} ${hide ? 'hidden' : 'shown'}`);
}

function cycleHops() {
  const order = ['arc', 'gap', 'none'] as const;
  const next = order[(order.indexOf(vdoc().settings.hops) + 1) % 3];
  mutateSettings((s) => (s.hops = next));
  toast(`Crossing style: ${next === 'arc' ? 'Hop' : next === 'gap' ? 'Gap' : 'None'}`);
}

function toggleCorners() {
  const r = vdoc().settings.wire.radius > 0 ? 0 : 8;
  mutateSettings((s) => (s.wire.radius = r));
  toast(r ? 'Wire corners: rounded' : 'Wire corners: sharp');
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

/** Renames the selected group (or the one being edited) in place on the canvas. */
function renameGroupCmd() {
  const gid = selectedGroup(vdoc(), S().selection, S().scope) ?? S().scope;
  if (gid) canvasActions.renameGroup?.(gid);
}

function focusValue() {
  if (!S().selection.length) return;
  focusValueField();
}

/**
 * Opens the inspector and puts the cursor in the selection's value field,
 * with a short glow so the eye finds it across the screen.
 */
export function focusValueField() {
  set({ rightPanel: true });
  setTimeout(() => {
    const el = document.querySelector<HTMLInputElement>('[data-focus="value"]');
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    el.focus();
    el.select();
    el.classList.remove('attention');
    void el.offsetWidth; // restart the glow if it is still running
    el.classList.add('attention');
    setTimeout(() => el.classList.remove('attention'), 1200);
  }, 30);
}

/** Escape cascade: cancel placement → close menus → exit group → clear selection → select tool. */
export function cancel() {
  const s = S();
  if (s.contextMenu) return set({ contextMenu: null });
  if (s.placing) return set({ placing: null });
  if (s.highlight) return set({ highlight: null });
  if (clearExplainOverlays()) return;
  if (s.wirePart) return set({ wirePart: null });
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

/** Every combo the Cadence scheme binds explicitly; Nodal defaults using one of them are dropped in that scheme. */
const CADENCE_USED = new Set(COMMANDS.flatMap((c) => c.cadence ?? []));

/** Built-in keys of a command in a scheme. */
export function defaultKeys(c: Command, scheme: 'nodal' | 'cadence'): string[] {
  if (scheme === 'nodal') return c.keys;
  return c.cadence ?? c.keys.filter((k) => !CADENCE_USED.has(k));
}

/** Custom key overrides of the active scheme (each scheme keeps its own). */
export function activeKeymap(): Record<string, string[]> {
  const p = S().prefs;
  return (p.shortcuts === 'cadence' ? p.keymapCadence : p.keymap) ?? {};
}

export function setActiveKeymap(km: Record<string, string[]>) {
  setPrefs(S().prefs.shortcuts === 'cadence' ? { keymapCadence: km } : { keymap: km });
}

export function keysFor(id: string): string[] {
  const c = COMMAND_MAP.get(id);
  return activeKeymap()[id] ?? (c ? defaultKeys(c, S().prefs.shortcuts) : []);
}

export function findCommand(combo: string): Command | undefined {
  for (const c of COMMANDS) if (keysFor(c.id).includes(combo)) return c;
  return undefined;
}

function toggleScheme() {
  const next = S().prefs.shortcuts === 'cadence' ? 'nodal' : 'cadence';
  setPrefs({ shortcuts: next });
  toast(next === 'cadence' ? 'Cadence shortcuts: W wire, I part, M move, C copy, L label, N note, Q properties, U undo' : 'Nodal shortcuts');
}

function checkAndSave() {
  set({ leftPanel: true, leftTab: 'check' });
  void fileSave();
}

viewModeKey.label = () => prettyKey(keysFor('view.viewMode')[0] ?? '');

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
            ? IS_MAC
              ? '⇧'
              : 'Shift'
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
                          ? IS_MAC
                            ? '⌫'
                            : 'Backspace'
                          : p === 'Enter'
                            ? '↵'
                            : p === '/'
                              ? '/'
                              : p,
    )
    .join(IS_MAC ? '' : '+')
    .replace('⇧+/', '?');
}

/** Opens the History tab with the version name field focused. */
function focusVersionName() {
  set({ leftPanel: true, leftTab: 'history' });
  setTimeout(() => document.querySelector<HTMLInputElement>('[data-focus="version-name"]')?.focus(), 30);
}

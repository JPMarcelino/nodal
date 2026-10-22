import type { Tool } from '../model/types';

/** What is selected, as far as the hint line cares. */
export type HintSel = 'part' | 'label' | 'wire' | 'labelledWire' | 'shape' | 'text' | 'other';

/** Gesture in progress on the canvas that changes what the next step is. */
export type HintGesture = 'wire' | 'polygon' | 'path' | 'connector' | 'other';

export interface HintState {
  tool: Tool;
  /** A part is armed for placing. */
  placing: boolean;
  /** Placing goes on after each click (tool lock or the Cadence scheme). */
  keepPlacing?: boolean;
  /** Tool lock is on. */
  toolLock?: boolean;
  /** Kinds of the selected items, one per item. */
  selection: HintSel[];
  gesture?: HintGesture | null;
  /** A text box (or a value / label) is being typed into on the canvas. */
  editingText?: boolean;
  /** A library shape is armed (the rectangle tool draws it). */
  shapePreset?: boolean;
  /** Modes that show their own banner (Alt move, area export): no hint. */
  banner?: boolean;
  /**
   * Formats a key: a command id (`edit.duplicate`) gives its current binding,
   * or '' when unbound; anything else is a fixed combo (`Mod+Enter`, `Esc`).
   */
  key: (idOrCombo: string) => string;
}

const join = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' · ');

/**
 * The next useful action for the current tool and selection, in one short
 * line; null when there is nothing to add. Only names shortcuts that exist,
 * in the user's bindings: a command whose key was removed drops out.
 */
export function hintFor(s: HintState): string | null {
  const k = s.key;
  /** "<key> <what>", or nothing when the command has no key. */
  const cmd = (id: string, what: string) => {
    const key = k(id);
    return key ? `${key} ${what}` : null;
  };
  const pair = (a: string, b: string, what: string) => {
    const ka = k(a);
    const kb = k(b);
    return ka && kb ? `${ka} / ${kb} ${what}` : ka ? `${ka} ${what}` : kb ? `${kb} ${what}` : null;
  };
  const esc = k('Escape');

  if (s.editingText) return join([`${k('Mod+Enter')} or click outside to finish`, `${esc} stops editing`, 'write $…$ for maths']);

  switch (s.gesture) {
    case 'wire':
      return join(['Click to add a bend', 'end on a pin or wire to connect', `${k('Space')} flips the elbow`, `${k('Tab')} 90° / 45° / any`, `${k('Backspace')} undoes a bend`, `${k('Enter')} or double-click finishes`, `${esc} cancels`]);
    case 'polygon':
      return join(['Click the next corner', 'click the first corner again (or double-click) to close', 'Shift 45°', `${k('Backspace')} undoes a corner`, `${esc} cancels`]);
    case 'path':
      return join(['Click for a corner, drag for a curve', 'click the first node to close', `${k('Enter')} or double-click ends an open path`, `${k('Backspace')} removes the last node`]);
    case 'connector':
      return join(['Release on a shape or part to attach the end: on a dot to pin it there, anywhere else to let it float round the outline', `${k('Alt')} doesn’t attach`]);
    case 'other':
      return null;
  }
  if (s.banner) return null;

  if (s.placing) {
    return join([
      s.keepPlacing ? 'Click to place copies' : 'Click to place',
      'drop it across a wire to insert it',
      cmd('arrange.rotateCw', 'rotates'),
      pair('arrange.flipH', 'arrange.flipV', 'flip'),
      !s.keepPlacing && 'Shift-click to place several',
      s.toolLock ? `${esc} stops (tool lock is on)` : `${esc} cancels`,
    ]);
  }

  switch (s.tool) {
    case 'select':
      return selectHint(s, cmd, pair);
    case 'wire':
      return join(['Click or drag from a pin, a wire or the grid to start a wire', `${k('Tab')} 90° / 45° / any angle`, `${esc} back to select`]);
    case 'node':
      return join(['Drag a bend, wire end or shape node to move it', 'click a node, then Del removes it', 'double-click a shape node: corner / smooth', `${k('Alt')}-drag a handle to break it`, `${esc} back to select`]);
    case 'solder':
      return join(['Click a crossing, a touching end or a pin on a wire to solder it', 'click a junction or wired pin to unsolder', `${esc} back to select`]);
    case 'rect':
      if (s.shapePreset) return join(['Click to drop the shape, or drag to size it', 'Shift keeps it square', `${esc} back to select`]);
      return join(['Drag to draw a rectangle', 'double-click it afterwards to add a title', `${esc} back to select`]);
    case 'zone':
      return join(['Drag to draw a filled zone around part of the circuit', `${esc} back to select`]);
    case 'ellipse':
      return join(['Drag to draw an ellipse', `${esc} back to select`]);
    case 'line':
    case 'arrow':
      return join([`Drag to draw ${s.tool === 'line' ? 'a line' : 'an arrow'}`, 'start or end on a shape or part to attach it', 'Shift 45°', `${esc} back to select`]);
    case 'polygon':
      return join(['Click the corners', 'click the first one again to close', `${esc} back to select`]);
    case 'path':
      return join(['Click for corners, drag for curves', 'click the first node to close', `${esc} back to select`]);
    case 'text':
      return join(['Click to place text', 'double-click text to edit it', `${esc} back to select`]);
    case 'frame':
      return join(['Drag an area for a presentation frame', 'a click frames the current view', cmd('explain.present', 'presents')]);
    case 'pan':
      return join(['Drag to pan', `hold ${k('Space')} to pan from any tool`, `${esc} back to select`]);
    case 'pen':
      return join(['Drag to draw', 'hold still at the end to snap to a line or shape', '1–7 colour', '[ ] size']);
    case 'highlighter':
      return join(['Drag to highlight', 'hold still to straighten', 'Shift straight']);
    case 'laser':
      return join(['Drag to point', 'the trail fades after a moment']);
    case 'eraser':
      return 'Drag over ink or callouts to erase them';
    case 'trace':
      return join(['Click a wire, pin or part to light up its nets', 'click again to clear']);
    case 'callout':
      return join(['Click to drop a numbered callout', 'drag a callout to move it']);
  }
  return null;
}

function selectHint(s: HintState, cmd: (id: string, what: string) => string | null, pair: (a: string, b: string, what: string) => string | null): string | null {
  const sel = s.selection;
  if (!sel.length) {
    return join(['Click a part or wire to select it, drag to select an area', cmd('tool.wire', 'draws wires'), cmd('view.search', 'finds parts'), cmd('help.palette', 'opens the command palette')]);
  }
  if (sel.length > 1) {
    const labels = sel.every((t) => t === 'label' || t === 'labelledWire');
    return join([
      labels && cmd('edit.duplicateIncrement', 'duplicates with the next numbers'),
      cmd('arrange.group', 'groups'),
      cmd('arrange.alignLeft', 'aligns left edges'),
      cmd('arrange.rotateCw', 'rotates'),
      cmd('edit.duplicate', 'duplicates'),
      cmd('edit.delete', 'deletes'),
    ]);
  }
  switch (sel[0]) {
    case 'part':
      return join([cmd('arrange.rotateCw', 'rotates'), pair('arrange.flipH', 'arrange.flipV', 'flip'), 'drag a corner to resize', cmd('edit.duplicate', 'duplicates'), cmd('edit.properties', 'edits the value')]);
    case 'label':
      return join([cmd('edit.properties', 'renames the net'), 'drag its name to move it', cmd('edit.duplicateIncrement', 'duplicates with the next number (D0 → D1)'), cmd('arrange.rotateCw', 'rotates')]);
    case 'labelledWire':
      return join(['Drag the label along the wire or to either side', cmd('edit.duplicateIncrement', 'duplicates with the next number'), cmd('wire.highlightNet', 'highlights the net')]);
    case 'wire':
      return join(['Click a segment to select it, then Del removes it', 'Alt-drag on a wire to branch', cmd('wire.highlightNet', 'highlights the net'), cmd('wire.reroute', 're-routes')]);
    case 'text':
      return join(['Double-click to edit the text', cmd('edit.duplicate', 'duplicates'), cmd('edit.lock', 'locks')]);
    case 'shape':
      return join(['Drag a handle to resize', 'double-click to add text', cmd('edit.duplicate', 'duplicates'), cmd('edit.lock', 'locks')]);
    default:
      return join([cmd('edit.duplicate', 'duplicates'), cmd('edit.delete', 'deletes')]);
  }
}

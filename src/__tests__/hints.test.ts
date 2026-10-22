import { describe, expect, it } from 'vitest';
import { hintFor, type HintState } from '../ui/hints';

const KEYS: Record<string, string> = {
  'arrange.rotateCw': 'R',
  'arrange.flipH': 'X',
  'arrange.flipV': 'Y',
  'edit.duplicate': 'Ctrl+D',
  'edit.duplicateIncrement': 'Ctrl+Alt+D',
  'edit.properties': 'F2',
  'edit.delete': 'Del',
  'arrange.group': 'Ctrl+G',
  'tool.wire': 'W',
  'view.search': '/',
  'help.palette': 'Ctrl+K',
  'wire.highlightNet': 'N',
  'edit.quickAddRight': 'Ctrl+Shift+→',
};
// command ids give their binding ('' when unbound); fixed combos come back as they are
const key = (x: string) => (x.includes('.') ? KEYS[x] ?? '' : x === 'Escape' ? 'Esc' : x);
const hint = (s: Partial<HintState>) => hintFor({ tool: 'select', placing: false, selection: [], key, ...s });

describe('hintFor', () => {
  it('select tool with nothing selected points at wiring, parts and the palette', () => {
    const h = hint({})!;
    expect(h).toContain('W draws wires');
    expect(h).toContain('/ finds parts');
    expect(h).toContain('Ctrl+K');
  });

  it('one part: rotate, flip, resize, duplicate', () => {
    const h = hint({ selection: ['part'] })!;
    expect(h).toContain('R rotates');
    expect(h).toContain('X / Y flip');
    expect(h).toContain('drag a corner to resize');
    expect(h).toContain('Ctrl+D duplicates');
    expect(h).toContain('Ctrl+Shift+→ (or another arrow) chains a wired copy');
  });

  it('uses the user’s bindings and drops unbound commands', () => {
    const custom = (x: string) => (x === 'arrange.rotateCw' ? 'Shift+T' : x === 'edit.duplicate' ? '' : key(x));
    const h = hintFor({ tool: 'select', placing: false, selection: ['part'], key: custom })!;
    expect(h).toContain('Shift+T rotates');
    expect(h).not.toContain('duplicates');
  });

  it('several selected: group and align', () => {
    expect(hint({ selection: ['part', 'wire'] })).toContain('Ctrl+G groups');
    expect(hint({ selection: ['label', 'label'] })).toContain('Ctrl+Alt+D duplicates with the next numbers');
  });

  it('net label: rename and duplicate-increment; labelled wire: drag along the wire', () => {
    expect(hint({ selection: ['label'] })).toContain('Ctrl+Alt+D duplicates with the next number');
    expect(hint({ selection: ['labelledWire'] })).toContain('Drag the label along the wire');
    expect(hint({ selection: ['wire'] })).toContain('Alt-drag on a wire to branch');
  });

  it('wire tool idle vs. mid-wire', () => {
    expect(hint({ tool: 'wire' })).toContain('to start a wire');
    const mid = hint({ tool: 'wire', gesture: 'wire' })!;
    expect(mid).toContain('Click to add a bend');
    expect(mid).toContain('Esc cancels');
  });

  it('placing: insert into a wire, Shift for several unless the tool lock keeps it', () => {
    const once = hint({ placing: true })!;
    expect(once).toContain('drop it across a wire to insert it');
    expect(once).toContain('Shift-click to place several');
    const locked = hint({ placing: true, keepPlacing: true, toolLock: true })!;
    expect(locked).not.toContain('Shift-click');
    expect(locked).toContain('tool lock is on');
  });

  it('text editing, pan and the explain tools', () => {
    expect(hint({ editingText: true })).toContain('click outside to finish');
    expect(hint({ tool: 'pan' })).toContain('Drag to pan');
    for (const tool of ['pen', 'highlighter', 'laser', 'eraser', 'trace', 'callout'] as const) expect(hint({ tool })).toBeTruthy();
  });

  it('modes with their own banner and other drags show nothing', () => {
    expect(hint({ banner: true })).toBeNull();
    expect(hint({ gesture: 'other' })).toBeNull();
  });
});

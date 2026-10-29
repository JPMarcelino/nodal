import { describe, expect, it } from 'vitest';
import { matchRanges, matchScore, pushRecent, queryWords } from '../ui/paletteSearch';
import { parseTip } from '../ui/Tooltips';

describe('palette ranking', () => {
  it('needs every word somewhere', () => {
    expect(matchScore('Rotate', '', ['rot'])).toBeGreaterThan(0);
    expect(matchScore('Rotate', '', ['rot', 'zz'])).toBe(0);
    expect(matchScore('Export…', 'png svg', ['png'])).toBeGreaterThan(0);
  });

  it('prefers label matches, word starts and short labels', () => {
    const w = queryWords('rotate');
    expect(matchScore('Rotate', '', w)).toBeGreaterThan(matchScore('Rotate counter-clockwise', '', w));
    expect(matchScore('Zoom in', '', ['in'])).toBeGreaterThan(matchScore('Print…', '', ['in']));
    expect(matchScore('Export…', 'png', ['png'])).toBeLessThan(matchScore('Copy selection as image (PNG)', '', ['png']));
  });

  it('highlights merged ranges', () => {
    expect(matchRanges('Zoom to fit', ['fit', 'zo'])).toEqual([
      [0, 2],
      [8, 11],
    ]);
    expect(matchRanges('Resistor', ['res', 'resi'])).toEqual([[0, 4]]);
  });

  it('keeps recents unique and short', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b'], 'z', 2)).toEqual(['z', 'a']);
  });
});

describe('tooltip text', () => {
  it('splits a trailing shortcut into keys', () => {
    expect(parseTip('Wire (W)')).toEqual({ label: 'Wire', keys: ['W'] });
    expect(parseTip('Next (→ / Space)')).toEqual({ label: 'Next', keys: ['→', 'Space'] });
    expect(parseTip('Paste style (Ctrl+Alt+Shift+V)')).toEqual({ label: 'Paste style', keys: ['Ctrl+Alt+Shift+V'] });
    expect(parseTip('Keyboard shortcuts (?)').keys).toEqual(['?']);
  });

  it('leaves ordinary brackets alone', () => {
    expect(parseTip('DXF (CAD)').keys).toEqual([]);
    expect(parseTip('Move up (hop over)').keys).toEqual([]);
    expect(parseTip('Ann (you)').keys).toEqual([]);
    expect(parseTip('Fill colour (empty: same as the line)').keys).toEqual([]);
  });
});

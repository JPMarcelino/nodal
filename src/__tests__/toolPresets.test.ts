import { describe, expect, it } from 'vitest';
import { createDoc, makeShape, nextZoneColour } from '../model/doc';

describe('shape tool settings', () => {
  it('apply to the shape a tool draws', () => {
    const d = createDoc();
    const s = makeShape(d, 'rect', 0, 0, 40, 20, { stroke: '#9ece6a', strokeWidth: 5, bold: true });
    expect(s.stroke).toBe('#9ece6a');
    expect(s.strokeWidth).toBe(5);
    expect(s.bold).toBe(true);
    expect(s.dash).toBe('dashed'); // untouched settings keep the kind's default
  });
  it('a setting cleared to undefined keeps the default (zones keep cycling colours)', () => {
    const d = createDoc();
    const s = makeShape(d, 'zone', 0, 0, 40, 20, { fill: undefined, stroke: undefined });
    expect(s.fill).toBe(nextZoneColour(d));
    expect(s.stroke).toBe(s.fill);
  });
});

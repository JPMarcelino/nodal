import { describe, expect, it } from 'vitest';
import { fragmentFromText, svgWithFragment } from '../io/clipboardCopy';
import { exportSvg } from '../io/export';
import { createDoc, makeComponent } from '../model/doc';
import { extractFragment } from '../model/ops';
import type { CircuitDoc } from '../model/types';

function copied() {
  const doc: CircuitDoc = createDoc();
  const c = makeComponent(doc, 'net-label', 0, 0);
  c.value = 'A<B & "C"';
  doc.items[c.id] = c;
  const frag = extractFragment(doc, new Set([c.id]));
  const svg = svgWithFragment(exportSvg(doc, { theme: 'dark', background: true, padding: 10, ids: [c.id] }).svg, frag);
  return { frag, svg };
}

describe('copying to other apps', () => {
  it('is a valid SVG picture with the items stored inside', () => {
    const { svg } = copied();
    expect(svg).toMatch(/^<\?xml[^>]*>\s*<svg[^>]*>\s*<metadata id="nodal-fragment">/);
    // markup in the items is escaped, so the SVG stays well-formed
    expect(svg).not.toContain('A<B');
    expect(/<metadata id="nodal-fragment">([^<]*)<\/metadata>/.test(svg)).toBe(true);
  });

  it('pastes back into Nodal as the same items', () => {
    const { frag, svg } = copied();
    expect(fragmentFromText(svg)).toEqual(frag);
  });

  it('still reads plain fragment JSON, and ignores other text and SVGs', () => {
    const { frag } = copied();
    expect(fragmentFromText(JSON.stringify(frag))).toEqual(frag);
    expect(fragmentFromText('hello')).toBeNull();
    expect(fragmentFromText('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBeNull();
    expect(fragmentFromText(null)).toBeNull();
  });
});

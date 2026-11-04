import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { exportSvg } from '../io/export';
import { createDoc, makeComponent, uid } from '../model/doc';
import { computeNets } from '../model/netlist';
import { unsolderJunction } from '../model/ops';
import { addPage } from '../model/pages';
import { settleEdit } from '../model/settle';
import { insertSvgDrawing } from '../model/svgDrawing';
import { joinTouches } from '../model/touches';
import type { CircuitDoc, ComponentItem, Endpoint, JunctionItem, Point, WireItem } from '../model/types';
import { endpointInfo, wirePolyline } from '../model/wires';

const F = (x: number, y: number): Endpoint => ({ kind: 'free', x, y });
function wire(d: CircuitDoc, a: Endpoint, b: Endpoint, pts: Point[] = [], extra: Partial<WireItem> = {}): WireItem {
  const w: WireItem = { id: uid('w'), type: 'wire', a, b, pts, ...extra };
  d.items[w.id] = w;
  return w;
}
function part(d: CircuitDoc, x: number, y: number): ComponentItem {
  const c = makeComponent(d, 'resistor', x, y);
  d.items[c.id] = c;
  return c;
}
const pinAt = (d: CircuitDoc, c: ComponentItem, port: string) => endpointInfo(d, { kind: 'port', comp: c.id, port })!.pt;
/** Groups of wire ids on one net, for nets holding wires. */
const wireNets = (d: CircuitDoc) =>
  computeNets(d)
    .filter((n) => n.wires.length)
    .map((n) => [...n.wires].sort().join(' '))
    .sort();
/** Pin groups ("comp.port") per net, nets with two or more pins only. */
const pinNets = (d: CircuitDoc) =>
  computeNets(d)
    .map((n) => n.pins.map((p) => `${p.comp}.${p.port}`).sort().join(' '))
    .filter((n) => n.includes(' '))
    .sort();

describe('if it touches, it is connected', () => {
  it('two wires meeting end to end share a net, and stay two wires', () => {
    const d = createDoc();
    const a = wire(d, F(0, 0), F(100, 0));
    const b = wire(d, F(100, 0), F(100, 100));
    expect(wireNets(d)).toEqual([[a.id, b.id].sort().join(' ')]);
    expect(Object.values(d.items).filter((i) => i.type === 'wire')).toHaveLength(2);
  });

  it('a wire ending on the middle of another (a tee) or on its bend is connected', () => {
    const d = createDoc();
    const run = wire(d, F(0, 0), F(200, 100), [{ x: 200, y: 0 }]);
    const tee = wire(d, F(100, 0), F(100, -100));
    const bend = wire(d, F(200, 0), F(300, 0));
    expect(wireNets(d)).toEqual([[run.id, tee.id, bend.id].sort().join(' ')]);
  });

  it('two runs crossing do not connect (they hop)', () => {
    const d = createDoc();
    wire(d, F(0, 50), F(100, 50));
    wire(d, F(50, 0), F(50, 100));
    expect(wireNets(d)).toHaveLength(2);
  });

  it('a wire end on a pin, and a pin on the middle of a wire, are connected', () => {
    const d = createDoc();
    const r1 = part(d, 100, 100);
    const r2 = part(d, 300, 300);
    const p1 = pinAt(d, r1, '2');
    const p2 = pinAt(d, r2, '1');
    // ends on R1.2 and runs straight across R2.1 (R2 stands crosswise to it)
    wire(d, F(p1.x, p1.y), F(p2.x, p2.y + 100), [{ x: p2.x, y: p1.y }]);
    expect(pinNets(d)).toEqual([[`${r1.id}.2`, `${r2.id}.1`].sort().join(' ')]);
  });

  it('a junction dot lying on a wire connects to it', () => {
    const d = createDoc();
    const j: JunctionItem = { id: uid('j'), type: 'junction', x: 50, y: 0 };
    d.items[j.id] = j;
    const run = wire(d, F(0, 0), F(100, 0));
    const branch = wire(d, { kind: 'junction', id: j.id }, F(50, 100));
    expect(wireNets(d)).toEqual([[run.id, branch.id].sort().join(' ')]);
  });

  it('hidden wires touch nothing, and nothing touches across pages', () => {
    const d = createDoc();
    const p2 = addPage(d, 'Two');
    wire(d, F(0, 0), F(100, 0));
    wire(d, F(50, 0), F(50, 100), [], { hidden: true });
    wire(d, F(50, 0), F(50, -100), [], { page: p2 });
    expect(wireNets(d)).toHaveLength(3);
  });

  it('a lead laid back across its own part shorts it, as drawn (no exceptions)', () => {
    const d = createDoc();
    const r = part(d, 100, 100);
    const p1 = pinAt(d, r, '1');
    const p2 = pinAt(d, r, '2');
    // pin 2's lead runs back across the body and over pin 1
    wire(d, { kind: 'port', comp: r.id, port: '2' }, F(p1.x - 50, p1.y), [{ x: p2.x, y: p2.y }]);
    expect(pinNets(d)).toEqual([[`${r.id}.1`, `${r.id}.2`].join(' ')]);
  });

});

describe('recording touches (settle)', () => {
  it('a tee gets a real junction, so its dot is drawn and the wires follow a drag', () => {
    const prev = createDoc();
    const next = produce(prev, (x) => {
      wire(x as CircuitDoc, F(0, 0), F(200, 0));
      wire(x as CircuitDoc, F(100, 0), F(100, 100));
    });
    const out = settleEdit(prev, next);
    const js = Object.values(out.items).filter((i): i is JunctionItem => i.type === 'junction');
    expect(js.map((j) => [j.x, j.y])).toEqual([[100, 0]]);
    const ends = Object.values(out.items).filter((i): i is WireItem => i.type === 'wire' && (i.a.kind === 'junction' || i.b.kind === 'junction'));
    expect(ends).toHaveLength(3);
    expect(wireNets(out)).toHaveLength(1);
  });

  it('a wire run across several pins is joined to every one of them', () => {
    const d = createDoc();
    const r = part(d, 100, 100);
    const a = pinAt(d, r, '1');
    wire(d, F(a.x - 100, a.y), F(a.x + 200, a.y));
    const before = pinNets(d);
    const out = joinTouches(d);
    expect(pinNets(out)).toEqual(before);
    const onPart = Object.values(out.items).filter((i): i is WireItem => i.type === 'wire' && [i.a, i.b].some((ep) => ep.kind === 'port'));
    expect(onPart).toHaveLength(3);
  });

  it('leaves locked wires as they are; they are connected all the same', () => {
    const d = createDoc();
    wire(d, F(0, 0), F(200, 0), [], { locked: true });
    wire(d, F(100, 0), F(100, 100), [], { locked: true });
    expect(joinTouches(d)).toBe(d);
    expect(wireNets(d)).toHaveLength(1);
  });

  it('never changes what is connected (random drawings)', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const g = (n: number) => rnd(n) * 20;
    for (let round = 0; round < 60; round++) {
      const d = createDoc();
      for (let k = 0; k < 3; k++) {
        const c = part(d, g(10), g(10));
        if (rnd(2)) c.rot = 90;
      }
      for (let k = 0; k < 8; k++) {
        const a = { x: g(10), y: g(10) };
        const b = rnd(2) ? { x: a.x, y: g(10) } : { x: g(10), y: a.y };
        if (a.x === b.x && a.y === b.y) continue;
        const bend = rnd(3) === 0 ? [{ x: b.x, y: a.y }] : [];
        wire(d, F(a.x, a.y), F(b.x + (bend.length ? 0 : 0), b.y + (bend.length ? 20 : 0)), bend);
      }
      const before = pinNets(d);
      const out = joinTouches(d);
      expect(pinNets(out), `round ${round}`).toEqual(before);
      // and the drawing is unchanged: every point of every wire is still drawn
      const cover = (x: CircuitDoc) => {
        const pts = new Set<string>();
        for (const w of Object.values(x.items)) if (w.type === 'wire') for (const p of wirePolyline(x, w)) pts.add(`${p.x},${p.y}`);
        return pts;
      };
      for (const p of cover(d)) {
        const [x, y] = p.split(',').map(Number);
        const on = [...Object.values(out.items)].some((w) => w.type === 'wire' && wirePolyline(out, w).some((q, i, all) => i > 0 && Math.abs((all[i - 1].x - x) * (q.y - y) - (all[i - 1].y - y) * (q.x - x)) < 1e-6 && Math.min(all[i - 1].x, q.x) <= x && x <= Math.max(all[i - 1].x, q.x) && Math.min(all[i - 1].y, q.y) <= y && y <= Math.max(all[i - 1].y, q.y)));
        expect(on, `round ${round}: ${p}`).toBe(true);
      }
    }
  });
});

describe('unsoldering', () => {
  it('pulls a branch a grid step clear of the run, so it really lets go', () => {
    const d = createDoc();
    wire(d, F(0, 0), F(200, 0));
    const branch = wire(d, F(100, 0), F(100, 100));
    const out = JSON.parse(JSON.stringify(joinTouches(d))) as CircuitDoc;
    const j = Object.values(out.items).find((i) => i.type === 'junction')!;
    unsolderJunction(out, j.id);
    expect(wireNets(out)).toHaveLength(2);
    expect((out.items[branch.id] as WireItem).a).toEqual({ kind: 'free', x: 100, y: out.settings.grid });
  });
});

describe('SVG', () => {
  const black = { width: 1, color: '#000000', dashed: false, closed: false };

  it('an imported drawing of touching lines comes in as one connected net', () => {
    const d = createDoc();
    const ids = insertSvgDrawing(d, {
      lines: [
        { ...black, pts: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
        { ...black, pts: [{ x: 100, y: 0 }, { x: 100, y: 100 }] },
        { ...black, pts: [{ x: 200, y: 0 }, { x: 200, y: 100 }] },
      ],
      boxes: [],
      dots: [],
      texts: [],
    }, { x: 0, y: 0 });
    expect(ids.length).toBeGreaterThan(0);
    expect(wireNets(d)).toHaveLength(1);
  });

  it('an exported tee is drawn with its dot, even when nothing recorded it yet', () => {
    const d = createDoc();
    wire(d, F(0, 0), F(200, 0));
    wire(d, F(100, 0), F(100, 100));
    const dots = (svg: string) => (/<g class="layer-dots">([\s\S]*?)<\/g>/.exec(svg)?.[1].match(/<circle/g) ?? []).length;
    expect(dots(exportSvg(d, { theme: 'light', background: false, padding: 10 }).svg)).toBe(1);
    // the document itself is left alone
    expect(Object.values(d.items).some((i) => i.type === 'junction')).toBe(false);
  });
});

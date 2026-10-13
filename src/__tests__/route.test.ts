import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import { componentBounds, segmentIntersectsRect } from '../model/geometry';
import { getSymbol } from '../model/registry';
import { routeLeg, routeObstacles } from '../model/route';
import type { CircuitDoc, ComponentItem, Point, WireItem } from '../model/types';
import { commitWire, type WireTarget } from '../model/wireCommit';
import { endpointInfo, wirePolyline } from '../model/wires';

const G = 10;

function place(doc: CircuitDoc, sym: string, x: number, y: number, rot: 0 | 90 | 180 | 270 = 0): ComponentItem {
  const c = makeComponent(doc, sym, x, y);
  c.rot = rot;
  doc.items[c.id] = c;
  return c;
}

function portTarget(doc: CircuitDoc, comp: string, port: string): WireTarget {
  const info = endpointInfo(doc, { kind: 'port', comp, port })!;
  return { kind: 'port', comp, port, pt: { ...info.pt }, dir: { ...info.dir } };
}

const isOrtho = (pts: Point[]) => pts.slice(1).every((q, i) => q.x === pts[i].x || q.y === pts[i].y);

/** Whether a polyline crosses the inside of a component body (touching a pin on its edge is fine). */
function crossesBody(doc: CircuitDoc, c: ComponentItem, pts: Point[]): boolean {
  const r = componentBounds(c, getSymbol(doc, c.symbol));
  const inner = { x: r.x + 0.5, y: r.y + 0.5, w: r.w - 1, h: r.h - 1 };
  return pts.slice(1).some((q, i) => segmentIntersectsRect(pts[i], q, inner));
}

describe('routeLeg', () => {
  it('draws a plain L in the preferred posture when nothing is in the way', () => {
    const obs = routeObstacles(createDoc());
    expect(routeLeg(obs, { x: 0, y: 0 }, { x: 100, y: 50 }, { grid: G, hFirst: true })).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
    ]);
    expect(routeLeg(obs, { x: 0, y: 0 }, { x: 100, y: 50 }, { grid: G, hFirst: false })).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ]);
  });

  it('goes around an instance body instead of over it', () => {
    const doc = createDoc();
    const r = place(doc, 'resistor', 200, 100);
    const pts = routeLeg(routeObstacles(doc), { x: 100, y: 100 - 50 }, { x: 300, y: 100 - 50 }, { grid: G, hFirst: true })!;
    expect(pts).toBeTruthy();
    // straight line above the body is free
    expect(pts).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 50 },
    ]);
    const through = routeLeg(routeObstacles(doc), { x: 100, y: 100 }, { x: 300, y: 100 }, { grid: G, hFirst: true })!;
    expect(isOrtho(through)).toBe(true);
    expect(crossesBody(doc, r, through)).toBe(false);
  });

  it('never runs through a terminal it is not connected to', () => {
    const doc = createDoc();
    const r = place(doc, 'resistor', 200, 100, 90); // vertical: pins at (200,60) and (200,140)
    const pins = getSymbol(doc, r.symbol).ports.map((p) => endpointInfo(doc, { kind: 'port', comp: r.id, port: p.id })!.pt);
    const pts = routeLeg(routeObstacles(doc), { x: 200, y: 0 }, { x: 200, y: 200 }, { grid: G, hFirst: false })!;
    for (const pin of pins) {
      const touches = pts.slice(1).some((q, i) => {
        const a = pts[i];
        const onV = a.x === q.x && a.x === pin.x && pin.y >= Math.min(a.y, q.y) && pin.y <= Math.max(a.y, q.y);
        const onH = a.y === q.y && a.y === pin.y && pin.x >= Math.min(a.x, q.x) && pin.x <= Math.max(a.x, q.x);
        return onV || onH;
      });
      expect(touches).toBe(false);
    }
    expect(crossesBody(doc, r, pts)).toBe(false);
  });

  it('stays off existing wires rather than running along them', () => {
    const doc = createDoc();
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: 0, y: 100 }, b: { kind: 'free', x: 300, y: 100 }, pts: [] };
    doc.items[w.id] = w;
    // from a point on the wire, heading along it: should leave perpendicular, not overlap it
    const pts = routeLeg(routeObstacles(doc), { x: 100, y: 100 }, { x: 200, y: 50 }, { grid: G, hFirst: true })!;
    expect(pts[1].x).toBe(100);
  });

  it('leaves a pin along its lead', () => {
    const doc = createDoc();
    const r = place(doc, 'resistor', 200, 100); // pin 2 at (240,100) pointing right
    const t = portTarget(doc, r.id, '2');
    const pts = routeLeg(routeObstacles(doc), t.pt, { x: 300, y: 0 }, { grid: G, hFirst: false, startDir: t.kind === 'port' ? t.dir : undefined })!;
    expect(pts[1].y).toBe(100);
    expect(pts[1].x).toBeGreaterThan(240);
  });
});

describe('commitWire with routing', () => {
  it('connects two pins facing away from each other without crossing either body', () => {
    const doc = createDoc();
    const a = place(doc, 'resistor', 100, 100);
    const b = place(doc, 'resistor', 300, 100);
    // pin 1 of a (left, x=60) to pin 2 of b (right, x=340): a straight line would cut both bodies
    const id = commitWire(doc, portTarget(doc, a.id, '1'), portTarget(doc, b.id, '2'), { routeGrid: G })!;
    expect(id).toBeTruthy();
    const pts = wirePolyline(doc, doc.items[id] as WireItem);
    expect(isOrtho(pts)).toBe(true);
    expect(crossesBody(doc, a, pts)).toBe(false);
    expect(crossesBody(doc, b, pts)).toBe(false);
  });
});

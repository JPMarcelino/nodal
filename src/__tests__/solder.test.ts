import { describe, expect, it } from 'vitest';
import { applySolder } from '../canvas/solder';
import type { SceneData } from '../canvas/Scene';
import { computeHotSpots } from '../model/hotspots';
import { createDoc, makeComponent, uid } from '../model/doc';
import { solderWires } from '../model/ops';
import type { CircuitDoc, JunctionItem, Point, WireItem } from '../model/types';
import { portPosition, wireCrossings, wirePolyline, type Crossing } from '../model/wires';

function freeWire(doc: CircuitDoc, ax: number, ay: number, bx: number, by: number): WireItem {
  const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'free', x: ax, y: ay }, b: { kind: 'free', x: bx, y: by }, pts: [] };
  doc.items[w.id] = w;
  return w;
}

function polysOf(doc: CircuitDoc): Map<string, Point[]> {
  const m = new Map<string, Point[]>();
  for (const it of Object.values(doc.items)) if (it.type === 'wire') m.set(it.id, wirePolyline(doc, it));
  return m;
}

function sceneData(crossings: Crossing[] = []): SceneData {
  return { polys: new Map(), hops: new Map(), crossings, layers: new Map(), portDegree: new Map(), junctionDegree: new Map(), touching: new Set(), touchCells: new Map() };
}

const snap = (doc: CircuitDoc) => JSON.parse(JSON.stringify(doc));

describe('applySolder respects locks', () => {
  it('solders an unlocked crossing (success path)', () => {
    const doc = createDoc();
    freeWire(doc, 0, 50, 100, 50);
    freeWire(doc, 50, 0, 50, 100);
    const data = sceneData(wireCrossings(polysOf(doc)));
    expect(applySolder(doc, { kind: 'crossing', pt: { x: 50, y: 50 } }, data)).toBeNull();
    expect(Object.values(doc.items).filter((i) => i.type === 'junction')).toHaveLength(1);
  });

  it('refuses a crossing when any wire there is locked', () => {
    const doc = createDoc();
    freeWire(doc, 0, 50, 100, 50);
    const v = freeWire(doc, 50, 0, 50, 100);
    v.locked = true;
    const data = sceneData(wireCrossings(polysOf(doc)));
    expect(data.crossings).toHaveLength(1);
    const before = snap(doc);
    expect(applySolder(doc, { kind: 'crossing', pt: { x: 50, y: 50 } }, data)).toBe('Locked wires cannot be soldered');
    expect(snap(doc)).toEqual(before);
  });

  it('refuses a touch when the loose wire is locked', () => {
    const doc = createDoc();
    freeWire(doc, 0, 0, 200, 0);
    const branch = freeWire(doc, 50, 0, 50, 100);
    const t = computeHotSpots(doc, polysOf(doc), []).find((h) => h.kind === 'touch');
    expect(t?.kind).toBe('touch');
    if (t?.kind !== 'touch') return;
    expect(t.wire).toBe(branch.id);
    (doc.items[t.wire] as WireItem).locked = true;
    const before = snap(doc);
    expect(applySolder(doc, t, sceneData())).toBe('Locked wires cannot be soldered');
    expect(snap(doc)).toEqual(before);
  });

  it('refuses a touch when the wire it rests on is locked', () => {
    const doc = createDoc();
    const top = freeWire(doc, 0, 0, 200, 0);
    freeWire(doc, 50, 0, 50, 100);
    const t = computeHotSpots(doc, polysOf(doc), []).find((h) => h.kind === 'touch');
    expect(t?.kind).toBe('touch');
    if (t?.kind !== 'touch') return;
    expect(t.target.kind).toBe('wire');
    top.locked = true;
    const before = snap(doc);
    expect(applySolder(doc, t, sceneData())).toBe('Locked wires cannot be soldered');
    expect(snap(doc)).toEqual(before);
  });

  it('refuses a touch when the junction it rests on is locked', () => {
    const doc = createDoc();
    const w = freeWire(doc, 0, 0, 100, 0);
    const jid = uid('j');
    const j: JunctionItem = { id: jid, type: 'junction', x: 100, y: 0, locked: true };
    doc.items[jid] = j;
    const t = computeHotSpots(doc, polysOf(doc), []).find((h) => h.kind === 'touch');
    expect(t?.kind).toBe('touch');
    if (t?.kind !== 'touch') return;
    expect(t.wire).toBe(w.id);
    expect(t.target).toEqual({ kind: 'junction', id: jid });
    const before = snap(doc);
    expect(applySolder(doc, t, sceneData())).toBe('Locked wires cannot be soldered');
    expect(snap(doc)).toEqual(before);
  });

  it('refuses a pinTouch when the wire is locked', () => {
    const doc = createDoc();
    const c = makeComponent(doc, 'resistor', 100, 100);
    doc.items[c.id] = c;
    const at = portPosition(doc, c, '1')!;
    const w = freeWire(doc, at.pt.x - 100, at.pt.y, at.pt.x + 100, at.pt.y);
    w.locked = true;
    const before = snap(doc);
    expect(applySolder(doc, { kind: 'pinTouch', pt: { ...at.pt }, comp: c.id, port: '1', wire: w.id }, sceneData())).toBe(
      'Locked wires cannot be soldered',
    );
    expect(snap(doc)).toEqual(before);
  });

  it('refuses to unsolder a locked junction', () => {
    const doc = createDoc();
    const h = freeWire(doc, 0, 50, 100, 50);
    const v = freeWire(doc, 50, 0, 50, 100);
    const jid = solderWires(doc, [h.id, v.id], { x: 50, y: 50 })!;
    (doc.items[jid] as JunctionItem).locked = true;
    const before = snap(doc);
    expect(applySolder(doc, { kind: 'junction', pt: { x: 50, y: 50 }, id: jid }, sceneData())).toBe('Locked wires cannot be unsoldered');
    expect(snap(doc)).toEqual(before);
  });

  it('refuses to unsolder a junction with a locked wire attached', () => {
    const doc = createDoc();
    const h = freeWire(doc, 0, 50, 100, 50);
    const v = freeWire(doc, 50, 0, 50, 100);
    const jid = solderWires(doc, [h.id, v.id], { x: 50, y: 50 })!;
    // one of the four pieces still runs through the junction: locking it must block the unsolder
    (doc.items[h.id] as WireItem).locked = true;
    const before = snap(doc);
    expect(applySolder(doc, { kind: 'junction', pt: { x: 50, y: 50 }, id: jid }, sceneData())).toBe('Locked wires cannot be unsoldered');
    expect(snap(doc)).toEqual(before);
  });

  it('refuses to unsolder a pin with a locked wire on it', () => {
    const doc = createDoc();
    const c = makeComponent(doc, 'resistor', 100, 100);
    doc.items[c.id] = c;
    const at = portPosition(doc, c, '1')!;
    const w: WireItem = { id: uid('w'), type: 'wire', a: { kind: 'port', comp: c.id, port: '1' }, b: { kind: 'free', x: at.pt.x + 100, y: at.pt.y }, pts: [] };
    doc.items[w.id] = w;
    w.locked = true;
    const before = snap(doc);
    expect(applySolder(doc, { kind: 'pin', pt: { ...at.pt }, comp: c.id, port: '1', ends: 1 }, sceneData())).toBe('Locked wires cannot be unsoldered');
    expect(snap(doc)).toEqual(before);
  });
});

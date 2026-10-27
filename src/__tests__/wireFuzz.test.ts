import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent } from '../model/doc';
import { cleanup, deleteItems, splitWire, translateItems } from '../model/ops';
import { settleEdit } from '../model/settle';
import type { CircuitDoc, Endpoint, WireItem } from '../model/types';
import { moveWireSegment } from '../model/wireCommit';
import { instanceSymbol } from '../model/registry';
import { wirePolyline } from '../model/wires';

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];

function build(): CircuitDoc {
  const d = createDoc();
  const ports: { comp: string; port: string }[] = [];
  for (let i = 0; i < 6; i++) {
    const c = makeComponent(d, pick(['resistor', 'capacitor', 'gnd']), 100 + i * 120, 100 + (i % 2) * 100);
    d.items[c.id] = c;
    for (const p of instanceSymbol(d, c).ports) ports.push({ comp: c.id, port: p.id });
  }
  const ends: Endpoint[] = ports.map((p) => ({ kind: 'port', ...p }));
  for (let i = 0; i < 10; i++) {
    const pt = { x: Math.round(rnd() * 8) * 20, y: Math.round(rnd() * 8) * 20 };
    ends.push({ kind: 'free', ...pt });
    if (rnd() < 0.5) {
      const id = `j${i}`;
      d.items[id] = { id, type: 'junction', x: pt.x, y: pt.y };
      ends.push({ kind: 'junction', id });
    }
  }
  for (let i = 0; i < 14; i++) {
    const w: WireItem = { id: `w${i}`, type: 'wire', a: pick(ends), b: pick(ends), pts: [] };
    if (w.a.kind === 'junction' && w.b.kind === 'junction' && w.a.id === w.b.id) continue;
    d.items[w.id] = w;
  }
  return d;
}

describe('fuzz: cleanup keeps every reference valid', () => {
  it('120 random documents survive edits and cleanup', () => {
    for (let round = 0; round < 120; round++) {
      let d = build();
      for (let step = 0; step < 6; step++) {
        const ids = Object.values(d.items).filter((i) => i.type === 'wire').map((i) => i.id);
        if (!ids.length) break;
        const id = pick(ids);
        const w = d.items[id] as WireItem;
        const full = wirePolyline(d, w);
        const prev = d;
        const op = Math.floor(rnd() * 4);
        const seg = Math.floor(rnd() * Math.max(1, full.length - 1));
        const dx = rnd() < 0.5 ? 20 : 0;
        const dy = rnd() < 0.5 ? 20 : 0;
        const cut = full[Math.floor(rnd() * Math.max(1, full.length))];
        const next = produce(prev, (draft) => {
          const doc = draft as CircuitDoc;
          if (op === 0 && full.length > 1) moveWireSegment(doc, id, full, seg, dx, dy, prev);
          else if (op === 1 && full.length > 1) splitWire(doc, id, seg, cut);
          else if (op === 2) deleteItems(doc, [id]);
          else {
            const c = Object.values(doc.items).find((i) => i.type === 'component');
            if (c) translateItems(prev, doc, new Set([c.id]), 20, 20);
          }
        });
        d = produce(settleEdit(prev, next), (draft) => cleanup(draft as CircuitDoc));
        for (const it of Object.values(d.items)) {
          if (it.type === 'wire') {
            const ok = (ep: Endpoint) =>
              ep.kind === 'free'
                ? Number.isFinite(ep.x) && Number.isFinite(ep.y)
                : ep.kind === 'junction'
                  ? !!d.items[ep.id] && d.items[ep.id].type === 'junction'
                  : !!d.items[ep.comp] && d.items[ep.comp].type === 'component';
            expect(ok(it.a) && ok(it.b), `round ${round} wire ${it.id}`).toBe(true);
            for (const p of it.pts) expect(Number.isFinite(p.x) && Number.isFinite(p.y), `round ${round} pts`).toBe(true);
            expect(wirePolyline(d, it).length, `round ${round} poly ${it.id}`).toBeGreaterThanOrEqual(2);
          }
          if (it.type === 'junction') {
            const ends = Object.values(d.items).filter((x): x is WireItem => x.type === 'wire').reduce((n, x) => n + (x.a.kind === 'junction' && x.a.id === it.id ? 1 : 0) + (x.b.kind === 'junction' && x.b.id === it.id ? 1 : 0), 0);
            expect(ends, `round ${round} junction ${it.id}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

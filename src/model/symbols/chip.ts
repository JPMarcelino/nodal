import { parseFields } from './dsl';
import type { FieldDef, PortDef, Prim, SymbolDef } from '../types';

export interface ChipSpec {
  left?: string[];
  right?: string[];
  top?: string[];
  bottom?: string[];
  title?: string;
  /** Minimum body width (multiple of 20). */
  minW?: number;
  numbers?: boolean;
}

/** "~Q" renders as Q with an overbar; the port id becomes "nQ". */
const display = (n: string) => (n.startsWith('~') ? [...n.slice(1)].map((c) => c + '̅').join('') : n);
const portId = (n: string) => (n.startsWith('~') ? 'n' + n.slice(1) : n).replace(/[\s:,]/g, '_');
const isClock = (n: string) => /^(CLK|CK|CP|SRCLK|RCLK|SCK|SCL)$/i.test(n);

/** Builds an IC-style box with pins, leads, names and optional pin numbers. Everything lands on the 10px grid. */
export function buildChip(spec: ChipSpec): { w: number; h: number; prims: Prim[]; ports: PortDef[] } {
  const L = spec.left ?? [];
  const R = spec.right ?? [];
  const T = spec.top ?? [];
  const B = spec.bottom ?? [];
  const lead = 20;
  const rows = Math.max(L.length, R.length, 1);
  const cols = Math.max(T.length, B.length, 0);
  const nameW = (arr: string[]) => Math.max(0, ...arr.map((s) => display(s).length));
  const textW = (nameW(L) + nameW(R)) * 6 + (spec.title ? Math.max(0, spec.title.length * 6.5 - 10) : 0) + 24;
  const r20 = (v: number) => Math.ceil(v / 20) * 20;
  const bodyW = Math.max(spec.minW ?? 60, r20(textW), (cols + 1) * 20);
  const bodyH = Math.max(40, (rows + 1) * 20);
  const w = bodyW + (L.length ? lead : 0) + (R.length ? lead : 0);
  const h = bodyH + (T.length ? lead : 0) + (B.length ? lead : 0);
  const x0 = L.length ? lead : 0;
  const y0 = T.length ? lead : 0;
  const x1 = w - (R.length ? lead : 0);
  const y1 = h - (B.length ? lead : 0);
  const prims: Prim[] = [{ t: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0, rx: 2, fill: 'bg' }];
  const ports: PortDef[] = [];
  const used = new Set<string>();
  let num = 1;
  const add = (name: string, x: number, y: number, side: PortDef['side']) => {
    let id = portId(name);
    while (used.has(id)) id += '_';
    used.add(id);
    ports.push({ id, name: display(name), x, y, side });
    return num++;
  };
  const clk = (x: number, y: number, dir: 1 | -1) => prims.push({ t: 'line', pts: [x, y - 4, x + 6 * dir, y, x, y + 4], w: 1.5 });
  const numbers = spec.numbers !== false;
  L.forEach((n, i) => {
    const y = y0 + 20 + i * 20;
    prims.push({ t: 'line', pts: [0, y, x0, y] });
    const ck = isClock(n);
    if (ck) clk(x0, y, 1);
    prims.push({ t: 'text', x: x0 + (ck ? 9 : 4), y: y + 3.5, size: 9, anchor: 'start', text: display(n) });
    const k = add(n, 0, y, 'left');
    if (numbers) prims.push({ t: 'text', x: x0 / 2, y: y - 3, size: 7, anchor: 'middle', text: String(k) });
  });
  B.forEach((n, i) => {
    const x = x0 + 20 + i * 20;
    prims.push({ t: 'line', pts: [x, y1, x, h] });
    prims.push({ t: 'text', x, y: y1 - 4, size: 7.5, anchor: 'middle', text: display(n) });
    add(n, x, h, 'bottom');
  });
  for (let i = R.length - 1; i >= 0; i--) {
    const n = R[i];
    const y = y0 + 20 + i * 20;
    prims.push({ t: 'line', pts: [x1, y, w, y] });
    prims.push({ t: 'text', x: x1 - 4, y: y + 3.5, size: 9, anchor: 'end', text: display(n) });
    const k = add(n, w, y, 'right');
    if (numbers) prims.push({ t: 'text', x: x1 + lead / 2, y: y - 3, size: 7, anchor: 'middle', text: String(k) });
  }
  for (let i = T.length - 1; i >= 0; i--) {
    const n = T[i];
    const x = x0 + 20 + i * 20;
    prims.push({ t: 'line', pts: [x, 0, x, y0] });
    prims.push({ t: 'text', x, y: y0 + 10, size: 7.5, anchor: 'middle', text: display(n) });
    add(n, x, 0, 'top');
  }
  if (spec.title) {
    const cy = (y0 + y1) / 2 + 4;
    // keep the title clear of pin names when only one side has pins
    if (L.length && !R.length) prims.push({ t: 'text', x: x1 - 6, y: cy, size: 10, anchor: 'end', text: spec.title });
    else if (R.length && !L.length) prims.push({ t: 'text', x: x0 + 6, y: cy, size: 10, anchor: 'start', text: spec.title });
    else prims.push({ t: 'text', x: (x0 + x1) / 2, y: cy, size: 10, anchor: 'middle', text: spec.title });
  }
  return { w, h, prims, ports };
}

export function chip(
  id: string,
  name: string,
  category: string,
  spec: ChipSpec & { prefix?: string; value?: string; keywords?: string; fields?: FieldDef[] | string },
): SymbolDef {
  const b = buildChip(spec);
  return {
    id,
    name,
    category,
    w: b.w,
    h: b.h,
    prims: b.prims,
    ports: b.ports,
    prefix: spec.prefix ?? 'U',
    value: spec.value,
    keywords: spec.keywords,
    fields: parseFields(spec.fields),
  };
}

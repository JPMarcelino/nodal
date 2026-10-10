import type { Fill, FieldDef, PortDef, Prim, Side, SymbolDef } from '../types';

/**
 * Symbol DSL — one command per line (or separated by `;`). Coordinates are in
 * symbol-local pixels, origin top-left, y pointing down.
 *
 *   W w                      stroke width for following commands (default 2)
 *   L x1 y1 x2 y2 …          open polyline
 *   D x1 y1 x2 y2 …          dashed polyline
 *   G x1 y1 x2 y2 …          closed polygon   (GF = filled, GB = background-filled)
 *   R x y w h [rx]           rectangle        (RF, RB)
 *   C cx cy r                circle           (CF, CB)
 *   E cx cy rx ry            ellipse          (EF, EB)
 *   A cx cy r a1 a2          arc, degrees clockwise from +x, drawn a1 → a2
 *   P <svg path data>        raw SVG path     (PF, PB)
 *   T x y size s|m|e text…   text (anchor start / middle / end)
 *   # comment
 *
 * Ports:  "name:x,y name2:x,y" — side is inferred from the closest edge.
 */
export function parseDraw(src: string): Prim[] {
  const prims: Prim[] = [];
  let w: number | undefined;
  for (const raw of src.split(/[\n;]/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z]{1,2})\s*(.*)$/.exec(line);
    if (!m) throw new Error(`Cannot parse "${line}"`);
    const [, cmd, rest] = m;
    const op = cmd[0];
    const mod = cmd[1];
    const fill: Fill = mod === 'F' ? 'solid' : mod === 'B' ? 'bg' : 'none';
    if (op === 'P') {
      prims.push({ t: 'path', d: rest, fill, w });
      continue;
    }
    if (op === 'T') {
      const tm = /^(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s+([sme])\s+(.*)$/.exec(rest);
      if (!tm) throw new Error(`Bad text "${line}"`);
      const anchor = tm[4] === 's' ? 'start' : tm[4] === 'e' ? 'end' : 'middle';
      prims.push({ t: 'text', x: +tm[1], y: +tm[2], size: +tm[3], anchor, text: tm[5] });
      continue;
    }
    const n = rest.split(/[\s,]+/).filter(Boolean).map(Number);
    if (n.some((v) => Number.isNaN(v))) throw new Error(`Bad number in "${line}"`);
    switch (op) {
      case 'W':
        w = n[0];
        break;
      case 'L':
        need(n, 4, line);
        prims.push({ t: 'line', pts: n, w });
        break;
      case 'D':
        need(n, 4, line);
        prims.push({ t: 'line', pts: n, w, dash: true });
        break;
      case 'G':
        need(n, 6, line);
        prims.push({ t: 'poly', pts: n, fill, w });
        break;
      case 'R':
        need(n, 4, line);
        prims.push({ t: 'rect', x: n[0], y: n[1], w: n[2], h: n[3], rx: n[4], fill, sw: w });
        break;
      case 'C':
        need(n, 3, line);
        prims.push({ t: 'circle', cx: n[0], cy: n[1], r: n[2], fill, w });
        break;
      case 'E':
        need(n, 4, line);
        prims.push({ t: 'ellipse', cx: n[0], cy: n[1], rx: n[2], ry: n[3], fill, w });
        break;
      case 'A':
        need(n, 5, line);
        prims.push({ t: 'arc', cx: n[0], cy: n[1], r: n[2], a1: n[3], a2: n[4], w });
        break;
      default:
        throw new Error(`Unknown command "${cmd}"`);
    }
  }
  return prims;
}

function need(n: number[], count: number, line: string) {
  if (n.length < count) throw new Error(`"${line}" needs at least ${count} numbers`);
}

export function parsePorts(src: string, w: number, h: number): PortDef[] {
  const ports: PortDef[] = [];
  for (const tok of src.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(.+):(-?[\d.]+),(-?[\d.]+)$/.exec(tok);
    if (!m) throw new Error(`Bad port "${tok}" (expected name:x,y)`);
    const x = +m[2];
    const y = +m[3];
    ports.push({ id: m[1], name: m[1].replace(/_/g, ' '), x, y, side: inferSide(x, y, w, h) });
  }
  return ports;
}

export function inferSide(x: number, y: number, w: number, h: number): Side {
  const d: [Side, number][] = [
    ['left', x],
    ['right', w - x],
    ['top', y],
    ['bottom', h - y],
  ];
  d.sort((a, b) => a[1] - b[1]);
  return d[0][0];
}

export interface SymbolSpec {
  w: number;
  h: number;
  draw: string;
  ports: string;
  prefix: string;
  value?: string;
  fields?: FieldDef[] | string;
  keywords?: string;
  hideLabels?: boolean;
  valueIsLabel?: boolean;
}

/** Field shorthand: "Power rating=0.25W, Tolerance=±5%". */
export function parseFields(f: FieldDef[] | string | undefined): FieldDef[] | undefined {
  if (!f) return undefined;
  if (Array.isArray(f)) return f;
  return f
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [label, def] = s.split('=').map((p) => p.trim());
      return { key: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label, default: def };
    });
}

export function sym(id: string, name: string, category: string, s: SymbolSpec): SymbolDef {
  return {
    id,
    name,
    category,
    keywords: s.keywords,
    w: s.w,
    h: s.h,
    prims: parseDraw(s.draw),
    ports: parsePorts(s.ports, s.w, s.h),
    prefix: s.prefix,
    value: s.value,
    fields: parseFields(s.fields),
    hideLabels: s.hideLabels,
    valueIsLabel: s.valueIsLabel,
  };
}

/** Serialisable source for a user symbol (round-trips through the symbol editor). */
export interface SymbolSource {
  id: string;
  name: string;
  category: string;
  w: number;
  h: number;
  draw: string;
  ports: string;
  prefix: string;
  value: string;
  fields: string;
  keywords: string;
}

export function compileSource(src: SymbolSource): SymbolDef {
  const def = sym(src.id, src.name || 'Untitled', src.category || 'My symbols', {
    w: src.w,
    h: src.h,
    draw: src.draw,
    ports: src.ports,
    prefix: src.prefix || 'U',
    value: src.value,
    fields: src.fields,
    keywords: src.keywords,
  });
  def.custom = true;
  def.source = JSON.stringify(src);
  return def;
}

export function sourceOf(def: SymbolDef): SymbolSource {
  if (def.source) {
    try {
      return JSON.parse(def.source) as SymbolSource;
    } catch {
      /* fall through */
    }
  }
  return {
    id: def.id,
    name: def.name,
    category: def.category,
    w: def.w,
    h: def.h,
    draw: primsToDsl(def.prims),
    ports: def.ports.map((p) => `${p.id}:${p.x},${p.y}`).join(' '),
    prefix: def.prefix,
    value: def.value ?? '',
    fields: (def.fields ?? []).map((f) => (f.default ? `${f.label}=${f.default}` : f.label)).join(', '),
    keywords: def.keywords ?? '',
  };
}

const r = (v: number) => +v.toFixed(2);
const mod = (f: Fill) => (f === 'solid' ? 'F' : f === 'bg' ? 'B' : '');

/** Converts primitives back into DSL text (used to edit built-in symbols). */
export function primsToDsl(prims: Prim[]): string {
  const out: string[] = [];
  let w: number | undefined;
  const width = (pw: number | undefined) => {
    if (pw !== w) {
      out.push(`W ${pw ?? 2}`);
      w = pw;
    }
  };
  for (const p of prims) {
    switch (p.t) {
      case 'line':
        width(p.w);
        out.push(`${p.dash ? 'D' : 'L'} ${p.pts.map(r).join(' ')}`);
        break;
      case 'poly':
        width(p.w);
        out.push(`G${mod(p.fill)} ${p.pts.map(r).join(' ')}`);
        break;
      case 'rect':
        width(p.sw);
        out.push(`R${mod(p.fill)} ${[p.x, p.y, p.w, p.h].map(r).join(' ')}${p.rx ? ` ${p.rx}` : ''}`);
        break;
      case 'circle':
        width(p.w);
        out.push(`C${mod(p.fill)} ${r(p.cx)} ${r(p.cy)} ${r(p.r)}`);
        break;
      case 'ellipse':
        width(p.w);
        out.push(`E${mod(p.fill)} ${r(p.cx)} ${r(p.cy)} ${r(p.rx)} ${r(p.ry)}`);
        break;
      case 'arc':
        width(p.w);
        out.push(`A ${r(p.cx)} ${r(p.cy)} ${r(p.r)} ${r(p.a1)} ${r(p.a2)}`);
        break;
      case 'path':
        width(p.w);
        out.push(`P${mod(p.fill)} ${p.d}`);
        break;
      case 'text':
        out.push(`T ${r(p.x)} ${r(p.y)} ${p.size} ${p.anchor[0]} ${p.text}`);
        break;
    }
  }
  return out.join('\n');
}

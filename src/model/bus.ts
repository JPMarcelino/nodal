import { instanceSymbol } from './registry';
import type { CircuitDoc, ComponentItem, DocSettings, WireItem, WireStyle } from './types';

/** Look of a bus where neither the document nor the bus says otherwise. */
export const DEFAULT_BUS_STYLE: Partial<WireStyle> = { width: 5 };

/** Most signals one bus name expands to (guards against "D[0..99999]"). */
const MAX_MEMBERS = 256;

/** Effective style of a wire: document wire defaults, then bus defaults for a bus, then its own overrides. */
export function wireStyleFor(settings: DocSettings, w: Pick<WireItem, 'bus' | 'style'>): WireStyle {
  return w.bus ? { ...settings.wire, ...DEFAULT_BUS_STYLE, ...settings.bus, ...w.style } : { ...settings.wire, ...w.style };
}

/**
 * Signals carried by a bus name. A range expands either way round and keeps
 * any text after it: "D[0..7]", "A[15:0]", "Q[3-0]_N". Commas (optionally in
 * braces) list members: "{CLK, RST, D[0..3]}". A plain name is one signal.
 */
export function busMembers(name: string | undefined): string[] {
  const text = (name ?? '').trim().replace(/^\{(.*)\}$/, '$1');
  if (!text) return [];
  const out: string[] = [];
  for (const part of splitTop(text)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(.*?)\[\s*(\d+)\s*(?:\.\.|:|-)\s*(\d+)\s*\](.*)$/.exec(p);
    if (!m) {
      out.push(p);
    } else {
      const [, pre, a, b, post] = m;
      const from = Number(a);
      const to = Number(b);
      const step = from <= to ? 1 : -1;
      for (let i = from; ; i += step) {
        out.push(`${pre}${i}${post}`);
        if (i === to || out.length >= MAX_MEMBERS) break;
      }
    }
    if (out.length >= MAX_MEMBERS) break;
  }
  return [...new Set(out)].slice(0, MAX_MEMBERS);
}

/** Splits on commas that are not inside brackets. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

export interface BusNet {
  /** Bus wires joined end to end through junctions. */
  wires: string[];
  /** Junctions the bus passes through or ends on. */
  junctions: string[];
  /** First name found on the bus wires ('' when none is named). */
  name: string;
  members: string[];
  /** Plain wires attached to the bus at one of its junctions, or through a bus entry part. */
  taps: { wire: string; junction: string }[];
  /** Part pins wired straight onto the bus (bus entries excepted). */
  pins: { comp: string; port: string }[];
}

/** Buses of a document, each with the signals it carries and what is attached to it. */
export function busNets(doc: CircuitDoc): BusNet[] {
  const buses = Object.values(doc.items).filter((i): i is WireItem => i.type === 'wire' && !!i.bus);
  if (!buses.length) return [];
  // bus wires that share a junction form one bus
  const parent = new Map<string, string>(buses.map((w) => [w.id, w.id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const byJunction = new Map<string, string[]>();
  for (const w of buses)
    for (const ep of [w.a, w.b]) {
      if (ep.kind !== 'junction') continue;
      const list = byJunction.get(ep.id);
      if (list) {
        parent.set(find(w.id), find(list[0]));
        list.push(w.id);
      } else byJunction.set(ep.id, [w.id]);
    }
  const nets = new Map<string, BusNet>();
  for (const w of buses) {
    const root = find(w.id);
    let n = nets.get(root);
    if (!n) nets.set(root, (n = { wires: [], junctions: [], name: '', members: [], taps: [], pins: [] }));
    n.wires.push(w.id);
    if (!n.name && w.label?.trim()) n.name = w.label.trim();
    for (const ep of [w.a, w.b]) {
      if (ep.kind === 'junction' && !n.junctions.includes(ep.id)) n.junctions.push(ep.id);
      if (ep.kind === 'port' && !n.pins.some((p) => p.comp === ep.comp && p.port === ep.port)) n.pins.push({ comp: ep.comp, port: ep.port });
    }
  }
  const netOfJunction = new Map<string, BusNet>();
  // a bus entry part on the bus passes its other pins on as taps
  const netOfEntryPin = new Map<string, BusNet>();
  for (const n of nets.values()) {
    n.members = busMembers(n.name);
    for (const j of n.junctions) netOfJunction.set(j, n);
    n.pins = n.pins.filter((p) => {
      const c = doc.items[p.comp] as ComponentItem | undefined;
      if (!c || !instanceSymbol(doc, c).prefix.startsWith('#BE')) return true;
      for (const port of instanceSymbol(doc, c).ports) if (port.id !== p.port) netOfEntryPin.set(`${c.id}:${port.id}`, n);
      return false;
    });
  }
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire' || it.bus) continue;
    for (const ep of [it.a, it.b]) {
      const n = ep.kind === 'junction' ? netOfJunction.get(ep.id) : ep.kind === 'port' ? netOfEntryPin.get(`${ep.comp}:${ep.port}`) : undefined;
      if (n && !n.taps.some((t) => t.wire === it.id)) n.taps.push({ wire: it.id, junction: ep.kind === 'junction' ? ep.id : '' });
    }
  }
  return [...nets.values()];
}

/** The bus a wire belongs to (a bus wire) or taps (a plain wire on a bus junction). */
export function busOfWire(nets: BusNet[], wireId: string): BusNet | undefined {
  return nets.find((n) => n.wires.includes(wireId) || n.taps.some((t) => t.wire === wireId));
}

/** First signal of a bus no other tap is named after yet, for naming a new tap. */
export function nextTapName(doc: CircuitDoc, net: BusNet, except?: string): string | null {
  const used = new Set(net.taps.filter((t) => t.wire !== except).map((t) => ((doc.items[t.wire] as WireItem | undefined)?.label ?? '').trim()));
  return net.members.find((m) => !used.has(m)) ?? null;
}

/** Summary of a bus name for the UI: "8 signals: D0 … D7". */
export function describeMembers(members: string[]): string {
  if (!members.length) return 'no signals yet';
  if (members.length === 1) return `1 signal: ${members[0]}`;
  const list = members.length <= 4 ? members.join(', ') : `${members[0]}, ${members[1]} … ${members[members.length - 1]}`;
  return `${members.length} signals: ${list}`;
}

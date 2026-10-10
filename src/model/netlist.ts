import { getSymbol } from './registry';
import type { CircuitDoc, ComponentItem, Endpoint } from './types';

export interface Net {
  name: string;
  wires: string[];
  pins: { comp: string; ref: string; port: string; portName: string }[];
}

const key = (ep: Endpoint, wireId: string, end: string) =>
  ep.kind === 'port' ? `p:${ep.comp}:${ep.port}` : ep.kind === 'junction' ? `j:${ep.id}` : `f:${wireId}:${end}`;

class DSU {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    while (this.parent.get(x) !== r) {
      const n = this.parent.get(x)!;
      this.parent.set(x, r);
      x = n;
    }
    return r;
  }
  union(a: string, b: string) {
    this.parent.set(this.find(a), this.find(b));
  }
}

/** Computes electrical nets. Wires joined by junctions/ports share a net; net labels and rails with equal names are joined. */
export function computeNets(doc: CircuitDoc): Net[] {
  const dsu = new DSU();
  const comps = Object.values(doc.items).filter((i): i is ComponentItem => i.type === 'component');
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    const a = key(it.a, it.id, 'a');
    const b = key(it.b, it.id, 'b');
    dsu.union(`w:${it.id}`, a);
    dsu.union(a, b);
  }
  const labelOf = new Map<string, string>();
  const byLabel = new Map<string, string>();
  for (const c of comps) {
    const def = getSymbol(doc, c.symbol);
    if (!def.valueIsLabel && !def.prefix.startsWith('#PWR')) continue;
    const name = (c.value || def.value || '').trim();
    if (!name) continue;
    for (const p of def.ports) {
      const k = `p:${c.id}:${p.id}`;
      dsu.find(k);
      labelOf.set(k, name);
      const prev = byLabel.get(name);
      if (prev) dsu.union(prev, k);
      else byLabel.set(name, k);
    }
  }
  for (const c of comps) for (const p of getSymbol(doc, c.symbol).ports) dsu.find(`p:${c.id}:${p.id}`);

  const groups = new Map<string, Net>();
  let auto = 1;
  const roots = [...dsu.parent.keys()].map((k) => dsu.find(k));
  for (const root of new Set(roots)) groups.set(root, { name: '', wires: [], pins: [] });
  for (const k of dsu.parent.keys()) {
    const net = groups.get(dsu.find(k))!;
    if (k.startsWith('w:')) net.wires.push(k.slice(2));
    else if (k.startsWith('p:')) {
      const [, comp, port] = k.split(':');
      const c = doc.items[comp] as ComponentItem;
      const def = getSymbol(doc, c.symbol);
      if (def.valueIsLabel || def.prefix.startsWith('#')) {
        if (!net.name && labelOf.has(k)) net.name = labelOf.get(k)!;
        continue;
      }
      net.pins.push({ comp, ref: c.ref, port, portName: def.ports.find((p) => p.id === port)?.name ?? port });
    }
  }
  const nets = [...groups.values()].filter((n) => n.pins.length || n.wires.length || n.name);
  for (const n of nets) if (!n.name) n.name = `N$${auto++}`;
  nets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return nets;
}

/** Net that contains a given wire. */
export function netOfWire(nets: Net[], wireId: string): Net | undefined {
  return nets.find((n) => n.wires.includes(wireId));
}

export function toSpiceNetlist(doc: CircuitDoc): string {
  const nets = computeNets(doc);
  const pinNet = new Map<string, string>();
  for (const n of nets) {
    const name = /^(gnd|0|ground)$/i.test(n.name) ? '0' : n.name.replace(/\s+/g, '_');
    for (const p of n.pins) pinNet.set(`${p.comp}:${p.port}`, name);
  }
  const lines = [`* ${doc.name} — exported from Nodal`, ''];
  for (const c of Object.values(doc.items)) {
    if (c.type !== 'component') continue;
    const def = getSymbol(doc, c.symbol);
    if (def.prefix.startsWith('#') || !def.ports.length) continue;
    const pins = def.ports.map((p) => pinNet.get(`${c.id}:${p.id}`) ?? `NC_${c.ref}_${p.id}`);
    lines.push(`${c.ref} ${pins.join(' ')} ${c.value || def.name.replace(/\s+/g, '_')}`);
  }
  lines.push('', '.end', '');
  return lines.join('\n');
}

export function toBomCsv(doc: CircuitDoc): string {
  const rows = new Map<string, { refs: string[]; value: string; name: string; props: string }>();
  for (const c of Object.values(doc.items)) {
    if (c.type !== 'component') continue;
    const def = getSymbol(doc, c.symbol);
    if (def.prefix.startsWith('#') || def.valueIsLabel) continue;
    const props = Object.entries(c.props)
      .filter(([, v]) => v)
      .map(([k, v]) => `${def.fields?.find((f) => f.key === k)?.label ?? k}: ${v}`)
      .join('; ');
    const k = `${def.id}|${c.value}|${props}`;
    const row = rows.get(k) ?? { refs: [], value: c.value, name: def.name, props };
    row.refs.push(c.ref);
    rows.set(k, row);
  }
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const out = ['Quantity,References,Component,Value,Specifications'];
  const sorted = [...rows.values()].sort((a, b) => a.refs[0].localeCompare(b.refs[0], undefined, { numeric: true }));
  for (const r of sorted) {
    r.refs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    out.push([r.refs.length, esc(r.refs.join(', ')), esc(r.name), esc(r.value), esc(r.props)].join(','));
  }
  return out.join('\n') + '\n';
}

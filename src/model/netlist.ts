import { toWorld } from './geometry';
import { stripMath } from './latex';
import { itemPage, multiPage } from './pages';
import { instanceSymbol } from './registry';
import type { CircuitDoc, ComponentItem, Endpoint } from './types';

export interface Net {
  name: string;
  /** Every distinct label / rail name on the net (more than one means differently named nets are joined). */
  names: string[];
  wires: string[];
  pins: { comp: string; ref: string; port: string; portName: string }[];
}

/**
 * Pins of different parts that sit on exactly the same spot (a ground symbol
 * dropped straight onto a pin, two parts butted together). They are connected
 * just as if a wire joined them. Returns the "comp:port" keys of each group.
 */
export function touchingPins(doc: CircuitDoc): string[][] {
  const at = new Map<string, string[]>();
  for (const c of Object.values(doc.items)) {
    if (c.type !== 'component') continue;
    const def = instanceSymbol(doc, c);
    const page = pageKey(doc, c);
    for (const p of def.ports) {
      const w = toWorld(c, def, p.x, p.y);
      const k = `${page}${Math.round(w.x * 2)},${Math.round(w.y * 2)}`;
      const list = at.get(k);
      if (list) list.push(`${c.id}:${p.id}`);
      else at.set(k, [`${c.id}:${p.id}`]);
    }
  }
  return [...at.values()].filter((g) => new Set(g.map((k) => k.split(':')[0])).size > 1);
}

/** Pins only touch on the same page: with several pages, cell keys carry the page id. */
const pageKey = (doc: CircuitDoc, c: ComponentItem) => (multiPage(doc) ? `${itemPage(doc, c)}|` : '');

function componentPinCells(doc: CircuitDoc, c: ComponentItem): Array<[string, string]> {
  const def = instanceSymbol(doc, c);
  const page = pageKey(doc, c);
  return def.ports.map((p) => {
    const w = toWorld(c, def, p.x, p.y);
    return [`${page}${Math.round(w.x * 2)},${Math.round(w.y * 2)}`, `${c.id}:${p.id}`] as [string, string];
  });
}

export function touchingCells(doc: CircuitDoc): Map<string, string[]> {
  const cells = new Map<string, string[]>();
  for (const c of Object.values(doc.items)) {
    if (c.type !== 'component') continue;
    for (const [cell, key] of componentPinCells(doc, c)) {
      const list = cells.get(cell);
      if (list) list.push(key);
      else cells.set(cell, [key]);
    }
  }
  return cells;
}

export function touchingFromCells(cells: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  for (const keys of cells.values()) {
    if (new Set(keys.map((k) => k.split(':')[0])).size > 1) for (const k of keys) out.add(k);
  }
  return out;
}

export function refreshTouching(
  prevDoc: CircuitDoc,
  prevCells: Map<string, string[]>,
  prevTouching: Set<string>,
  doc: CircuitDoc,
  moved: Set<string>,
): { cells: Map<string, string[]>; touching: Set<string>; same: boolean } {
  const pins = (d: CircuitDoc, id: string) => {
    const c = d.items[id];
    return c && c.type === 'component' ? componentPinCells(d, c).map(([cell, key]) => `${cell} ${key}`).join('\n') : null;
  };
  let same = true;
  for (const id of moved) {
    if (pins(prevDoc, id) !== pins(doc, id)) {
      same = false;
      break;
    }
  }
  if (same) return { cells: prevCells, touching: prevTouching, same: true };
  const cells = new Map(prevCells);
  const before = new Map<string, string[] | undefined>();
  const snap = (cell: string) => {
    if (!before.has(cell)) before.set(cell, cells.get(cell));
  };
  for (const id of moved) {
    const c = prevDoc.items[id];
    if (!c || c.type !== 'component') continue;
    for (const [cell, key] of componentPinCells(prevDoc, c)) {
      snap(cell);
      const list = cells.get(cell);
      if (!list || !list.includes(key)) continue;
      const next = list.filter((k) => k !== key);
      if (next.length) cells.set(cell, next);
      else cells.delete(cell);
    }
  }
  for (const id of moved) {
    const c = doc.items[id];
    if (!c || c.type !== 'component') continue;
    for (const [cell, key] of componentPinCells(doc, c)) {
      snap(cell);
      const list = cells.get(cell);
      if (list) {
        if (!list.includes(key)) cells.set(cell, [...list, key]);
      } else cells.set(cell, [key]);
    }
  }
  const touching = new Set(prevTouching);
  for (const [cell, old] of before) {
    for (const key of old ?? []) touching.delete(key);
    const list = cells.get(cell) ?? [];
    if (new Set(list.map((k) => k.split(':')[0])).size > 1) for (const key of list) touching.add(key);
  }
  return { cells, touching, same: false };
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

/** Computes electrical nets. Wires joined by junctions/ports share a net; wire labels name their net like net-label and rail symbols, and equal names are joined. Hidden labels name the net too. */
export function computeNets(doc: CircuitDoc, opts?: { ignoreLabels?: boolean }): Net[] {
  const dsu = new DSU();
  const comps = Object.values(doc.items).filter((i): i is ComponentItem => i.type === 'component');
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    const a = key(it.a, it.id, 'a');
    const b = key(it.b, it.id, 'b');
    dsu.union(`w:${it.id}`, a);
    dsu.union(a, b);
  }
  for (const group of touchingPins(doc)) for (const k of group.slice(1)) dsu.union(`p:${group[0]}`, `p:${k}`);
  const labelOf = new Map<string, string>();
  const wireLabelOf = new Map<string, string>();
  const byLabel = new Map<string, string>();
  const nameKey = (name: string, k: string) => {
    const prev = byLabel.get(name);
    if (prev) dsu.union(prev, k);
    else byLabel.set(name, k);
  };
  if (!opts?.ignoreLabels) {
    for (const c of comps) {
      const def = instanceSymbol(doc, c);
      if (!def.valueIsLabel && !def.prefix.startsWith('#PWR')) continue;
      const name = (c.value || def.value || '').trim();
      if (!name) continue;
      for (const p of def.ports) {
        const k = `p:${c.id}:${p.id}`;
        dsu.find(k);
        labelOf.set(k, name);
        nameKey(name, k);
      }
    }
    for (const it of Object.values(doc.items)) {
      if (it.type !== 'wire') continue;
      const name = (it.label ?? '').trim();
      if (!name) continue;
      const k = `w:${it.id}`;
      dsu.find(k);
      wireLabelOf.set(k, name);
      nameKey(name, k);
    }
  }
  for (const c of comps) for (const p of instanceSymbol(doc, c).ports) dsu.find(`p:${c.id}:${p.id}`);

  const groups = new Map<string, Net>();
  let auto = 1;
  const symFirst = new Map<string, string>();
  const roots = [...dsu.parent.keys()].map((k) => dsu.find(k));
  for (const root of new Set(roots)) groups.set(root, { name: '', names: [], wires: [], pins: [] });
  for (const k of dsu.parent.keys()) {
    const root = dsu.find(k);
    const net = groups.get(root)!;
    if (k.startsWith('w:')) {
      net.wires.push(k.slice(2));
      const label = wireLabelOf.get(k);
      if (label) {
        if (!net.names.includes(label)) net.names.push(label);
        if (!net.name) net.name = label;
      }
    } else if (k.startsWith('p:')) {
      const [, comp, port] = k.split(':');
      const c = doc.items[comp] as ComponentItem;
      const def = instanceSymbol(doc, c);
      if (def.valueIsLabel || def.prefix.startsWith('#')) {
        const label = labelOf.get(k);
        if (label && !net.names.includes(label)) net.names.push(label);
        if (label) symFirst.set(root, symFirst.get(root) ?? label);
        if (!net.name && label) net.name = label;
        continue;
      }
      net.pins.push({ comp, ref: c.ref, port, portName: def.ports.find((p) => p.id === port)?.name ?? port });
    }
  }
  // A net named by both a symbol and a wire label keeps the symbol's name; both stay in names so ERC reports the mismatch.
  for (const [root, net] of groups) {
    const s = symFirst.get(root);
    if (s) net.name = s;
  }
  const nets = [...groups.values()].filter((n) => n.pins.length || n.wires.length || n.name);
  // every net gets a name: unnamed ones become net1, net2… numbered by their oldest item,
  // so existing nets keep their number while new ones are appended
  const order = new Map(Object.keys(doc.items).map((id, i) => [id, i]));
  const age = (n: Net) => Math.min(Infinity, ...n.wires.map((w) => order.get(w) ?? Infinity), ...n.pins.map((p) => order.get(p.comp) ?? Infinity));
  const taken = new Set(nets.map((n) => n.name).filter(Boolean));
  for (const n of nets.filter((n) => !n.name).sort((a, b) => age(a) - age(b))) {
    while (taken.has(`net${auto}`)) auto++;
    n.name = `net${auto++}`;
  }
  nets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return nets;
}

/** Net that contains a given wire. */
export function netOfWire(nets: Net[], wireId: string): Net | undefined {
  return nets.find((n) => n.wires.includes(wireId));
}

/** SPICE number from an engineering value: "10kΩ" → "10k", "4k7" → "4.7k", "100nF" → "100n", "10µF" → "10u". */
export function spiceValue(v: string): string {
  let t = stripMath(v).trim().replace(/µ|μ/g, 'u').replace(/Ω|ohms?/gi, '').replace(/\s+/g, '');
  const rkm = /^(\d+)([RrkKmMuUnNpPgGtT])(\d+)$/.exec(t);
  if (rkm) t = `${rkm[1]}.${rkm[3]}${/[Rr]/.test(rkm[2]) ? '' : rkm[2]}`;
  const m = /^(-?\d+(?:\.\d+)?(?:e-?\d+)?)(meg|[TGkKmMunpf])?(?:[FHVAWfhvaw]|Hz)?$/i.exec(t);
  if (!m) return t || '0';
  let unit = m[2] ?? '';
  // SPICE reads "M" as milli; mega is "meg"
  if (unit === 'M') unit = 'meg';
  else if (unit === 'K') unit = 'k';
  return m[1] + unit;
}

type SpiceKind = { letter: string; order: string[] } | { letter: 'X'; order: null } | null;

/** How a part is written into a SPICE netlist: element letter and node order, or null to leave it out. */
function spiceKind(id: string, prefix: string, ports: string[]): SpiceKind {
  const has = (...ids: string[]) => ids.every((p) => ports.includes(p)) && ports.length === ids.length;
  if (has('A', 'K')) return { letter: 'D', order: ['A', 'K'] };
  if (has('B', 'C', 'E')) return { letter: 'Q', order: ['C', 'B', 'E'] };
  if (has('G', 'D', 'S') || has('G', 'D', 'S', 'B')) {
    if (/jfet/.test(id)) return { letter: 'J', order: ['D', 'G', 'S'] };
    return { letter: 'M', order: ['D', 'G', 'S', ports.includes('B') ? 'B' : 'S'] };
  }
  if (ports.length === 2 && /^(R|TH|RV|VR)$/.test(prefix)) return { letter: 'R', order: ports };
  if (ports.length === 2 && prefix === 'C') return { letter: 'C', order: ports };
  if (ports.length === 2 && prefix === 'L' && id !== 'solenoid') return { letter: 'L', order: ports };
  if (has('+', '-') && /^(V|BT|PV)$/.test(prefix)) return { letter: 'V', order: ['+', '-'] };
  if (has('+', '-') && prefix === 'I') return { letter: 'I', order: ['+', '-'] };
  if (has('+', '-', 'C+', 'C-') && /^[EG]$/.test(prefix)) return { letter: prefix, order: ['+', '-', 'C+', 'C-'] };
  if (/^(U|IC|Q|RN|D|X|Y|T|OK)$/.test(prefix)) return { letter: 'X', order: null };
  return null;
}

export function toSpiceNetlist(doc: CircuitDoc): string {
  const nets = computeNets(doc);
  const pinNet = new Map<string, string>();
  for (const n of nets) {
    const name = /^(gnd|0|ground|0v|agnd|dgnd)$/i.test(n.name) ? '0' : stripMath(n.name).replace(/[^\w.+-]+/g, '_');
    for (const p of n.pins) pinNet.set(`${p.comp}:${p.port}`, name);
  }
  const lines = [`* ${doc.name} — exported from Nodal`, '* Semiconductors and subcircuits need their .model / .subckt definitions (.include your vendor libraries).', ''];
  const skipped: string[] = [];
  const comps = Object.values(doc.items)
    .filter((c): c is ComponentItem => c.type === 'component')
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  for (const c of comps) {
    const def = instanceSymbol(doc, c);
    if (def.prefix.startsWith('#') || !def.ports.length) continue;
    if (c.props.dnp === '1') {
      skipped.push(`${c.ref} (not populated)`);
      continue;
    }
    const kind = spiceKind(def.id, def.prefix, def.ports.map((p) => p.id));
    if (!kind) {
      skipped.push(`${c.ref} (${def.name})`);
      continue;
    }
    const order = kind.order ?? def.ports.map((p) => p.id);
    const nodes = order.map((id) => pinNet.get(`${c.id}:${id}`) ?? `NC_${c.ref}_${id}`.replace(/[^\w]+/g, '_'));
    const ref = c.ref.replace(/[^\w]+/g, '_');
    const name = ref.toUpperCase().startsWith(kind.letter) ? ref : `${kind.letter}${ref}`;
    const raw = stripMath(c.value || def.value || '').trim();
    let value: string;
    switch (kind.letter) {
      case 'R':
      case 'C':
      case 'L':
        value = spiceValue(raw);
        break;
      case 'V':
      case 'I':
        value = /^(dc|ac|sin|pulse|pwl|exp|sffm)\b/i.test(raw) ? raw : `DC ${spiceValue(raw.split(/\s+/)[0] ?? '0')}`;
        break;
      case 'E':
      case 'G':
        value = spiceValue(raw.replace(/^[a-z]\s*=\s*/i, ''));
        break;
      default:
        value = (raw || def.name).replace(/\s+/g, '_');
    }
    lines.push(`${name} ${nodes.join(' ')} ${value}`);
  }
  if (skipped.length) lines.push('', `* Not simulated: ${skipped.join(', ')}`);
  lines.push('', '.end', '');
  return lines.join('\n');
}

const BOM_COLUMNS = ['Item', 'Quantity', 'References', 'Value', 'Description', 'Footprint', 'Manufacturer', 'Part number', 'Supplier', 'Supplier part no.', 'Datasheet', 'Specifications', 'Populate'];

export function toBomCsv(doc: CircuitDoc): string {
  type Row = { refs: string[]; cells: string[]; dnp: boolean };
  const rows = new Map<string, Row>();
  for (const c of Object.values(doc.items)) {
    if (c.type !== 'component') continue;
    const def = instanceSymbol(doc, c);
    if (def.prefix.startsWith('#') || def.valueIsLabel) continue;
    const std = new Set(['footprint', 'manufacturer', 'mpn', 'supplier', 'supplier_pn', 'datasheet', 'dnp']);
    const specs = Object.entries(c.props)
      .filter(([k, v]) => v && !std.has(k))
      .map(([k, v]) => `${def.fields?.find((f) => f.key === k)?.label ?? k}: ${v}`)
      .join('; ');
    const p = (k: string) => (c.props[k] ?? '').trim();
    const dnp = p('dnp') === '1';
    const cells = [stripMath(c.value), def.name, p('footprint'), p('manufacturer'), p('mpn'), p('supplier'), p('supplier_pn'), p('datasheet'), specs];
    const k = `${def.id}|${dnp}|${cells.join('|')}`;
    const row = rows.get(k) ?? { refs: [], cells, dnp };
    row.refs.push(c.ref);
    rows.set(k, row);
  }
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const out = [BOM_COLUMNS.join(',')];
  const sorted = [...rows.values()]
    .map((r) => ({ ...r, refs: r.refs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }))
    // parts to fit first, do-not-populate parts at the end
    .sort((a, b) => Number(a.dnp) - Number(b.dnp) || a.refs[0].localeCompare(b.refs[0], undefined, { numeric: true }));
  sorted.forEach((r, i) => {
    out.push([i + 1, r.refs.length, esc(r.refs.join(', ')), ...r.cells.map(esc), r.dnp ? 'DNP' : 'Yes'].join(','));
  });
  return out.join('\n') + '\n';
}

/** KiCad netlist (S-expression, version E) for handing the design to a PCB layout. */
export function toKicadNetlist(doc: CircuitDoc): string {
  const q = (s: string) => `"${stripMath(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const comps = Object.values(doc.items)
    .filter((c): c is ComponentItem => c.type === 'component')
    .filter((c) => {
      const def = instanceSymbol(doc, c);
      return !def.prefix.startsWith('#') && !def.valueIsLabel;
    })
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  const out = ['(export (version "E")', `  (design (source ${q(`${doc.name}.nodal`)}) (date ${q(new Date().toISOString())}) (tool "Nodal"))`, '  (components'];
  for (const c of comps) {
    const def = instanceSymbol(doc, c);
    const fp = c.props.footprint?.trim();
    const extra = [
      ['Manufacturer', c.props.manufacturer],
      ['MPN', c.props.mpn],
      ['Datasheet', c.props.datasheet],
      ['DNP', c.props.dnp === '1' ? 'DNP' : ''],
    ].filter(([, v]) => v?.trim());
    out.push(
      `    (comp (ref ${q(c.ref)}) (value ${q(c.value || def.name)})${fp ? ` (footprint ${q(fp)})` : ''}` +
        ` (libsource (lib "nodal") (part ${q(def.id)}) (description ${q(def.name)}))` +
        (extra.length ? ` (fields ${extra.map(([k, v]) => `(field (name ${q(k!)}) ${q(v!)})`).join(' ')})` : '') +
        ')',
    );
  }
  out.push('  )', '  (nets');
  computeNets(doc)
    .filter((n) => n.pins.length)
    .forEach((n, i) => {
      out.push(`    (net (code "${i + 1}") (name ${q(n.name)})`);
      for (const p of n.pins) out.push(`      (node (ref ${q(p.ref)}) (pin ${q(p.port)}) (pinfunction ${q(p.portName)}))`);
      out.push('    )');
    });
  out.push('  )', ')', '');
  return out.join('\n');
}

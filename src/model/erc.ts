import { computeHotSpots } from './hotspots';
import { toWorld } from './geometry';
import { computeNets, touchingPins } from './netlist';
import { instanceSymbol } from './registry';
import type { CircuitDoc, ComponentItem, Point, SymbolDef } from './types';
import { wirePolyline } from './wires';

export type ErcSeverity = 'error' | 'warning';

export interface ErcIssue {
  /** Stable key (rule + subject), e.g. for React lists. */
  key: string;
  rule: ErcRule;
  severity: ErcSeverity;
  message: string;
  /** Items to select / zoom to. */
  items: string[];
  /** Where to draw the marker. */
  at: Point | null;
}

export type ErcRule =
  | 'duplicate-ref'
  | 'unannotated'
  | 'unconnected-pin'
  | 'unconnected-label'
  | 'single-pin-net'
  | 'single-label'
  | 'shorted-nets'
  | 'loose-end'
  | 'touching-end'
  | 'stacked-parts'
  | 'nc-connected';

export const ERC_RULES: Record<ErcRule, string> = {
  'duplicate-ref': 'Duplicate reference designators',
  unannotated: 'Parts without a reference number',
  'unconnected-pin': 'Unconnected pins',
  'unconnected-label': 'Labels and rails not attached to anything',
  'single-pin-net': 'Nets that reach only one pin',
  'single-label': 'Net labels used only once',
  'shorted-nets': 'Differently named nets joined together',
  'loose-end': 'Wire ends left hanging',
  'touching-end': 'Wire ends touching something without connecting',
  'stacked-parts': 'Parts stacked on top of each other',
  'nc-connected': 'No-connect flags on wired pins',
};

/** Pin names that carry power: leaving one open is an error, not a warning. */
const POWER_PIN = /^(v(cc|dd|ee|ss|in|bat|bus|s|\+|-)\d*|[ad]?gnd\d*|gnd[ad]?|v[+-]|vcc[a-z]*|vdd[a-z]*|avcc|avdd|dvdd|vref[+-]?|pwr|power|ep|pad)$/i;
/** Ground-like rail names that are often bonded on purpose. */
const GROUNDS = /^(gnd|agnd|dgnd|pgnd|sgnd|gnda|gndd|chassis|pe|earth|0v?|vss|low)$/i;

/** Symbols the checker treats as real parts (not labels, rails or flags). */
const isPart = (def: SymbolDef) => !def.prefix.startsWith('#') && !def.valueIsLabel;
const isLabel = (def: SymbolDef) => !!def.valueIsLabel || def.prefix.startsWith('#PWR') || def.prefix.startsWith('#NL') || def.prefix.startsWith('#GL');

/** Runs the electrical rules check over a circuit. Issues come errors first, then by position. */
export function runErc(doc: CircuitDoc): ErcIssue[] {
  const issues: ErcIssue[] = [];
  const comps = Object.values(doc.items).filter((i): i is ComponentItem => i.type === 'component');
  const defOf = new Map(comps.map((c) => [c.id, instanceSymbol(doc, c)]));
  const pinAt = (c: ComponentItem, port: string): Point | null => {
    const def = defOf.get(c.id)!;
    const p = def.ports.find((q) => q.id === port);
    return p ? toWorld(c, def, p.x, p.y) : null;
  };
  const pinName = (def: SymbolDef, port: string) => def.ports.find((p) => p.id === port)?.name ?? port;

  /* --------------------------- references --------------------------- */
  const byRef = new Map<string, ComponentItem[]>();
  for (const c of comps) {
    const def = defOf.get(c.id)!;
    if (!isPart(def)) continue;
    const ref = c.ref.trim();
    if (!ref || /\?$/.test(ref) || ref === def.prefix) {
      issues.push({ key: `unannotated:${c.id}`, rule: 'unannotated', severity: 'warning', message: `${def.name} has no reference number${ref ? ` (“${ref}”)` : ''}`, items: [c.id], at: { x: c.x, y: c.y } });
      continue;
    }
    const list = byRef.get(ref.toUpperCase());
    if (list) list.push(c);
    else byRef.set(ref.toUpperCase(), [c]);
  }
  for (const [, list] of byRef) {
    if (list.length < 2) continue;
    issues.push({
      key: `duplicate-ref:${list[0].ref}`,
      rule: 'duplicate-ref',
      severity: 'error',
      message: `${list.length} parts are called ${list[0].ref}`,
      items: list.map((c) => c.id),
      at: { x: list[1].x, y: list[1].y },
    });
  }

  /* ----------------------------- pins ------------------------------- */
  const wired = new Map<string, number>();
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    for (const ep of [it.a, it.b]) if (ep.kind === 'port') wired.set(`${ep.comp}:${ep.port}`, (wired.get(`${ep.comp}:${ep.port}`) ?? 0) + 1);
  }
  const touching = touchingPins(doc);
  const touched = new Set(touching.flat());
  // pins capped with a no-connect flag (resting on the pin, or wired to it)
  const ncPins = new Set<string>();
  const ncOf = (key: string) => defOf.get(key.split(':')[0])?.prefix.startsWith('#NC');
  for (const group of touching) {
    if (!group.some(ncOf)) continue;
    for (const k of group) if (!ncOf(k)) ncPins.add(k);
  }
  for (const c of comps) {
    const def = defOf.get(c.id)!;
    if (!def.prefix.startsWith('#NC')) continue;
    for (const it of Object.values(doc.items)) {
      if (it.type !== 'wire') continue;
      const ends = [it.a, it.b];
      if (!ends.some((e) => e.kind === 'port' && e.comp === c.id)) continue;
      for (const e of ends) if (e.kind === 'port' && e.comp !== c.id) ncPins.add(`${e.comp}:${e.port}`);
    }
  }
  for (const c of comps) {
    const def = defOf.get(c.id)!;
    if (!def.ports.length || def.prefix.startsWith('#NC') || def.prefix.startsWith('#BE')) continue;
    const open = def.ports.filter((p) => {
      const k = `${c.id}:${p.id}`;
      return !wired.get(k) && !touched.has(k) && !ncPins.has(k);
    });
    if (!open.length) continue;
    if (isPart(def)) {
      const power = open.filter((p) => POWER_PIN.test(p.name.trim()));
      const name = c.ref || def.name;
      const list = (ps: typeof open) => ps.map((p) => p.name || p.id).join(', ');
      if (power.length) {
        issues.push({
          key: `unconnected-pin:power:${c.id}`,
          rule: 'unconnected-pin',
          severity: 'error',
          message: `${name}: power pin${power.length > 1 ? 's' : ''} ${list(power)} not connected`,
          items: [c.id],
          at: pinAt(c, power[0].id),
        });
      }
      const rest = open.filter((p) => !power.includes(p));
      if (rest.length) {
        issues.push({
          key: `unconnected-pin:${c.id}`,
          rule: 'unconnected-pin',
          severity: 'warning',
          message: rest.length === def.ports.length && def.ports.length > 1 ? `${name} is not connected to anything` : `${name}: pin${rest.length > 1 ? 's' : ''} ${list(rest)} not connected`,
          items: [c.id],
          at: pinAt(c, rest[0].id),
        });
      }
    } else if (isLabel(def) || def.prefix.startsWith('#')) {
      const what = def.valueIsLabel ? `${def.name} “${c.value}”` : def.prefix.startsWith('#PWR') ? `${def.name} (${c.value || def.value})` : def.name;
      issues.push({ key: `unconnected-label:${c.id}`, rule: 'unconnected-label', severity: 'warning', message: `${what} is not attached to anything`, items: [c.id], at: pinAt(c, open[0].id) });
    }
  }
  // a no-connect flag on a pin that is wired anyway
  for (const k of ncPins) {
    if (!wired.get(k)) continue;
    const [comp, port] = k.split(':');
    const c = doc.items[comp] as ComponentItem;
    const def = defOf.get(comp)!;
    issues.push({ key: `nc-connected:${k}`, rule: 'nc-connected', severity: 'warning', message: `${c.ref || def.name} pin ${pinName(def, port)} is marked no-connect but has a wire`, items: [comp], at: pinAt(c, port) });
  }

  /* ----------------------------- wires ------------------------------ */
  const polys = new Map<string, Point[]>();
  for (const it of Object.values(doc.items)) if (it.type === 'wire' && !it.hidden) polys.set(it.id, wirePolyline(doc, it));
  const unfinished = new Set<string>();
  for (const h of computeHotSpots(doc, polys, [])) {
    if (h.kind === 'end' || h.kind === 'touch' || h.kind === 'pinTouch') unfinished.add(h.wire);
    if (h.kind === 'end') {
      issues.push({ key: `loose-end:${h.wire}:${h.end}`, rule: 'loose-end', severity: 'warning', message: 'Wire end is not connected to anything', items: [h.wire], at: h.pt });
    } else if (h.kind === 'touch' || h.kind === 'pinTouch') {
      const what =
        h.kind === 'pinTouch'
          ? describePin(doc, h.comp, h.port)
          : h.target.kind === 'port'
            ? describePin(doc, h.target.comp, h.target.port)
            : h.target.kind === 'junction'
              ? 'a junction'
              : h.target.kind === 'end'
                ? 'another wire end'
                : 'a wire';
      const message =
        h.kind === 'pinTouch' ? `${what} lies on a wire without connecting to it — solder it` : `Wire end touches ${what} without connecting — solder it`;
      issues.push({ key: `touching-end:${h.kind}:${h.pt.x},${h.pt.y}`, rule: 'touching-end', severity: 'warning', message, items: [h.wire], at: h.pt });
    }
  }

  /* ----------------------------- nets ------------------------------- */
  const nets = computeNets(doc);
  const labelUses = new Map<string, ComponentItem[]>();
  for (const c of comps) {
    const def = defOf.get(c.id)!;
    if (!(def.prefix.startsWith('#NL') || def.prefix.startsWith('#GL'))) continue;
    const name = (c.value || def.value || '').trim();
    if (!name) continue;
    labelUses.set(name, [...(labelUses.get(name) ?? []), c]);
  }
  const rails = new Set(comps.filter((c) => defOf.get(c.id)!.prefix.startsWith('#PWR')).map((c) => (c.value || defOf.get(c.id)!.value || '').trim()));
  // wire labels join nets by name too, so a label used by a wire connects to something else
  const wireLabelNames = new Map<string, string[]>();
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'wire') continue;
    const name = (it.label ?? '').trim();
    if (!name) continue;
    wireLabelNames.set(name, [...(wireLabelNames.get(name) ?? []), it.id]);
  }
  for (const n of nets) {
    if (n.names.length > 1) {
      const powered = n.names.filter((x) => rails.has(x));
      const bad = powered.length > 1 && !powered.every((x) => GROUNDS.test(x));
      const parts = n.pins.map((p) => p.comp);
      const anyLabel = comps.find((c) => n.names.includes((c.value || '').trim()) && isLabel(defOf.get(c.id)!));
      issues.push({
        key: `shorted-nets:${n.names.join('|')}`,
        rule: 'shorted-nets',
        severity: bad ? 'error' : 'warning',
        message: bad ? `Supply rails ${n.names.join(' and ')} are shorted together` : `Nets ${n.names.join(' and ')} are joined into one`,
        items: [...n.wires, ...parts],
        at: anyLabel ? { x: anyLabel.x, y: anyLabel.y } : null,
      });
    }
    if (n.pins.length === 1 && !rails.has(n.name)) {
      const p = n.pins[0];
      const c = doc.items[p.comp] as ComponentItem;
      // a wire or label from a pin that reaches nothing else (loose ends and lone labels are reported on their own)
      const reported = n.wires.some((w) => unfinished.has(w)) || n.names.some((x) => labelUses.get(x)?.length === 1);
      if ((n.wires.length || n.names.length) && !reported) {
        issues.push({
          key: `single-pin-net:${n.name}:${p.comp}:${p.port}`,
          rule: 'single-pin-net',
          severity: 'warning',
          message: `Net ${n.name} only reaches ${p.ref || 'one pin'}${p.portName ? ` pin ${p.portName}` : ''}`,
          items: [...n.wires, p.comp],
          at: pinAt(c, p.port),
        });
      }
    }
  }
  for (const [name, uses] of labelUses) {
    if (uses.length !== 1 || rails.has(name)) continue;
    // fine if the net also has a port / off-page connector of the same name
    const c = uses[0];
    const others = comps.filter((o) => o.id !== c.id && (o.value || '').trim() === name && isLabelLike(defOf.get(o.id)!));
    if (others.length) continue;
    // fine if a wire elsewhere carries the same label: it names and joins the same net
    if (wireLabelNames.has(name)) continue;
    issues.push({ key: `single-label:${c.id}`, rule: 'single-label', severity: 'warning', message: `Net label “${name}” is used only once, so it connects to nothing else`, items: [c.id], at: { x: c.x, y: c.y } });
  }

  /* ----------------------------- layout ----------------------------- */
  const spots = new Map<string, ComponentItem[]>();
  for (const c of comps) {
    if (!isPart(defOf.get(c.id)!)) continue;
    const k = `${c.symbol}@${Math.round(c.x)},${Math.round(c.y)}`;
    spots.set(k, [...(spots.get(k) ?? []), c]);
  }
  for (const [k, list] of spots) {
    if (list.length < 2) continue;
    issues.push({ key: `stacked-parts:${k}`, rule: 'stacked-parts', severity: 'warning', message: `${list.map((c) => c.ref).join(', ')} are stacked on the same spot`, items: list.map((c) => c.id), at: { x: list[0].x, y: list[0].y } });
  }

  const rank = (i: ErcIssue) => (i.severity === 'error' ? 0 : 1);
  return issues.sort((a, b) => rank(a) - rank(b) || (a.at?.y ?? 0) - (b.at?.y ?? 0) || (a.at?.x ?? 0) - (b.at?.x ?? 0));
}

/** Splits rule-check findings into active and user-ignored ones (by stable key). Keeps order; missing list = empty. */
export function splitIgnored(issues: ErcIssue[], ignored: readonly string[] | undefined): { active: ErcIssue[]; ignored: ErcIssue[] } {
  const set = new Set(ignored ?? []);
  const active: ErcIssue[] = [];
  const ign: ErcIssue[] = [];
  for (const i of issues) (set.has(i.key) ? ign : active).push(i);
  return { active, ignored: ign };
}

const isLabelLike = (def: SymbolDef) => !!def.valueIsLabel;

function describePin(doc: CircuitDoc, comp: string, port: string) {
  const c = doc.items[comp];
  if (!c || c.type !== 'component') return 'a pin';
  const def = instanceSymbol(doc, c);
  const name = def.ports.find((p) => p.id === port)?.name ?? port;
  if (!isPart(def)) return def.valueIsLabel ? `label “${c.value}”` : def.name.toLowerCase();
  return `${c.ref || def.name} pin ${name}`;
}

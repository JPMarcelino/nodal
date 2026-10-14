import type { CircuitDoc, ComponentItem, Dash, Item, ShapeItem, WireItem } from './types';

/**
 * One set of style properties for every kind of item, so a selection of parts,
 * wires and shapes can be restyled together. Each kind maps them onto its own
 * fields; properties a kind doesn't have are skipped.
 */
export interface Look {
  /** Line / outline colour; '' = the default. */
  line: string;
  /** Fill colour; '' = none / the default. */
  fill: string;
  fillOpacity: number;
  width: number;
  dash: Dash;
  /** Text and label colour; '' = the default. */
  text: string;
}

export type LookKey = keyof Look;

/** Which style properties an item has. */
export function lookKeys(it: Item): LookKey[] {
  switch (it.type) {
    case 'component':
      return ['line', 'fill', 'fillOpacity', 'width', 'dash', 'text'];
    case 'wire':
      return ['line', 'width', 'dash'];
    case 'shape':
      if (it.kind === 'text') return ['text', 'fill', 'fillOpacity'];
      if (it.kind === 'line' || it.kind === 'arrow' || it.kind === 'ink') return ['line', 'width', 'dash'];
      if (it.kind === 'image') return ['line', 'width', 'dash'];
      return ['line', 'fill', 'fillOpacity', 'width', 'dash', 'text'];
    default:
      return [];
  }
}

/** An item's style as shown in the editor (defaults filled in). */
export function lookOf(doc: CircuitDoc, it: Item): Partial<Look> {
  switch (it.type) {
    case 'component':
      return { line: it.color ?? '', fill: it.fill ?? '', fillOpacity: it.fillOpacity ?? 1, width: it.lineWidth ?? 2, dash: it.dash ?? 'solid', text: it.labelColor ?? '' };
    case 'wire': {
      const st = { ...doc.settings.wire, ...it.style };
      return { line: st.color, width: st.width, dash: st.dash };
    }
    case 'shape':
      return {
        line: it.stroke,
        fill: it.fill === 'none' ? '' : it.fill,
        fillOpacity: it.fillOpacity,
        width: it.strokeWidth,
        dash: it.dash,
        text: it.textColor ?? '',
      };
    default:
      return {};
  }
}

/** Writes style properties into an item (a draft); keys the item doesn't have are ignored. */
export function applyLook(it: Item, p: Partial<Look>) {
  const has = new Set(lookKeys(it));
  const want = <K extends LookKey>(k: K): k is K => k in p && has.has(k);
  if (it.type === 'component') {
    const c = it as ComponentItem;
    if (want('line')) c.color = p.line || undefined;
    if (want('fill')) c.fill = p.fill || undefined;
    if (want('fillOpacity')) c.fillOpacity = p.fillOpacity === 1 ? undefined : p.fillOpacity;
    if (want('width')) c.lineWidth = p.width === 2 ? undefined : p.width;
    if (want('dash')) c.dash = p.dash === 'solid' ? undefined : p.dash;
    if (want('text')) c.labelColor = p.text || undefined;
  } else if (it.type === 'wire') {
    const w = it as WireItem;
    const st = { ...w.style };
    if (want('line')) {
      if (p.line) st.color = p.line;
      else delete st.color;
    }
    if (want('width')) st.width = p.width;
    if (want('dash')) st.dash = p.dash;
    w.style = st;
  } else if (it.type === 'shape') {
    const s = it as ShapeItem;
    if (want('line') && p.line) s.stroke = p.line;
    if (want('fill')) {
      s.fill = p.fill || 'none';
      // picking a fill colour for an unfilled shape should show it
      if (p.fill && s.fillOpacity === 0 && !('fillOpacity' in p)) s.fillOpacity = s.kind === 'zone' ? 0.15 : 1;
    }
    if (want('fillOpacity')) s.fillOpacity = p.fillOpacity!;
    if (want('width')) s.strokeWidth = p.width!;
    if (want('dash')) s.dash = p.dash!;
    if (want('text')) s.textColor = p.text || undefined;
  }
}

/** The shared value of a property across items, or undefined when they differ (or none has it). */
export function commonLook(doc: CircuitDoc, items: Item[]): { value: Partial<Look>; keys: Set<LookKey>; mixed: Set<LookKey> } {
  const value: Partial<Look> = {};
  const keys = new Set<LookKey>();
  const mixed = new Set<LookKey>();
  for (const it of items) {
    const l = lookOf(doc, it);
    for (const k of lookKeys(it)) {
      if (!keys.has(k)) {
        keys.add(k);
        (value as Record<string, unknown>)[k] = l[k];
      } else if (value[k] !== l[k]) mixed.add(k);
    }
  }
  return { value, keys, mixed };
}

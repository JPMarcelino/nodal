import { wireStyleFor } from './wires';
import { defaultAlign, defaultValign, lineCap, lineJoin, textSize } from './shapeText';
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
  /* text (shapes) */
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** '' = sans. */
  font: '' | 'serif' | 'mono';
  align: 'start' | 'middle' | 'end';
  valign: 'top' | 'middle' | 'bottom';
  /** Free text: width it wraps at; 0 = no wrapping. */
  wrapW: number;
  /* line (shapes) */
  lineOpacity: number;
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
  radius: number;
  /* fill (shapes) */
  fillKind: 'none' | 'solid' | 'gradient';
  /** Second colour of a gradient. */
  fill2: string;
  /** Gradient direction in degrees (0 = left to right, clockwise). */
  gradAngle: number;
  /* effects (shapes) */
  opacity: number;
  shadow: boolean;
}

export type LookKey = keyof Look;

const TEXT_KEYS: LookKey[] = ['size', 'bold', 'italic', 'underline', 'font', 'text', 'align'];
const EFFECT_KEYS: LookKey[] = ['opacity', 'shadow'];

/** Which style properties an item has. */
export function lookKeys(it: Item): LookKey[] {
  switch (it.type) {
    case 'component':
      return ['line', 'fill', 'fillOpacity', 'width', 'dash', 'text'];
    case 'wire':
      return ['line', 'width', 'dash'];
    case 'shape':
      switch (it.kind) {
        case 'text':
          return [...TEXT_KEYS, 'wrapW', 'fill', 'fillOpacity', ...EFFECT_KEYS];
        case 'line':
        case 'arrow':
          return [...TEXT_KEYS, 'line', 'width', 'dash', 'lineOpacity', 'cap', 'join', ...EFFECT_KEYS];
        case 'image':
          return ['line', 'width', 'dash', 'lineOpacity', 'cap', 'join', ...EFFECT_KEYS];
        case 'rect':
        case 'zone':
          return [...TEXT_KEYS, 'valign', 'line', 'width', 'dash', 'lineOpacity', 'cap', 'join', 'radius', 'fillKind', 'fill', 'fill2', 'gradAngle', 'fillOpacity', ...EFFECT_KEYS];
        case 'ellipse':
        case 'polygon':
          return [...TEXT_KEYS, 'valign', 'line', 'width', 'dash', 'lineOpacity', 'cap', 'join', 'fillKind', 'fill', 'fill2', 'gradAngle', 'fillOpacity', ...EFFECT_KEYS];
        case 'ink':
          return ['line', 'width', 'dash'];
        default:
          return ['line', 'fill', 'fillOpacity', 'width', 'dash', 'text'];
      }
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
      const st = wireStyleFor(doc.settings, it);
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
        size: textSize(it),
        bold: it.bold ?? (it.kind === 'rect' || it.kind === 'zone' || it.kind === 'ellipse' || it.kind === 'polygon'),
        italic: !!it.italic,
        underline: !!it.underline,
        font: it.font ?? '',
        align: it.align ?? defaultAlign(it),
        valign: it.valign ?? defaultValign(it),
        wrapW: it.wrapW ?? 0,
        lineOpacity: it.strokeOpacity ?? 1,
        cap: lineCap(it),
        join: lineJoin(it),
        radius: it.radius,
        fillKind: it.fill === 'none' || it.fillOpacity === 0 ? 'none' : it.gradient ? 'gradient' : 'solid',
        fill2: it.gradient?.to ?? '#bb9af7',
        gradAngle: it.gradient?.angle ?? 90,
        opacity: it.opacity ?? 1,
        shadow: !!it.shadow,
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
      if (!p.fill) delete s.gradient;
      // picking a fill colour for an unfilled shape should show it
      if (p.fill && s.fillOpacity === 0 && !('fillOpacity' in p)) s.fillOpacity = s.kind === 'zone' ? 0.15 : 1;
    }
    if (want('fillOpacity')) s.fillOpacity = p.fillOpacity!;
    if (want('fillKind')) {
      if (p.fillKind === 'none') {
        s.fill = 'none';
        delete s.gradient;
      } else {
        // a fill needs a colour and a visible opacity to show
        if (s.fill === 'none') s.fill = '#7aa2f7';
        if (s.fillOpacity === 0 && !('fillOpacity' in p)) s.fillOpacity = s.kind === 'zone' ? 0.15 : 1;
        if (p.fillKind === 'solid') delete s.gradient;
        else s.gradient = s.gradient ?? { to: '#bb9af7', angle: 90 };
      }
    }
    if (want('fill2') && s.gradient) s.gradient.to = p.fill2!;
    if (want('gradAngle') && s.gradient) s.gradient.angle = p.gradAngle!;
    if (want('width')) s.strokeWidth = p.width!;
    if (want('dash')) s.dash = p.dash!;
    if (want('text')) s.textColor = p.text || undefined;
    if (want('size')) s.fontSize = p.size!;
    if (want('bold')) s.bold = p.bold!;
    if (want('italic')) s.italic = p.italic || undefined;
    if (want('underline')) s.underline = p.underline || undefined;
    if (want('font')) s.font = p.font || undefined;
    if (want('align')) s.align = p.align === defaultAlign(s) ? undefined : p.align;
    if (want('valign')) s.valign = p.valign === defaultValign(s) ? undefined : p.valign;
    if (want('wrapW')) s.wrapW = p.wrapW! > 0 ? p.wrapW : undefined;
    if (want('lineOpacity')) s.strokeOpacity = p.lineOpacity === 1 ? undefined : p.lineOpacity;
    if (want('cap')) s.cap = p.cap === lineCap({ ...s, cap: undefined }) ? undefined : p.cap;
    if (want('join')) s.join = p.join === lineJoin({ ...s, join: undefined }) ? undefined : p.join;
    if (want('radius')) s.radius = p.radius!;
    if (want('opacity')) s.opacity = p.opacity === 1 ? undefined : p.opacity;
    if (want('shadow')) s.shadow = p.shadow || undefined;
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

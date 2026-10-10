export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = 'left' | 'right' | 'top' | 'bottom';

/* ------------------------------------------------------------------ */
/* Symbols                                                             */
/* ------------------------------------------------------------------ */

export type Fill = 'none' | 'solid' | 'bg';

/** Drawing primitives a symbol is made of (local coordinates, y down). */
export type Prim =
  | { t: 'line'; pts: number[]; w?: number; dash?: boolean }
  | { t: 'poly'; pts: number[]; fill: Fill; w?: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; rx?: number; fill: Fill; sw?: number }
  | { t: 'circle'; cx: number; cy: number; r: number; fill: Fill; w?: number }
  | { t: 'ellipse'; cx: number; cy: number; rx: number; ry: number; fill: Fill; w?: number }
  | { t: 'arc'; cx: number; cy: number; r: number; a1: number; a2: number; w?: number }
  | { t: 'path'; d: string; fill: Fill; w?: number }
  | { t: 'text'; x: number; y: number; size: number; anchor: 'start' | 'middle' | 'end'; text: string };

export interface PortDef {
  id: string;
  name: string;
  x: number;
  y: number;
  side: Side;
}

export interface FieldDef {
  key: string;
  label: string;
  default?: string;
}

export interface SymbolDef {
  id: string;
  name: string;
  category: string;
  keywords?: string;
  w: number;
  h: number;
  prims: Prim[];
  ports: PortDef[];
  prefix: string;
  value?: string;
  fields?: FieldDef[];
  /** Source text in the symbol DSL (kept for user symbols so they stay editable). */
  source?: string;
  custom?: boolean;
  /** Hide the reference/value labels by default (power rails, labels…). */
  hideLabels?: boolean;
  /** Symbols whose value is shown as the main label (net labels, rails). */
  valueIsLabel?: boolean;
}

/* ------------------------------------------------------------------ */
/* Document items                                                      */
/* ------------------------------------------------------------------ */

export type Dash = 'solid' | 'dashed' | 'dotted';

export interface WireStyle {
  color: string;
  width: number;
  /** Corner radius for bends; 0 = sharp corners. */
  radius: number;
  dash: Dash;
}

export type Endpoint =
  | { kind: 'port'; comp: string; port: string }
  | { kind: 'junction'; id: string }
  | { kind: 'free'; x: number; y: number };

interface ItemBase {
  id: string;
  /** Innermost group this item belongs to. */
  group?: string;
  locked?: boolean;
  hidden?: boolean;
}

export interface ComponentItem extends ItemBase {
  type: 'component';
  symbol: string;
  x: number;
  y: number;
  rot: 0 | 90 | 180 | 270;
  flipX?: boolean;
  ref: string;
  value: string;
  props: Record<string, string>;
  showRef: boolean;
  showValue: boolean;
  color?: string;
  /** Label offset relative to the component centre (unrotated). */
  labelDx?: number;
  labelDy?: number;
}

export interface WireItem extends ItemBase {
  type: 'wire';
  a: Endpoint;
  b: Endpoint;
  /** Intermediate vertices (absolute coordinates). */
  pts: Point[];
  /** Style overrides; missing keys fall back to document defaults. */
  style?: Partial<WireStyle>;
  /** 'straight' allows diagonal segments instead of automatic orthogonal elbows. */
  routing?: 'ortho' | 'straight';
  /** Stacking layer at crossings: a higher layer hops over a lower one (undefined = 0). */
  hopLayer?: number;
  label?: string;
}

export interface JunctionItem extends ItemBase {
  type: 'junction';
  x: number;
  y: number;
}

export type ShapeKind = 'rect' | 'zone' | 'ellipse' | 'line' | 'arrow' | 'text';

export type HeadKind = 'none' | 'open' | 'filled' | 'circle' | 'bar';

export interface ShapeItem extends ItemBase {
  type: 'shape';
  kind: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: string;
  strokeWidth: number;
  fill: string;
  fillOpacity: number;
  dash: Dash;
  radius: number;
  /** Arrowhead at the start / end point (line & arrow shapes). */
  headStart?: HeadKind;
  headEnd?: HeadKind;
  /** Arrowhead length in px; undefined = auto (stroke width based). */
  headSize?: number;
  /** 'below' renders behind wires and components; 'above' on top of everything. */
  layer: 'below' | 'above';
  text?: string;
  fontSize?: number;
  textColor?: string;
  bold?: boolean;
  /** Stacking within its layer. */
  z: number;
}

export type Item = ComponentItem | WireItem | JunctionItem | ShapeItem;

export interface Group {
  id: string;
  name: string;
  /** Parent group for nesting. */
  group?: string;
}

export interface DocSettings {
  grid: number;
  showGrid: boolean;
  snap: boolean;
  wire: WireStyle;
  hops: 'arc' | 'gap' | 'none';
  hopSize: number;
  junctionSize: number;
  componentColor: string;
  labelColor: string;
  background: string;
  titleBlock: boolean;
  author: string;
  revision: string;
}

export interface CircuitDoc {
  format: 'nodal';
  version: 1;
  name: string;
  settings: DocSettings;
  items: Record<string, Item>;
  groups: Record<string, Group>;
  /** User symbols travel with the document so files stay self-contained. */
  symbols: Record<string, SymbolDef>;
}

export type Tool = 'select' | 'node' | 'wire' | 'solder' | 'rect' | 'zone' | 'ellipse' | 'line' | 'arrow' | 'text' | 'pan';

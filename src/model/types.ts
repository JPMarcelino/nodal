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

/** Optional styling any primitive can carry; unset parts follow the theme's ink colour. */
export interface PrimStyle {
  /** Line / outline colour (text: its colour). */
  color?: string;
  /** Fill colour of `fill: 'solid'` shapes; defaults to the line colour. */
  fc?: string;
  dash?: boolean;
}

/** Drawing primitives a symbol is made of (local coordinates, y down). */
export type Prim = PrimStyle &
  (
  | { t: 'line'; pts: number[]; w?: number }
  | { t: 'poly'; pts: number[]; fill: Fill; w?: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; rx?: number; fill: Fill; sw?: number }
  | { t: 'circle'; cx: number; cy: number; r: number; fill: Fill; w?: number }
  | { t: 'ellipse'; cx: number; cy: number; rx: number; ry: number; fill: Fill; w?: number }
  | { t: 'arc'; cx: number; cy: number; r: number; a1: number; a2: number; w?: number }
  | { t: 'path'; d: string; fill: Fill; w?: number }
  | { t: 'text'; x: number; y: number; size: number; anchor: 'start' | 'middle' | 'end'; text: string }
  );

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

/** A named alternative drawing ("type") of a symbol. Refers to another symbol id. */
export interface VariantRef {
  id: string;
  name: string;
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
  /** When set, this symbol is an alternative drawing ("type") of the symbol with this id. */
  variantOf?: string;
  /** Human label of this type, e.g. "Type B — source arrow". */
  variantName?: string;
  /** Alternative drawings of this symbol, offered as a type picker wherever it is placed. */
  variants?: VariantRef[];
  /** Drawing of the closed (actuated) state, for switches; parts opt in with `closed`. */
  closedPrims?: Prim[];
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
  /** Stacking order shared by all items (higher = in front); unset = in front, by creation order. */
  z?: number;
}

export interface ComponentItem extends ItemBase {
  type: 'component';
  symbol: string;
  x: number;
  y: number;
  rot: 0 | 90 | 180 | 270;
  flipX?: boolean;
  /** Draws a switch closed (its symbol's `closedPrims`). */
  closed?: boolean;
  ref: string;
  value: string;
  props: Record<string, string>;
  showRef: boolean;
  showValue: boolean;
  /** Line colour of the drawing (default: the document's part colour). */
  color?: string;
  /** Fills the drawing's closed shapes (outline-only ones too). */
  fill?: string;
  /** Opacity of `fill`, 0…1 (default 1). */
  fillOpacity?: number;
  /** Line width of the drawing (default 2); explicit widths scale along. */
  lineWidth?: number;
  dash?: Dash;
  labelColor?: string;
  /** Size of the drawing, pins and text (default 1); line widths stay as they are. */
  scale?: number;
  /** Label offset relative to the component centre (unrotated). */
  /** Reference label offset (also the value's, until the value is moved on its own). */
  labelDx?: number;
  labelDy?: number;
  /** Value label offset when it has been dragged separately from the reference. */
  valueDx?: number;
  valueDy?: number;
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
  /** Where the label sits along the wire, 0 (end a) … 1 (end b); unset = middle of the longest segment. */
  labelAt?: number;
  /** Which side of the wire the label is on; unset = above horizontal runs, right of vertical ones. */
  labelSide?: LabelSide;
  /** Keep the label (it still names the net in lists and search) but don't draw it. */
  labelHidden?: boolean;
}

export type LabelSide = 'above' | 'below' | 'left' | 'right';

/** Angles new wires are drawn at: square elbows, 45° steps (grid-friendly), or any angle. */
export type WireAngle = 'ortho' | '45' | 'any';

export interface JunctionItem extends ItemBase {
  type: 'junction';
  x: number;
  y: number;
}

export type ShapeKind = 'rect' | 'zone' | 'ellipse' | 'polygon' | 'line' | 'arrow' | 'text' | 'image' | 'ink' | 'callout' | 'frame';

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
  /** Image shapes: the picture as a data URL (PNG / JPEG). */
  src?: string;
  fontSize?: number;
  textColor?: string;
  bold?: boolean;
  /** Title offset from its default spot (rect / zone / ellipse / polygon); dragged with the shape selected. */
  textDx?: number;
  textDy?: number;
  /** Stacking within its layer. */
  z: number;
  /** Ink strokes: flat [x, y, pressure, …] list, x / y as fractions (0–1) of the box. */
  ink?: number[];
  /** Polygon corners: flat [x, y, …] list as fractions (0–1) of the box. */
  poly?: number[];
  /** Ink drawn with the highlighter (wide, translucent, under the circuit). */
  highlighter?: boolean;
  /** Callouts and frames: step number shown in the badge (walkthrough order). */
  step?: number;
  /** Callouts and frames: seconds the presentation stays on this step (undefined = default). */
  hold?: number;
  /** Callouts and frames: seconds the camera takes to glide here (undefined = default). */
  transition?: number;
  /** Callouts: what the leader line points at, as an offset from that item's bounds corner. */
  anchor?: { id?: string; dx: number; dy: number; x: number; y: number };
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
  /** Draw the drawing frame (sheet border with zone markers and a title block). */
  titleBlock: boolean;
  author: string;
  revision: string;
  /** Hide every instance name (reference designator), whatever the parts say. */
  hideRefs?: boolean;
  /** Hide every instance value (net labels and rails still show their names). */
  hideValues?: boolean;
  /** Hide every wire name. */
  hideWireLabels?: boolean;
  /** Keys of rule-check findings the user chose to ignore (see ErcIssue.key). */
  ercIgnored?: string[];
  /** Frame size and title block fields; used while `titleBlock` is on. */
  sheet?: SheetSettings;
}

export type SheetSize = 'A5' | 'A4' | 'A3' | 'A2' | 'A1' | 'A0' | 'Letter' | 'Legal' | 'Tabloid' | 'C' | 'D' | 'E';

export interface SheetSettings {
  size: SheetSize;
  orientation: 'landscape' | 'portrait';
  /** Top-left corner of the sheet on the canvas. */
  x: number;
  y: number;
  company: string;
  /** Free-form date text; empty shows today's date. */
  date: string;
  /** e.g. "1 / 3". */
  sheetNo: string;
  description: string;
}

export interface CircuitDoc {
  format: 'nodal';
  version: 1;
  /** Stable identity across saves, used to key local version history. */
  id?: string;
  name: string;
  settings: DocSettings;
  items: Record<string, Item>;
  groups: Record<string, Group>;
  /** User symbols travel with the document so files stay self-contained. */
  symbols: Record<string, SymbolDef>;
}

export type Tool =
  | 'select' | 'node' | 'wire' | 'solder' | 'rect' | 'zone' | 'ellipse' | 'polygon' | 'line' | 'arrow' | 'text' | 'pan' | 'frame'
  // explain tools: annotate and talk through a circuit
  | 'pen' | 'highlighter' | 'laser' | 'eraser' | 'trace' | 'callout';

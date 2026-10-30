import { FONT_STACKS } from './fonts';
import { measureRich, upperText, wrapRich } from './richText';
import type { ShapeItem, ShapeKind } from './types';

/** Whether a container shows its title in a header band (swimlane look). */
export const hasHeader = (s: Pick<ShapeItem, 'kind' | 'container' | 'header'>): boolean => !!s.container && !!s.header && (s.kind === 'rect' || s.kind === 'zone');

/** Height of a container's header band. */
export const headerHeight = (s: Pick<ShapeItem, 'fontSize'>): number => Math.max(28, Math.round((s.fontSize ?? 13) * 2.1));

/** Shapes whose title sits inside their box (and wraps to it). */
export const BOX_TITLE_KINDS: ReadonlySet<ShapeKind> = new Set(['rect', 'zone', 'ellipse', 'polygon']);

/** Font weight of a shape's text; box titles are bold unless switched off. */
export function textWeight(s: ShapeItem): number {
  if (s.kind === 'text') return s.bold ? 700 : 400;
  if (BOX_TITLE_KINDS.has(s.kind)) return s.bold === false ? 400 : 600;
  return s.bold ? 600 : 400;
}

/** Font size of a shape's text. */
export const textSize = (s: ShapeItem): number => s.fontSize ?? (s.kind === 'text' ? 16 : 13);

/** Room a box title wraps into (the ellipse and polygon corners are cut off). */
export function titleWidth(s: ShapeItem): number {
  const w = Math.abs(s.w);
  return Math.max(20, s.kind === 'ellipse' ? w * 0.75 : s.kind === 'polygon' ? w * 0.8 : w - 20);
}

/** Width the text of a shape wraps at, if it does. */
export function wrapWidth(s: ShapeItem): number | undefined {
  if (s.kind === 'text') return s.wrapW && s.wrapW > 0 ? s.wrapW : undefined;
  return BOX_TITLE_KINDS.has(s.kind) ? titleWidth(s) : undefined;
}

/** The text as it is laid out: the same source, with line breaks where it wraps. */
export function shapeText(s: ShapeItem): string {
  const text = s.allCaps ? upperText(s.text ?? '') : (s.text ?? '');
  const w = wrapWidth(s);
  return w ? wrapRich(text, textSize(s), textWeight(s), w, s.font, s.italic) : text;
}

/** Size of a shape's laid-out text; a free text with a wrap width is exactly that wide. */
export function measureTextShape(s: ShapeItem): { w: number; h: number } {
  const m = measureRich(shapeText(s), textSize(s), textWeight(s), s.font, s.italic);
  return s.kind === 'text' && s.wrapW && s.wrapW > 0 ? { w: s.wrapW, h: m.h } : m;
}

/** Italic, underline and font family of a shape's text, as inline style. */
export function textFaceStyle(s: Pick<ShapeItem, 'italic' | 'underline' | 'font'>): { fontStyle?: 'italic'; textDecoration?: 'underline'; fontFamily?: string } {
  return {
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: s.underline ? 'underline' : undefined,
    fontFamily: s.font ? FONT_STACKS[s.font] : undefined,
  };
}

/** Horizontal alignment a shape's text has unless set: centred on round shapes and lines, left otherwise. */
export const defaultAlign = (s: Pick<ShapeItem, 'kind'>): 'start' | 'middle' | 'end' =>
  s.kind === 'ellipse' || s.kind === 'polygon' || s.kind === 'line' || s.kind === 'arrow' ? 'middle' : 'start';

/** Where a title sits in its box unless set: top of rectangles and zones, middle of round shapes. */
export const defaultValign = (s: Pick<ShapeItem, 'kind'>): 'top' | 'middle' | 'bottom' => (s.kind === 'ellipse' || s.kind === 'polygon' ? 'middle' : 'top');

/** Line cap of a shape: round on lines, and on dotted styles (whose dots are zero-length dashes). */
export const lineCap = (s: Pick<ShapeItem, 'kind' | 'cap' | 'dash'>): 'butt' | 'round' | 'square' =>
  s.cap ?? (s.kind === 'line' || s.kind === 'arrow' || s.dash === 'dotted' || s.dash === 'dash-dot' ? 'round' : 'butt');

/** Line join of a shape: round on polygons, mitred otherwise. */
export const lineJoin = (s: Pick<ShapeItem, 'kind' | 'join'>): 'miter' | 'round' | 'bevel' => s.join ?? (s.kind === 'polygon' ? 'round' : 'miter');

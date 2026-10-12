import type { CircuitDoc, DocSettings, Rect, SheetSettings, SheetSize } from './types';

/** Canvas units per millimetre: the 10 px grid is 0.1 in (2.54 mm), as in most schematic tools. */
export const PX_PER_MM = 10 / 2.54;

/** Sheet sizes in millimetres, landscape (width ≥ height). */
export const SHEET_SIZES: Record<SheetSize, { w: number; h: number; label: string }> = {
  A5: { w: 210, h: 148, label: 'A5' },
  A4: { w: 297, h: 210, label: 'A4' },
  A3: { w: 420, h: 297, label: 'A3' },
  A2: { w: 594, h: 420, label: 'A2' },
  A1: { w: 841, h: 594, label: 'A1' },
  A0: { w: 1189, h: 841, label: 'A0' },
  Letter: { w: 279.4, h: 215.9, label: 'US Letter' },
  Legal: { w: 355.6, h: 215.9, label: 'US Legal' },
  Tabloid: { w: 431.8, h: 279.4, label: 'Tabloid (B)' },
  C: { w: 558.8, h: 431.8, label: 'ANSI C' },
  D: { w: 863.6, h: 558.8, label: 'ANSI D' },
  E: { w: 1117.6, h: 863.6, label: 'ANSI E' },
};

/** Border between the paper edge and the frame, and the depth of the zone-marker band. */
export const SHEET_MARGIN = 40;
export const SHEET_BAND = 20;
export const TITLE_BLOCK = { w: 440, h: 120 };

export const DEFAULT_SHEET: SheetSettings = { size: 'A4', orientation: 'landscape', x: 0, y: 0, company: '', date: '', sheetNo: '1 / 1', description: '' };

/** Sheet rectangle on the canvas, or null while the frame is off. */
export function sheetRect(settings: DocSettings): Rect | null {
  if (!settings.titleBlock) return null;
  const s = { ...DEFAULT_SHEET, ...settings.sheet };
  const mm = SHEET_SIZES[s.size] ?? SHEET_SIZES.A4;
  const long = Math.round(mm.w * PX_PER_MM);
  const short = Math.round(mm.h * PX_PER_MM);
  const [w, h] = s.orientation === 'portrait' ? [short, long] : [long, short];
  return { x: s.x, y: s.y, w, h };
}

/** Sheet placement that centres the given content, snapped to the grid. */
export function centredSheet(settings: DocSettings, content: Rect | null): Pick<SheetSettings, 'x' | 'y'> {
  const r = sheetRect({ ...settings, titleBlock: true })!;
  if (!content) return { x: -Math.round(r.w / 2 / 10) * 10, y: -Math.round(r.h / 2 / 10) * 10 };
  // keep the drawing clear of the title block in the bottom-right corner
  const cx = content.x + content.w / 2 + TITLE_BLOCK.w / 4;
  const cy = content.y + content.h / 2 + TITLE_BLOCK.h / 4;
  return { x: Math.round((cx - r.w / 2) / 10) * 10, y: Math.round((cy - r.h / 2) / 10) * 10 };
}

/** Number of zone columns / rows along the frame (about one per 50 mm, like most drawing standards). */
export function sheetZones(r: Rect): { cols: number; rows: number } {
  const per = 50 * PX_PER_MM;
  return { cols: Math.max(2, Math.round(r.w / per)), rows: Math.max(2, Math.round(r.h / per)) };
}

export const sheetOf = (doc: Pick<CircuitDoc, 'settings'>): SheetSettings => ({ ...DEFAULT_SHEET, ...doc.settings.sheet });

export const todayText = () => new Date().toISOString().slice(0, 10);

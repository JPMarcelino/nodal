import { measureText } from '../model/geometry';
import { SHEET_BAND, SHEET_MARGIN, SHEET_SIZES, TITLE_BLOCK, sheetOf, sheetRect, sheetZones, todayText } from '../model/sheet';
import type { CircuitDoc } from '../model/types';

/** Shortens text with an ellipsis so it fits `max` px at the given size. */
export function fitText(text: string, size: number, max: number, weight = 400): string {
  if (measureText(text, size, weight).w <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureText(`${text.slice(0, mid).trimEnd()}…`, size, weight).w <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${text.slice(0, lo).trimEnd()}…` : '';
}

/** Drawing frame: paper outline, border with zone markers, and the title block. */
export function SheetFrame({ doc, ink, dim }: { doc: CircuitDoc; ink: string; dim: string }) {
  const r = sheetRect(doc.settings);
  if (!r) return null;
  const s = sheetOf(doc);
  const m = SHEET_MARGIN;
  const b = SHEET_BAND;
  const outer = { x: r.x + m, y: r.y + m, w: r.w - 2 * m, h: r.h - 2 * m };
  const inner = { x: outer.x + b, y: outer.y + b, w: outer.w - 2 * b, h: outer.h - 2 * b };
  const { cols, rows } = sheetZones(inner);
  const colW = inner.w / cols;
  const rowH = inner.h / rows;
  const zoneText = { fontSize: 10, fill: dim, textAnchor: 'middle' as const, className: 'sheet-text' };

  const tb = { x: inner.x + inner.w - TITLE_BLOCK.w, y: inner.y + inner.h - TITLE_BLOCK.h, ...TITLE_BLOCK };
  const cell = (x: number, y: number, w: number, h: number, label: string, value: string, size = 11, weight = 500) => (
    <g key={label}>
      <rect x={x} y={y} width={w} height={h} fill="none" stroke={ink} strokeWidth={1} />
      <text x={x + 6} y={y + 11} fontSize={7.5} fill={dim} className="sheet-text sheet-caption">
        {label.toUpperCase()}
      </text>
      <text x={x + 6} y={y + h - (h > 40 ? 14 : 9)} fontSize={size} fontWeight={weight} fill={ink} className="sheet-text">
        {fitText(value, size, w - 12, weight)}
      </text>
    </g>
  );
  const size = SHEET_SIZES[s.size]?.label ?? s.size;
  const bottom = [
    { label: 'Drawn by', value: doc.settings.author || '—', w: 140 },
    { label: 'Date', value: s.date || todayText(), w: 100 },
    { label: 'Size', value: size, w: 70 },
    { label: 'Rev', value: doc.settings.revision || '—', w: 50 },
    { label: 'Sheet', value: s.sheetNo || '1 / 1', w: 80 },
  ];
  let bx = tb.x;
  return (
    <g className="sheet-frame" pointerEvents="none">
      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke={dim} strokeWidth={0.75} strokeDasharray="6 6" />
      <rect x={outer.x} y={outer.y} width={outer.w} height={outer.h} fill="none" stroke={ink} strokeWidth={1.5} />
      <rect x={inner.x} y={inner.y} width={inner.w} height={inner.h} fill="none" stroke={ink} strokeWidth={1} />
      {Array.from({ length: cols }, (_, i) => {
        const x = inner.x + i * colW;
        return (
          <g key={`c${i}`}>
            {i > 0 && <path d={`M${x} ${outer.y}V${inner.y}M${x} ${inner.y + inner.h}V${outer.y + outer.h}`} stroke={ink} strokeWidth={1} />}
            <text x={x + colW / 2} y={outer.y + b / 2 + 3.5} {...zoneText}>
              {i + 1}
            </text>
            <text x={x + colW / 2} y={inner.y + inner.h + b / 2 + 3.5} {...zoneText}>
              {i + 1}
            </text>
          </g>
        );
      })}
      {Array.from({ length: rows }, (_, i) => {
        const y = inner.y + i * rowH;
        const letter = String.fromCharCode(65 + (i % 26));
        return (
          <g key={`r${i}`}>
            {i > 0 && <path d={`M${outer.x} ${y}H${inner.x}M${inner.x + inner.w} ${y}H${outer.x + outer.w}`} stroke={ink} strokeWidth={1} />}
            <text x={outer.x + b / 2} y={y + rowH / 2 + 3.5} {...zoneText}>
              {letter}
            </text>
            <text x={inner.x + inner.w + b / 2} y={y + rowH / 2 + 3.5} {...zoneText}>
              {letter}
            </text>
          </g>
        );
      })}
      <rect x={tb.x} y={tb.y} width={tb.w} height={tb.h} fill="var(--sym-bg)" stroke={ink} strokeWidth={1.5} />
      {cell(tb.x, tb.y, tb.w, 34, 'Company', s.company || '—')}
      {cell(tb.x, tb.y + 34, tb.w, 46, 'Title', doc.name || 'Untitled circuit', 17, 700)}
      {s.description && (
        <text x={tb.x + tb.w - 6} y={tb.y + 45} fontSize={8.5} fill={dim} textAnchor="end" className="sheet-text">
          {fitText(s.description, 8.5, tb.w - 70)}
        </text>
      )}
      {bottom.map((c) => {
        const el = cell(bx, tb.y + 80, c.w, 40, c.label, c.value);
        bx += c.w;
        return el;
      })}
    </g>
  );
}

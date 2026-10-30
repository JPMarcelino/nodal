import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { SWATCHES, swatchBg, swatchTitle } from './controls';
import { restyle } from './StyleSection';
import { lookKeys, lookOf } from '../model/style';
import { useStore } from '../store/store';
import type { ShapeItem } from '../model/types';

/**
 * The small card that follows a hovered object and offers its most useful
 * style edits: a part's fill and line, a wire's colour and thickness, a text's
 * size and colour. Keeping the pointer on the card holds it open; leaving both
 * the object and the card closes it.
 */

/** Short names for the card's title. */
const SHAPE_NAMES: Record<ShapeItem['kind'], string> = {
  rect: 'Rectangle',
  zone: 'Zone',
  ellipse: 'Ellipse',
  polygon: 'Polygon',
  line: 'Line',
  arrow: 'Arrow',
  text: 'Text',
  image: 'Image',
  ink: 'Ink',
  callout: 'Note',
  frame: 'Frame',
};

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

type ColourKind = 'fill' | 'line' | 'text';

/**
 * A colour dot that opens the palette. The dot itself shows what it paints:
 * a filled chip for a fill, a ring for a line, an "A" for text.
 */
export function QuickColor({
  value,
  fallback,
  onChange,
  title,
  kind = 'line',
}: {
  value: string;
  fallback?: string;
  onChange: (v: string) => void;
  title: string;
  kind?: ColourKind;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const shown = value || fallback || '';
  // close when clicking anywhere outside this control (its palette included)
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]);
  return (
    <span className="qe-colour" ref={ref}>
      <button
        type="button"
        className={`qe-dot ${kind}${shown ? '' : ' none'}`}
        style={{ ['--dot' as string]: shown ? swatchBg(shown) : undefined } as CSSProperties}
        title={title}
        aria-label={title}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {kind === 'text' && <span className="qe-dot-a">A</span>}
      </button>
      {open && (
        <div className="qe-palette" role="listbox" aria-label={`${title} palette`}>
          <button
            type="button"
            className="qe-pal none"
            title="Automatic"
            aria-label="Automatic"
            onClick={() => {
              onChange('');
              setOpen(false);
            }}
          />
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              className={c.toLowerCase() === value.toLowerCase() ? 'qe-pal picked' : 'qe-pal'}
              style={{ background: swatchBg(c) }}
              title={swatchTitle(c)}
              aria-label={swatchTitle(c)}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
            />
          ))}
          <label className="qe-pal custom" title="Any colour">
            +
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(shown) ? shown : '#7aa2f7'}
              onChange={(e) => {
                onChange(e.target.value);
                setOpen(false);
              }}
            />
          </label>
        </div>
      )}
    </span>
  );
}

/** A small − value + stepper, for a line width or a font size. */
export function QuickNumber({
  value,
  min,
  max,
  step = 1,
  onChange,
  title,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  title: string;
  suffix?: string;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, +v.toFixed(2))));
  const label = `${+value.toFixed(2)}${suffix ?? ''}`;
  return (
    <span className="qe-step" title={title}>
      <button type="button" className="qe-step-btn" aria-label={`Less ${title.toLowerCase()}`} disabled={value <= min} onClick={() => set(value - step)}>
        −
      </button>
      <span className="qe-step-value">
        {+value.toFixed(2)}
        {suffix && <i>{suffix}</i>}
      </span>
      <button type="button" className="qe-step-btn" aria-label={`More ${title.toLowerCase()}`} disabled={value >= max} onClick={() => set(value + step)}>
        +
      </button>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* The card                                                            */
/* ------------------------------------------------------------------ */

export function HoverEdit({
  id,
  x,
  y,
  onEnter,
  onLeave,
}: {
  /** The item under the pointer. */
  id: string;
  /** Screen anchor (inside the canvas wrapper): the middle of the item's top edge. */
  x: number;
  y: number;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const doc = useStore((s) => s.doc);
  const canvas = useStore((s) => s.canvasSize);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const it = doc.items[id];

  // measure, then sit above the object (or below when there is no room above)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(x - w / 2, canvas.w - w - 8));
    let top = y - h - 12;
    if (top < 8) top = y + 26;
    top = Math.max(8, Math.min(top, canvas.h - h - 8));
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [x, y, canvas.w, canvas.h, id]);

  // the wheel belongs to the card while the pointer is on it (the canvas zooms otherwise)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener('wheel', stop, { passive: true });
    return () => el.removeEventListener('wheel', stop);
  }, [id]);

  if (!it || it.locked || it.type === 'junction') return null;

  const look = lookOf(doc, it);
  const keys = new Set(lookKeys(it));
  const set = (p: Parameters<typeof restyle>[1]) => restyle([id], p);

  // what this object is, in a word or two
  let name = '';
  let colour: { value: string; title: string; kind: ColourKind; patch: (v: string) => Parameters<typeof restyle>[1] }[] = [];
  let sizes: { value: number; min: number; max: number; step: number; title: string; suffix: string; set: (v: number) => void }[] = [];
  if (it.type === 'component') {
    name = it.ref || it.value || 'Part';
    colour = [
      ...(keys.has('fill') ? [{ value: look.fill ?? '', title: 'Fill colour', kind: 'fill' as const, patch: (fill: string) => ({ fill }) }] : []),
      ...(keys.has('line') ? [{ value: look.line ?? '', title: 'Line colour', kind: 'line' as const, patch: (line: string) => ({ line }) }] : []),
    ];
    if (keys.has('width'))
      sizes = [{ value: look.width ?? 2, min: 0.25, max: 30, step: 0.25, title: 'Line width', suffix: 'px', set: (width) => set({ width }) }];
  } else if (it.type === 'wire') {
    name = it.label ? `Wire · ${it.label}` : 'Wire';
    colour = [{ value: look.line ?? '', title: 'Wire colour', kind: 'line' as const, patch: (line: string) => ({ line }) }];
    sizes = [{ value: look.width ?? 2, min: 0.5, max: 20, step: 0.5, title: 'Wire thickness', suffix: 'px', set: (width) => set({ width }) }];
  } else {
    name = SHAPE_NAMES[it.kind];
    if (it.kind === 'text') {
      colour = [{ value: look.text ?? '', title: 'Text colour', kind: 'text' as const, patch: (text: string) => ({ text }) }];
      sizes = [{ value: look.size ?? 16, min: 4, max: 200, step: 1, title: 'Text size', suffix: 'px', set: (size) => set({ size }) }];
    } else {
      if (keys.has('fill')) colour.push({ value: it.fill === 'none' || it.fillOpacity === 0 ? '' : (look.fill ?? ''), title: 'Fill colour', kind: 'fill' as const, patch: (fill: string) => ({ fill }) });
      if (keys.has('line')) colour.push({ value: look.line ?? '', title: 'Line colour', kind: 'line' as const, patch: (line: string) => ({ line }) });
      if (keys.has('width')) sizes.push({ value: look.width ?? 2, min: 0, max: 40, step: 0.5, title: 'Line width', suffix: 'px', set: (width) => set({ width }) });
    }
  }

  return (
    <div
      className="hover-edit"
      ref={ref}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      role="toolbar"
      aria-label={`${name} quick style`}
    >
      <span className="he-name">{name}</span>
      <span className="he-divider" />
      {colour.map((c) => (
        <QuickColor key={c.title} value={c.value} title={c.title} kind={c.kind} onChange={(v) => set(c.patch(v))} />
      ))}
      {sizes.map((s) => (
        <QuickNumber key={s.title} value={s.value} min={s.min} max={s.max} step={s.step} title={s.title} suffix={s.suffix} onChange={s.set} />
      ))}
    </div>
  );
}

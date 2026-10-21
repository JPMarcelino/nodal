import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { createPortal } from 'react-dom';
import { keysFor, prettyKey } from '../store/commands';

/** Pure black is the theme-aware "ink" (black on paper, cream on the dark theme). */
export const INK = '#000000';
const isInk = (c: string) => /^#(000|000000)$/i.test(c);
/** What a swatch paints: ink follows the theme, anything else is literal. */
export const swatchBg = (c: string) => (isInk(c) ? 'var(--ink)' : c);
export const swatchTitle = (c: string) => (isInk(c) ? 'Ink (follows the theme)' : c);

export const SWATCHES = ['#000000', '#3ddc97', '#7aa2f7', '#bb9af7', '#f7768e', '#ff9e64', '#e0af68', '#9ece6a', '#2ac3de', '#c0caf5', '#565f89', '#1f2433', '#ffffff'];

export function Field({ label, children, hint, wide }: { label: string; children: ReactNode; hint?: string; wide?: boolean }) {
  return (
    <label className={wide ? 'field wide' : 'field'} title={hint}>
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
    </label>
  );
}

/** Text input that commits on blur / Enter so typing doesn't flood undo history. */
export function TextInput({
  value,
  onChange,
  placeholder,
  focusKey,
  multiline,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  focusKey?: string;
  multiline?: boolean;
  mono?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v !== value && onChange(v);
  if (multiline)
    return (
      <textarea
        className={mono ? 'input mono' : 'input'}
        value={v}
        rows={3}
        placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
          if (e.key === 'Escape') (e.target as HTMLElement).blur();
        }}
      />
    );
  return (
    <input
      className={mono ? 'input mono' : 'input'}
      value={v}
      placeholder={placeholder}
      data-focus={focusKey}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLElement).blur();
        }
        if (e.key === 'Escape') {
          setV(value);
          setTimeout(() => (e.target as HTMLElement).blur());
        }
      }}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  const fmt = (n: number) => String(+n.toFixed(2));
  const [v, setV] = useState(fmt(value));
  useEffect(() => setV(fmt(value)), [value]);
  const commit = (raw = v) => {
    let n = parseFloat(raw);
    if (!Number.isFinite(n)) return setV(fmt(value));
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    if (n !== value) onChange(n);
    else setV(fmt(value));
  };
  return (
    <span className="number-input">
      <input
        className="input"
        value={v}
        inputMode="decimal"
        onChange={(e) => setV(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const base = parseFloat(v);
            const n = (Number.isFinite(base) ? base : value) + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1);
            setV(fmt(n));
            commit(String(n));
          }
        }}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </span>
  );
}

export function Slider({ value, onChange, min, max, step = 0.01 }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      type="range"
      className="slider"
      min={min}
      max={max}
      step={step}
      value={v}
      onChange={(e) => setV(+e.target.value)}
      onPointerUp={() => v !== value && onChange(v)}
      onKeyUp={() => v !== value && onChange(v)}
    />
  );
}

export function ColorInput({ value, onChange, allowNone }: { value: string; onChange: (v: string) => void; allowNone?: boolean }) {
  const [open, setOpen] = useState(false);
  const [rev, setRev] = useState(0);
  const isNone = !value || value === 'none';
  const ref = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  // close when clicking anywhere outside the picker (the field or the portalled popover)
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]);
  // the popover is portalled so panels can't clip it; keep it inside the viewport,
  // flipping above the field when there's no room below
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = ref.current?.getBoundingClientRect();
      const p = popRef.current;
      if (!a || !p) return;
      const m = 8;
      const width = Math.min(Math.max(a.width, 150), window.innerWidth - 2 * m);
      p.style.width = `${width}px`;
      const h = p.offsetHeight;
      let top = a.bottom + 6;
      if (top + h > window.innerHeight - m && a.top - 6 - h >= m) top = a.top - 6 - h;
      top = Math.max(m, Math.min(top, window.innerHeight - m - h));
      const left = Math.max(m, Math.min(a.left, window.innerWidth - m - width));
      setPos({ top, left, width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      setPos({ visibility: 'hidden' });
    };
  }, [open]);
  return (
    <span className="color-input" ref={ref}>
      <button type="button" className={isNone ? 'swatch none' : 'swatch'} style={{ background: isNone ? undefined : swatchBg(value) }} title={isNone ? 'Automatic' : swatchTitle(value)} onClick={() => setOpen(!open)} />
      <TextInput
        key={rev}
        value={isNone ? '' : isInk(value) ? 'ink' : value}
        onChange={(raw) => {
          const v = raw.trim();
          if (!v) return onChange(allowNone ? '' : value);
          if (v.toLowerCase() === 'ink') return onChange(INK);
          // a bare hex without '#' is still meant as a colour; anything unreadable keeps the old one
          const c = /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? `#${v}` : v;
          if (CSS.supports('color', c)) onChange(c.toLowerCase());
          else setRev((r) => r + 1);
        }}
        placeholder={allowNone ? 'auto' : ''}
        mono
      />
      {open &&
        createPortal(
          <div className="swatch-pop" ref={popRef} style={pos}>
            {allowNone && (
              <button
                className="swatch none"
                title="Automatic"
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
              />
            )}
            {SWATCHES.map((c) => (
              <button
                key={c}
                className="swatch"
                style={{ background: swatchBg(c) }}
                title={swatchTitle(c)}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
              />
            ))}
            <label className="swatch custom" title="Custom colour">
              +
              <input type="color" value={/^#[0-9a-f]{6}/i.test(value) ? value.slice(0, 7) : '#7aa2f7'} onChange={(e) => onChange(e.target.value)} />
            </label>
          </div>,
          document.body,
        )}
    </span>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <span className="segmented">
      {options.map((o) => (
        <button key={String(o.value)} type="button" title={o.title ?? (typeof o.label === 'string' ? o.label : undefined)} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" className={checked ? 'toggle on' : 'toggle'} disabled={disabled} style={disabled ? { opacity: 0.45 } : undefined} onClick={() => onChange(!checked)} aria-pressed={checked}>
      <span className="knob" />
      {label && <span className="toggle-label">{label}</span>}
    </button>
  );
}

export function Kbd({ combo }: { combo: string }) {
  return <kbd>{prettyKey(combo)}</kbd>;
}

export function shortcutHint(id: string) {
  const k = keysFor(id)[0];
  return k ? ` (${prettyKey(k)})` : '';
}

/* Open / closed state of inspector sections and "more options" folds, remembered across sessions. */
const FOLD_KEY = 'nodal.folds';
let folds: Record<string, boolean> = (() => {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
})();
const foldListeners = new Set<() => void>();
export function setFolds(patch: Record<string, boolean>) {
  folds = { ...folds, ...patch };
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(folds));
  } catch {
    /* storage full or blocked: keep it for this session */
  }
  foldListeners.forEach((f) => f());
}
/** A fold (open / closed) that is remembered across sessions. */
export function useFold(id: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(
    (f) => (foldListeners.add(f), () => void foldListeners.delete(f)),
    () => folds[id] ?? defaultOpen,
  );
  return [open, (v) => setFolds({ [id]: v })];
}

export function Section({
  title,
  children,
  actions,
  id = title.replace(/\s*\(.*\)$/, ''),
  defaultOpen = true,
  summary,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  /** Key the open state is remembered under (default: the title without a "(count)"). */
  id?: string;
  defaultOpen?: boolean;
  /** Short state shown in the header while folded, e.g. "A4 · landscape". */
  summary?: ReactNode;
}) {
  const [open, setOpen] = useFold(`s:${id}`, defaultOpen);
  return (
    <section className={open ? 'section' : 'section folded'} data-section={id} data-title={title}>
      <header className="section-head">
        <button type="button" className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Fold this section' : 'Show this section'}>
          <ChevronRight size={13} className="section-chevron" />
          <span className="section-title">{title}</span>
          {!open && summary && <span className="section-summary">{summary}</span>}
        </button>
        {open && actions}
      </header>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

/** Less-used options of a section, folded away behind a "More options" row. */
export function More({ id, children, label = 'More options', count }: { id: string; children: ReactNode; label?: string; count?: number }) {
  const [open, setOpen] = useFold(`m:${id}`, false);
  return (
    <>
      <button type="button" className={open ? 'more-toggle open' : 'more-toggle'} aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className="section-chevron" />
        {open ? 'Fewer options' : label}
        {!open && !!count && <span className="more-count" title={`${count} changed from the default`}>{count}</span>}
      </button>
      {open && <div className="more-body">{children}</div>}
    </>
  );
}

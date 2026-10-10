import { useEffect, useState, type ReactNode } from 'react';
import { keysFor, prettyKey } from '../store/commands';

export const SWATCHES = [
  '#3ddc97',
  '#7aa2f7',
  '#bb9af7',
  '#f7768e',
  '#ff9e64',
  '#e0af68',
  '#9ece6a',
  '#2ac3de',
  '#c0caf5',
  '#565f89',
  '#1f2433',
  '#ffffff',
];

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
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(+value.toFixed(2))), [value]);
  const commit = (raw = v) => {
    let n = parseFloat(raw);
    if (Number.isNaN(n)) return setV(String(value));
    if (min !== undefined) n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    if (n !== value) onChange(n);
    else setV(String(value));
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
            const n = (parseFloat(v) || 0) + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1);
            setV(String(+n.toFixed(2)));
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
  const isNone = !value || value === 'none';
  return (
    <span className="color-input">
      <button type="button" className={isNone ? 'swatch none' : 'swatch'} style={{ background: isNone ? undefined : value }} onClick={() => setOpen(!open)} />
      <TextInput value={isNone ? '' : value} onChange={(v) => onChange(v || (allowNone ? '' : value))} placeholder={allowNone ? 'auto' : ''} mono />
      {open && (
        <div className="swatch-pop" onPointerLeave={() => setOpen(false)}>
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
              style={{ background: c }}
              title={c}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
            />
          ))}
          <label className="swatch custom" title="Custom colour">
            +
            <input type="color" value={isNone ? '#7aa2f7' : value.slice(0, 7)} onChange={(e) => onChange(e.target.value)} />
          </label>
        </div>
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
        <button key={String(o.value)} type="button" title={o.title} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" className={checked ? 'toggle on' : 'toggle'} onClick={() => onChange(!checked)} aria-pressed={checked}>
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

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <span>{title}</span>
        {actions}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

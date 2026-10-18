import { useState } from 'react';
import { create } from 'zustand';
import type { SvgDrawing } from '../io/svgImport';
import { DEFAULT_SVG_IMPORT, type SvgImportOptions } from '../model/svgDrawing';
import { Segmented } from './controls';

/*
 * Asks how an SVG should come in (wires or lines, polygons, shapes, symbol
 * recognition). The last answer is remembered and preselected next time.
 */

const STORE_KEY = 'nodal.svgImport';

export function lastSvgImportOptions(): SvgImportOptions {
  try {
    return { ...DEFAULT_SVG_IMPORT, ...JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') };
  } catch {
    return DEFAULT_SVG_IMPORT;
  }
}

interface Question {
  name: string;
  drawing: SvgDrawing;
  resolve: (v: SvgImportOptions | null) => void;
}

const useSvgAsk = create<{ q: Question | null }>(() => ({ q: null }));

/** Shows the import options for one SVG; resolves with the choice, or null when cancelled. */
export function askSvgImport(name: string, drawing: SvgDrawing): Promise<SvgImportOptions | null> {
  return new Promise((resolve) => {
    useSvgAsk.getState().q?.resolve(null);
    useSvgAsk.setState({ q: { name, drawing, resolve } });
  });
}

const answer = (v: SvgImportOptions | null) => {
  const q = useSvgAsk.getState().q;
  if (v)
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(v));
    } catch {
      /* private mode: just don't remember */
    }
  q?.resolve(v);
  useSvgAsk.setState({ q: null });
};

// like the Ask dialog: Esc cancels, and no shortcut reaches the app behind
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener(
    'keydown',
    (e) => {
      if (!useSvgAsk.getState().q) return;
      e.stopImmediatePropagation();
      if (e.key !== 'Escape') return;
      e.preventDefault();
      answer(null);
    },
    true,
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function SvgImportHost() {
  const q = useSvgAsk((s) => s.q);
  if (!q) return null;
  return <SvgImportDialog key={q.name} q={q} />;
}

function SvgImportDialog({ q }: { q: Question }) {
  const [o, setO] = useState(lastSvgImportOptions);
  const set = (patch: Partial<SvgImportOptions>) => setO((v) => ({ ...v, ...patch }));
  const d = q.drawing;
  const open = d.lines.filter((l) => !l.closed).length;
  const closed = d.lines.length - open;
  const summary = [plural(open, 'stroke'), plural(closed, 'closed outline'), plural(d.boxes.length, 'box', 'boxes'), plural(d.dots.length, 'dot'), plural(d.texts.length, 'text')]
    .filter((s) => !s.startsWith('0 '))
    .join(' · ');
  return (
    <div className="ask-backdrop" onPointerDown={(e) => e.target === e.currentTarget && answer(null)}>
      <div className="ask svg-import" role="dialog" aria-label="Import SVG">
        <strong>Import “{q.name}”</strong>
        <span className="muted small">{summary || 'Nothing drawable found'}</span>
        <div className="svg-import-row">
          <span>Strokes</span>
          <Segmented
            value={o.strokes}
            options={[
              { value: 'wires', label: 'Wires', title: 'Connected wires, joined by junctions where they meet' },
              { value: 'lines', label: 'Lines', title: 'Plain drawn lines (not part of the circuit)' },
            ]}
            onChange={(strokes) => set({ strokes })}
          />
        </div>
        <div className="svg-import-row">
          <span>Closed outlines</span>
          <Segmented
            value={o.closed}
            options={[
              { value: 'polygons', label: 'Polygons', title: 'Polygon shapes, keeping their fill' },
              { value: 'strokes', label: 'Like strokes', title: 'Loops of wires or lines, as chosen above' },
            ]}
            onChange={(closed) => set({ closed })}
          />
        </div>
        <div className="svg-import-row">
          <span>Rectangles &amp; ellipses</span>
          <Segmented
            value={o.boxes}
            options={[
              { value: 'shapes', label: 'Boxes', title: 'Rectangle and ellipse shapes' },
              { value: 'outlines', label: 'Like outlines', title: 'Treated like the other closed outlines' },
            ]}
            onChange={(boxes) => set({ boxes })}
          />
        </div>
        <label className="check" title="Drawings whose geometry matches a library symbol exactly (moved, rotated, flipped or scaled) become that part, wired up at its pins">
          <input type="checkbox" checked={o.symbols} onChange={(e) => set({ symbols: e.target.checked })} /> Recognise library symbols (exact matches)
        </label>
        <div className="btn-row">
          <button className="secondary-btn" onClick={() => answer(null)}>
            Cancel
          </button>
          <button className="primary-btn" autoFocus onClick={() => answer(o)}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

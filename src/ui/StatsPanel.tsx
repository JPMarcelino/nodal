import { X } from 'lucide-react';
import { useMemo } from 'react';
import { docStats, selectionStats, type Counts } from '../model/stats';
import { viewDoc } from '../model/pages';
import * as A from '../store/actions';
import { keysFor, prettyKey } from '../store/commands';
import { useStore } from '../store/store';
import { useSettledDoc } from './useSettledDoc';

const n = (v: number) => Math.round(v).toLocaleString();

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stats-row" title={hint}>
      <span className="stats-label">{label}</span>
      <span className="stats-value">{value}</span>
    </div>
  );
}

function CountRows({ c }: { c: Counts }) {
  return (
    <>
      <Row label="Parts" value={n(c.parts)} hint="Components, not counting power symbols, labels, ports and flags" />
      <Row label="Power & labels" value={n(c.markers)} hint="Ground and supply symbols, net labels, ports, no-connect and other flags" />
      <Row label="Wires" value={n(c.wires)} />
      <Row label="Wire length" value={`${n(c.wireLength)} px`} />
      {c.shapes > 0 && <Row label="Shapes & text" value={n(c.shapes)} />}
    </>
  );
}

/**
 * Floating stats: the selection's size and place, and counts for the page and
 * the circuit. It only listens to the document, page and selection, and
 * recounts once edits settle, so drags and pointer moves don't pay for it.
 */
export function StatsPanel() {
  const open = useStore((s) => s.statsOpen);
  return open ? <StatsBody /> : null;
}

function StatsBody() {
  const page = useStore((s) => s.page);
  const selection = useStore((s) => s.selection);
  const grid = useStore((s) => s.doc.settings.grid);
  useStore((s) => s.prefs.keymap);
  useStore((s) => s.prefs.keymapCadence);
  // recount once edits settle (like the nets panel): not on every drag frame
  const settled = useSettledDoc(200);
  const stats = useMemo(() => docStats(settled, page), [settled, page]);
  const sel = useMemo(() => (selection.length ? selectionStats(viewDoc(settled, page), selection) : null), [settled, page, selection]);
  const multi = stats.all.pages > 1;
  const key = prettyKey(keysFor('view.stats')[0] ?? '');
  const b = sel?.bounds;
  return (
    <div className="stats-panel" role="region" aria-label="Stats" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="stats-head">
        <span>Stats</span>
        <button className="icon-btn small" onClick={A.toggleStats} title={`Close${key ? ` (${key})` : ''}`} aria-label="Close stats">
          <X size={14} />
        </button>
      </div>
      {sel && sel.count > 0 && (
        <div className="stats-group">
          <div className="stats-title">Selection</div>
          <Row label="Items" value={n(sel.count)} />
          {b && (
            <>
              <Row label="X, Y" value={`${n(b.x)}, ${n(b.y)} px`} hint="Top-left corner of the selection’s bounding box" />
              <Row label="W × H" value={`${n(b.w)} × ${n(b.h)} px`} hint={`${+(b.w / grid).toFixed(1)} × ${+(b.h / grid).toFixed(1)} grid squares of ${grid} px`} />
            </>
          )}
          {sel.rotation !== undefined && <Row label="Rotation" value={`${+sel.rotation.toFixed(1)}°${sel.flipped ? ' · flipped' : ''}`} />}
        </div>
      )}
      {multi && (
        <div className="stats-group">
          <div className="stats-title">This page</div>
          <CountRows c={stats.page} />
        </div>
      )}
      <div className="stats-group">
        <div className="stats-title">{multi ? 'Whole circuit' : 'Circuit'}</div>
        <CountRows c={stats.all} />
        <Row label="Nets" value={n(stats.all.nets)} hint="Connections that join something: a wire, or two pins touching" />
        <Row label="Pages" value={n(stats.all.pages)} />
      </div>
    </div>
  );
}

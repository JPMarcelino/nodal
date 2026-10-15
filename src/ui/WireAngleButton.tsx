import type { WireAngle } from '../model/types';
import * as A from '../store/actions';
import { keysFor, prettyKey } from '../store/commands';
import { useStore } from '../store/store';

const ICONS: Record<WireAngle, JSX.Element> = {
  ortho: <polyline points="3,15 3,6 15,6 15,3" />,
  '45': <polyline points="2,15 7,15 15,7 15,2" />,
  any: <polyline points="2,15 16,4" />,
};

/** Tool rail button for the angle new wires are drawn at; each click steps 90° → 45° → any. */
export function WireAngleButton() {
  const angle = useStore((s) => s.prefs.wireAngle);
  const tool = useStore((s) => s.tool);
  const cur = A.WIRE_ANGLES.find((a) => a.value === angle) ?? A.WIRE_ANGLES[0];
  const k = prettyKey(keysFor('wire.angle')[0] ?? '');
  return (
    <button
      className={tool === 'wire' ? 'tool-btn wire-angle-btn active-soft' : 'tool-btn wire-angle-btn'}
      onClick={() => A.setWireAngle()}
      title={`Wire angle: ${cur.title} — click (or Tab while wiring${k ? `, ${k}` : ''}) for ${A.WIRE_ANGLES.map((a) => a.label).join(' / ')}`}
    >
      <svg width={17} height={17} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        {ICONS[angle]}
      </svg>
      <span className="tool-key">{cur.label}</span>
    </button>
  );
}

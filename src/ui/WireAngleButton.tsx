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
      title={`Wire angle: ${cur.title} — click (or W / Tab while wiring${k ? `, ${k}` : ''}) for ${A.WIRE_ANGLES.map((a) => a.label).join(' / ')}`}
    >
      <svg width={17} height={17} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        {ICONS[angle]}
      </svg>
      <span className="tool-key">{cur.label}</span>
    </button>
  );
}

/** Tool rail toggle between drawing plain wires and buses. */
export function BusButton() {
  const bus = useStore((s) => s.prefs.drawBus);
  const k = prettyKey(keysFor('wire.bus')[0] ?? '');
  return (
    <button
      className={bus ? 'tool-btn wire-angle-btn active' : 'tool-btn wire-angle-btn'}
      onClick={() => A.setDrawBus()}
      aria-pressed={bus}
      title={`${bus ? 'Drawing buses' : 'Drawing plain wires'} — click${k ? ` (${k})` : ''} to switch. Name a bus like D[0..7]; wires tapped onto it named D0…D7 join those signals`}
    >
      <svg width={17} height={17} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M2 9H16" strokeWidth={4} />
        <path d="M7 12.5L10 5.5" strokeWidth={1.4} />
      </svg>
      <span className="tool-key">Bus</span>
    </button>
  );
}

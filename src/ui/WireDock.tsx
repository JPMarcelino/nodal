import type { WireAngle } from '../model/types';
import * as A from '../store/actions';
import { keysFor, prettyKey } from '../store/commands';
import { useStore } from '../store/store';

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

const ICONS: Record<WireAngle, JSX.Element> = {
  ortho: <polyline points="3,15 3,6 15,6 15,3" />,
  '45': <polyline points="2,15 7,15 15,7 15,2" />,
  any: <polyline points="2,15 16,4" />,
};

/** Angle picker shown with the wire tool: square elbows, 45° steps or any angle. */
export function WireDock({ drawing }: { drawing: boolean }) {
  const angle = useStore((s) => s.prefs.wireAngle);
  const k = prettyKey(keysFor('wire.angle')[0] ?? '');
  return (
    <div className="explain-dock-wrap wire-dock-wrap" onPointerDown={stop} onPointerUp={stop} onWheel={stop}>
      <div className="explain-hint">
        {drawing ? (
          <>
            Click to add a bend · click a pin or wire, or double-click, to finish · <kbd>Space</kbd> flip bend · <kbd>Tab</kbd> angle · <kbd>Backspace</kbd> undo bend
          </>
        ) : (
          <>
            Click or drag from a pin, wire or the grid · <kbd>Tab</kbd>{k && <> / <kbd>{k}</kbd></>} changes the angle
          </>
        )}
      </div>
      <div className="explain-dock wire-dock">
        {A.WIRE_ANGLES.map((a) => (
          <button key={a.value} className={angle === a.value ? 'xd-btn active' : 'xd-btn'} title={a.title} onClick={() => A.setWireAngle(a.value)}>
            <svg width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              {ICONS[a.value]}
            </svg>
            <span className="wd-label">{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

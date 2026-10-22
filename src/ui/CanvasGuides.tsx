import { memo } from 'react';
import { Command, Cpu, FolderOpen, Radio, Search, Upload } from 'lucide-react';
import { getSymbol } from '../model/registry';
import type { CircuitDoc, Item } from '../model/types';
import { openExample } from '../io/fileActions';
import { COMMAND_MAP, keysFor, prettyKey } from '../store/commands';
import { isExplainTool, useExplain } from '../store/explain';
import { set, useStore } from '../store/store';
import { viewDoc } from '../model/pages';
import { hintFor, type HintGesture, type HintSel } from './hints';
import { Logo } from './Logo';

/** Command id → its first key in the user's bindings; anything else → a pretty fixed combo. */
const keyLabel = (idOrCombo: string) => (/^[a-z]+\.[A-Za-z0-9]+$/.test(idOrCombo) ? prettyKey(keysFor(idOrCombo)[0] ?? '') : prettyKey(idOrCombo));

function selKind(doc: CircuitDoc, it: Item | undefined): HintSel {
  if (!it) return 'other';
  if (it.type === 'wire') return it.label ? 'labelledWire' : 'wire';
  if (it.type === 'component') {
    const def = getSymbol(doc, it.symbol);
    return def.valueIsLabel && !def.prefix?.startsWith('#PWR') ? 'label' : 'part';
  }
  if (it.type === 'shape') {
    if (it.kind === 'text') return 'text';
    if (it.kind === 'rect' || it.kind === 'zone' || it.kind === 'ellipse' || it.kind === 'polygon') return 'shape';
  }
  return 'other';
}

/** No own keys (stops at the first: this runs on every store update, pointer moves included). */
function isEmpty(o: object): boolean {
  for (const k in o) {
    void k;
    return false;
  }
  return true;
}

/** The welcome screen shows on an empty page while editing (not presenting, not as a session guest). */
function useWelcomeShown(): boolean {
  const empty = useStore((s) => isEmpty(viewDoc(s.doc, s.page).items));
  const idle = useStore((s) => s.tool === 'select' && !s.placing && !s.viewOnly && !s.exportArea);
  const presenting = useExplain((s) => s.presenting !== null);
  return empty && idle && !presenting;
}

/**
 * A quiet line at the bottom of the canvas with the next useful action for
 * the tool in hand. Never takes the pointer; hidden by Settings → Show hints,
 * while presenting, under the explain dock and on touch-only screens.
 */
export const HintBar = memo(function HintBar({ gesture, editingText }: { gesture: HintGesture | null; editingText: boolean }) {
  const show = useStore((s) => s.prefs.showHints && !s.viewOnly);
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => !!s.placing);
  const toolLock = useStore((s) => s.prefs.toolLock);
  const cadence = useStore((s) => s.prefs.shortcuts === 'cadence');
  const banner = useStore((s) => !!s.exportArea || (s.tool === 'select' && s.altMove));
  const shapePreset = useStore((s) => !!s.shapePreset);
  const minimap = useStore((s) => s.prefs.showMinimap);
  // a string, so the line only re-renders when the kinds change
  const selKey = useStore((s) => {
    if (!s.selection.length) return '';
    const d = viewDoc(s.doc, s.page);
    return s.selection.map((id) => selKind(d, d.items[id])).join(',');
  });
  // keymap changes re-render the line with the new keys
  useStore((s) => s.prefs.keymap);
  useStore((s) => s.prefs.keymapCadence);
  const explainUi = useExplain((s) => s.presenting !== null || s.traces.length > 0);
  const welcome = useWelcomeShown();

  if (!show || explainUi || isExplainTool(tool) || (welcome && !gesture)) return null;
  const text = hintFor({
    tool,
    placing,
    keepPlacing: toolLock || cadence,
    toolLock,
    selection: selKey ? (selKey.split(',') as HintSel[]) : [],
    gesture,
    editingText,
    shapePreset,
    banner,
    key: keyLabel,
  });
  if (!text) return null;
  return (
    <div className={minimap ? 'hint-bar with-minimap' : 'hint-bar'} role="status" aria-live="polite">
      {text}
    </div>
  );
});

/** Runs a command by id (they all exist; a missing one would just do nothing). */
const run = (id: string) => COMMAND_MAP.get(id)?.run();

/**
 * Shown over an empty page: the name and the first things to do. Only its
 * buttons take the pointer, so the canvas under it still works; it goes away
 * as soon as anything is on the page.
 */
export function WelcomeScreen() {
  const shown = useWelcomeShown();
  const library = useStore((s) => s.leftPanel && s.leftTab === 'library');
  useStore((s) => s.prefs.keymap);
  useStore((s) => s.prefs.keymapCadence);
  if (!shown) return null;
  const k = (id: string) => prettyKey(keysFor(id)[0] ?? '');
  const actions: { icon: JSX.Element; label: string; key?: string; run: () => void }[] = [
    { icon: <Search size={16} />, label: 'Place a part', key: k('view.search'), run: () => run('view.search') },
    { icon: <FolderOpen size={16} />, label: 'Open a file…', key: k('file.open'), run: () => run('file.open') },
    { icon: <Upload size={16} />, label: 'Import…', key: k('file.import'), run: () => run('file.import') },
    { icon: <Command size={16} />, label: 'Command palette', key: k('help.palette'), run: () => run('help.palette') },
    { icon: <Cpu size={16} />, label: 'Open the example circuit', run: () => void openExample() },
    { icon: <Radio size={16} />, label: 'Join a live session…', run: () => set({ dialog: 'share' }) },
  ];
  return (
    <div className="welcome" aria-label="Welcome">
      <div className="welcome-inner">
        <span className="welcome-note to-rail" aria-hidden>
          <svg width="44" height="64" viewBox="0 0 44 64">
            <path d="M20 62 C 10 44, 30 28, 22 6" />
            <path d="M14 15 L 22 4 L 30 14" />
          </svg>
          tools
        </span>
        {library && (
          <span className="welcome-note to-library" aria-hidden>
            <svg width="96" height="40" viewBox="0 0 96 40">
              <path d="M94 28 C 70 38, 40 8, 6 18" />
              <path d="M16 9 L 4 18 L 16 27" />
            </svg>
            parts library
          </span>
        )}
        <div className="welcome-card">
          <div className="welcome-brand">
            <Logo size={34} />
            <span>Nodal</span>
          </div>
          <div className="welcome-sub">Place parts, then wire their pins together.</div>
          <div className="welcome-actions" role="group" aria-label="Get started" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            {actions.map((a) => (
              <button key={a.label} className="welcome-btn" onClick={a.run}>
                {a.icon}
                <span>{a.label}</span>
                {a.key && <kbd>{a.key}</kbd>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

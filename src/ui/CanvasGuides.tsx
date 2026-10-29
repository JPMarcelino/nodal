import { memo, useEffect, useMemo, useState } from 'react';
import { Command, Cpu, FilePlus2, FileText, FolderOpen, MousePointerClick, Radio, Search, Sparkles, Spline, Upload, X } from 'lucide-react';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import { exportSvg } from '../io/export';
import { listOtherCircuits, onVersionsChanged } from '../io/versionStore';
import type { Version } from '../model/versions';
import * as A from '../store/actions';
import { getSymbol } from '../model/registry';
import type { CircuitDoc, Item } from '../model/types';
import { fileNew, openExample, openFromHistory } from '../io/fileActions';
import { COMMAND_MAP, keysFor, prettyKey } from '../store/commands';
import { isExplainTool, useExplain } from '../store/explain';
import { firstVisit, readOnly, set, useStore } from '../store/store';
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

/** The welcome screen shows on an empty page while editing (not presenting, not in View mode or as a session guest). */
function useWelcomeShown(): boolean {
  const empty = useStore((s) => isEmpty(viewDoc(s.doc, s.page).items));
  const idle = useStore((s) => s.tool === 'select' && !s.placing && !readOnly(s) && !s.exportArea);
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
  // a toast takes the quiet line's place while it is up, rather than covering it
  const toasting = useStore((s) => s.toasts.length > 0);
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => !!s.placing);
  const toolLock = useStore((s) => s.prefs.toolLock);
  const cadence = useStore((s) => s.prefs.shortcuts === 'cadence');
  const banner = useStore((s) => !!s.exportArea || (s.tool === 'select' && s.altMove));
  const shapePreset = useStore((s) => !!s.shapePreset);
  const minimap = useStore((s) => s.prefs.showMinimap);
  const viewMode = useStore((s) => s.viewMode);
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

  if (!show || toasting || explainUi || isExplainTool(tool) || (welcome && !gesture)) return null;
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
    viewMode,
    key: markedKey,
  });
  if (!text) return null;
  return (
    <div className={minimap ? 'hint-bar with-minimap' : 'hint-bar'} role="status" aria-live="polite">
      <HintText text={text} />
    </div>
  );
});

/* Keys in a hint are wrapped in these (invisible) marks, so the line can draw them as keycaps. */
const KEY_OPEN = '\u2063';
const KEY_CLOSE = '\u2064';
const markedKey = (idOrCombo: string) => {
  const label = keyLabel(idOrCombo);
  return label ? `${KEY_OPEN}${label}${KEY_CLOSE}` : '';
};

/** A hint with its keys as keycaps and its steps set apart by quiet dots. */
function HintText({ text }: { text: string }) {
  const steps = text.split(' · ');
  return (
    <>
      {steps.map((step, i) => (
        <span key={i} className="hint-step">
          {i > 0 && <span className="hint-dot"> · </span>}
          {step.split(new RegExp(`(${KEY_OPEN}[^${KEY_CLOSE}]*${KEY_CLOSE})`)).map((part, j) =>
            part.startsWith(KEY_OPEN) ? <kbd key={j}>{part.slice(1, -1)}</kbd> : part,
          )}
        </span>
      ))}
    </>
  );
}

/** Runs a command by id (they all exist; a missing one would just do nothing). */
const run = (id: string) => COMMAND_MAP.get(id)?.run();

/** Parts most circuits start with: one click arms them for placing. */
const QUICK_PARTS: [id: string, label: string][] = [
  ['resistor', 'Resistor'],
  ['capacitor', 'Capacitor'],
  ['led', 'LED'],
  ['diode', 'Diode'],
  ['npn', 'NPN'],
  ['opamp', 'Op-amp'],
  ['vcc', 'Supply'],
  ['gnd', 'Ground'],
];

/** "3 min ago", "Yesterday", "12 Mar" */
function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'Yesterday';
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Circuits kept on this device (newest first), loaded once the welcome screen shows. */
function useRecentCircuits(shown: boolean, docId: string | undefined): Version[] {
  const [list, setList] = useState<Version[]>([]);
  useEffect(() => {
    if (!shown) return;
    let alive = true;
    const load = () => listOtherCircuits(docId, 3).then((vs) => alive && setList(vs), () => {});
    void load();
    const off = onVersionsChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [shown, docId]);
  return list;
}

function RecentCard({ v, theme }: { v: Version; theme: 'light' | 'dark' }) {
  const src = useMemo(() => {
    try {
      const { svg } = exportSvg(viewDoc(v.doc), { theme, background: false, padding: 16 });
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch {
      return null;
    }
  }, [v, theme]);
  return (
    <button className="welcome-recent" onClick={() => void openFromHistory(v.doc)} title={`Open “${v.doc.name}”`}>
      <span className="welcome-thumb">{src ? <img src={src} alt="" draggable={false} /> : <FileText size={18} />}</span>
      <span className="welcome-recent-text">
        <span className="welcome-recent-name">{v.doc.name}</span>
        <span className="welcome-recent-time">{ago(v.t)}</span>
      </span>
    </button>
  );
}

/**
 * Shown over an empty page: the name and the first things to do. Only its
 * buttons take the pointer, so the canvas under it still works; it goes away
 * as soon as anything is on the page.
 */
export function WelcomeScreen() {
  const shown = useWelcomeShown();
  const docId = useStore((s) => s.doc.id);
  const docSymbols = useStore((s) => s.doc.symbols);
  const theme = useStore((s) => s.prefs.theme);
  const recent = useRecentCircuits(shown, docId);
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
  const parts = QUICK_PARTS.map(([id, label]) => ({ def: getSymbol({ symbols: docSymbols }, id), label })).filter((p) => p.def.id !== '__missing');
  const steps: { n: number; text: string; key?: string }[] = [
    { n: 1, text: 'Place parts', key: k('view.search') },
    { n: 2, text: 'Drag from a pin to wire', key: k('tool.wire') },
    { n: 3, text: 'Export or share', key: k('file.export') },
  ];
  return (
    <div className="welcome" aria-label="Welcome">
      <div className="welcome-inner">
        <div className="welcome-card" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <div className="welcome-brand">
            <Logo size={34} />
            <span>Nodal</span>
          </div>
          <div className="welcome-sub">Place parts, then wire their pins together.</div>
          <div className={recent.length ? 'welcome-cols two' : 'welcome-cols'}>
            <div className="welcome-col">
              <div className="welcome-heading">Start</div>
              <div className="welcome-actions" role="group" aria-label="Get started">
                {actions.map((a) => (
                  <button key={a.label} className="welcome-btn" onClick={a.run}>
                    {a.icon}
                    <span>{a.label}</span>
                    {a.key && <kbd>{a.key}</kbd>}
                  </button>
                ))}
              </div>
            </div>
            {recent.length > 0 && (
              <div className="welcome-col welcome-recents">
                <div className="welcome-heading">Recent on this device</div>
                {recent.map((v) => (
                  <RecentCard key={v.id} v={v} theme={theme} />
                ))}
              </div>
            )}
          </div>
          <div className="welcome-parts" role="group" aria-label="Quick parts">
            <div className="welcome-heading">Drop in a part</div>
            <div className="welcome-part-row">
              {parts.map(({ def, label }) => (
                <button key={def.id} className="welcome-part" onClick={() => A.startPlacing(def.id)} title={`Place: ${def.name}`}>
                  <SymbolPreview def={def} size={30} pad={2} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
          <ol className="welcome-steps">
            {steps.map((st) => (
              <li key={st.n}>
                <span className="welcome-step-n">{st.n}</span>
                {st.text}
                {st.key && <kbd>{st.key}</kbd>}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

const INTRO_KEY = 'nodal.introSeen';

/**
 * A first visit opens the example circuit; this card says so and offers a
 * blank page. It shows once, and goes as soon as it is dismissed or the
 * circuit is edited.
 */
export function IntroCard() {
  const [seen, setSeen] = useState(() => {
    try {
      return !firstVisit || !!localStorage.getItem(INTRO_KEY);
    } catch {
      return true;
    }
  });
  const edited = useStore((s) => s.past.length > 0);
  const presenting = useExplain((s) => s.presenting !== null);
  const blocked = useStore((s) => readOnly(s));
  const dismiss = () => {
    setSeen(true);
    try {
      localStorage.setItem(INTRO_KEY, '1');
    } catch {
      /* storage blocked: it just shows again next time */
    }
  };
  useEffect(() => {
    if (edited && !seen) dismiss();
  }, [edited, seen]);
  if (seen || presenting || blocked) return null;
  const k = (id: string) => prettyKey(keysFor(id)[0] ?? '');
  return (
    <div className="intro-card" role="dialog" aria-label="Welcome to Nodal" onPointerDown={(e) => e.stopPropagation()}>
      <button className="intro-close" onClick={dismiss} aria-label="Close">
        <X size={14} />
      </button>
      <div className="intro-title">
        <Sparkles size={15} /> Welcome to Nodal
      </div>
      <p>This is an example circuit — poke at it, nothing here can break.</p>
      <ul>
        <li>
          <MousePointerClick size={14} /> Drag parts in from the library on the left
        </li>
        <li>
          <Spline size={14} /> Drag from any pin to draw a wire
        </li>
        <li>
          <Command size={14} /> <kbd>{k('help.palette')}</kbd> finds any command or part
        </li>
      </ul>
      <div className="intro-actions">
        <button
          className="primary-btn"
          onClick={() => {
            dismiss();
            void fileNew();
          }}
        >
          <FilePlus2 size={14} /> Start blank
        </button>
        <button className="secondary-btn" onClick={dismiss}>
          Explore it
        </button>
      </div>
    </div>
  );
}

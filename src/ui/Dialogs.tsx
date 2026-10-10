import { FileCode2, FileImage, FileJson, FileSpreadsheet, FileText, Layers3, Printer, RotateCcw, Scan, BoxSelect, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import { doExport, filePrint, exportSelection, startAreaExport } from '../io/fileActions';
import { BUILTIN_SYMBOLS } from '../model/symbols';
import * as A from '../store/actions';
import { COMMANDS, eventToCombo, keysFor, prettyKey, type Command } from '../store/commands';
import { S, set, setPrefs, useStore } from '../store/store';
import { Field, Kbd, Segmented, Toggle } from './controls';
import { Logo } from './Logo';

export function Modal({ title, onClose, children, width = 560, className }: { title?: ReactNode; onClose: () => void; children: ReactNode; width?: number; className?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ''}`} style={{ width }} role="dialog">
        {title && (
          <header className="modal-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose}>
              <X size={16} />
            </button>
          </header>
        )}
        {children}
      </div>
    </div>
  );
}

const close = () => set({ dialog: null });

/* ------------------------------------------------------------------ */
/* Command palette                                                     */
/* ------------------------------------------------------------------ */

type PaletteEntry = { kind: 'cmd'; cmd: Command } | { kind: 'sym'; id: string; name: string; category: string };

export function CommandPalette() {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const userLib = useStore((s) => s.userLibrary);
  const listRef = useRef<HTMLDivElement>(null);
  const entries = useMemo<PaletteEntry[]>(() => {
    const query = q.trim().toLowerCase();
    const cmds = COMMANDS.filter((c) => !c.when || c.when());
    const syms = [...Object.values(userLib), ...BUILTIN_SYMBOLS];
    const match = (s: string) => query.split(/\s+/).every((w) => s.toLowerCase().includes(w));
    const out: PaletteEntry[] = [];
    for (const c of cmds) if (!query || match(`${c.category} ${c.label}`)) out.push({ kind: 'cmd', cmd: c });
    if (query) for (const s of syms) if (match(`place ${s.name} ${s.keywords ?? ''} ${s.category}`)) out.push({ kind: 'sym', id: s.id, name: s.name, category: s.category });
    return out.slice(0, 80);
  }, [q, userLib]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);
  const run = (e: PaletteEntry | undefined) => {
    if (!e) return;
    close();
    if (e.kind === 'cmd') setTimeout(() => e.cmd.run(), 0);
    else A.startPlacing(e.id);
  };
  return (
    <Modal onClose={close} width={600} className="palette">
      <input
        className="palette-input"
        autoFocus
        placeholder="Type a command or a part name (e.g. “rotate”, “op amp”, “export png”)…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIdx((i) => Math.min(entries.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIdx((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter') run(entries[idx]);
        }}
      />
      <div className="palette-list" ref={listRef}>
        {entries.map((e, i) => (
          <button key={e.kind === 'cmd' ? e.cmd.id : `s:${e.id}`} className={i === idx ? 'palette-item active' : 'palette-item'} onMouseEnter={() => setIdx(i)} onClick={() => run(e)}>
            {e.kind === 'cmd' ? (
              <>
                <span className="palette-cat">{e.cmd.category}</span>
                <span className="palette-label">{e.cmd.label}</span>
                {keysFor(e.cmd.id)[0] && <Kbd combo={keysFor(e.cmd.id)[0]} />}
              </>
            ) : (
              <>
                <span className="palette-cat sym">Place</span>
                <span className="palette-label">{e.name}</span>
                <span className="palette-meta">{e.category}</span>
              </>
            )}
          </button>
        ))}
        {!entries.length && <div className="empty-note">No matches</div>}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Shortcuts (with rebinding)                                          */
/* ------------------------------------------------------------------ */

export function ShortcutsDialog({ editable = false }: { editable?: boolean }) {
  const keymap = useStore((s) => s.prefs.keymap);
  const [q, setQ] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      if (e.key === 'Escape') return setRecording(null);
      const combo = eventToCombo(e);
      const conflicts = COMMANDS.filter((c) => c.id !== recording && keysFor(c.id).includes(combo));
      const next = { ...S().prefs.keymap, [recording]: [combo] };
      for (const c of conflicts) next[c.id] = keysFor(c.id).filter((k) => k !== combo);
      setPrefs({ keymap: next });
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording]);
  const cats = [...new Set(COMMANDS.map((c) => c.category))];
  const query = q.toLowerCase();
  const content = (
    <>
      <div className="shortcuts-toolbar">
        <input className="input" placeholder="Filter shortcuts…" value={q} onChange={(e) => setQ(e.target.value)} />
        {editable && Object.keys(keymap).length > 0 && (
          <button className="secondary-btn" onClick={() => setPrefs({ keymap: {} })}>
            <RotateCcw size={13} /> Reset all
          </button>
        )}
      </div>
      <div className="shortcuts">
        {cats.map((cat) => {
          const cmds = COMMANDS.filter((c) => c.category === cat && (!query || c.label.toLowerCase().includes(query) || keysFor(c.id).some((k) => k.toLowerCase().includes(query))));
          if (!cmds.length) return null;
          return (
            <div key={cat} className="shortcut-group">
              <h3>{cat}</h3>
              {cmds.map((c) => (
                <div key={c.id} className="shortcut-row">
                  <span>{c.label}</span>
                  <span className="shortcut-keys">
                    {recording === c.id ? (
                      <span className="recording">Press keys… (Esc to cancel)</span>
                    ) : (
                      <>
                        {keysFor(c.id).map((k) => (
                          <Kbd key={k} combo={k} />
                        ))}
                        {editable && (
                          <>
                            <button className="mini-btn" onClick={() => setRecording(c.id)}>
                              {keysFor(c.id).length ? 'Change' : 'Set'}
                            </button>
                            {keymap[c.id] && (
                              <button
                                className="mini-btn"
                                title="Restore default"
                                onClick={() => {
                                  const next = { ...keymap };
                                  delete next[c.id];
                                  setPrefs({ keymap: next });
                                }}
                              >
                                <RotateCcw size={11} />
                              </button>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
        {!editable && (
          <div className="shortcut-group">
            <h3>Mouse & wiring</h3>
            {[
              ['Pan', 'Space + drag · middle mouse · scroll'],
              ['Zoom', 'Ctrl + scroll · pinch'],
              ['Draw a wire', 'Drag from any pin, or W then click'],
              ['Branch from a wire', 'Alt + drag on a wire, or start a wire on it'],
              ['Flip wire elbow', 'Space or / while wiring'],
              ['Remove last bend', 'Backspace while wiring'],
              ['Reshape a wire', 'Select it, then drag a segment'],
              ['Reconnect wire end', 'Select it, then drag an end handle'],
              ['Switch hop side', 'Select wires, then Ctrl+Shift+U (or Crossings in the inspector)'],
              ['Export selection', 'Ctrl+Alt+E exports the selected items as PNG'],
              ['Export an area', 'Ctrl+Alt+A, then drag a rectangle on the canvas'],
              ['Box select', 'Drag right → fully inside · drag left ← touching'],
              ['Constrain move', 'Shift while dragging'],
              ['Enter a group', 'Double-click a grouped item'],
              ['Move labels', 'Select a part, then drag its reference label'],
            ].map(([a, b]) => (
              <div key={a} className="shortcut-row">
                <span>{a}</span>
                <span className="shortcut-keys muted">{b}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
  if (editable) return content;
  return (
    <Modal
      title={
        <>
          Keyboard shortcuts{' '}
          <button className="link-btn" onClick={() => set({ dialog: 'settings' })}>
            Customise…
          </button>
        </>
      }
      onClose={close}
      width={760}
    >
      {content}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function SettingsDialog() {
  const prefs = useStore((s) => s.prefs);
  const [tab, setTab] = useState<'general' | 'keys'>('general');
  return (
    <Modal title="Settings" onClose={close} width={760}>
      <div className="tabs inline">
        <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>
          General
        </button>
        <button className={tab === 'keys' ? 'active' : ''} onClick={() => setTab('keys')}>
          Keyboard shortcuts
        </button>
      </div>
      {tab === 'general' ? (
        <div className="settings-body">
          <Field label="Theme">
            <Segmented
              value={prefs.theme}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
              onChange={(theme) => setPrefs({ theme })}
            />
          </Field>
          <Field label="Mouse wheel">
            <Segmented
              value={prefs.wheel}
              options={[
                { value: 'zoom', label: 'Zooms' },
                { value: 'pan', label: 'Pans (Ctrl zooms)' },
              ]}
              onChange={(wheel) => setPrefs({ wheel })}
            />
          </Field>
          <Field label="Interface size">
            <Segmented
              value={prefs.uiScale}
              options={[
                { value: 0.9, label: 'Compact' },
                { value: 1, label: 'Normal' },
                { value: 1.1, label: 'Large' },
              ]}
              onChange={(uiScale) => setPrefs({ uiScale })}
            />
          </Field>
          <Field label="Minimap">
            <Toggle checked={prefs.showMinimap} onChange={(showMinimap) => setPrefs({ showMinimap })} />
          </Field>
          <Field label="Unconnected pin markers">
            <Toggle checked={prefs.showPortMarkers} onChange={(showPortMarkers) => setPrefs({ showPortMarkers })} />
          </Field>
          <Field label="Autosave (restores your work on restart)">
            <Toggle checked={prefs.autosave} onChange={(autosave) => setPrefs({ autosave })} />
          </Field>
        </div>
      ) : (
        <ShortcutsDialog editable />
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export function ExportDialog() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [bg, setBg] = useState(true);
  const [scale, setScale] = useState(3);
  const [onlySel, setOnlySel] = useState(false);
  const hasSel = useStore((s) => s.selection.length > 0);
  const opts = () => ({ theme, background: bg, scale, ids: onlySel ? S().selection : undefined });
  const Card = ({ icon, title, desc, onClick }: { icon: ReactNode; title: string; desc: string; onClick: () => void }) => (
    <button
      className="export-card"
      onClick={() => {
        close();
        onClick();
      }}
    >
      <span className="export-icon">{icon}</span>
      <span>
        <b>{title}</b>
        <small>{desc}</small>
      </span>
    </button>
  );
  return (
    <Modal title="Export" onClose={close} width={620}>
      <div className="export-opts">
        <Field label="Image theme">
          <Segmented
            value={theme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={setTheme}
          />
        </Field>
        <Field label="Background">
          <Toggle checked={bg} onChange={setBg} />
        </Field>
        <Field label="PNG resolution">
          <Segmented
            value={scale}
            options={[
              { value: 1, label: '1×' },
              { value: 2, label: '2×' },
              { value: 3, label: '3×' },
              { value: 4, label: '4×' },
            ]}
            onChange={setScale}
          />
        </Field>
        {hasSel && (
          <Field label="Only selection">
            <Toggle checked={onlySel} onChange={setOnlySel} />
          </Field>
        )}
      </div>
      <div className="export-grid">
        <Card icon={<FileImage size={20} />} title="PNG image" desc="High-resolution bitmap for documents & chat" onClick={() => doExport('png', opts())} />
        <Card icon={<FileCode2 size={20} />} title="SVG vector" desc="Crisp, editable in Inkscape / Illustrator / Figma" onClick={() => doExport('svg', opts())} />
        {hasSel && (
          <Card icon={<BoxSelect size={20} />} title="Selection → PNG" desc="Exports exactly the selected items" onClick={() => exportSelection('png')} />
        )}
        {hasSel && (
          <Card icon={<BoxSelect size={20} />} title="Selection → SVG" desc="Exports exactly the selected items" onClick={() => exportSelection('svg')} />
        )}
        <Card icon={<Scan size={20} />} title="Area → PNG" desc="Draw a rectangle on the canvas — wires crossing it are cut" onClick={() => startAreaExport('png', { theme, background: bg, scale })} />
        <Card icon={<Scan size={20} />} title="Area → SVG" desc="Draw a rectangle on the canvas — wires crossing it are cut" onClick={() => startAreaExport('svg', { theme, background: bg })} />
        <Card icon={<Layers3 size={20} />} title="DXF (CAD)" desc="AutoCAD, LibreCAD, BricsCAD — layered" onClick={() => doExport('dxf')} />
        <Card icon={<FileText size={20} />} title="SPICE netlist" desc="Simulate in LTspice / ngspice" onClick={() => doExport('spice')} />
        <Card icon={<FileSpreadsheet size={20} />} title="Bill of materials" desc="CSV grouped by part and value" onClick={() => doExport('bom')} />
        <Card icon={<FileJson size={20} />} title="JSON" desc="Full circuit data for scripts & tools" onClick={() => doExport('json')} />
        <Card icon={<Printer size={20} />} title="Print / PDF" desc="Use “Save as PDF” in the print dialog" onClick={filePrint} />
      </div>
    </Modal>
  );
}

export function AboutDialog() {
  return (
    <Modal onClose={close} width={440}>
      <div className="about">
        <Logo size={64} />
        <h2>Nodal</h2>
        <p className="muted">Version {__APP_VERSION__}</p>
        <p>A fast, beautiful schematic &amp; circuit designer for Windows, Linux and the web.</p>
        <div className="about-syms">
          {['resistor', 'capacitor', 'npn', 'opamp', 'led', 'and-gate'].map((id) => {
            const d = BUILTIN_SYMBOLS.find((s) => s.id === id);
            return d ? <SymbolPreview key={id} def={d} size={36} /> : null;
          })}
        </div>
        <p className="muted small">
          Based on the MIT-licensed ngDiagram circuit editor template by Synergy Codes. Rewritten in React.
        </p>
        <button className="primary-btn" onClick={close}>
          Close
        </button>
      </div>
    </Modal>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  switch (dialog) {
    case 'palette':
      return <CommandPalette />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    case 'settings':
      return <SettingsDialog />;
    case 'export':
      return <ExportDialog />;
    case 'about':
      return <AboutDialog />;
    default:
      return null;
  }
}

export { prettyKey };

import { ClipboardPaste, Copy, FileCode2, FileImage, FileJson, FileSpreadsheet, FileText, FolderUp, Layers3, Printer, RotateCcw, Scan, Share2, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import { doExport, filePrint, startAreaExport } from '../io/fileActions';
import {
  buildLibraryFile,
  buildTemplateFile,
  copyToClipboard,
  exportLibraryFile,
  exportTemplateFile,
  importLibraryFile,
  importLibraryText,
  importTemplateFile,
  importTemplateText,
  libraryToText,
  pasteLibraryFromClipboard,
  pasteTemplateFromClipboard,
  templateToText,
} from '../io/sharing';
import { librarySymbols, variantDefs } from '../model/registry';
import { BUILTIN_SYMBOLS } from '../model/symbols';
import type { SymbolDef } from '../model/types';
import * as A from '../store/actions';
import { COMMANDS, activeKeymap, eventToCombo, keysFor, prettyKey, setActiveKeymap, type Command } from '../store/commands';
import { S, set, setPrefs, toast, useStore } from '../store/store';
import { Field, Kbd, Segmented, Toggle } from './controls';
import { FindDialog } from './FindDialog';
import { LiveSession } from './LiveSession';
import { Logo } from './Logo';
import { SymbolPopup, anchorOf, type SymbolPopupState } from './SymbolHover';
import { VideoDialog } from './VideoDialog';

export function Modal({
  title,
  onClose,
  onEscape,
  children,
  width = 560,
  className,
}: {
  title?: ReactNode;
  onClose: () => void;
  /** Called on Esc before closing; return true when the content used the key (the modal stays open). */
  onEscape?: () => boolean;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        const t = e.target as HTMLElement;
        // Esc in a text field just leaves the field
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return t.blur();
        if (onEscape?.()) return;
        onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose, onEscape]);
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

type PaletteEntry = { kind: 'cmd'; cmd: Command } | { kind: 'sym'; def: SymbolDef };

export function CommandPalette() {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [preview, setPreview] = useState<SymbolPopupState | null>(null);
  const [picker, setPicker] = useState<SymbolPopupState | null>(null);
  const docSymbols = useStore((s) => s.doc.symbols);
  const listRef = useRef<HTMLDivElement>(null);
  // grace period so the pointer can travel from a row into its preview popup
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearClose = () => clearTimeout(closeTimer.current);
  const scheduleClose = () => {
    clearClose();
    closeTimer.current = setTimeout(() => setPreview((p) => (p && !p.pinned ? null : p)), 200);
  };
  useEffect(() => () => clearClose(), []);
  const syms = useMemo(() => librarySymbols({ symbols: docSymbols }), [docSymbols]);
  const entries = useMemo<PaletteEntry[]>(() => {
    const query = q.trim().toLowerCase();
    const cmds = COMMANDS.filter((c) => !c.when || c.when());
    const match = (s: string) => query.split(/\s+/).every((w) => s.toLowerCase().includes(w));
    const out: PaletteEntry[] = [];
    for (const c of cmds) if (!query || match(`${c.category} ${c.label}`)) out.push({ kind: 'cmd', cmd: c });
    if (query) {
      for (const s of syms) {
        // one row per part; its types are offered by the picker, not as duplicate rows
        const extra = variantDefs({ symbols: docSymbols }, s)
          .map((v) => `${v.variantName ?? ''} ${v.keywords ?? ''}`)
          .join(' ');
        if (match(`place ${s.name} ${s.keywords ?? ''} ${s.category} ${extra}`)) out.push({ kind: 'sym', def: s });
      }
    }
    return out.slice(0, 80);
  }, [q, syms, docSymbols]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);
  const variantsOf = (def: SymbolDef) => variantDefs({ symbols: docSymbols }, def);
  const openPicker = (def: SymbolDef, el: Element | null) => {
    const anchorEl = el ?? (listRef.current?.querySelector('.palette-item.active') as HTMLElement | null);
    if (!anchorEl) return;
    setPreview(null);
    setPicker({ def, variants: variantsOf(def), anchor: anchorOf(anchorEl), pinned: true });
  };
  const place = (def: SymbolDef) => {
    setPicker(null);
    setPreview(null);
    close();
    A.startPlacing(def.id);
  };
  const run = (e: PaletteEntry | undefined, el?: Element | null) => {
    if (!e) return;
    if (e.kind === 'cmd') {
      setPreview(null);
      close();
      setTimeout(() => e.cmd.run(), 0);
      return;
    }
    // a part with several drawings opens its type picker; a plain part places straight away
    if (variantsOf(e.def).length) return openPicker(e.def, el ?? null);
    place(e.def);
  };
  const hoverSym = (def: SymbolDef, el: Element) => {
    if (picker) return;
    setPreview({ def, variants: variantsOf(def), anchor: anchorOf(el), pinned: false });
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
        {entries.map((e, i) => {
          const types = e.kind === 'sym' ? variantsOf(e.def).length : 0;
          return (
            <button
              key={e.kind === 'cmd' ? e.cmd.id : `s:${e.def.id}`}
              className={i === idx ? 'palette-item active' : 'palette-item'}
              onMouseEnter={(ev) => {
                clearClose();
                setIdx(i);
                if (e.kind === 'sym') hoverSym(e.def, ev.currentTarget);
                else setPreview(null);
              }}
              onMouseLeave={scheduleClose}
              onClick={(ev) => run(e, ev.currentTarget)}
            >
              {e.kind === 'cmd' ? (
                <>
                  <span className="palette-cat">{e.cmd.category}</span>
                  <span className="palette-label">{e.cmd.label}</span>
                  {keysFor(e.cmd.id)[0] && <Kbd combo={keysFor(e.cmd.id)[0]} />}
                </>
              ) : (
                <>
                  <span className="palette-cat sym">Place</span>
                  <span className="palette-label">{e.def.name}</span>
                  <span className="palette-meta">{e.def.category}</span>
                  {types > 0 && <span className="palette-types">{types + 1} types</span>}
                </>
              )}
            </button>
          );
        })}
        {!entries.length && <div className="empty-note">No matches</div>}
      </div>
      {preview && <SymbolPopup {...preview} onPick={(d) => place(d)} onClose={() => setPreview(null)} onEnter={clearClose} />}
      {picker && <SymbolPopup {...picker} onPick={(d) => place(d)} onClose={() => setPicker(null)} />}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Shortcuts (with rebinding)                                          */
/* ------------------------------------------------------------------ */

export function ShortcutsDialog({ editable = false }: { editable?: boolean }) {
  const scheme = useStore((s) => s.prefs.shortcuts);
  const keymap = useStore((s) => (s.prefs.shortcuts === 'cadence' ? s.prefs.keymapCadence : s.prefs.keymap) ?? {});
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
      const next = { ...activeKeymap(), [recording]: [combo] };
      for (const c of conflicts) next[c.id] = keysFor(c.id).filter((k) => k !== combo);
      setActiveKeymap(next);
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
        <Segmented
          value={scheme}
          options={[
            { value: 'nodal', label: 'Nodal' },
            { value: 'cadence', label: 'Cadence' },
          ]}
          onChange={(shortcuts) => setPrefs({ shortcuts })}
        />
        <input className="input" placeholder="Filter shortcuts…" value={q} onChange={(e) => setQ(e.target.value)} />
        {editable && Object.keys(keymap).length > 0 && (
          <button className="secondary-btn" onClick={() => setActiveKeymap({})}>
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
                                  setActiveKeymap(next);
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
              ['Wire bend direction', 'Follows the way you first move the pointer off the last point; Space or / flips it (Cadence keys: right click)'],
              ['Wire routing', 'New wires route around parts and stay off pins they don\'t connect to (Settings to turn off)'],
              ['Move with the pointer', 'Cadence keys: M (or S) carries the selection, Shift+M leaves its wires behind, C places a copy; click to drop, R or right click rotates, Esc cancels'],
              ['Alignment guides', 'Lines show what a moved part lines up with (Guides in the top bar, Alt+G); with snap off they pull it into line'],
              ['Remove last bend', 'Backspace while wiring'],
              ['Reshape a wire', 'Select it, then drag a segment'],
              ['Delete a segment', 'Select a wire, click a segment again to select it, then Del removes just that segment'],
              ['Delete a node', 'Edit points tool (E): click a bend or end, then Del removes it (the wire splits at a middle segment)'],
              ['Solder / unsolder', 'Solder tool (S): click a crossing or a pin on a wire to solder, a junction or wired pin to unsolder'],
              ['Move bend points', 'Edit points tool (E): drag any bend or end · Alt drags freely · double-click adds/removes a bend'],
              ['Reconnect wire end', 'Select it, then drag an end handle'],
              ['Switch hop side', 'Rest the pointer on a crossing and reorder the wires there'],
              ['Alt move', 'Shift+M: only the selection moves; wires to it are left behind, unsoldered'],
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
          <Field label="One finger (touch)">
            <Segmented
              value={prefs.touch}
              options={[
                { value: 'auto', label: 'Pans with a stylus' },
                { value: 'draw', label: 'Draws' },
                { value: 'pan', label: 'Pans' },
              ]}
              onChange={(touch) => setPrefs({ touch })}
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
          <Field label="Wires route around parts and stay off other pins">
            <Toggle checked={prefs.wireAvoid} onChange={(wireAvoid) => setPrefs({ wireAvoid })} />
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
        <Card icon={<Scan size={20} />} title="Area → PNG" desc="Drag a rectangle on the canvas; wires crossing its edge are cut" onClick={() => startAreaExport('png', { theme, background: bg, scale })} />
        <Card icon={<Scan size={20} />} title="Area → SVG" desc="Drag a rectangle on the canvas; wires crossing its edge are cut" onClick={() => startAreaExport('svg', { theme, background: bg })} />
        <Card icon={<Layers3 size={20} />} title="DXF (CAD)" desc="AutoCAD, LibreCAD, BricsCAD — layered" onClick={() => doExport('dxf')} />
        <Card icon={<FileText size={20} />} title="SPICE netlist" desc="Simulate in LTspice / ngspice" onClick={() => doExport('spice')} />
        <Card icon={<FileText size={20} />} title="KiCad netlist" desc="Parts, footprints and nets for PCB layout" onClick={() => doExport('kicad')} />
        <Card icon={<FileSpreadsheet size={20} />} title="Bill of materials" desc="CSV with footprints, part numbers and DNP" onClick={() => doExport('bom')} />
        <Card icon={<FileJson size={20} />} title="JSON" desc="Full circuit data for scripts & tools" onClick={() => doExport('json')} />
        <Card icon={<Printer size={20} />} title="Print / PDF" desc="Use “Save as PDF” in the print dialog" onClick={filePrint} />
      </div>
    </Modal>
  );
}

export function ShareDialog() {
  const [tab, setTab] = useState<'library' | 'template'>('library');
  const userLibrary = useStore((s) => s.userLibrary);
  const selection = useStore((s) => s.selection);
  const [pasted, setPasted] = useState('');
  const libText = useMemo(() => libraryToText(buildLibraryFile()), [userLibrary]);
  const tpl = useMemo(() => buildTemplateFile(selection), [selection, userLibrary]);
  const tplText = tpl ? templateToText(tpl) : '';
  const libCount = Object.keys(userLibrary).length;
  const isLib = tab === 'library';
  return (
    <Modal title="Share & collaborate" onClose={close} width={680}>
      <LiveSession />
      <div className="share-intro">
        <Users size={18} />
        <div>
          Or share without a live session: send your <b>whole symbol library</b>, or any part of a circuit as a reusable <b>template</b>.
        </div>
      </div>
      <div className="tabs inline">
        <button className={isLib ? 'active' : ''} onClick={() => setTab('library')}>
          My symbols ({libCount})
        </button>
        <button className={!isLib ? 'active' : ''} onClick={() => setTab('template')}>
          Selection template ({selection.length})
        </button>
      </div>
      {isLib ? (
        libCount ? (
          <>
            <div className="btn-row wrap">
              <button className="primary-btn" onClick={() => copyToClipboard(libText, 'Symbol library')}>
                <Copy size={14} /> Copy
              </button>
              <button className="secondary-btn" onClick={exportLibraryFile}>
                <Share2 size={14} /> Save .json
              </button>
              <button className="secondary-btn" onClick={pasteLibraryFromClipboard}>
                <ClipboardPaste size={14} /> Paste & import
              </button>
              <button className="secondary-btn" onClick={importLibraryFile}>
                <FolderUp size={14} /> Import file
              </button>
            </div>
            <textarea className="input mono share-text" readOnly value={libText} onFocus={(e) => e.currentTarget.select()} />
          </>
        ) : (
          <div className="empty-note">You haven't saved any symbols yet. Draw one with the symbol editor (Ctrl+Shift+N), then share it here.</div>
        )
      ) : selection.length ? (
        <>
          <div className="btn-row wrap">
            <button className="primary-btn" onClick={() => copyToClipboard(tplText, 'Template')}>
              <Copy size={14} /> Copy
            </button>
            <button className="secondary-btn" onClick={() => exportTemplateFile(selection)}>
              <Share2 size={14} /> Save .json
            </button>
            <button className="secondary-btn" onClick={pasteTemplateFromClipboard}>
              <ClipboardPaste size={14} /> Paste & insert
            </button>
            <button className="secondary-btn" onClick={importTemplateFile}>
              <FolderUp size={14} /> Import file
            </button>
          </div>
          <textarea className="input mono share-text" readOnly value={tplText} onFocus={(e) => e.currentTarget.select()} />
          <p className="muted small">The template carries the parts, wiring and any custom symbols it uses, so it lands correctly on another machine.</p>
        </>
      ) : (
        <div className="empty-note">Select some parts and wires on the canvas to share them as a reusable template.</div>
      )}
      <div className="share-paste">
        <Field label="…or paste share text here" wide>
          <div className="row-gap">
            <input
              className="input mono"
              placeholder="Paste library or template JSON…"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <button
              className="secondary-btn"
              disabled={!pasted.trim()}
              onClick={() => {
                try {
                  if (isLib) {
                    const n = importLibraryText(pasted, { overwrite: false });
                    toast(n ? `Imported ${n} symbol${n > 1 ? 's' : ''}` : 'Nothing new to import', n ? 'success' : 'info');
                  } else {
                    const ids = importTemplateText(pasted);
                    toast(`Inserted template (${ids.length} items)`, 'success');
                    close();
                  }
                  setPasted('');
                } catch (e) {
                  toast(`Could not import: ${(e as Error).message}`, 'error');
                }
              }}
            >
              Import
            </button>
          </div>
        </Field>
      </div>
      <p className="muted small share-foot">
        Tip: keep the copied text or the saved <code>.json</code> and send it however you like — importing merges, never overwrites, your library.
      </p>
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
    case 'find':
      return <FindDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    case 'settings':
      return <SettingsDialog />;
    case 'export':
      return <ExportDialog />;
    case 'share':
      return <ShareDialog />;
    case 'about':
      return <AboutDialog />;
    case 'video':
      return <VideoDialog />;
    default:
      return null;
  }
}

export { prettyKey };

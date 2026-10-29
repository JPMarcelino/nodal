import { CircleHelp, ClipboardPaste, Copy, Cpu, Eye, FileCode2, FileImage, FileJson, FileSpreadsheet, FileText, Files, Film, FolderUp, History, Layers3, LayoutGrid, LayoutTemplate, Pencil, Printer, RotateCcw, Scan, Search, Shapes, Share2, Spline, Users, Wrench, X, type LucideIcon } from 'lucide-react';
import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import { importFile } from '../io/importFiles';
import { copyScope, doClipExport, doExport, filePrint, scopeSvgOptions, startAreaExport } from '../io/fileActions';
import { clipAreaDoc, exportSvg, selectionDoc } from '../io/export';
import { prepareMath } from '../model/latex';
import { withoutFrames } from '../model/presentation';
import {
  buildLibraryFile,
  buildTemplateFile,
  copyToClipboard,
  exportLibraryFile,
  exportTemplateFile,
  importLibraryText,
  importTemplateText,
  libraryToText,
  pasteLibraryFromClipboard,
  pasteTemplateFromClipboard,
  templateToText,
} from '../io/sharing';
import { buildLibraryLink } from '../io/libraryUrl';
import { isDesktop } from '../io/files';
import { PUBLIC_APP_URL } from '../collab/session';
import { librarySymbols, variantDefs } from '../model/registry';
import { BUILTIN_SYMBOLS } from '../model/symbols';
import type { SymbolDef } from '../model/types';
import * as A from '../store/actions';
import { COMMANDS, activeKeymap, eventToCombo, keysFor, prettyKey, setActiveKeymap, type Command } from '../store/commands';
import { readOnly, set, setPrefs, setTheme, toast, useStore, vdoc, type ExportScope } from '../store/store';
import { Field, Kbd, Segmented, Toggle } from './controls';
import { FindDialog } from './FindDialog';
import { LiveSession } from './LiveSession';
import { Logo } from './Logo';
import { SymbolPopup, anchorOf, type SymbolPopupState } from './SymbolHover';
import { VideoDialog } from './VideoDialog';
import { placeHere } from './dragState';
import { matchRanges, matchScore, pushRecent, queryWords } from './paletteSearch';

export function Modal({
  title,
  onClose,
  onEscape,
  children,
  width = 560,
  className,
  closeFromInput = false,
  ariaLabel,
}: {
  title?: ReactNode;
  onClose: () => void;
  /** Called on Esc before closing; return true when the content used the key (the modal stays open). */
  onEscape?: () => boolean;
  children: ReactNode;
  width?: number;
  className?: string;
  /** Esc in a text field closes the modal (search dialogs) instead of only leaving the field. */
  closeFromInput?: boolean;
  /** Name for a dialog with no visible title. */
  ariaLabel?: string;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        const t = e.target as HTMLElement;
        // Esc in a text field just leaves the field, unless this is a search dialog
        if ((t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !closeFromInput) return t.blur();
        if (onEscape?.()) return;
        onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose, onEscape]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ''}`} style={{ width }} role="dialog" aria-modal="true" aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}>
        {title && (
          <header className="modal-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
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

type PaletteEntry = { kind: 'cmd'; cmd: Command; score: number } | { kind: 'sym'; def: SymbolDef; score: number };
type PaletteSection = { title: string; entries: PaletteEntry[] };

const CATEGORY_ICON: Record<Command['category'], LucideIcon> = {
  File: FileText,
  Edit: Pencil,
  Tools: Wrench,
  Arrange: LayoutGrid,
  Page: Files,
  View: Eye,
  Wire: Spline,
  Symbols: Cpu,
  Help: CircleHelp,
};

const RECENT_KEY = 'nodal.palette.recent';
function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function rememberRecent(key: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(pushRecent(loadRecent(), key)));
  } catch {
    /* storage blocked: the list just isn't remembered */
  }
}

/** The label with the matched stretches marked. */
function Highlight({ text, words }: { text: string; words: string[] }) {
  const ranges = words.length ? matchRanges(text, words) : [];
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={i}>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/** Parts offered first when the palette was opened to place one (double-click on empty canvas). */
const COMMON_PARTS = ['resistor', 'capacitor', 'capacitor-polarized', 'inductor', 'diode', 'led', 'npn', 'pnp', 'opamp', 'vcc', 'gnd', 'net-label'];

export function CommandPalette() {
  const [q, setQ] = useState('');
  // opened by a double-click on the canvas: only parts, and the pick lands where the click was
  const [at] = useState(() => placeHere.at);
  useEffect(() => () => void (placeHere.at = null), []);
  const recentParts = useStore((s) => s.recent);
  const [idx, setIdx] = useState(0);
  const [preview, setPreview] = useState<SymbolPopupState | null>(null);
  const [picker, setPicker] = useState<SymbolPopupState | null>(null);
  const docSymbols = useStore((s) => s.doc.symbols);
  const listRef = useRef<HTMLDivElement>(null);
  // the keyboard moves the highlight; a pointer only takes it over once it actually moves
  const pointerMoved = useRef(false);
  // grace period so the pointer can travel from a row into its preview popup
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearClose = () => clearTimeout(closeTimer.current);
  const scheduleClose = () => {
    clearClose();
    closeTimer.current = setTimeout(() => setPreview((p) => (p && !p.pinned ? null : p)), 200);
  };
  useEffect(() => () => clearClose(), []);
  const syms = useMemo(() => librarySymbols({ symbols: docSymbols }), [docSymbols]);
  const words = useMemo(() => queryWords(q), [q]);
  const sections = useMemo<PaletteSection[]>(() => {
    const cmds = at ? [] : COMMANDS.filter((c) => !c.when || c.when());
    if (at && !words.length) {
      const byId = new Map(syms.map((d) => [d.id, d]));
      const seen = new Set<string>();
      const pick = (ids: string[]) =>
        ids.flatMap((id) => {
          const d = byId.get(id);
          if (!d || seen.has(id)) return [];
          seen.add(id);
          return [{ kind: 'sym' as const, def: d, score: 1 }];
        });
      const recent = pick(recentParts.slice(0, 6));
      const common = pick(COMMON_PARTS);
      return [...(recent.length ? [{ title: 'Recently used', entries: recent }] : []), ...(common.length ? [{ title: 'Common parts', entries: common }] : [])];
    }
    if (!words.length) {
      // nothing typed: what was used last, then everything by menu
      const byId = new Map(cmds.map((c) => [c.id, c]));
      const symById = new Map(syms.map((d) => [d.id, d]));
      const recent: PaletteEntry[] = [];
      for (const key of loadRecent()) {
        if (key.startsWith('s:')) {
          const def = symById.get(key.slice(2));
          if (def) recent.push({ kind: 'sym', def, score: 1 });
        } else {
          const cmd = byId.get(key);
          if (cmd) recent.push({ kind: 'cmd', cmd, score: 1 });
        }
      }
      const out: PaletteSection[] = recent.length ? [{ title: 'Recent', entries: recent }] : [];
      const groups = new Map<string, PaletteEntry[]>();
      for (const c of cmds) {
        const g = groups.get(c.category) ?? [];
        g.push({ kind: 'cmd', cmd: c, score: 1 });
        groups.set(c.category, g);
      }
      for (const [title, entries] of groups) out.push({ title, entries });
      return out;
    }
    const found: PaletteEntry[] = [];
    for (const c of cmds) {
      const score = matchScore(c.label, `${c.category} ${c.keywords ?? ''}`, words);
      if (score > 0) found.push({ kind: 'cmd', cmd: c, score });
    }
    const parts: PaletteEntry[] = [];
    for (const d of syms) {
      // one row per part; its types are offered by the picker, not as duplicate rows
      const extra = variantDefs({ symbols: docSymbols }, d)
        .map((v) => `${v.variantName ?? ''} ${v.keywords ?? ''}`)
        .join(' ');
      const score = matchScore(d.name, `place ${d.keywords ?? ''} ${d.category} ${extra}`, words);
      if (score > 0) parts.push({ kind: 'sym', def: d, score });
    }
    found.sort((a, b) => b.score - a.score);
    parts.sort((a, b) => b.score - a.score);
    const out: PaletteSection[] = [];
    const cmdSec = found.length ? { title: 'Commands', entries: found.slice(0, 40) } : null;
    const partSec = parts.length ? { title: 'Parts', entries: parts.slice(0, 40) } : null;
    // whichever has the better top match comes first
    if (cmdSec && partSec && partSec.entries[0].score > cmdSec.entries[0].score) out.push(partSec, cmdSec);
    else for (const sec of [cmdSec, partSec]) if (sec) out.push(sec);
    return out;
  }, [words, syms, docSymbols, at, recentParts]);
  const flat = useMemo(() => sections.flatMap((s) => s.entries), [sections]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);
  const variantsOf = (def: SymbolDef) => variantDefs({ symbols: docSymbols }, def);
  const openPicker = (def: SymbolDef, el: Element | null) => {
    const anchorEl = el ?? (listRef.current?.querySelector('.palette-item.active') as HTMLElement | null);
    if (!anchorEl) return;
    setPreview(null);
    setPicker({ def, variants: variantsOf(def), anchor: anchorOf(anchorEl), pinned: true });
  };
  const place = (def: SymbolDef, key = def.id) => {
    rememberRecent(`s:${key}`);
    setPicker(null);
    setPreview(null);
    close();
    if (at) A.placeComponent(def.id, at.x, at.y);
    else A.startPlacing(def.id);
  };
  const run = (e: PaletteEntry | undefined, el?: Element | null) => {
    if (!e) return;
    if (e.kind === 'cmd') {
      rememberRecent(e.cmd.id);
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
  const move = (d: number) => {
    pointerMoved.current = false;
    setIdx((i) => (flat.length ? (i + d + flat.length) % flat.length : 0));
  };
  let n = -1;
  return (
    <Modal onClose={close} width={640} className="palette" closeFromInput ariaLabel="Command palette">
      <div className="palette-search">
        <Search size={17} />
        <input
          className="palette-input"
          autoFocus
          placeholder={at ? 'Place a part here — type its name: “resistor”, “op amp”, “555”…' : 'Search commands and parts — “rotate”, “op amp”, “export png”…'}
          value={q}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={flat[idx] ? `palette-row-${idx}` : undefined}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              move(-1);
            } else if (e.key === 'PageDown') {
              e.preventDefault();
              setIdx((i) => Math.min(flat.length - 1, i + 8));
            } else if (e.key === 'PageUp') {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 8));
            } else if (e.key === 'Enter') run(flat[idx]);
          }}
        />
        {q && (
          <button className="palette-clear" onClick={() => setQ('')} aria-label="Clear search">
            <X size={14} />
          </button>
        )}
      </div>
      <div className="palette-list" id="palette-list" role="listbox" ref={listRef} onPointerMove={() => (pointerMoved.current = true)}>
        {sections.map((sec) => (
          <div key={sec.title} className="palette-section" role="group" aria-label={sec.title}>
            <div className="palette-heading">
              {sec.title === 'Recent' && <History size={12} />}
              {sec.title}
            </div>
            {sec.entries.map((e) => {
              const i = ++n;
              const types = e.kind === 'sym' ? variantsOf(e.def).length : 0;
              const on = e.kind === 'cmd' ? e.cmd.checked?.() : undefined;
              const Icon = e.kind === 'cmd' ? CATEGORY_ICON[e.cmd.category] : null;
              const combo = e.kind === 'cmd' ? keysFor(e.cmd.id)[0] : undefined;
              return (
                <button
                  key={e.kind === 'cmd' ? e.cmd.id : `s:${e.def.id}`}
                  id={`palette-row-${i}`}
                  role="option"
                  aria-selected={i === idx}
                  className={i === idx ? 'palette-item active' : 'palette-item'}
                  onMouseEnter={(ev) => {
                    if (!pointerMoved.current) return;
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
                      <span className="palette-icon">{Icon && <Icon size={15} />}</span>
                      <span className="palette-label">
                        <Highlight text={e.cmd.label} words={words} />
                      </span>
                      {on !== undefined && <span className={on ? 'palette-state on' : 'palette-state'}>{on ? 'On' : 'Off'}</span>}
                      {(words.length > 0 || sec.title === 'Recent') && <span className="palette-meta">{e.cmd.category}</span>}
                      {combo && <Kbd combo={combo} />}
                    </>
                  ) : (
                    <>
                      <span className="palette-icon sym">
                        <SymbolPreview def={e.def} size={26} pad={2} />
                      </span>
                      <span className="palette-label">
                        <Highlight text={e.def.name} words={words} />
                      </span>
                      {types > 0 && <span className="palette-types">{types + 1} types</span>}
                      <span className="palette-meta">{e.def.category}</span>
                      <span className="palette-place">Place</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        ))}
        {!flat.length && (
          <div className="palette-empty">
            <Search size={22} />
            <div>Nothing matches “{q.trim()}”</div>
            <div className="small muted">Try a part name like “resistor” or a command like “align”.</div>
          </div>
        )}
      </div>
      <div className="palette-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move
        </span>
        <span>
          <kbd>↵</kbd> {at ? 'to place it there' : 'to run or place'}
        </span>
        <span>
          <kbd>Esc</kbd> to close
        </span>
        <span className="grow" />
        <span className="muted">{flat.length} {flat.length === 1 ? 'result' : 'results'}</span>
      </div>
      {preview && <SymbolPopup {...preview} onPick={(d) => place(d, preview.def.id)} onClose={() => setPreview(null)} onEnter={clearClose} />}
      {picker && <SymbolPopup {...picker} onPick={(d) => place(d, picker.def.id)} onClose={() => setPicker(null)} />}
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
              ['Alignment guides', 'Lines show what a moved part lines up with (guide buttons in the status bar, Alt+G); with snap off they pull it into line'],
              ['Spacing guides', 'Pink gap marks show when a moved item sits as far from its neighbour as they sit from each other (Alt+Shift+G)'],
              ['Label guides', 'Part names and values line up with guides too, also when dragged on their own (Alt+Shift+N)'],
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
              ['Move labels', 'Select a part, then drag its name label'],
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

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h3>{title}</h3>
      <div className="settings-rows">{children}</div>
    </section>
  );
}

/** One preference: its name (and what it does, quietly) on the left, the control on the right. */
function Setting({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  // a switch can be flipped from anywhere on its row; a row of choices only from the choices
  const Row = isValidElement(children) && children.type === Toggle ? 'label' : 'div';
  return (
    <Row className="setting-row">
      <span className="setting-text">
        <span className="setting-label">{label}</span>
        {desc && <span className="setting-desc">{desc}</span>}
      </span>
      <span className="setting-control">{children}</span>
    </Row>
  );
}

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
          <SettingsGroup title="Appearance">
            <Setting label="Theme">
              <Segmented
                value={prefs.theme}
                options={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                ]}
                onChange={(theme) => setTheme(theme)}
              />
            </Setting>
            <Setting label="Interface size">
              <Segmented
                value={prefs.uiScale}
                options={[
                  { value: 0.9, label: 'Compact' },
                  { value: 1, label: 'Normal' },
                  { value: 1.1, label: 'Large' },
                ]}
                onChange={(uiScale) => setPrefs({ uiScale })}
              />
            </Setting>
            <Setting label="Minimap" desc="A small map of the page in the corner; click or drag it to move around">
              <Toggle checked={prefs.showMinimap} onChange={(showMinimap) => setPrefs({ showMinimap })} />
            </Setting>
            <Setting label="Show hints" desc="The next step for the tool in hand, at the bottom of the canvas">
              <Toggle checked={prefs.showHints} onChange={(showHints) => setPrefs({ showHints })} />
            </Setting>
            <Setting label="Unconnected pin markers" desc="A ring on every pin that isn't wired yet">
              <Toggle checked={prefs.showPortMarkers} onChange={(showPortMarkers) => setPrefs({ showPortMarkers })} />
            </Setting>
          </SettingsGroup>
          <SettingsGroup title="Mouse and touch">
            <Setting label="Mouse wheel">
              <Segmented
                value={prefs.wheel}
                options={[
                  { value: 'zoom', label: 'Zooms' },
                  { value: 'pan', label: 'Pans (Ctrl zooms)' },
                ]}
                onChange={(wheel) => setPrefs({ wheel })}
              />
            </Setting>
            <Setting label="One finger (touch)">
              <Segmented
                value={prefs.touch}
                options={[
                  { value: 'auto', label: 'Pans with a stylus' },
                  { value: 'draw', label: 'Draws' },
                  { value: 'pan', label: 'Pans' },
                ]}
                onChange={(touch) => setPrefs({ touch })}
              />
            </Setting>
          </SettingsGroup>
          <SettingsGroup title="Editing">
            <Setting label="Tool lock" desc="Keep placing parts after each click (Esc stops)">
              <Toggle checked={prefs.toolLock} onChange={(toolLock) => setPrefs({ toolLock })} />
            </Setting>
            <Setting label="Smart wire routing" desc="Wires route around parts and stay off other pins">
              <Toggle checked={prefs.wireAvoid} onChange={(wireAvoid) => setPrefs({ wireAvoid })} />
            </Setting>
            <Setting label="Alignment guides" desc="Lines that snap edges and centres together while moving">
              <Toggle checked={prefs.alignGuides} onChange={(alignGuides) => setPrefs({ alignGuides })} />
            </Setting>
            <Setting label="Equal-spacing guides" desc="Snap to the same gap as the neighbours">
              <Toggle checked={prefs.spacingGuides} onChange={(spacingGuides) => setPrefs({ spacingGuides })} />
            </Setting>
            <Setting label="Part names and values follow guides">
              <Toggle checked={prefs.labelGuides} onChange={(labelGuides) => setPrefs({ labelGuides })} />
            </Setting>
          </SettingsGroup>
          <SettingsGroup title="Saving">
            <Setting label="Autosave" desc="Keeps your work in this browser and restores it on restart">
              <Toggle checked={prefs.autosave} onChange={(autosave) => setPrefs({ autosave })} />
            </Setting>
          </SettingsGroup>
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

/** Live picture of what the export will look like: colours, background (checkered when transparent) and extent. */
function scopeIsEmpty(scope: ExportScope): boolean {
  const view = vdoc();
  let d = withoutFrames(view);
  if (scope.ids?.length) d = selectionDoc(view, scope.ids);
  if (scope.clip) d = clipAreaDoc(d, scope.clip);
  // a page's drawing frame is still something to export
  if (!scope.ids?.length && !scope.clip && d.settings.titleBlock) return false;
  return !Object.values(d.items).some((it) => !it.hidden);
}

function ExportPreview({ scope, theme, background, scale }: { scope: ExportScope; theme: 'light' | 'dark'; background: boolean; scale: number }) {
  const doc = useStore((s) => s.doc);
  const page = useStore((s) => s.page);
  const [shot, setShot] = useState<{ url: string; w: number; h: number } | null>(null);
  const [error, setError] = useState('');
  // narrowed the way exportSvg narrows it, so an empty scope says so instead of showing a blank picture
  const empty = useMemo(() => scopeIsEmpty(scope), [doc, page, scope]);
  useEffect(() => {
    if (empty) return;
    let url = '';
    let live = true;
    const view = vdoc();
    // formulas render asynchronously; the export waits for them, so the preview does too
    prepareMath(view)
      .catch(() => undefined)
      .then(() => {
        if (!live) return;
        try {
          const { svg, bounds } = exportSvg(view, scopeSvgOptions(scope, 'png', { theme, background }));
          url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          setShot({ url, w: Math.ceil(bounds.w), h: Math.ceil(bounds.h) });
          setError('');
        } catch (e) {
          setError((e as Error).message);
        }
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [doc, page, scope, theme, background, empty]);
  const clip = scope.clip;
  const num = (n: number) => String(Math.round(n)).replace('-', '\u2212');
  return (
    <div className="export-preview-wrap">
      <div className={`export-preview${background || empty ? '' : ' transparent'}`}>
        {empty ? (
          <span className="muted small">{clip ? 'Nothing to export in this area' : scope.ids?.length ? 'Nothing selected to export' : 'Nothing to export on this page'}</span>
        ) : error ? (
          <span className="muted small">Preview failed: {error}</span>
        ) : shot ? (
          <img src={shot.url} alt="Export preview" />
        ) : (
          <span className="muted small">Rendering preview…</span>
        )}
      </div>
      {shot && !empty && (
        <span className="muted small">
          {clip && `Area ${num(clip.x)}, ${num(clip.y)} · ${num(clip.w)} × ${num(clip.h)} px · `}
          {shot.w} × {shot.h} px · PNG at {scale}×: {shot.w * scale} × {shot.h * scale} px{background ? '' : ' · transparent background'}
        </span>
      )}
    </div>
  );
}

export function ExportDialog() {
  // theme, background and resolution are prefs, so menus, shortcuts and copying export the same picture
  const theme = useStore((s) => s.prefs.exportTheme ?? s.prefs.theme);
  const setTheme = (exportTheme: 'light' | 'dark') => setPrefs({ exportTheme });
  const bg = useStore((s) => s.prefs.exportBackground ?? true);
  const scale = useStore((s) => s.prefs.exportScale ?? 3);
  const setBg = (exportBackground: boolean) => setPrefs({ exportBackground });
  const setScale = (exportScale: number) => setPrefs({ exportScale });
  const withScene = useStore((s) => s.prefs.exportScene ?? true);
  const setWithScene = (exportScene: boolean) => setPrefs({ exportScene });
  const given = useStore((s) => s.exportScope);
  const doc = useStore((s) => s.doc);
  const page = useStore((s) => s.page);
  const clip = given?.clip;
  const selection = useStore((s) => s.selection);
  // items handed in (right-click on a selection) or the current selection
  const pick = given?.ids?.length ? given.ids : selection;
  const [onlySel, setOnlySel] = useState(() => !!given?.ids?.length);
  const ids = !clip && onlySel && pick.length ? pick : undefined;
  const scope = useMemo<ExportScope>(() => (clip ? { clip } : { ids }), [clip, ids?.join()]);
  const empty = useMemo(() => scopeIsEmpty(scope), [doc, page, scope]);
  const done = () => set({ dialog: null, exportScope: null });
  const Card = ({ icon, title, desc, onClick, disabled }: { icon: ReactNode; title: string; desc: string; onClick: () => void; disabled?: boolean }) => (
    <button
      className="export-card"
      disabled={disabled}
      title={disabled ? 'Nothing to export in this scope' : undefined}
      onClick={() => {
        done();
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
  const image = (kind: 'png' | 'svg') => () =>
    clip ? doClipExport(kind, clip, { ...scopeSvgOptions(scope, kind, { theme, background: bg }), scale }) : doExport(kind, { theme, background: bg, scale, ids });
  return (
    <Modal title={clip ? 'Export area' : ids ? `Export ${ids.length} item${ids.length > 1 ? 's' : ''}` : 'Export'} onClose={done} width={680} className="export-modal">
      <ExportPreview scope={scope} theme={theme} background={bg} scale={scale} />
      <div className="export-opts">
        <Field label="Image theme" hint="Every image export uses it; a page colour set in Inspector → Background wins over it">
          <Segmented
            value={theme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={setTheme}
          />
        </Field>
        <Field label="Background" hint="Paint the canvas colour behind the drawing; off leaves it transparent">
          <Toggle checked={bg} onChange={setBg} />
        </Field>
        <Field label="PNG resolution" hint="PNG only; SVG stays vector">
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
        <Field label="Include circuit (re-editable)" hint="PNG and SVG files carry the circuit: open, import or drop them into Nodal to edit it again">
          <Toggle checked={withScene} onChange={setWithScene} />
        </Field>
        {!clip && pick.length > 0 && (
          <Field label={`Only selection (${pick.length})`}>
            <Toggle checked={onlySel} onChange={setOnlySel} />
          </Field>
        )}
        {clip && (
          <Field label="Area">
            <button className="secondary-btn" onClick={() => startAreaExport('png')}>
              Draw another area
            </button>
          </Field>
        )}
        <p className="muted small" style={{ gridColumn: '1 / -1', margin: 0 }}>
          Theme, background and resolution set here also apply to copying and to exports from the menus, shortcuts and right-click.
        </p>
      </div>
      <div className="export-group">Drawing · {clip ? 'this area' : ids ? 'selected items' : 'this page'}</div>
      <div className="export-grid">
        <Card icon={<FileImage size={20} />} title="PNG image" desc="High-resolution bitmap for documents & chat" onClick={image('png')} disabled={empty} />
        <Card icon={<FileCode2 size={20} />} title="SVG vector" desc="Crisp, editable in Inkscape / Illustrator / Figma" onClick={image('svg')} disabled={empty} />
        <Card icon={<Copy size={20} />} title="Copy to clipboard" desc="The picture above, to paste into any app (or back into Nodal)" onClick={() => copyScope(scope, { theme, background: bg, scale })} disabled={empty} />
        {!clip && <Card icon={<Layers3 size={20} />} title="DXF (CAD)" desc={`${ids ? 'The selection' : 'This page'} as layered CAD entities for AutoCAD, LibreCAD, BricsCAD`} onClick={() => doExport('dxf', { ids })} disabled={empty} />}
        {!clip && <Card icon={<Scan size={20} />} title="Area…" desc="Drag a rectangle on the canvas, then preview it here; wires crossing its edge are cut" onClick={() => startAreaExport('png')} />}
      </div>
      {!clip && !ids && (
        <>
          <div className="export-group">Print &amp; video · every page</div>
          <div className="export-grid">
            <Card icon={<Printer size={20} />} title="Print / PDF" desc="Every page; use “Save as PDF” in the print dialog (always light, for paper)" onClick={filePrint} />
            <Card icon={<Film size={20} />} title="Presentation video" desc="Your presentation frames as an MP4 / WebM" onClick={() => set({ dialog: 'video' })} />
          </div>
        </>
      )}
      {!clip && (
        <>
          <div className="export-group">Data · {ids ? 'selected items only' : 'all pages'}</div>
          <div className="export-grid">
            <Card icon={<FileText size={20} />} title="SPICE netlist" desc="Simulate in LTspice / ngspice" onClick={() => doExport('spice', { ids })} />
            <Card icon={<FileText size={20} />} title="KiCad netlist" desc="Parts, footprints and nets for PCB layout" onClick={() => doExport('kicad', { ids })} />
            <Card icon={<FileSpreadsheet size={20} />} title="Bill of materials" desc="CSV with footprints, part numbers and DNP" onClick={() => doExport('bom', { ids })} />
            <Card icon={<FileJson size={20} />} title="JSON" desc="Full circuit data for scripts & tools" onClick={() => doExport('json', { ids })} />
          </div>
          <div className="export-group">Share with other Nodal users</div>
          <div className="export-grid">
            {ids && <Card icon={<LayoutTemplate size={20} />} title="Template" desc="The selected items as a reusable block; Import inserts it" onClick={() => exportTemplateFile(ids)} />}
            <Card icon={<Shapes size={20} />} title="Symbol library" desc="Your own symbols (My symbols); Import adds them to another library" onClick={exportLibraryFile} />
          </div>
        </>
      )}
    </Modal>
  );
}

/**
 * Builds an "add this library" link: host the saved .json anywhere that serves
 * it over https with CORS (a GitHub gist's raw link, GitHub Pages…), paste its
 * address, copy the Nodal link that offers to add it.
 */
function LibraryLinkBuilder() {
  const [fileUrl, setFileUrl] = useState('');
  let link = '';
  let error = '';
  if (fileUrl.trim()) {
    try {
      link = buildLibraryLink(fileUrl, isDesktop() ? PUBLIC_APP_URL : `${location.origin}${location.pathname}`);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return (
    <details className="share-link-builder">
      <summary>Copy library link…</summary>
      <p className="muted small">
        Save the library as .json and put it online where it is served over https and may be downloaded from other sites (a GitHub gist’s “Raw” link or GitHub Pages work). Paste its address here: anyone opening the link is asked before the symbols are added to their library.
      </p>
      <div className="row-gap">
        <input className="input mono" placeholder="https://…/my-symbols.nodal-lib.json" value={fileUrl} onChange={(e) => setFileUrl(e.target.value)} aria-label="Address of the hosted library file" />
        <button className="primary-btn" disabled={!link} onClick={() => copyToClipboard(link, 'Library link')}>
          <Copy size={14} /> Copy link
        </button>
      </div>
      {error ? <p className="muted small error-text">{error}</p> : link ? <input className="input mono small" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Library link" /> : null}
    </details>
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
              <button className="secondary-btn" onClick={importFile}>
                <FolderUp size={14} /> Import file
              </button>
            </div>
            <textarea className="input mono share-text" readOnly value={libText} onFocus={(e) => e.currentTarget.select()} />
            <LibraryLinkBuilder />
          </>
        ) : (
          <>
            <div className="empty-note">You haven't saved any symbols yet. Draw one with the symbol editor (Ctrl+Shift+N), then share it here — or bring in someone else's library.</div>
            <div className="btn-row wrap">
              <button className="secondary-btn" onClick={pasteLibraryFromClipboard}>
                <ClipboardPaste size={14} /> Paste & import
              </button>
              <button className="secondary-btn" onClick={importFile}>
                <FolderUp size={14} /> Import file
              </button>
            </div>
          </>
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
            <button className="secondary-btn" onClick={importFile}>
              <FolderUp size={14} /> Import file
            </button>
          </div>
          <textarea className="input mono share-text" readOnly value={tplText} onFocus={(e) => e.currentTarget.select()} />
          <p className="muted small">The template carries the parts, wiring and any custom symbols it uses, so it lands correctly on another machine.</p>
        </>
      ) : (
        <>
          <div className="empty-note">Select some parts and wires on the canvas to share them as a reusable template — or insert one you were sent.</div>
          <div className="btn-row wrap">
            <button className="secondary-btn" onClick={pasteTemplateFromClipboard}>
              <ClipboardPaste size={14} /> Paste & insert
            </button>
            <button className="secondary-btn" onClick={importFile}>
              <FolderUp size={14} /> Import file
            </button>
          </div>
        </>
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
                if (!isLib && readOnly()) return A.readOnlyNotice();
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
        Tip: keep the copied text or the saved <code>.json</code> and send it however you like. Importing merges symbols into your library and never overwrites one you already have.
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

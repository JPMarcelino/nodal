import {
  CircleDot,
  Unplug,
  PenTool,
  ArrowUpRight,
  Circle,
  Download,
  Hand,
  Keyboard,
  Minus,
  Moon,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Redo2,
  RectangleHorizontal,
  Search,
  Spline,
  Square,
  Sun,
  Type,
  Undo2,
  Presentation,
} from 'lucide-react';
import { isExplainTool, useExplain } from '../store/explain';
import { useEffect, useRef, useState } from 'react';
import type { Tool } from '../model/types';
import * as A from '../store/actions';
import { COMMANDS, COMMAND_MAP, keysFor, prettyKey } from '../store/commands';
import { S, mutate, redo, set, setPrefs, undo, useStore } from '../store/store';
import { CollabBar } from './CollabBar';
import { Logo } from './Logo';

const MENUS: { label: string; items: (string | '-')[] }[] = [
  {
    label: 'File',
    items: ['file.new', 'file.open', 'file.import', '-', 'file.save', 'file.saveAs', '-', 'file.export', 'file.exportSvg', 'file.exportPng', 'file.exportDxf', 'file.exportSpice', 'file.exportKicad', 'file.exportBom', 'file.copySvg', '-', 'file.print', '-', 'collab.share', 'collab.exportLib', 'collab.importLib', 'collab.exportTemplate', 'collab.importTemplate'],
  },
  {
    label: 'Edit',
    items: ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.pasteHere', 'edit.duplicate', 'edit.delete', '-', 'edit.selectAll', 'edit.find', 'edit.lock', 'edit.hide', '-', 'edit.annotate', '-', 'help.settings'],
  },
  {
    label: 'Place',
    items: ['tool.wire', 'tool.placeLast', '-', 'tool.resistor', 'tool.capacitor', 'tool.ground', 'tool.vcc', 'tool.netLabel', 'tool.junction', '-', 'tool.rect', 'tool.zone', 'tool.ellipse', 'tool.line', 'tool.arrow', 'tool.text', '-', 'symbols.new', 'symbols.fromSelection', 'symbols.edit'],
  },
  {
    label: 'Arrange',
    items: [
      'arrange.rotateCw', 'arrange.rotateCcw', 'arrange.flipH', 'arrange.flipV', '-',
      'arrange.group', 'arrange.ungroup', 'arrange.enterGroup', '-',
      'arrange.alignLeft', 'arrange.alignHCenter', 'arrange.alignRight', 'arrange.alignTop', 'arrange.alignVCenter', 'arrange.alignBottom', 'arrange.distH', 'arrange.distV', '-',
      'arrange.front', 'arrange.forward', 'arrange.backward', 'arrange.back', 'arrange.layer',
    ],
  },
  { label: 'Wire', items: ['tool.wire', 'wire.reroute', 'wire.highlightNet', '-', 'wire.hops', 'wire.corners'] },
  {
    label: 'Explain',
    items: ['explain.toggle', '-', 'tool.pen', 'tool.highlighter', 'tool.laser', 'tool.eraser', '-', 'tool.trace', 'tool.callout', '-', 'explain.present', 'explain.renumber', 'explain.clear'],
  },
  {
    label: 'View',
    items: ['view.zoomIn', 'view.zoomOut', 'view.fit', 'view.fitSel', 'view.100', '-', 'view.grid', 'view.snap', 'view.minimap', 'view.alignGuides', '-', 'view.refs', 'view.values', 'view.wireLabels', '-', 'view.library', 'view.layers', 'view.check', 'view.inspector', 'view.focus', '-', 'view.theme'],
  },
  { label: 'Help', items: ['help.palette', 'help.shortcuts', '-', 'help.about'] },
];

function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open === null) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="menubar" ref={ref}>
      {MENUS.map((m, i) => (
        <div key={m.label} className="menu-root">
          <button className={open === i ? 'menu-btn open' : 'menu-btn'} onClick={() => setOpen(open === i ? null : i)} onPointerEnter={() => open !== null && setOpen(i)}>
            {m.label}
          </button>
          {open === i && (
            <div className="dropdown">
              {m.items.map((id, j) => {
                if (id === '-') return <div key={j} className="dropdown-sep" />;
                const c = COMMAND_MAP.get(id);
                if (!c) return null;
                const k = keysFor(id)[0];
                return (
                  <button
                    key={id}
                    className="dropdown-item"
                    onClick={() => {
                      setOpen(null);
                      c.run();
                    }}
                  >
                    <span>{c.label}</span>
                    {k && <kbd>{prettyKey(k)}</kbd>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DocName() {
  const name = useStore((s) => s.doc.name);
  const dirty = useStore((s) => s.dirty);
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  if (editing)
    return (
      <input
        className="doc-name-input"
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (v.trim() && v !== name) mutate((d) => void (d.name = v.trim()));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setV(name);
            setEditing(false);
          }
        }}
      />
    );
  return (
    <button className="doc-name" onClick={() => setEditing(true)} title="Rename circuit">
      {name}
      {dirty && <span className="dirty-dot" title="Unsaved changes" />}
    </button>
  );
}

export function TopBar() {
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const theme = useStore((s) => s.prefs.theme);
  const scheme = useStore((s) => s.prefs.shortcuts);
  const guides = useStore((s) => s.prefs.alignGuides);
  const hideRefs = useStore((s) => !!s.doc.settings.hideRefs);
  const hideValues = useStore((s) => !!s.doc.settings.hideValues);
  const zoom = useStore((s) => s.view.zoom);
  const left = useStore((s) => s.leftPanel);
  const right = useStore((s) => s.rightPanel);
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand" title="Nodal">
          <Logo size={22} />
          <span>Nodal</span>
        </div>
        <MenuBar />
      </div>
      <div className="topbar-center">
        <DocName />
      </div>
      <div className="topbar-right">
        <button className="icon-btn" title={`Command palette (${prettyKey(keysFor('help.palette')[0] ?? '')})`} onClick={() => set({ dialog: 'palette' })}>
          <Search size={16} />
          <span className="palette-hint">{prettyKey(keysFor('help.palette')[0] ?? '')}</span>
        </button>
        <span className="divider" />
        <button className="icon-btn" disabled={!canUndo} onClick={undo} title={`Undo (${prettyKey(keysFor('edit.undo')[0] ?? '')})`}>
          <Undo2 size={16} />
        </button>
        <button className="icon-btn" disabled={!canRedo} onClick={redo} title={`Redo (${prettyKey(keysFor('edit.redo')[0] ?? '')})`}>
          <Redo2 size={16} />
        </button>
        <span className="divider" />
        <button className="zoom-chip" onClick={() => A.fitView()} title="Zoom to fit (F)">
          {Math.round(zoom * 100)}%
        </button>
        <button className={left ? 'icon-btn active' : 'icon-btn'} onClick={() => set({ leftPanel: !left })} title="Toggle library (Ctrl+B)">
          <PanelLeft size={16} />
        </button>
        <button className={right ? 'icon-btn active' : 'icon-btn'} onClick={() => set({ rightPanel: !right })} title="Toggle properties (Ctrl+I)">
          <PanelRight size={16} />
        </button>
        <button className="icon-btn" onClick={() => set({ dialog: 'shortcuts' })} title="Keyboard shortcuts (?)">
          <Keyboard size={16} />
        </button>
        <span className="divider" />
        <button className={hideRefs ? 'zoom-chip' : 'zoom-chip active'} onClick={() => COMMAND_MAP.get('view.refs')!.run()} title={`${hideRefs ? 'Show' : 'Hide'} all instance names (${prettyKey(keysFor('view.refs')[0] ?? '')})`}>
          Names
        </button>
        <button className={hideValues ? 'zoom-chip' : 'zoom-chip active'} onClick={() => COMMAND_MAP.get('view.values')!.run()} title={`${hideValues ? 'Show' : 'Hide'} all instance values (${prettyKey(keysFor('view.values')[0] ?? '')})`}>
          Values
        </button>
        <button className={guides ? 'zoom-chip active' : 'zoom-chip'} onClick={() => COMMAND_MAP.get('view.alignGuides')!.run()} title={`Alignment guides while moving: ${guides ? 'on' : 'off'} (${prettyKey(keysFor('view.alignGuides')[0] ?? '')})`}>
          Guides
        </button>
        <button
          className={scheme === 'cadence' ? 'zoom-chip active' : 'zoom-chip'}
          onClick={() => setPrefs({ shortcuts: scheme === 'cadence' ? 'nodal' : 'cadence' })}
          title={scheme === 'cadence' ? 'Cadence shortcuts are on (W wire, I instance, M move, C copy, L label, N note, Q properties, U undo). Click for Nodal shortcuts.' : 'Switch to Cadence Virtuoso shortcuts'}
        >
          {scheme === 'cadence' ? 'Cadence keys' : 'Nodal keys'}
        </button>
        <button className="icon-btn" onClick={() => setPrefs({ theme: theme === 'dark' ? 'light' : 'dark' })} title="Toggle theme">
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <CollabBar />
        <button className="primary-btn" onClick={() => set({ dialog: 'export' })}>
          <Download size={15} /> Export
        </button>
      </div>
    </header>
  );
}

const TOOLS: { tool: Tool; icon: JSX.Element; label: string; cmd: string; alt?: boolean }[] = [
  { tool: 'select', icon: <MousePointer2 size={17} />, label: 'Move / select', cmd: 'tool.select' },
  { tool: 'select', alt: true, icon: <Unplug size={17} />, label: 'Alt move (leave wires behind)', cmd: 'tool.altMove' },
  { tool: 'node', icon: <PenTool size={17} />, label: 'Edit points', cmd: 'tool.node' },
  { tool: 'pan', icon: <Hand size={17} />, label: 'Pan', cmd: 'tool.pan' },
  { tool: 'wire', icon: <Spline size={17} />, label: 'Wire', cmd: 'tool.wire' },
  { tool: 'solder', icon: <CircleDot size={17} />, label: 'Solder', cmd: 'tool.solder' },
  { tool: 'rect', icon: <Square size={17} />, label: 'Rectangle', cmd: 'tool.rect' },
  { tool: 'zone', icon: <RectangleHorizontal size={17} fill="currentColor" fillOpacity={0.35} />, label: 'Filled zone', cmd: 'tool.zone' },
  { tool: 'ellipse', icon: <Circle size={17} />, label: 'Ellipse', cmd: 'tool.ellipse' },
  { tool: 'line', icon: <Minus size={17} style={{ transform: 'rotate(-45deg)' }} />, label: 'Line', cmd: 'tool.line' },
  { tool: 'arrow', icon: <ArrowUpRight size={17} />, label: 'Arrow', cmd: 'tool.arrow' },
  { tool: 'text', icon: <Type size={17} />, label: 'Text', cmd: 'tool.text' },
];

export function ToolRail() {
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => s.placing);
  const altMove = useStore((s) => s.altMove);
  const lastExplain = useExplain((s) => s.lastTool);
  return (
    <div className="tool-rail" onPointerDown={(e) => e.stopPropagation()}>
      {TOOLS.map((t, i) => (
        <span key={t.cmd} style={{ display: 'contents' }}>
          {(i === 4 || i === 6) && <span className="rail-sep" />}
          <button
            className={tool === t.tool && !!t.alt === altMove && !placing ? 'tool-btn active' : 'tool-btn'}
            onClick={() => (t.alt ? A.setAltMove() : A.setTool(t.tool))}
            title={`${t.label} (${prettyKey(keysFor(t.cmd)[0] ?? '')})`}
          >
            {t.icon}
            <span className="tool-key">{prettyKey(keysFor(t.cmd)[0] ?? '')}</span>
          </button>
        </span>
      ))}
      <span className="rail-sep" />
      <button
        className={isExplainTool(tool) ? 'tool-btn explain-btn active' : 'tool-btn explain-btn'}
        onClick={A.toggleExplain}
        title="Explain tools"
      >
        <Presentation size={17} />
        <span className="tool-key">{prettyKey(keysFor(`tool.${lastExplain}`)[0] ?? '')}</span>
      </button>
    </div>
  );
}

export const ALL_COMMANDS = COMMANDS;
export const getState = S;

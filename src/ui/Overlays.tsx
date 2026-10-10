import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { COMMAND_MAP, keysFor, prettyKey } from '../store/commands';
import * as A from '../store/actions';
import { set, useStore } from '../store/store';

type MenuEntry = string | '-' | { label: string; run: () => void; key?: string };

export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const closeIt = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && set({ contextMenu: null });
    window.addEventListener('pointerdown', closeIt, true);
    return () => window.removeEventListener('pointerdown', closeIt, true);
  }, [menu]);
  if (!menu) return null;
  const target = menu.target ? doc.items[menu.target] : null;
  const types = new Set(selection.map((id) => doc.items[id]?.type));
  let entries: MenuEntry[];
  if (!target) {
    entries = [
      { label: 'Paste here', run: () => void A.paste(menu.world), key: keysFor('edit.pasteHere')[0] },
      'edit.selectAll',
      '-',
      'tool.wire',
      'tool.zone',
      'tool.rect',
      'tool.text',
      '-',
      'view.fit',
      'view.grid',
      '-',
      'symbols.new',
      'help.palette',
    ];
  } else {
    entries = ['edit.cut', 'edit.copy', 'edit.duplicate', 'edit.delete', '-'];
    if (types.has('component') || types.has('shape')) entries.push('arrange.rotateCw', 'arrange.rotateCcw', 'arrange.flipH', 'arrange.flipV', '-');
    if (selection.length > 1) entries.push('arrange.group');
    if (selection.some((id) => doc.items[id]?.group)) entries.push('arrange.ungroup');
    if (target.group) entries.push({ label: 'Enter group', run: () => A.enterGroup(target.id), key: keysFor('arrange.enterGroup')[0] });
    entries.push('edit.lock', '-');
    if (types.has('shape')) entries.push('arrange.layer', 'arrange.front', 'arrange.back', '-');
    if (types.has('wire')) entries.push('wire.highlightNet', 'wire.reroute', '-');
    if (types.has('component')) entries.push('symbols.edit', '-');
    if (selection.length > 1) entries.push('arrange.alignLeft', 'arrange.alignTop', 'arrange.distH', '-');
    entries.push({ label: 'Zoom to selection', run: () => A.fitView(selection), key: keysFor('view.fitSel')[0] });
    entries.push('-', 'file.exportSelection');
  }
  while (entries[entries.length - 1] === '-') entries.pop();
  const x = Math.min(menu.x, window.innerWidth - 250);
  const y = Math.min(menu.y, window.innerHeight - entries.length * 30 - 20);
  return (
    <div ref={ref} className="dropdown context-menu" style={{ left: x, top: Math.max(8, y) }} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((e, i) => {
        if (e === '-') return <div key={i} className="dropdown-sep" />;
        const item = typeof e === 'string' ? COMMAND_MAP.get(e) : null;
        const label = typeof e === 'string' ? item?.label : e.label;
        const key = typeof e === 'string' ? keysFor(e)[0] : e.key;
        const run = typeof e === 'string' ? item?.run : e.run;
        if (!label || !run) return null;
        return (
          <button
            key={i}
            className="dropdown-item"
            onClick={() => {
              set({ contextMenu: null });
              run();
            }}
          >
            <span>{label}</span>
            {key && <kbd>{prettyKey(key)}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

export function StatusBar() {
  const cursor = useStore((s) => s.cursor);
  const selection = useStore((s) => s.selection.length);
  const tool = useStore((s) => s.tool);
  const placing = useStore((s) => s.placing);
  const snapOn = useStore((s) => s.doc.settings.snap);
  const grid = useStore((s) => s.doc.settings.grid);
  const zoom = useStore((s) => s.view.zoom);
  const scope = useStore((s) => s.scope);
  const filePath = useStore((s) => s.filePath);
  const hint = placing
    ? 'Placing — click to drop, R rotate, X/Y flip, Esc cancel'
    : tool === 'wire'
      ? 'Wire — click a pin, wire or empty grid to start'
      : tool === 'select'
        ? 'Click a wire, click again on a segment to select it · Del removes the segment · Alt-drag on a wire to branch'
        : tool === 'node'
          ? 'Drag a bend to move it · click a node, Del removes it · Alt-drag freely'
          : tool === 'zone' || tool === 'rect' || tool === 'ellipse'
          ? 'Drag to draw · hold Shift to keep the tool'
          : tool === 'text'
            ? 'Click to place text'
            : tool === 'pan'
              ? 'Drag to pan'
              : 'Drag to draw';
  return (
    <footer className="statusbar">
      <span className="status-hint">{hint}</span>
      <span className="grow" />
      {filePath && <span className="status-item path" title={filePath}>{filePath.split(/[\\/]/).pop()}</span>}
      {scope && <span className="status-item accent">in group</span>}
      {selection > 0 && <span className="status-item">{selection} selected</span>}
      <button className="status-item btn" onClick={() => COMMAND_MAP.get('view.snap')!.run()} title="Toggle snap (Ctrl+')">
        snap {snapOn ? `${grid}px` : 'off'}
      </button>
      <span className="status-item mono">
        {Math.round(cursor.x)}, {Math.round(cursor.y)}
      </span>
      <span className="status-item mono">{Math.round(zoom * 100)}%</span>
    </footer>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'success' ? <CheckCircle2 size={15} /> : t.kind === 'error' ? <XCircle size={15} /> : <Info size={15} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDownToLine,
  ArrowUpToLine,
  BringToFront,
  ChevronRight,
  Circle,
  ClipboardPaste,
  Command,
  Copy,
  CopyPlus,
  Crosshair,
  Download,
  Eye,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FlipHorizontal2,
  FlipVertical2,
  Focus,
  Grid3x3,
  Group,
  Layers3,
  LayoutTemplate,
  Lock,
  LogIn,
  Magnet,
  Maximize,
  MousePointerSquareDashed,
  Move3d,
  Pentagon,
  PenTool,
  Plus,
  Printer,
  Redo2,
  RotateCcw,
  RotateCw,
  Route,
  Scan,
  Scissors,
  SendToBack,
  Shapes,
  Spline,
  Square,
  SquarePen,
  Trash2,
  Type,
  Undo2,
  Pencil,
  Ungroup,
  Waypoints,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { copyAsSvg, doExport, filePrint, startAreaExport, type ExportKind } from '../io/fileActions';
import { exportTemplateFile } from '../io/sharing';
import * as A from '../store/actions';
import { COMMAND_MAP, keysFor, prettyKey } from '../store/commands';
import { S, set, useStore, type ContextMenuState } from '../store/store';
import type { CircuitDoc } from '../model/types';

interface Entry {
  label: string;
  icon?: ReactNode;
  run?: () => void;
  key?: string;
  danger?: boolean;
  sub?: Row[];
}
type Row = Entry | '-';

const I = 14;

/** A menu row running a command, with its current shortcut. */
function cmd(id: string, label: string, icon?: ReactNode, extra: Partial<Entry> = {}): Entry | null {
  const c = COMMAND_MAP.get(id);
  if (!c || (c.when && !c.when())) return null;
  return { label, icon, run: c.run, key: keysFor(id)[0], ...extra };
}

const rows = (...r: (Row | null | false | '' | undefined)[]): Row[] => {
  const out = r.filter((x): x is Row => !!x);
  // no leading, trailing or doubled separators
  return out.filter((x, i) => x !== '-' || (i > 0 && i < out.length - 1 && out[i - 1] !== '-'));
};

/** Every export format, for the whole circuit or (with ids) just those items. */
function exportRows(ids?: string[]): Row[] {
  const x = (kind: ExportKind) => () => void doExport(kind, { ids });
  return rows(
    { label: 'PNG image', icon: <FileImage size={I} />, run: x('png') },
    { label: 'SVG vector', icon: <FileCode2 size={I} />, run: x('svg') },
    { label: 'Copy as SVG', icon: <Copy size={I} />, run: () => void copyAsSvg(), key: keysFor('file.copySvg')[0] },
    '-',
    { label: 'DXF (CAD)', icon: <Layers3 size={I} />, run: x('dxf') },
    { label: 'SPICE netlist', icon: <FileText size={I} />, run: x('spice') },
    { label: 'KiCad netlist', icon: <FileText size={I} />, run: x('kicad') },
    { label: 'Bill of materials (CSV)', icon: <FileSpreadsheet size={I} />, run: x('bom') },
    { label: 'JSON data', icon: <FileJson size={I} />, run: x('json') },
    ids ? { label: 'Nodal template', icon: <LayoutTemplate size={I} />, run: () => void exportTemplateFile(ids) } : null,
    '-',
    !ids && { label: 'Area…', icon: <Scan size={I} />, run: () => startAreaExport('png'), key: keysFor('file.exportArea')[0] },
    !ids && { label: 'Print / PDF…', icon: <Printer size={I} />, run: () => void filePrint(), key: keysFor('file.print')[0] },
    { label: 'More options…', icon: <Download size={I} />, run: () => set({ dialog: 'export' }), key: keysFor('file.export')[0] },
  );
}

function canvasMenu(menu: ContextMenuState): { strip: Entry[]; list: Row[] } {
  return {
    strip: [
      { label: 'Paste here', icon: <ClipboardPaste size={15} />, run: () => void A.paste(menu.world), key: keysFor('edit.paste')[0] },
      cmd('edit.selectAll', 'Select all', <MousePointerSquareDashed size={15} />)!,
      cmd('edit.undo', 'Undo', <Undo2 size={15} />)!,
      cmd('edit.redo', 'Redo', <Redo2 size={15} />)!,
    ],
    list: rows(
      {
        label: 'Add',
        icon: <Plus size={I} />,
        sub: rows(
          cmd('tool.wire', 'Wire', <Spline size={I} />),
          cmd('tool.netLabel', 'Net label', <Type size={I} />),
          '-',
          cmd('tool.rect', 'Rectangle', <Square size={I} />),
          cmd('tool.zone', 'Filled zone', <Square size={I} fill="currentColor" fillOpacity={0.35} />),
          cmd('tool.ellipse', 'Ellipse', <Circle size={I} />),
          cmd('tool.polygon', 'Polygon', <Pentagon size={I} />),
          cmd('tool.text', 'Text', <Type size={I} />),
          '-',
          cmd('symbols.new', 'New symbol…', <Shapes size={I} />),
        ),
      },
      {
        label: 'View',
        icon: <Eye size={I} />,
        sub: rows(
          cmd('view.fit', 'Zoom to fit', <Maximize size={I} />),
          cmd('view.100', 'Zoom to 100%', <Focus size={I} />),
          '-',
          cmd('view.grid', 'Grid', <Grid3x3 size={I} />),
          cmd('view.snap', 'Snap to grid', <Magnet size={I} />),
          cmd('view.alignGuides', 'Alignment guides', <Crosshair size={I} />),
          cmd('view.minimap', 'Minimap', <Scan size={I} />),
        ),
      },
      { label: 'Export', icon: <Download size={I} />, sub: exportRows() },
      '-',
      cmd('help.palette', 'Command palette…', <Command size={I} />),
    ),
  };
}

function itemMenu(doc: CircuitDoc, target: string, selection: string[]): { strip: Entry[]; list: Row[] } {
  const items = selection.map((id) => doc.items[id]).filter(Boolean);
  const types = new Set(items.map((i) => i.type));
  const multi = selection.length > 1;
  const grouped = items.some((i) => i.group);
  const t = doc.items[target];
  const transformable = types.has('component') || types.has('shape');
  const locked = items.length > 0 && items.every((i) => i.locked);
  return {
    strip: [
      cmd('edit.cut', 'Cut', <Scissors size={15} />)!,
      cmd('edit.copy', 'Copy', <Copy size={15} />)!,
      cmd('edit.duplicate', 'Duplicate', <CopyPlus size={15} />)!,
      cmd('edit.delete', 'Delete', <Trash2 size={15} />, { danger: true })!,
    ].filter(Boolean),
    list: rows(
      transformable && {
        label: 'Transform',
        icon: <RotateCw size={I} />,
        sub: rows(
          cmd('arrange.rotateCw', 'Rotate 90° clockwise', <RotateCw size={I} />),
          cmd('arrange.rotateCcw', 'Rotate 90° counter-clockwise', <RotateCcw size={I} />),
          '-',
          cmd('arrange.flipH', 'Flip horizontally', <FlipHorizontal2 size={I} />),
          cmd('arrange.flipV', 'Flip vertically', <FlipVertical2 size={I} />),
        ),
      },
      multi && {
        label: 'Align',
        icon: <AlignStartVertical size={I} />,
        sub: rows(
          cmd('arrange.alignLeft', 'Left', <AlignStartVertical size={I} />),
          cmd('arrange.alignHCenter', 'Centre', <AlignCenterVertical size={I} />),
          cmd('arrange.alignRight', 'Right', <AlignEndVertical size={I} />),
          '-',
          cmd('arrange.alignTop', 'Top', <AlignStartHorizontal size={I} />),
          cmd('arrange.alignVCenter', 'Middle', <AlignCenterHorizontal size={I} />),
          cmd('arrange.alignBottom', 'Bottom', <AlignEndHorizontal size={I} />),
          '-',
          cmd('arrange.distH', 'Distribute horizontally', <AlignHorizontalDistributeCenter size={I} />),
          cmd('arrange.distV', 'Distribute vertically', <AlignVerticalDistributeCenter size={I} />),
        ),
      },
      {
        label: 'Order',
        icon: <Layers3 size={I} />,
        sub: rows(
          cmd('arrange.front', 'Bring to front', <BringToFront size={I} />),
          cmd('arrange.forward', 'Bring forward', <ArrowUpToLine size={I} />),
          cmd('arrange.backward', 'Send backward', <ArrowDownToLine size={I} />),
          cmd('arrange.back', 'Send to back', <SendToBack size={I} />),
          types.has('shape') && '-',
          types.has('shape') && cmd('arrange.layer', 'Behind / above wires', <Layers3 size={I} />),
        ),
      },
      (multi || grouped || t?.group) && {
        label: 'Group',
        icon: <Group size={I} />,
        sub: rows(
          multi && cmd('arrange.group', 'Group', <Group size={I} />),
          grouped && cmd('arrange.ungroup', 'Ungroup', <Ungroup size={I} />),
          grouped && cmd('arrange.renameGroup', 'Rename group…', <Pencil size={I} />),
          t?.group && { label: 'Enter group', icon: <LogIn size={I} />, run: () => A.enterGroup(target), key: keysFor('arrange.enterGroup')[0] },
        ),
      },
      types.has('wire') && {
        label: 'Wire',
        icon: <Route size={I} />,
        sub: rows(
          cmd('wire.highlightNet', 'Highlight net', <Waypoints size={I} />),
          cmd('wire.reroute', 'Re-route', <Route size={I} />),
          { label: 'Edit points', icon: <PenTool size={I} />, run: () => A.setTool('node'), key: keysFor('tool.node')[0] },
        ),
      },
      {
        label: 'Symbol',
        icon: <Shapes size={I} />,
        sub: rows(
          types.has('component') && !multi && cmd('symbols.edit', 'Edit symbol…', <SquarePen size={I} />),
          cmd('symbols.fromSelection', 'Create symbol from selection…', <Shapes size={I} />),
        ),
      },
      '-',
      cmd('edit.lock', locked ? 'Unlock' : 'Lock', <Lock size={I} />),
      cmd('edit.hide', 'Hide', <Eye size={I} />),
      { label: 'Zoom to selection', icon: <Move3d size={I} />, run: () => A.fitView(selection), key: keysFor('view.fitSel')[0] },
      '-',
      { label: multi ? `Export ${selection.length} items` : 'Export selection', icon: <Download size={I} />, sub: exportRows(selection) },
    ),
  };
}

const close = () => set({ contextMenu: null });

/** Keeps a menu panel inside the window: flips a submenu to the left, shifts anything that would run off the bottom. */
function useFit(ref: React.RefObject<HTMLDivElement>, sub: boolean) {
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // measured from the anchor and the panel's own size, so the opening animation's transform can't skew it
    const anchor = el.parentElement!.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = sub ? anchor.right + 2 : anchor.left;
    const top = sub ? anchor.top - 5 : anchor.top;
    const out: React.CSSProperties = {};
    let dx = 0;
    if (left + w > window.innerWidth - 6) {
      if (sub) {
        out.left = 'auto';
        out.right = 'calc(100% + 2px)';
      } else dx = window.innerWidth - 6 - (left + w);
    }
    const over = top + h - (window.innerHeight - 8);
    const dy = over > 0 ? -Math.min(over, Math.max(0, top - 8)) : 0;
    // `translate` (not `transform`) so the opening animation does not fight the offset
    if (dx || dy) out.translate = `${dx}px ${dy}px`;
    setStyle(out);
  }, []);
  return style;
}

function Panel({ list, strip, className, sub = false }: { list: Row[]; strip?: Entry[]; className?: string; sub?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const fit = useFit(ref, sub);
  const [open, setOpen] = useState<number | null>(null);
  const timer = useRef<number>();
  const hover = (i: number | null) => {
    window.clearTimeout(timer.current);
    // a short pause, so cutting across other rows on the way to a submenu does not swap it
    timer.current = window.setTimeout(() => setOpen(i), i === null ? 250 : 90);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <div ref={ref} className={`ctx ${className ?? ''}`} style={fit} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {strip && strip.length > 0 && (
        <div className="ctx-strip">
          {strip.map((e) => (
            <button
              key={e.label}
              className={e.danger ? 'danger' : ''}
              title={`${e.label}${e.key ? ` (${prettyKey(e.key)})` : ''}`}
              onClick={() => {
                close();
                e.run?.();
              }}
              onPointerEnter={() => hover(null)}
            >
              {e.icon}
            </button>
          ))}
        </div>
      )}
      {list.map((e, i) => {
        if (e === '-') return <div key={i} className="ctx-sep" />;
        if (e.sub && !e.sub.length) return null;
        const isOpen = open === i && !!e.sub;
        return (
          <div key={i} className="ctx-row-wrap" onPointerEnter={() => hover(e.sub ? i : null)}>
            <button
              className={`ctx-row${isOpen ? ' open' : ''}${e.danger ? ' danger' : ''}`}
              role="menuitem"
              aria-haspopup={e.sub ? 'menu' : undefined}
              onClick={() => {
                if (e.sub) {
                  window.clearTimeout(timer.current);
                  setOpen(i);
                  return;
                }
                close();
                e.run?.();
              }}
            >
              <span className="ctx-icon">{e.icon}</span>
              <span className="ctx-label">{e.label}</span>
              {e.sub ? <ChevronRight size={13} className="ctx-chev" /> : e.key ? <kbd>{prettyKey(e.key)}</kbd> : null}
            </button>
            {isOpen && <Panel list={e.sub!} className="ctx-sub" sub />}
          </div>
        );
      })}
    </div>
  );
}

export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const closeIt = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', closeIt, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', closeIt, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu]);
  if (!menu) return null;
  const target = menu.target && doc.items[menu.target] ? menu.target : null;
  const { strip, list } = target ? itemMenu(doc, target, S().selection.length ? selection : [target]) : canvasMenu(menu);
  return (
    <div ref={ref} className="ctx-root" style={{ left: menu.x, top: menu.y }} key={`${menu.x},${menu.y}`}>
      <Panel list={list} strip={strip} />
    </div>
  );
}

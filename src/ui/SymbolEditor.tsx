import { Circle, Copy, Cpu, Code2, MousePointer2, PenLine, Pin, Redo2, Slash, Square, Trash2, Type, Undo2, Upload, Spline } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { PrimEl, SymbolPreview } from '../canvas/SymbolGraphic';
import { uid } from '../model/doc';
import { compileSource, inferSide, parseDraw, parsePorts, primsToDsl, sourceOf, type SymbolSource } from '../model/symbols/dsl';
import { getSymbol } from '../model/registry';
import { CATEGORY_ORDER } from '../model/symbols';
import type { Fill, PortDef, Prim, SymbolDef } from '../model/types';
import { eventToCombo } from '../store/commands';
import { S, mutate, saveUserSymbol, set, toast, useStore } from '../store/store';
import { Modal } from './Dialogs';
import { Field, NumberInput, Segmented, TextInput } from './controls';

type Tool = 'select' | 'line' | 'poly' | 'rect' | 'circle' | 'ellipse' | 'text' | 'pin';
type Tab = 'draw' | 'chip' | 'svg' | 'code';

const blank = (): SymbolSource => ({
  id: '',
  name: 'New symbol',
  category: 'My symbols',
  w: 80,
  h: 40,
  draw: 'L 0 20 20 20\nRB 20 8 40 24 3\nL 60 20 80 20',
  ports: '1:0,20 2:80,20',
  prefix: 'U',
  value: '',
  fields: '',
  keywords: '',
});

const r20 = (v: number) => Math.max(20, Math.round(v / 20) * 20);
const s5 = (v: number) => Math.round(v / 5) * 5;
const s10 = (v: number) => Math.round(v / 10) * 10;

interface Snap {
  src: SymbolSource;
  prims: Prim[];
  ports: PortDef[];
}

export function SymbolEditor() {
  const editing = useStore((s) => s.editingSymbol);
  const original = useMemo<SymbolDef | null>(() => (editing ? getSymbol(S().doc, editing) : null), [editing]);
  const [src, setSrc] = useState<SymbolSource>(() => (original ? { ...sourceOf(original), id: original.custom ? original.id : '', name: original.custom ? original.name : `${original.name} (custom)`, category: original.custom ? original.category : 'My symbols' } : blank()));
  const [prims, setPrims] = useState<Prim[]>(() => safePrims(src.draw));
  const [ports, setPorts] = useState<PortDef[]>(() => safePorts(src.ports, src.w, src.h));
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [tab, setTab] = useState<Tab>('draw');
  const [error, setError] = useState<string | null>(null);
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  /** Key of the last coalescing edit (typing in a field, nudging) so a burst becomes one undo step. */
  const lastKey = useRef<string | null>(null);
  const stateRef = useRef<Snap>({ src, prims, ports });
  stateRef.current = { src, prims, ports };

  const snapshot = (): Snap => ({
    src: { ...stateRef.current.src },
    prims: [...stateRef.current.prims],
    ports: stateRef.current.ports.map((p) => ({ ...p })),
  });

  const write = (n: Snap) => {
    stateRef.current = n;
    setSrc(n.src);
    setPrims(n.prims);
    setPorts(n.ports);
    rerender();
  };

  /**
   * Applies an editing change with the editor's own undo/redo history.
   * `history`: true records an undo step, false doesn't (live drag updates),
   * a string key records one step for a run of edits sharing that key.
   */
  const apply = (mut: (s: Snap) => void, history: boolean | string = true) => {
    const key = typeof history === 'string' ? history : null;
    if (history && (key === null || key !== lastKey.current)) {
      past.current = [...past.current.slice(-150), snapshot()];
      future.current = [];
    }
    if (history) lastKey.current = key;
    const next = snapshot();
    mut(next);
    // keep the DSL text in sync with the structured drawing
    next.src = { ...next.src, draw: primsToDsl(next.prims), ports: next.ports.map((p) => `${p.id}:${p.x},${p.y}`).join(' ') };
    write(next);
  };

  const undoEd = () => {
    const prev = past.current.pop();
    if (!prev) return;
    lastKey.current = null;
    future.current = [...future.current, snapshot()];
    write(prev);
  };

  const redoEd = () => {
    const nxt = future.current.pop();
    if (!nxt) return;
    lastKey.current = null;
    past.current = [...past.current, snapshot()];
    write(nxt);
  };

  const hist = { canUndo: past.current.length > 0, canRedo: future.current.length > 0 };

  const preview = useMemo<SymbolDef | null>(() => {
    try {
      return compileSource({ ...src, id: src.id || 'preview' });
    } catch {
      return null;
    }
  }, [src]);

  const save = (asNew: boolean) => {
    try {
      const problems = ports.filter((p) => !(p.x === 0 || p.y === 0 || p.x === src.w || p.y === src.h));
      if (problems.length) throw new Error(`Pin ${problems[0].name} must sit on the symbol's outline`);
      const ids = new Set<string>();
      for (const p of ports) {
        if (ids.has(p.id)) throw new Error(`Two pins are named "${p.id}"`);
        ids.add(p.id);
      }
      const id = !asNew && src.id ? src.id : `user-${slug(src.name)}-${uid('').slice(-5)}`;
      const def = compileSource({ ...src, id });
      saveUserSymbol(def);
      // keep the document copy in sync so placed parts update
      if (S().doc.symbols[id]) mutate((d) => void (d.symbols[id] = def));
      // when customising a built-in symbol for a selected part, swap it in
      if (original && !original.custom) {
        const targets = S().selection.filter((sid) => {
          const it = S().doc.items[sid];
          return it?.type === 'component' && it.symbol === original.id;
        });
        if (targets.length) {
          mutate((d) => {
            d.symbols[id] = def;
            for (const t of targets) {
              const c = d.items[t];
              if (c.type === 'component') c.symbol = id;
            }
          });
        }
      }
      toast(`Saved “${def.name}” to My symbols`, 'success');
      set({ dialog: null, editingSymbol: null });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={original ? (original.custom ? `Edit symbol — ${original.name}` : `Customise “${original.name}”`) : 'Create a symbol'} onClose={() => set({ dialog: null, editingSymbol: null })} width={1040} className="symbol-editor">
      <div className="se-layout">
        <div className="se-main">
          <div className="tabs inline">
            <button className={tab === 'draw' ? 'active' : ''} onClick={() => setTab('draw')}>
              <PenLine size={13} /> Draw
            </button>
            <button className={tab === 'chip' ? 'active' : ''} onClick={() => setTab('chip')}>
              <Cpu size={13} /> Chip / IC builder
            </button>
            <button className={tab === 'svg' ? 'active' : ''} onClick={() => setTab('svg')}>
              <Upload size={13} /> Import SVG
            </button>
            <button className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}>
              <Code2 size={13} /> Code
            </button>
          </div>
          {tab === 'draw' && <DrawPane src={src} apply={apply} prims={prims} ports={ports} onUndo={undoEd} onRedo={redoEd} canUndo={hist.canUndo} canRedo={hist.canRedo} />}
          {tab === 'chip' && (
            <ChipBuilder
              onBuild={(b) => {
                apply((s) => {
                  s.src.w = b.w;
                  s.src.h = b.h;
                  if (!s.src.prefix) s.src.prefix = 'U';
                  s.prims = b.prims;
                  s.ports = b.ports;
                });
                setTab('draw');
              }}
            />
          )}
          {tab === 'svg' && (
            <SvgImport
              onImport={(p, w, h) => {
                apply((s) => {
                  s.src.w = w;
                  s.src.h = h;
                  s.prims = p;
                  s.ports = [];
                });
                setTab('draw');
                toast('Imported — now add pins with the Pin tool');
              }}
            />
          )}
          {tab === 'code' && (
            <CodePane
              src={src}
              onApply={(draw, portsText) => {
                try {
                  const p = parseDraw(draw);
                  const pt = parsePorts(portsText, src.w, src.h);
                  apply((s) => {
                    s.prims = p;
                    s.ports = pt;
                    s.src.draw = draw;
                    s.src.ports = portsText;
                  });
                  setError(null);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
          )}
        </div>
        <div className="se-side">
          <div className="se-preview">{preview ? <SymbolPreview def={preview} size={150} ports /> : <span className="muted">Invalid symbol</span>}</div>
          <Field label="Name">
            <TextInput value={src.name} onChange={(name) => apply((s) => void (s.src.name = name), 'name')} />
          </Field>
          <Field label="Category">
            <select className="input" value={src.category} onChange={(e) => apply((s) => void (s.src.category = e.target.value))}>
              {['My symbols', ...CATEGORY_ORDER].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Ref prefix" hint="R for resistors, U for ICs, Q for transistors…">
            <TextInput value={src.prefix} onChange={(prefix) => apply((s) => void (s.src.prefix = prefix), 'prefix')} />
          </Field>
          <Field label="Default value">
            <TextInput value={src.value} onChange={(value) => apply((s) => void (s.src.value = value), 'value')} placeholder="e.g. 10kΩ" />
          </Field>
          <Field label="Fields" hint="Comma separated, e.g. Package=0805, Voltage=50V">
            <TextInput value={src.fields} onChange={(fields) => apply((s) => void (s.src.fields = fields), 'fields')} placeholder="Package=0805, Tolerance=1%" />
          </Field>
          <Field label="Search words">
            <TextInput value={src.keywords} onChange={(keywords) => apply((s) => void (s.src.keywords = keywords), 'keywords')} />
          </Field>
          <div className="se-pins">
            <b>{ports.length} pins</b>
            {ports.map((p, i) => (
              <span key={i} className="pin-chip">
                <input
                  value={p.id}
                  onChange={(e) => {
                    const id = e.target.value.replace(/[\s:,]/g, '_');
                    apply((s) => void (s.ports[i] = { ...s.ports[i], id, name: id }), `pin-${i}`);
                  }}
                />
                <button onClick={() => apply((s) => void s.ports.splice(i, 1))}>×</button>
              </span>
            ))}
          </div>
          {error && <div className="error-note">{error}</div>}
          <div className="btn-row">
            {src.id && (
              <button className="secondary-btn" onClick={() => save(true)}>
                Save as copy
              </button>
            )}
            <button className="primary-btn" onClick={() => save(false)}>
              {src.id ? 'Save changes' : 'Add to My symbols'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'symbol';
}

function safePrims(d: string): Prim[] {
  try {
    return parseDraw(d);
  } catch {
    return [];
  }
}
function safePorts(p: string, w: number, h: number): PortDef[] {
  try {
    return parsePorts(p, w, h);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Draw pane                                                           */
/* ------------------------------------------------------------------ */

function primBounds(p: Prim): { x: number; y: number; w: number; h: number } {
  const pts: number[] = [];
  switch (p.t) {
    case 'line':
    case 'poly':
      pts.push(...p.pts);
      break;
    case 'rect':
      pts.push(p.x, p.y, p.x + p.w, p.y + p.h);
      break;
    case 'circle':
    case 'arc':
      pts.push(p.cx - p.r, p.cy - p.r, p.cx + p.r, p.cy + p.r);
      break;
    case 'ellipse':
      pts.push(p.cx - p.rx, p.cy - p.ry, p.cx + p.rx, p.cy + p.ry);
      break;
    case 'text':
      pts.push(p.x - p.text.length * p.size * 0.3, p.y - p.size, p.x + p.text.length * p.size * 0.3, p.y);
      break;
    case 'path':
      return { x: 0, y: 0, w: 0, h: 0 };
  }
  const xs = pts.filter((_, i) => i % 2 === 0);
  const ys = pts.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function movePrim(p: Prim, dx: number, dy: number): Prim {
  switch (p.t) {
    case 'line':
    case 'poly':
      return { ...p, pts: p.pts.map((v, i) => v + (i % 2 ? dy : dx)) };
    case 'rect':
    case 'text':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'circle':
    case 'ellipse':
    case 'arc':
      return { ...p, cx: p.cx + dx, cy: p.cy + dy };
    case 'path':
      return p;
  }
}

const TOOL_KEYS: Record<Tool, string> = { select: 'V', line: 'L', poly: 'P', rect: 'R', circle: 'C', ellipse: 'E', text: 'T', pin: 'N' };

/** The primitive a drag from a to b draws with the given tool, or null for click-only tools. */
function dragShape(tool: Tool, a: { x: number; y: number }, b: { x: number; y: number }, fill: Fill): Prim | null {
  if (tool === 'line') return { t: 'line', pts: [a.x, a.y, b.x, b.y] };
  if (tool === 'rect') return { t: 'rect', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), fill };
  if (tool === 'circle') return { t: 'circle', cx: a.x, cy: a.y, r: Math.round(Math.hypot(b.x - a.x, b.y - a.y)), fill };
  if (tool === 'ellipse') return { t: 'ellipse', cx: a.x, cy: a.y, rx: Math.abs(b.x - a.x), ry: Math.abs(b.y - a.y), fill };
  return null;
}

function DrawPane({
  src,
  apply,
  prims,
  ports,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: {
  src: SymbolSource;
  apply: (mut: (s: Snap) => void, history?: boolean | string) => void;
  prims: Prim[];
  ports: PortDef[];
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const [tool, setTool] = useState<Tool>('select');
  const [sel, setSel] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; cur: { x: number; y: number }; moveBase?: Prim; moved?: boolean } | null>(null);
  const [poly, setPoly] = useState<number[] | null>(null);
  const [fill, setFill] = useState<Fill>('none');
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const pad = 30;
  const viewW = src.w + pad * 2;
  const viewH = src.h + pad * 2;
  const scale = Math.min(620 / viewW, 400 / viewH, 8);

  const toLocal = (e: React.PointerEvent | React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / scale - pad;
    const y = (e.clientY - r.top) / scale - pad;
    return { x: s5(x), y: s5(y) };
  };

  const finishPoly = () => {
    if (poly && poly.length >= 4) apply((s) => void s.prims.push(fill === 'none' ? { t: 'line', pts: poly } : { t: 'poly', pts: poly, fill }));
    setPoly(null);
  };

  const dupSel = () => {
    if (sel === null) return;
    const copy = movePrim(structuredClone(prims[sel]), 5, 5);
    apply((s) => void s.prims.splice(sel + 1, 0, copy));
    setSel(sel + 1);
  };

  const delSel = () => {
    if (sel === null) return;
    apply((s) => void s.prims.splice(sel, 1));
    setSel(null);
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const combo = eventToCombo(e);
      if (combo === 'Mod+Z') {
        e.preventDefault();
        e.stopPropagation();
        onUndo();
        return;
      }
      if (combo === 'Mod+Shift+Z' || combo === 'Mod+Y') {
        e.preventDefault();
        e.stopPropagation();
        onRedo();
        return;
      }
      if (combo === 'Escape') return; // the modal owns Esc
      if (combo === 'Enter' && poly) {
        finishPoly();
        return;
      }
      if (poly && (combo === 'Delete' || combo === 'Backspace')) {
        e.preventDefault();
        if (poly.length >= 4) setPoly(poly.slice(0, -2));
        else finishPoly();
        return;
      }
      if ((combo === 'Delete' || combo === 'Backspace') && sel !== null) {
        e.preventDefault();
        delSel();
        return;
      }
      const hotTool = (Object.keys(TOOL_KEYS) as Tool[]).find((t) => TOOL_KEYS[t] === combo);
      if (hotTool) {
        finishPoly();
        setTool(hotTool);
        return;
      }
      if (combo === 'Mod+D' && sel !== null) {
        e.preventDefault();
        dupSel();
        return;
      }
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-5, 0],
        ArrowRight: [5, 0],
        ArrowUp: [0, -5],
        ArrowDown: [0, 5],
      };
      if (nudge[combo]) {
        e.preventDefault();
        if (poly) return setPoly([...poly.slice(0, -2), s5(poly[poly.length - 2] + nudge[combo][0]), s5(poly[poly.length - 1] + nudge[combo][1])]);
        if (sel !== null) apply((s) => void (s.prims[sel] = movePrim(s.prims[sel], nudge[combo][0], nudge[combo][1])), `nudge-${sel}`);
        return;
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });

  const hitPrim = (p: { x: number; y: number }) => {
    for (let i = prims.length - 1; i >= 0; i--) {
      const b = primBounds(prims[i]);
      if (p.x >= b.x - 3 && p.x <= b.x + b.w + 3 && p.y >= b.y - 3 && p.y <= b.y + b.h + 3) return i;
    }
    return null;
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toLocal(e);
    if (tool === 'select') {
      const i = hitPrim(p);
      setSel(i);
      if (i !== null) setDrag({ start: p, cur: p, moveBase: prims[i] });
      return;
    }
    if (tool === 'pin') {
      const x = Math.min(src.w, Math.max(0, s10(p.x)));
      const y = Math.min(src.h, Math.max(0, s10(p.y)));
      const side = inferSide(x, y, src.w, src.h);
      const pos = side === 'left' ? { x: 0, y } : side === 'right' ? { x: src.w, y } : side === 'top' ? { x, y: 0 } : { x, y: src.h };
      const existing = ports.findIndex((q) => q.x === pos.x && q.y === pos.y);
      if (existing >= 0) return apply((s) => void s.ports.splice(existing, 1));
      let n = ports.length + 1;
      while (ports.some((q) => q.id === String(n))) n++;
      apply((s) => void s.ports.push({ id: String(n), name: String(n), ...pos, side }));
      return;
    }
    if (tool === 'text') {
      const text = prompt('Text');
      if (text) apply((s) => void s.prims.push({ t: 'text', x: p.x, y: p.y, size: 10, anchor: 'middle', text }));
      return;
    }
    if (tool === 'poly') {
      if (poly && e.detail >= 2) return finishPoly();
      setPoly([...(poly ?? []), p.x, p.y]);
      return;
    }
    setDrag({ start: p, cur: p });
  };

  const onMove = (e: React.PointerEvent) => {
    const p = toLocal(e);
    setCursor(p);
    if (!drag) return;
    const moving = tool === 'select' && drag.moveBase && sel !== null && (drag.moved || p.x !== drag.start.x || p.y !== drag.start.y);
    setDrag({ ...drag, cur: p, moved: drag.moved || !!moving });
    if (moving) {
      const base = drag.moveBase!;
      // the first real movement records the undo step; the rest of the drag updates in place
      apply((s) => void (s.prims[sel] = movePrim(base, p.x - drag.start.x, p.y - drag.start.y)), !drag.moved);
    }
  };

  const onUp = () => {
    if (!drag) return;
    const { start: a, cur: b } = drag;
    setDrag(null);
    if (tool === 'select') return;
    if (a.x === b.x && a.y === b.y) return;
    const prim = dragShape(tool, a, b, fill);
    if (!prim) return;
    apply((s) => void s.prims.push(prim));
    setSel(prims.length);
  };

  const draft: Prim | null = poly ? { t: 'line', pts: [...poly, cursor.x, cursor.y] } : drag && tool !== 'select' ? dragShape(tool, drag.start, drag.cur, fill) : null;

  const selected = sel !== null ? prims[sel] : null;
  const setSelFill = (f: Fill) => {
    if (sel === null) return setFill(f);
    apply((s) => {
      const p = s.prims[sel];
      if ('fill' in p) s.prims[sel] = { ...p, fill: f } as Prim;
      else if (p.t === 'line' && f !== 'none') s.prims[sel] = { t: 'poly', pts: p.pts, fill: f, w: p.w };
    });
    setFill(f);
  };

  const setSelWidth = (w: number) => {
    if (sel !== null)
      apply((s) => {
        const p = s.prims[sel];
        if (p.t === 'rect') s.prims[sel] = { ...p, sw: w };
        else if ('w' in p) s.prims[sel] = { ...p, w } as Prim;
      });
  };
  const selWidth = selected ? (selected.t === 'rect' ? (selected.sw ?? 2) : 'w' in selected ? (selected.w ?? 2) : 2) : 2;

  const toolNote =
    tool === 'pin'
      ? 'Click on the dashed outline to add a pin; click an existing pin to remove it.'
      : tool === 'poly'
        ? 'Click to add points · Enter or double-click to finish · Backspace removes the last point.'
        : tool === 'select'
          ? 'Click a shape to select it · drag to move · arrows nudge.'
          : 'Drag to draw.';

  const tools: [Tool, JSX.Element, string][] = [
    ['select', <MousePointer2 size={15} />, 'Select & move (Del removes, arrows nudge, Ctrl+D duplicates)'],
    ['line', <Slash size={15} />, 'Line (drag)'],
    ['poly', <Spline size={15} />, 'Polyline / polygon (click points, Enter or double-click to finish)'],
    ['rect', <Square size={15} />, 'Rectangle (drag)'],
    ['circle', <Circle size={15} />, 'Circle (drag from centre)'],
    ['ellipse', <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><ellipse cx="12" cy="12" rx="10" ry="6" /></svg>, 'Ellipse (drag from centre)'],
    ['text', <Type size={15} />, 'Text'],
    ['pin', <Pin size={15} />, 'Pin (click on the outline, click again to remove)'],
  ];

  return (
    <div className="se-draw">
      <div className="se-toolbar">
        {tools.map(([t, icon, title]) => (
          <button
            key={t}
            className={tool === t ? 'tool-btn active' : 'tool-btn'}
            title={`${title} — ${TOOL_KEYS[t]}`}
            onClick={() => {
              finishPoly();
              setTool(t);
            }}
          >
            {icon}
            <span className="tool-key">{TOOL_KEYS[t]}</span>
          </button>
        ))}
        <span className="rail-sep v" />
        <Segmented
          value={selected && 'fill' in selected ? selected.fill : fill}
          options={[
            { value: 'none', label: 'Outline' },
            { value: 'solid', label: 'Filled' },
            { value: 'bg', label: 'Opaque' },
          ]}
          onChange={setSelFill}
        />
        {sel !== null && (
          <Segmented
            value={selWidth}
            options={[
              { value: 1, label: 'Thin', title: 'Stroke width of the selected shape' },
              { value: 2, label: 'Normal', title: 'Stroke width of the selected shape' },
              { value: 3, label: 'Thick', title: 'Stroke width of the selected shape' },
            ]}
            onChange={setSelWidth}
          />
        )}
        {sel !== null && (
          <>
            <button className="tool-btn" title="Duplicate (Ctrl+D)" onClick={dupSel}>
              <Copy size={15} />
            </button>
            <button className="tool-btn" title="Delete shape (Del)" onClick={delSel}>
              <Trash2 size={15} />
            </button>
          </>
        )}
        <span className="rail-sep v" />
        <button className="tool-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={15} />
        </button>
        <button className="tool-btn" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={15} />
        </button>
        <span className="grow" />
        <span className="se-size">
          <NumberInput value={src.w} min={20} max={400} step={20} suffix="w" onChange={(v) => apply((s) => void (s.src.w = r20(v)))} />
          <NumberInput value={src.h} min={20} max={400} step={20} suffix="h" onChange={(v) => apply((s) => void (s.src.h = r20(v)))} />
        </span>
      </div>
      <div className="se-canvas">
        <svg ref={svgRef} width={viewW * scale} height={viewH * scale} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={() => poly && finishPoly()}>
          <defs>
            <pattern id="se-grid" width={5 * scale} height={5 * scale} patternUnits="userSpaceOnUse" x={(pad % 5) * scale} y={(pad % 5) * scale}>
              <circle cx={0.6} cy={0.6} r={0.6} className="grid-dot" />
            </pattern>
            <pattern id="se-grid10" width={10 * scale} height={10 * scale} patternUnits="userSpaceOnUse" x={(pad % 10) * scale} y={(pad % 10) * scale}>
              <circle cx={1} cy={1} r={1.2} className="grid-dot-major" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#se-grid)" />
          <rect width="100%" height="100%" fill="url(#se-grid10)" />
          <g transform={`scale(${scale}) translate(${pad} ${pad})`}>
            <rect x={0} y={0} width={src.w} height={src.h} className="se-bounds" strokeWidth={1 / scale} />
            <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" className="se-prims">
              {prims.map((p, i) =>
                p.t === 'text' ? (
                  <text key={i} x={p.x} y={p.y} fontSize={p.size} textAnchor={p.anchor} fill="currentColor" stroke="none">
                    {p.text}
                  </text>
                ) : (
                  <PrimEl key={i} p={p} sw={2} />
                ),
              )}
              {draft && <g opacity={0.6}><PrimEl p={draft} sw={2} /></g>}
            </g>
            {selected &&
              (() => {
                const b = primBounds(selected);
                return <rect x={b.x - 3} y={b.y - 3} width={b.w + 6} height={b.h + 6} className="se-sel" strokeWidth={1 / scale} />;
              })()}
            {ports.map((p) => (
              <g key={`${p.x},${p.y}`}>
                <circle cx={p.x} cy={p.y} r={3} className="se-pin" />
                <text x={p.x + (p.side === 'left' ? -5 : p.side === 'right' ? 5 : 0)} y={p.y + (p.side === 'top' ? -6 : p.side === 'bottom' ? 11 : 3)} textAnchor={p.side === 'left' ? 'end' : p.side === 'right' ? 'start' : 'middle'} className="se-pin-label">
                  {p.id}
                </text>
              </g>
            ))}
            {tool !== 'select' && <circle cx={cursor.x} cy={cursor.y} r={1.5} className="se-cursor" />}
            {poly && poly.length >= 2 && <circle cx={poly[poly.length - 2]} cy={poly[poly.length - 1]} r={2.5} className="se-cursor" />}
          </g>
        </svg>
      </div>
      <div className="se-help muted small">
        <div className="se-tool-note">{toolNote}</div>
        Grid: 5px drawing, 10px pins. Pins sit on the dashed outline so wires snap to the schematic grid; size is kept to multiples of 20.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chip builder                                                        */
/* ------------------------------------------------------------------ */

function ChipBuilder({ onBuild }: { onBuild: (b: { w: number; h: number; prims: Prim[]; ports: PortDef[] }) => void }) {
  const [left, setLeft] = useState('VCC\nIN1\nIN2\nGND');
  const [right, setRight] = useState('OUT1\nOUT2');
  const [top, setTop] = useState('');
  const [bottom, setBottom] = useState('');
  const [title, setTitle] = useState('IC');
  const [numbers, setNumbers] = useState(true);
  const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

  const build = () => {
    const L = lines(left);
    const R = lines(right);
    const T = lines(top);
    const B = lines(bottom);
    const lead = 20;
    const rows = Math.max(L.length, R.length, 1);
    const cols = Math.max(T.length, B.length, 0);
    const maxName = Math.max(0, ...L.map((s) => s.length)) + Math.max(0, ...R.map((s) => s.length));
    const bodyW = Math.max(60, Math.ceil((maxName * 6.2 + 30) / 20) * 20, (cols + 1) * 20);
    const bodyH = Math.max(40, (rows + 1) * 20);
    const w = r20(bodyW + (L.length ? lead : 0) + (R.length ? lead : 0));
    const h = r20(bodyH + (T.length ? lead : 0) + (B.length ? lead : 0));
    const x0 = L.length ? lead : 0;
    const y0 = T.length ? lead : 0;
    const x1 = w - (R.length ? lead : 0);
    const y1 = h - (B.length ? lead : 0);
    const prims: Prim[] = [{ t: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0, rx: 2, fill: 'bg' }];
    const ports: PortDef[] = [];
    const used = new Set<string>();
    let num = 1;
    const addPin = (name: string, x: number, y: number, side: PortDef['side']) => {
      let id = name.replace(/[\s:,]/g, '_');
      while (used.has(id)) id += '_';
      used.add(id);
      ports.push({ id, name, x, y, side });
      return num++;
    };
    L.forEach((n, i) => {
      const y = y0 + 20 + i * 20;
      prims.push({ t: 'line', pts: [0, y, x0, y] });
      prims.push({ t: 'text', x: x0 + 4, y: y + 3.5, size: 9, anchor: 'start', text: n });
      const k = addPin(n, 0, y, 'left');
      if (numbers) prims.push({ t: 'text', x: x0 / 2, y: y - 3, size: 7, anchor: 'middle', text: String(k) });
    });
    B.forEach((n, i) => {
      const x = x0 + 20 + i * 20;
      prims.push({ t: 'line', pts: [x, y1, x, h] });
      prims.push({ t: 'text', x, y: y1 - 4, size: 8, anchor: 'middle', text: n });
      addPin(n, x, h, 'bottom');
    });
    [...R].reverse().forEach((n, ri) => {
      const i = R.length - 1 - ri;
      const y = y0 + 20 + i * 20;
      prims.push({ t: 'line', pts: [x1, y, w, y] });
      prims.push({ t: 'text', x: x1 - 4, y: y + 3.5, size: 9, anchor: 'end', text: n });
      const k = addPin(n, w, y, 'right');
      if (numbers) prims.push({ t: 'text', x: x1 + (w - x1) / 2, y: y - 3, size: 7, anchor: 'middle', text: String(k) });
    });
    [...T].reverse().forEach((n, ri) => {
      const i = T.length - 1 - ri;
      const x = x0 + 20 + i * 20;
      prims.push({ t: 'line', pts: [x, 0, x, y0] });
      prims.push({ t: 'text', x, y: y0 + 11, size: 8, anchor: 'middle', text: n });
      addPin(n, x, 0, 'top');
    });
    if (title) prims.push({ t: 'text', x: (x0 + x1) / 2, y: (y0 + y1) / 2 + 4, size: 11, anchor: 'middle', text: title });
    onBuild({ w, h, prims, ports });
  };

  return (
    <div className="chip-builder">
      <p className="muted small">List pin names, one per line (or comma separated). The chip outline, leads, labels and pin numbers are generated for you — tweak the result in Draw afterwards.</p>
      <div className="chip-grid">
        <Field label="Title inside" wide>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div />
        <Field label="Left pins" wide>
          <textarea className="input mono" rows={8} value={left} onChange={(e) => setLeft(e.target.value)} />
        </Field>
        <Field label="Right pins" wide>
          <textarea className="input mono" rows={8} value={right} onChange={(e) => setRight(e.target.value)} />
        </Field>
        <Field label="Top pins" wide>
          <textarea className="input mono" rows={3} value={top} onChange={(e) => setTop(e.target.value)} />
        </Field>
        <Field label="Bottom pins" wide>
          <textarea className="input mono" rows={3} value={bottom} onChange={(e) => setBottom(e.target.value)} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={numbers} onChange={(e) => setNumbers(e.target.checked)} /> Show pin numbers
      </label>
      <button className="primary-btn" onClick={build}>
        <Cpu size={14} /> Generate chip
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SVG import                                                          */
/* ------------------------------------------------------------------ */

function SvgImport({ onImport }: { onImport: (p: Prim[], w: number, h: number) => void }) {
  const [text, setText] = useState('');
  const [size, setSize] = useState(80);
  const [err, setErr] = useState<string | null>(null);
  const run = () => {
    try {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const svg = doc.querySelector('svg');
      if (!svg) throw new Error('No <svg> element found');
      // measure in a live DOM so transforms and path lengths resolve
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;visibility:hidden;left:-9999px';
      host.appendChild(document.importNode(svg, true));
      document.body.appendChild(host);
      const live = host.querySelector('svg')!;
      const els = [...live.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse')] as SVGGeometryElement[];
      if (!els.length) throw new Error('The SVG has no drawable shapes');
      const runs: { pts: number[]; closed: boolean; filled: boolean }[] = [];
      for (const el of els) {
        const len = el.getTotalLength();
        if (!len) continue;
        const m = el.getCTM();
        const steps = Math.min(400, Math.max(8, Math.ceil(len / 2)));
        const pts: number[] = [];
        for (let i = 0; i <= steps; i++) {
          let p = el.getPointAtLength((len * i) / steps);
          if (m) p = p.matrixTransform(m);
          pts.push(p.x, p.y);
        }
        const fill = getComputedStyle(el).fill;
        const filled = !!fill && fill !== 'none' && !fill.includes('rgba(0, 0, 0, 0)');
        runs.push({ pts, closed: el.tagName !== 'line' && el.tagName !== 'polyline', filled });
      }
      host.remove();
      const xs = runs.flatMap((r) => r.pts.filter((_, i) => i % 2 === 0));
      const ys = runs.flatMap((r) => r.pts.filter((_, i) => i % 2 === 1));
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const bw = Math.max(...xs) - minX || 1;
      const bh = Math.max(...ys) - minY || 1;
      const k = (size - 20) / Math.max(bw, bh);
      const w = r20(bw * k + 20);
      const h = r20(bh * k + 20);
      const ox = (w - bw * k) / 2;
      const oy = (h - bh * k) / 2;
      const prims: Prim[] = runs.map((r) => {
        const pts = simplifyPts(r.pts.map((v, i) => +(i % 2 === 0 ? (v - minX) * k + ox : (v - minY) * k + oy).toFixed(1)));
        return r.filled ? { t: 'poly', pts, fill: 'solid' } : { t: 'line', pts };
      });
      onImport(prims, w, h);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="svg-import">
      <p className="muted small">Paste SVG markup (or load a file). Shapes are converted to symbol outlines and scaled to fit; then add pins in Draw.</p>
      <textarea className="input mono" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder="<svg …>…</svg>" />
      <div className="btn-row">
        <label className="secondary-btn">
          Load .svg file
          <input
            type="file"
            accept=".svg,image/svg+xml"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setText(await f.text());
            }}
          />
        </label>
        <Field label="Fit to">
          <NumberInput value={size} min={20} max={300} step={20} suffix="px" onChange={setSize} />
        </Field>
        <button className="primary-btn" disabled={!text.trim()} onClick={run}>
          Convert
        </button>
      </div>
      {err && <div className="error-note">{err}</div>}
    </div>
  );
}

function simplifyPts(pts: number[]): number[] {
  // drop nearly collinear points to keep the symbol light
  const out: number[] = [pts[0], pts[1]];
  for (let i = 2; i < pts.length - 2; i += 2) {
    const ax = out[out.length - 2],
      ay = out[out.length - 1];
    const bx = pts[i],
      by = pts[i + 1];
    const cx = pts[i + 2],
      cy = pts[i + 3];
    const cross = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    if (cross > 0.6) out.push(bx, by);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Code pane                                                           */
/* ------------------------------------------------------------------ */

function CodePane({ src, onApply }: { src: SymbolSource; onApply: (draw: string, ports: string) => void }) {
  const [draw, setDraw] = useState(src.draw);
  const [ports, setPorts] = useState(src.ports);
  return (
    <div className="code-pane">
      <div className="code-help muted small">
        <code>L x1 y1 x2 y2…</code> line · <code>G/GF/GB …</code> polygon (outline / filled / opaque) · <code>R x y w h [rx]</code> rect · <code>C cx cy r</code> circle · <code>E cx cy rx ry</code> ellipse ·{' '}
        <code>A cx cy r a1 a2</code> arc · <code>P d</code> SVG path · <code>T x y size s|m|e text</code> · <code>W width</code> · <code>D …</code> dashed line
      </div>
      <Field label="Drawing" wide>
        <textarea className="input mono" rows={14} value={draw} onChange={(e) => setDraw(e.target.value)} spellCheck={false} />
      </Field>
      <Field label="Pins (name:x,y …)" wide>
        <input className="input mono" value={ports} onChange={(e) => setPorts(e.target.value)} spellCheck={false} />
      </Field>
      <button className="primary-btn" onClick={() => onApply(draw, ports)}>
        Apply
      </button>
    </div>
  );
}

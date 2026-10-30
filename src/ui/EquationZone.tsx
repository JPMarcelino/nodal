/**
 * Word-style equation input for any text field that can hold maths. Alt+= opens a
 * math zone at the caret (or on the formula the caret is in, or turns the selected
 * text into an equation). The field keeps the focus: keys are routed to the zone,
 * and the field's text is kept up to date with the formula as `$…$` (or `$$…$$`).
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { mathRanges } from '../model/latex';
import { ACCENTS, EqEditor, charSym, fnSym, isLimitsBase, lookupSym, type MNode, type Row } from '../model/mathEdit';

type Field = HTMLTextAreaElement | HTMLInputElement;
interface Session {
  el: Field;
  start: number;
  len: number;
  ed: EqEditor;
  display: boolean;
}

let session: Session | null = null;
/** Counts openings, so each one lays its zone out afresh. */
let opened = 0;
let tick = 0;
const subs = new Set<() => void>();
const emit = () => {
  tick++;
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};

/** Fields that take equations: the canvas editors, and inputs marked `data-math`. */
export const mathField = (t: EventTarget | null): Field | null => {
  const el = t as HTMLElement | null;
  if (!el || !(el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text')) || el.readOnly) return null;
  return el.matches('.text-editor, .callout-editor, [data-math]') && !el.matches('.group-name-editor') ? el : null;
};

function setFieldValue(el: Field, v: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Writes the formula into the field. */
function write(s: Session) {
  const tex = s.ed.toTex();
  const wrapped = tex ? (s.display ? `$$${tex}$$` : `$${tex}$`) : '';
  const v = s.el.value;
  setFieldValue(s.el, v.slice(0, s.start) + wrapped + v.slice(s.start + s.len));
  s.len = wrapped.length;
  const at = s.start + s.len;
  s.el.setSelectionRange(at, at);
}

/** Opens the math zone on a field, at its caret. */
export function openEquation(el: Field, fresh = false) {
  if (session) closeEquation();
  const v = el.value;
  // fresh: the field holds nothing yet but its placeholder text, which the equation replaces
  const a = fresh ? 0 : (el.selectionStart ?? v.length);
  const b = fresh ? v.length : (el.selectionEnd ?? a);
  if (fresh) {
    opened++;
    session = { el, start: 0, len: v.length, ed: new EqEditor(), display: true };
    write(session);
    return emit();
  }
  const hit = mathRanges(v).find((m) => a >= m.start && b <= m.end && (a > m.start || b < m.end || a === b));
  let s: Session;
  if (hit) {
    s = { el, start: hit.start, len: hit.end - hit.start, ed: new EqEditor(hit.tex), display: hit.display };
  } else {
    const lineStart = v.lastIndexOf('\n', a - 1) + 1;
    const nl = v.indexOf('\n', b);
    const lineEnd = nl < 0 ? v.length : nl;
    // like Word, an equation alone on its line is a display equation
    const alone = !v.slice(lineStart, a).trim() && !v.slice(b, lineEnd).trim() && !(el instanceof HTMLInputElement);
    s = { el, start: a, len: b - a, ed: new EqEditor(), display: alone && a === b };
    // selected text becomes an equation, built up as if typed
    if (b > a) s.ed.paste(v.slice(a, b));
  }
  opened++;
  session = s;
  write(s);
  emit();
}

/** Leaves the math zone; the caret goes before or after the formula. */
export function closeEquation(caret: 'before' | 'after' = 'after') {
  const s = session;
  if (!s) return;
  session = null;
  s.ed.finishPending();
  if (s.el.isConnected) {
    write(s);
    const at = caret === 'before' ? s.start : s.start + s.len;
    s.el.setSelectionRange(at, at);
  }
  emit();
}

export const equationOpen = () => !!session;

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

const isEqualKey = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'Equal' || e.key === '=');

function onKeyDown(e: KeyboardEvent) {
  if (!session) {
    const el = mathField(e.target);
    if (el && isEqualKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openEquation(el);
    }
    return;
  }
  const s = session;
  if (e.target !== s.el) return;
  if (e.isComposing || e.key === 'Process' || e.key === 'Dead') return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  // copy, cut and paste go through their own events
  if (mod && !e.altKey && (k === 'c' || k === 'x' || k === 'v')) return;
  const stop = () => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const ed = s.ed;
  let res: string | undefined;
  if (isEqualKey(e)) {
    stop();
    return closeEquation();
  }
  if (mod && !e.altKey) {
    if (k === 'z' && !e.shiftKey) ed.undo();
    else if (k === 'y' || (k === 'z' && e.shiftKey)) ed.redo();
    else if (k === 'a') ed.selectAll();
    else return; // other shortcuts (save…) carry on as usual
    stop();
    write(s);
    return emit();
  }
  switch (e.key) {
    case 'Escape':
    case 'Enter':
    case 'Tab':
      stop();
      return closeEquation();
    case 'ArrowLeft':
      res = ed.moveLeft(e.shiftKey);
      break;
    case 'ArrowRight':
      res = ed.moveRight(e.shiftKey);
      break;
    case 'ArrowUp':
    case 'ArrowDown':
      ed.moveVertical(e.key === 'ArrowUp');
      break;
    case 'Home':
      ed.home(e.shiftKey);
      break;
    case 'End':
      ed.end(e.shiftKey);
      break;
    case 'Backspace':
      if (ed.isEmpty) {
        stop();
        return closeEquation();
      }
      ed.backspace();
      break;
    case 'Delete':
      ed.del();
      break;
    default:
      // AltGr arrives as Ctrl+Alt on Windows
      if (e.key.length === 1 && !e.metaKey && (!e.ctrlKey || e.altKey)) ed.type(e.key);
      else if (e.key.length !== 1) {
        if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) stop();
        return;
      }
  }
  stop();
  if (res === 'exit-left') return closeEquation('before');
  if (res === 'exit-right') return closeEquation('after');
  write(s);
  emit();
}

function onBeforeInput(e: InputEvent) {
  if (!session || e.target !== session.el) return;
  e.preventDefault();
  // typing that never came as a key (on-screen keyboards)
  if (e.data && e.inputType.startsWith('insert')) {
    session.ed.typeText(e.data);
    write(session);
    emit();
  }
}

function onClipboard(e: ClipboardEvent) {
  const s = session;
  if (!s || e.target !== s.el) return;
  e.preventDefault();
  if (e.type === 'paste') {
    const t = e.clipboardData?.getData('text/plain') ?? '';
    if (t) s.ed.paste(t);
  } else {
    const tex = s.ed.selectedTex();
    if (tex) e.clipboardData?.setData('text/plain', `$${tex}$`);
    if (e.type === 'cut') s.ed.deleteSelection();
  }
  write(s);
  emit();
}

function onFocusOut(e: FocusEvent) {
  if (session && e.target === session.el) closeEquation();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

interface Ctx {
  ed: EqEditor | null;
  display: boolean;
}

const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const md = (fn: (e: React.MouseEvent) => void) => (e: React.MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  fn(e);
};

function placeAt(ctx: Ctx, path: number[], pos: number, e: React.MouseEvent) {
  if (!ctx.ed) return;
  ctx.ed.place(path, pos, e.shiftKey);
  emit();
}

const Caret = () => <span className="eq-caret" key={`caret${tick}`} />;
const Probe = () => <span className="eq-probe" />;

function renderNode(n: MNode, row: Row, i: number, path: number[], ctx: Ctx): ReactNode {
  const at = (pos: number) => md((e) => placeAt(ctx, path, pos, e));
  const half = md((e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    placeAt(ctx, path, e.clientX < r.left + r.width / 2 ? i : i + 1, e);
  });
  const slot = (k: number, r: Row) => renderRow(r, [...path, i, k], ctx, false);
  switch (n.t) {
    case 'sym':
      return (
        <span className={`eq-s eq-${n.cls}`} onMouseDown={half}>
          {n.v}
        </span>
      );
    case 'frac':
      return (
        <span className="eq-frac" data-va="frac" onMouseDown={half}>
          <span className="eq-fnum">
            <Probe />
            {slot(0, n.num)}
          </span>
          <span className="eq-fden">{slot(1, n.den)}</span>
        </span>
      );
    case 'sqrt':
      return (
        <span className="eq-sqrt" onMouseDown={half}>
          {n.idx && <span className="eq-idx">{slot(0, n.idx)}</span>}
          <span className="eq-rad">
            <svg className="eq-rad-sign" viewBox="0 0 10 100" preserveAspectRatio="none">
              <path d="M0 62 L2.4 56 L5.6 97 L9.6 1.5 L10 1.5" />
            </svg>
            <span className="eq-rad-body">{slot(1, n.body)}</span>
          </span>
        </span>
      );
    case 'scripts': {
      const base = row[i - 1];
      const noBase = !base || base.t === 'scripts' || (base.t === 'sym' && ['bin', 'rel', 'open', 'punct', 'cmd'].includes(base.cls));
      const kind = n.sub && n.sup ? 'both' : n.sup ? 'sup' : 'sub';
      return (
        <span className="eq-scripts" onMouseDown={half}>
          {noBase && <span className="eq-ph eq-base" />}
          <span className={`eq-ss eq-ss-${kind}`}>
            {n.sup && <span className="eq-sup">{slot(1, n.sup)}</span>}
            {n.sub && <span className="eq-sub">{slot(0, n.sub)}</span>}
          </span>
        </span>
      );
    }
    case 'delim':
      return (
        <span className="eq-delim" onMouseDown={half}>
          <Fence ch={n.l} side="l" onMouseDown={at(i)} />
          {slot(0, n.body)}
          <Fence ch={n.r} side="r" onMouseDown={at(i + 1)} />
        </span>
      );
    case 'accent':
      return (
        <span className={`eq-acc eq-acc-${n.acc}`} onMouseDown={half}>
          {ACCENTS[n.acc]?.mark && n.acc !== 'vec' && <span className="eq-acc-mark">{ACCENTS[n.acc].mark}</span>}
          {n.acc === 'vec' && (
            <svg className="eq-acc-vec" viewBox="0 0 20 8" preserveAspectRatio="none">
              <path d="M0 4 H19 M15 1 L19 4 L15 7" />
            </svg>
          )}
          <span className="eq-acc-body">{slot(0, n.body)}</span>
        </span>
      );
    case 'mat':
      return (
        <span className="eq-mat" data-va="mid" style={{ gridTemplateColumns: `repeat(${n.cols}, auto)` }} onMouseDown={half}>
          {n.cells.map((c, k) => (
            <span key={k} className="eq-cell">
              {k === 0 && <Probe />}
              {slot(k, c)}
            </span>
          ))}
        </span>
      );
  }
}

const FENCES: Record<string, string> = {
  '(l': 'M8.5 1 Q1 50 8.5 99',
  ')r': 'M1.5 1 Q9 50 1.5 99',
  '[l': 'M8 1 H3 V99 H8',
  ']r': 'M2 1 H7 V99 H2',
  '{l': 'M8.5 1 Q4.5 1 4.5 9 V40 Q4.5 50 1 50 Q4.5 50 4.5 60 V91 Q4.5 99 8.5 99',
  '}r': 'M1.5 1 Q5.5 1 5.5 9 V40 Q5.5 50 9 50 Q5.5 50 5.5 60 V91 Q5.5 99 1.5 99',
  '|': 'M5 1 V99',
  '‖': 'M3 1 V99 M7 1 V99',
  '⟨l': 'M8 1 L2 50 L8 99',
  '⟩r': 'M2 1 L8 50 L2 99',
  '⌊l': 'M3 1 V99 H8',
  '⌋r': 'M7 1 V99 H2',
  '⌈l': 'M8 1 H3 V99',
  '⌉r': 'M2 1 H7 V99',
};
function Fence({ ch, side, onMouseDown }: { ch: string; side: 'l' | 'r'; onMouseDown: (e: React.MouseEvent) => void }) {
  if (!ch) return <span className={`eq-fence eq-fence-${side} eq-fence-none`} onMouseDown={onMouseDown} />;
  // a closing bracket used to open (or the other way round), e.g. ]0, 1[
  const d = FENCES[ch + side] ?? FENCES[ch] ?? FENCES[ch + (side === 'l' ? 'r' : 'l')] ?? FENCES['|'];
  return (
    <span className={`eq-fence eq-fence-${side}`} onMouseDown={onMouseDown}>
      <svg viewBox="0 0 10 100" preserveAspectRatio="none">
        <path d={d} />
      </svg>
    </span>
  );
}

function renderRow(row: Row, path: number[], ctx: Ctx, isRoot: boolean): ReactNode {
  const ed = ctx.ed;
  const here = !!ed && same(ed.path, path);
  const sel = here ? ed!.selection : null;
  const caretAt = here && !sel ? ed!.pos : -1;
  const out: ReactNode[] = [];
  if (!row.length) {
    if (caretAt === 0) out.push(<Caret key="c" />);
    out.push(isRoot ? <span key="h" className="eq-hint">Type equation here.</span> : <span key="p" className={here ? 'eq-ph eq-ph-on' : 'eq-ph'} onMouseDown={md((e) => placeAt(ctx, path, 0, e))} />);
  }
  for (let i = 0; i < row.length; i++) {
    if (caretAt === i) out.push(<Caret key={`c${i}`} />);
    const n = row[i];
    const next = row[i + 1];
    const selected = !!sel && i >= sel[0] && i < sel[1];
    let node: ReactNode;
    if (ctx.display && isLimitsBase(n) && next && next.t === 'scripts') {
      // ∑, lim…: limits under and over in a display equation
      const sp = [...path, i + 1];
      const lim = (k: 0 | 1, r: Row | null) => (r ? renderRow(r, [...sp, k], ctx, false) : <span className="eq-lim-none" />);
      node = (
        <span className="eq-lim" data-va="lim">
          <span className="eq-lim-top">
            <Probe />
            {lim(1, next.sup)}
          </span>
          <span className="eq-lim-mid">
            <Probe />
            {renderNode(n, row, i, path, ctx)}
            {caretAt === i + 1 && <Caret />}
          </span>
          <span className="eq-lim-bot">{lim(0, next.sub)}</span>
        </span>
      );
      const both = !!sel && i + 1 >= sel[0] && i + 1 < sel[1];
      out.push(
        <span key={i} className={selected || both ? 'eq-sel' : undefined}>
          {node}
        </span>,
      );
      i++;
      continue;
    }
    node = renderNode(n, row, i, path, ctx);
    out.push(
      selected ? (
        <span key={i} className="eq-sel">
          {node}
        </span>
      ) : (
        <span key={i} className="eq-n">
          {node}
        </span>
      ),
    );
  }
  if (row.length && caretAt === row.length) out.push(<Caret key="ce" />);
  return (
    <span className={isRoot ? 'eq-row eq-root' : 'eq-row'} onMouseDown={md((e) => placeAt(ctx, path, row.length, e))}>
      {out}
    </span>
  );
}

/** Puts fractions' bars and limits' operators on the maths axis (CSS alone can't pick the baseline). */
function useMathLayout(ref: React.RefObject<HTMLElement>) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>('[data-va]')].reverse();
    for (const el of els) {
      const kind = el.dataset.va;
      const first = el.querySelector(':scope > * > .eq-probe') as HTMLElement | null;
      if (!first) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
      const base = first.getBoundingClientRect().bottom;
      let delta = 0;
      if (kind === 'frac') delta = (el.firstElementChild as HTMLElement).getBoundingClientRect().bottom + 0.27 * fs - base;
      else if (kind === 'lim') delta = ((el.children[1] as HTMLElement).querySelector(':scope > .eq-probe') as HTMLElement).getBoundingClientRect().bottom - base;
      else {
        const r = el.getBoundingClientRect();
        delta = r.top + r.height / 2 + 0.27 * fs - base;
      }
      el.style.verticalAlign = `${delta.toFixed(2)}px`;
    }
  });
}

/** An equation drawn as it is edited (also used for the ribbon's previews). */
export function MathView({ row, ed, display }: { row: Row; ed?: EqEditor | null; display: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useMathLayout(ref);
  return (
    <span ref={ref} className={display ? 'eq-view eq-display' : 'eq-view'}>
      {renderRow(row, [], { ed: ed ?? null, display }, !!ed)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Ribbon (Equation tab)                                               */
/* ------------------------------------------------------------------ */

const S = (s: string): MNode => (lookupSym(s) ? { t: 'sym', ...lookupSym(s)! } : charSym(s));
const txt = (s: string): Row => [...s].map(charSym);
const frac = (num: Row = [], den: Row = []): MNode => ({ t: 'frac', num, den });
const sc = (sub: Row | null, sup: Row | null): MNode => ({ t: 'scripts', sub, sup });
const dl = (l: string, r: string, body: Row = []): MNode => ({ t: 'delim', l, r, body });
const mat = (rows: number, cols: number): MNode => ({ t: 'mat', cols, cells: Array.from({ length: rows * cols }, () => []) });

interface Item {
  label: string;
  nodes: MNode[];
}
interface Group {
  id: string;
  label: string;
  icon: MNode[];
  items: Item[];
}

const STRUCTURES: Group[] = [
  {
    id: 'frac',
    label: 'Fraction',
    icon: [frac(txt('x'), txt('y'))],
    items: [
      { label: 'Stacked fraction', nodes: [frac()] },
      { label: 'Linear fraction', nodes: [charSym('/')] },
      { label: 'dy over dx', nodes: [frac(txt('dy'), txt('dx'))] },
      { label: 'Partial differential', nodes: [frac([S('partial'), charSym('y')], [S('partial'), charSym('x')])] },
      { label: 'One half', nodes: [frac(txt('1'), txt('2'))] },
      { label: 'Delta y over delta x', nodes: [frac([S('Delta'), charSym('y')], [S('Delta'), charSym('x')])] },
    ],
  },
  {
    id: 'script',
    label: 'Script',
    icon: [charSym('e'), sc(null, txt('x'))],
    items: [
      { label: 'Superscript', nodes: [sc(null, [])] },
      { label: 'Subscript', nodes: [sc([], null)] },
      { label: 'Subscript-superscript', nodes: [sc([], [])] },
      { label: 'x squared', nodes: [charSym('x'), sc(null, txt('2'))] },
      { label: 'x sub n', nodes: [charSym('x'), sc(txt('n'), null)] },
      { label: 'e to the minus i omega t', nodes: [charSym('e'), sc(null, [charSym('-'), charSym('j'), S('omega'), charSym('t')])] },
    ],
  },
  {
    id: 'radical',
    label: 'Radical',
    icon: [{ t: 'sqrt', idx: txt('n'), body: txt('x') }],
    items: [
      { label: 'Square root', nodes: [{ t: 'sqrt', idx: null, body: [] }] },
      { label: 'Radical with degree', nodes: [{ t: 'sqrt', idx: [], body: [] }] },
      { label: 'Cube root', nodes: [{ t: 'sqrt', idx: txt('3'), body: [] }] },
      { label: 'Quadratic formula', nodes: [frac([charSym('-'), charSym('b'), S('pm'), { t: 'sqrt', idx: null, body: [charSym('b'), sc(null, txt('2')), charSym('-'), ...txt('4ac')] }], txt('2a'))] },
    ],
  },
  {
    id: 'integral',
    label: 'Integral',
    icon: [S('int'), sc(txt('a'), txt('b'))],
    items: [
      { label: 'Integral', nodes: [S('int')] },
      { label: 'Integral with limits', nodes: [S('int'), sc([], [])] },
      { label: 'Double integral', nodes: [S('iint')] },
      { label: 'Triple integral', nodes: [S('iiint')] },
      { label: 'Contour integral', nodes: [S('oint')] },
      { label: 'Contour integral with limit', nodes: [S('oint'), sc([], null)] },
      { label: 'Differential dx', nodes: [charSym('d'), charSym('x')] },
    ],
  },
  {
    id: 'large',
    label: 'Large Operator',
    icon: [S('sum'), sc(txt('i'), txt('n'))],
    items: [
      { label: 'Summation', nodes: [S('sum')] },
      { label: 'Summation with limits', nodes: [S('sum'), sc([], [])] },
      { label: 'Sum from i = 1 to n', nodes: [S('sum'), sc(txt('i=1'), txt('n'))] },
      { label: 'Product', nodes: [S('prod')] },
      { label: 'Product with limits', nodes: [S('prod'), sc([], [])] },
      { label: 'Union', nodes: [S('bigcup'), sc([], [])] },
      { label: 'Intersection', nodes: [S('bigcap'), sc([], [])] },
    ],
  },
  {
    id: 'bracket',
    label: 'Bracket',
    icon: [dl('{', '}', [dl('(', ')', [])])],
    items: [
      { label: 'Parentheses', nodes: [dl('(', ')')] },
      { label: 'Brackets', nodes: [dl('[', ']')] },
      { label: 'Braces', nodes: [dl('{', '}')] },
      { label: 'Angle brackets', nodes: [dl('⟨', '⟩')] },
      { label: 'Absolute value', nodes: [dl('|', '|')] },
      { label: 'Norm', nodes: [dl('‖', '‖')] },
      { label: 'Floor', nodes: [dl('⌊', '⌋')] },
      { label: 'Ceiling', nodes: [dl('⌈', '⌉')] },
      { label: 'Half-open interval', nodes: [dl('[', ')')] },
    ],
  },
  {
    id: 'function',
    label: 'Function',
    icon: [fnSym('sin'), S('theta')],
    items: ['sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan', 'exp'].map((f) => ({ label: f, nodes: [fnSym(f)] })),
  },
  {
    id: 'accent',
    label: 'Accent',
    icon: [{ t: 'accent', acc: 'ddot', body: txt('a') }],
    items: [
      { label: 'Dot', nodes: [{ t: 'accent', acc: 'dot', body: [] }] },
      { label: 'Double dot', nodes: [{ t: 'accent', acc: 'ddot', body: [] }] },
      { label: 'Hat', nodes: [{ t: 'accent', acc: 'hat', body: [] }] },
      { label: 'Check', nodes: [{ t: 'accent', acc: 'check', body: [] }] },
      { label: 'Tilde', nodes: [{ t: 'accent', acc: 'tilde', body: [] }] },
      { label: 'Bar', nodes: [{ t: 'accent', acc: 'bar', body: [] }] },
      { label: 'Vector', nodes: [{ t: 'accent', acc: 'vec', body: [] }] },
      { label: 'Overbar', nodes: [{ t: 'accent', acc: 'overline', body: [] }] },
      { label: 'Underbar', nodes: [{ t: 'accent', acc: 'underline', body: [] }] },
    ],
  },
  {
    id: 'limit',
    label: 'Limit and Log',
    icon: [fnSym('lim'), sc([charSym('n'), S('to'), S('infty')], null)],
    items: [
      { label: 'Limit', nodes: [fnSym('lim'), sc([], null)] },
      { label: 'Limit as n → ∞', nodes: [fnSym('lim'), sc([charSym('n'), S('to'), S('infty')], null)] },
      { label: 'Logarithm', nodes: [fnSym('log'), sc([], null)] },
      { label: 'Log', nodes: [fnSym('log')] },
      { label: 'Natural log', nodes: [fnSym('ln')] },
      { label: 'Maximum', nodes: [fnSym('max'), sc([], null)] },
      { label: 'Minimum', nodes: [fnSym('min'), sc([], null)] },
    ],
  },
  {
    id: 'matrix',
    label: 'Matrix',
    icon: [dl('[', ']', [mat(2, 2)])],
    items: [
      { label: '1×2 empty matrix', nodes: [mat(1, 2)] },
      { label: '2×1 empty matrix', nodes: [mat(2, 1)] },
      { label: '2×2 empty matrix', nodes: [mat(2, 2)] },
      { label: '3×3 empty matrix', nodes: [mat(3, 3)] },
      { label: '2×2 matrix in parentheses', nodes: [dl('(', ')', [mat(2, 2)])] },
      { label: '2×2 matrix in brackets', nodes: [dl('[', ']', [mat(2, 2)])] },
      { label: 'Determinant', nodes: [dl('|', '|', [mat(2, 2)])] },
      { label: '3×3 matrix in brackets', nodes: [dl('[', ']', [mat(3, 3)])] },
    ],
  },
];

const SYMBOL_SETS: { label: string; names: string[] }[] = [
  {
    label: 'Basic Math',
    names: '± ∞ = ≠ ∼ × ÷ ! ∝ < ≪ > ≫ ≤ ≥ ∓ ≅ ≈ ≡ ∀ ∁ ∂ √ ∪ ∩ ∅ % ° ℉ ℃ Δ ∇ ∃ ∄ ∈ ∋ ← ↑ → ↓ ↔ ∴ ∵ + − ¬ α β γ δ ε θ λ μ π ρ σ τ φ ω Ω ∗ ∙ ⋮ ⋯ ⋱ ℵ ∎'.split(' '),
  },
  { label: 'Greek Letters', names: 'α β γ δ ϵ ε ζ η θ ϑ ι κ λ μ ν ξ ο π ϖ ρ ϱ σ ς τ υ ϕ φ χ ψ ω Γ Δ Θ Λ Ξ Π Σ Υ Φ Ψ Ω'.split(' ') },
  { label: 'Letter-Like Symbols', names: 'ℏ ℓ ℜ ℑ ℘ ∂ ∇ ℂ ℕ ℚ ℝ ℤ ° ′ Å ℧ ∅ ℵ ℶ † ∠'.split(' ') },
  { label: 'Operators', names: '+ − ± ∓ × ÷ ⋅ ∘ ∗ ⋆ ⊕ ⊖ ⊗ ⊙ ∧ ∨ ∩ ∪ ∖ ⊂ ⊃ ⊆ ⊇ ∈ ∉ ∋ ≤ ≥ ≠ ≈ ≡ ≅ ∼ ≃ ∝ ⊥ ∥ ≪ ≫ ≔ ≜ ≐ ≺ ≻'.split(' ') },
  { label: 'Arrows', names: '← → ↑ ↓ ↔ ↕ ⇐ ⇒ ⇑ ⇓ ⇔ ⇕ ↦ ⟵ ⟶ ⟸ ⟹ ⟺ ↗ ↘ ↙ ↖ ⇌ ⇄ ↩ ↪'.split(' ') },
];
const symbolNode = (ch: string): MNode => (ch === '√' ? { t: 'sqrt', idx: null, body: [] } : ch === '℃' ? S('celsius') : ch === '℉' ? S('fahrenheit') : ch === 'Å' ? S('Angstrom') : ch === '°' ? S('degree') : ch === 'ℂ' ? S('C') : ch === 'ℕ' ? S('N') : ch === 'ℚ' ? S('Q') : ch === 'ℝ' ? S('R') : ch === 'ℤ' ? S('Z') : ch === 'Ω' ? S('Omega') : charSym(ch));

function insert(nodes: MNode[]) {
  const s = session;
  if (!s) return;
  s.ed.insertTemplate(nodes);
  write(s);
  emit();
}

function Ribbon() {
  const [open, setOpen] = useState<string | null>(null);
  const [set, setSet] = useState(0);
  const [more, setMore] = useState(false);
  const [setsOpen, setSetsOpen] = useState(false);
  const symbols = SYMBOL_SETS[set];
  return (
    <div className="eq-ribbon">
      <div className="eq-ribbon-tab">Equation</div>
      <div className="eq-ribbon-body">
        <div className="eq-group">
          <div className={more ? 'eq-symbols eq-symbols-more' : 'eq-symbols'}>
            {symbols.names.map((ch) => (
              <button key={ch} className="eq-symbol" title={ch} onMouseDown={md(() => insert([symbolNode(ch)]))}>
                {ch}
              </button>
            ))}
          </div>
          <div className="eq-symbols-side">
            <button className="eq-set" onMouseDown={md(() => setSetsOpen(!setsOpen))}>
              {symbols.label} ▾
            </button>
            {setsOpen && (
              <div className="eq-menu eq-sets">
                {SYMBOL_SETS.map((x, k) => (
                  <button
                    key={x.label}
                    className={k === set ? 'on' : undefined}
                    onMouseDown={md(() => {
                      setSet(k);
                      setSetsOpen(false);
                    })}
                  >
                    {x.label}
                  </button>
                ))}
              </div>
            )}
            <button className="eq-more" title={more ? 'Fewer' : 'More'} onMouseDown={md(() => setMore(!more))}>
              {more ? '▴' : '▾'}
            </button>
          </div>
          <div className="eq-group-label">Symbols</div>
        </div>
        <div className="eq-group">
          <div className="eq-structs">
            {STRUCTURES.map((g) => (
              <div key={g.id} className="eq-struct-wrap">
                <button className={open === g.id ? 'eq-struct on' : 'eq-struct'} onMouseDown={md(() => setOpen(open === g.id ? null : g.id))}>
                  <span className="eq-struct-icon">
                    <MathView row={g.icon} display={g.id === 'large'} />
                  </span>
                  <span className="eq-struct-label">
                    {g.label} <span className="eq-caretdown">▾</span>
                  </span>
                </button>
                {open === g.id && (
                  <div className="eq-gallery">
                    <div className="eq-gallery-title">{g.label}</div>
                    <div className="eq-gallery-grid">
                      {g.items.map((it) => (
                        <button
                          key={it.label}
                          className="eq-gallery-item"
                          title={it.label}
                          onMouseDown={md(() => {
                            insert(it.nodes);
                            setOpen(null);
                          })}
                        >
                          <MathView row={it.nodes} display />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="eq-group-label">Structures</div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Host                                                                */
/* ------------------------------------------------------------------ */

function Zone({ s }: { s: Session }) {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const place = useRef<{ below: boolean; left: number } | null>(null);
  const fieldSize = parseFloat(getComputedStyle(s.el).fontSize) || 16;
  const size = Math.max(17, Math.min(30, fieldSize * 1.1));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = s.el.getBoundingClientRect();
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    // the side (below or above the field) and the left edge are picked once, so the zone
    // doesn't hop about as the field grows while typing
    if (!place.current) {
      const below = r.bottom + 8 + h <= window.innerHeight - 8 || r.top - h - 8 < 8;
      place.current = { below, left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) };
    }
    const top = place.current.below ? r.bottom + 8 : r.top - h - 8;
    const left = Math.max(8, Math.min(place.current.left, window.innerWidth - w - 8));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  });
  const toggleDisplay = () => {
    s.display = !s.display;
    write(s);
    setMenu(false);
    emit();
  };
  const asLatex = () => {
    const sess = s;
    setMenu(false);
    closeEquation();
    // select the LaTeX between the dollars, to edit it as text
    const open = sess.display ? 2 : 1;
    if (sess.len) sess.el.setSelectionRange(sess.start + open, sess.start + sess.len - open);
  };
  return (
    <div ref={ref} className="eq-pop" onMouseDown={md(() => setMenu(false))}>
      <Ribbon />
      <div className={s.display ? 'eq-zone eq-zone-display' : 'eq-zone'}>
        <span className="eq-handle" title="Equation">
          ⋮⋮
        </span>
        <div className="eq-content" style={{ fontSize: size }} onMouseDown={md(() => (s.ed.end(), emit()))}>
          <MathView row={s.ed.root} ed={s.ed} display={s.display} />
        </div>
        <button className="eq-options" title="Equation Options" onMouseDown={md(() => setMenu(!menu))}>
          ▾
        </button>
        {menu && (
          <div className="eq-menu" onMouseDown={(e) => e.stopPropagation()}>
            <button onMouseDown={md(toggleDisplay)}>{s.display ? 'Change to Inline' : 'Change to Display'}</button>
            <button onMouseDown={md(asLatex)}>Edit as LaTeX</button>
            <div className="eq-menu-sep" />
            <button onMouseDown={md(() => closeEquation())}>Done (Enter)</button>
          </div>
        )}
      </div>
      <div className="eq-help">
        <b>\name</b> + Space: symbol (\Omega → Ω) · <b>_</b> / <b>^</b>: sub/superscript, Space leaves · <b>/</b>: fraction · <b>Enter</b>: done
      </div>
    </div>
  );
}

/** Mount once: listens for Alt+= in maths fields and draws the open math zone. */
export function EquationHost() {
  useSyncExternalStore(subscribe, () => tick);
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('beforeinput', onBeforeInput as EventListener, true);
    window.addEventListener('paste', onClipboard, true);
    window.addEventListener('copy', onClipboard, true);
    window.addEventListener('cut', onClipboard, true);
    window.addEventListener('focusout', onFocusOut, true);
    // the field can go away without losing focus first (its editor closed)
    const t = setInterval(() => session && !session.el.isConnected && closeEquation(), 500);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('beforeinput', onBeforeInput as EventListener, true);
      window.removeEventListener('paste', onClipboard, true);
      window.removeEventListener('copy', onClipboard, true);
      window.removeEventListener('cut', onClipboard, true);
      window.removeEventListener('focusout', onFocusOut, true);
      clearInterval(t);
    };
  }, []);
  const s = session;
  if (!s) return null;
  return createPortal(<Zone key={opened} s={s} />, document.body);
}

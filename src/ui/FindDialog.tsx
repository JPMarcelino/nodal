import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, Spline, Tag, Type, X } from 'lucide-react';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import type { SymbolDef } from '../model/types';
import { matchRanges, queryWords } from './paletteSearch';
import { computeNets } from '../model/netlist';
import { instanceSymbol } from '../model/registry';
import * as A from '../store/actions';
import { docPages, itemPage, multiPage } from '../model/pages';
import { goToItems, select, set, useStore } from '../store/store';
import { Modal } from './Dialogs';

interface Hit {
  key: string;
  kind: 'Part' | 'Label' | 'Net' | 'Text' | 'Wire';
  label: string;
  meta: string;
  ids: string[];
  /** Wires to highlight (nets). */
  net?: string[];
  /** The part's drawing, for its thumbnail. */
  def?: SymbolDef;
}

const KIND_ICON: Record<Exclude<Hit['kind'], 'Part'>, ReactNode> = {
  Label: <Tag size={14} />,
  Net: <Spline size={14} />,
  Wire: <Tag size={14} />,
  Text: <Type size={14} />,
};

function Marked({ text, words }: { text: string; words: string[] }) {
  const ranges = matchRanges(text, words);
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

const close = () => set({ dialog: null });

/** Find (Ctrl+F): parts by reference, value or any field, nets, labels and text; Enter shows the match. */
export function FindDialog() {
  const doc = useStore((s) => s.doc);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // the keyboard moves the highlight; a pointer only takes it over once it actually moves
  const pointerMoved = useRef(false);

  const all = useMemo<Hit[]>(() => {
    const out: Hit[] = [];
    for (const it of Object.values(doc.items)) {
      if (it.type === 'component') {
        const def = instanceSymbol(doc, it);
        const fields = Object.values(it.props).filter(Boolean).join(' · ');
        if (def.valueIsLabel || def.prefix.startsWith('#')) {
          if (it.value) out.push({ key: it.id, kind: 'Label', label: it.value, meta: def.name, ids: [it.id], def });
          continue;
        }
        out.push({ key: it.id, kind: 'Part', label: [it.ref, it.value].filter(Boolean).join('  '), meta: [def.name, fields].filter(Boolean).join(' · '), ids: [it.id], def });
      } else if (it.type === 'shape' && it.text?.trim()) {
        out.push({ key: it.id, kind: 'Text', label: it.text.trim().replace(/\s+/g, ' '), meta: it.kind === 'text' ? 'Text' : `${it.kind} title`, ids: [it.id] });
      } else if (it.type === 'wire' && it.label?.trim()) {
        out.push({ key: it.id, kind: 'Wire', label: it.label.trim(), meta: 'Wire label', ids: [it.id] });
      }
    }
    for (const n of computeNets(doc)) {
      if (!n.wires.length && n.pins.length < 2) continue;
      const pins = n.pins.map((p) => `${p.ref}.${p.portName}`).join(' ');
      out.push({ key: `net:${n.name}`, kind: 'Net', label: n.name, meta: `${n.pins.length} pin${n.pins.length === 1 ? '' : 's'}${pins ? ` · ${pins}` : ''}`, ids: n.wires, net: n.wires });
    }
    // with several pages, say which page each hit is on (Find searches them all)
    if (multiPage(doc)) {
      const names = new Map(docPages(doc).map((p) => [p.id, p.name]));
      for (const h of out) {
        const pages = [...new Set(h.ids.flatMap((id) => (doc.items[id] ? [itemPage(doc, doc.items[id])] : [])))];
        if (pages.length) h.meta = [h.meta, pages.map((p) => names.get(p)).join(', ')].filter(Boolean).join(' · ');
      }
    }
    const order = { Part: 0, Label: 1, Net: 2, Wire: 3, Text: 4 };
    return out.sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label, undefined, { numeric: true }));
  }, [doc]);

  const words = useMemo(() => queryWords(q), [q]);
  const hits = useMemo(() => {
    if (!words.length) return all.slice(0, 200);
    const scored = all
      .map((h) => {
        const hay = `${h.kind} ${h.label} ${h.meta}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) return null;
        // exact reference / net name first, then prefix matches
        const lab = h.label.toLowerCase();
        const score = lab === words.join(' ') || lab.split(/\s+/)[0] === words[0] ? 0 : lab.startsWith(words[0]) ? 1 : 2;
        return { h, score };
      })
      .filter((x): x is { h: Hit; score: number } => !!x);
    return scored.sort((a, b) => a.score - b.score).map((x) => x.h).slice(0, 200);
  }, [all, words]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const go = (h: Hit | undefined) => {
    if (!h) return;
    close();
    // a hit on another page switches to it first
    const ids = h.ids.length ? goToItems(h.ids) : [];
    select(ids);
    set({ highlight: h.net ? new Set(h.net) : null });
    A.revealItems(ids);
  };

  return (
    <Modal onClose={close} width={640} className="palette" closeFromInput ariaLabel="Find">
      <div className="palette-search">
        <Search size={17} />
        <input
          className="palette-input"
          autoFocus
          placeholder="Find a part, value, net, label or text — “R12”, “10k”, “GND”…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              pointerMoved.current = false;
              setIdx((i) => Math.min(hits.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              pointerMoved.current = false;
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') go(hits[idx]);
          }}
        />
        {q && (
          <button className="palette-clear" onClick={() => setQ('')} aria-label="Clear search">
            <X size={14} />
          </button>
        )}
      </div>
      <div className="palette-list" ref={listRef} onPointerMove={() => (pointerMoved.current = true)}>
        {hits.map((h, i) => (
          <button key={h.key} className={i === idx ? 'palette-item active' : 'palette-item'} onMouseEnter={() => pointerMoved.current && setIdx(i)} onClick={() => go(h)}>
            <span className={h.def ? 'palette-icon sym' : 'palette-icon'}>{h.def ? <SymbolPreview def={h.def} size={26} pad={2} /> : h.kind !== 'Part' && KIND_ICON[h.kind]}</span>
            <span className="palette-label">
              <Marked text={h.label} words={words} />
            </span>
            <span className="palette-meta">{h.meta}</span>
            <span className="palette-kind">{h.kind}</span>
          </button>
        ))}
        {!hits.length && (
          <div className="palette-empty">
            <Search size={22} />
            <div>{all.length ? `Nothing matches “${q.trim()}”` : 'The circuit is empty'}</div>
            {all.length > 0 && <div className="small muted">Search by reference (R12), value (10k), net (GND), label or any text.</div>}
          </div>
        )}
      </div>
      <div className="palette-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move
        </span>
        <span>
          <kbd>↵</kbd> to show it
        </span>
        <span>
          <kbd>Esc</kbd> to close
        </span>
        <span className="grow" />
        <span className="muted">
          {hits.length} of {all.length}
        </span>
      </div>
    </Modal>
  );
}

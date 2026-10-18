import { useEffect, useMemo, useRef, useState } from 'react';
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
}

const close = () => set({ dialog: null });

/** Find (Ctrl+F): parts by reference, value or any field, nets, labels and text; Enter shows the match. */
export function FindDialog() {
  const doc = useStore((s) => s.doc);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const all = useMemo<Hit[]>(() => {
    const out: Hit[] = [];
    for (const it of Object.values(doc.items)) {
      if (it.type === 'component') {
        const def = instanceSymbol(doc, it);
        const fields = Object.values(it.props).filter(Boolean).join(' · ');
        if (def.valueIsLabel || def.prefix.startsWith('#')) {
          if (it.value) out.push({ key: it.id, kind: 'Label', label: it.value, meta: def.name, ids: [it.id] });
          continue;
        }
        out.push({ key: it.id, kind: 'Part', label: [it.ref, it.value].filter(Boolean).join('  '), meta: [def.name, fields].filter(Boolean).join(' · '), ids: [it.id] });
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

  const hits = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
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
  }, [all, q]);

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
    <Modal onClose={close} width={600} className="palette">
      <input
        className="palette-input"
        autoFocus
        placeholder="Find a part, value, net, label or text (e.g. “R12”, “10k”, “GND”)…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIdx((i) => Math.min(hits.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIdx((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter') go(hits[idx]);
        }}
      />
      <div className="palette-list" ref={listRef}>
        {hits.map((h, i) => (
          <button key={h.key} className={i === idx ? 'palette-item active' : 'palette-item'} onMouseEnter={() => setIdx(i)} onClick={() => go(h)}>
            <span className={h.kind === 'Part' ? 'palette-cat sym' : 'palette-cat'}>{h.kind}</span>
            <span className="palette-label">{h.label}</span>
            <span className="palette-meta">{h.meta}</span>
          </button>
        ))}
        {!hits.length && <div className="empty-note">{all.length ? 'No matches' : 'The circuit is empty'}</div>}
      </div>
    </Modal>
  );
}

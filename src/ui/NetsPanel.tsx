import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { computeNets, netPages, type Net } from '../model/netlist';
import { docPages, multiPage } from '../model/pages';
import * as A from '../store/actions';
import { goToItems, select, set, useStore } from '../store/store';

interface Row {
  net: Net;
  pages: { id: string; name: string; n: number }[];
}

/** Every net in the whole circuit, with its pin and wire counts and the pages it spans. */
export function NetsPanel() {
  const doc = useStore((s) => s.doc);
  // recompute once edits settle, like CheckPanel: not on every drag frame
  const [settled, setSettled] = useState(doc);
  useEffect(() => {
    if (doc === settled) return;
    const t = setTimeout(() => setSettled(doc), 250);
    return () => clearTimeout(t);
  }, [doc, settled]);
  const nets = useMemo(() => computeNets(settled), [settled]);
  const pages = useMemo(() => docPages(settled), [settled]);
  const multi = multiPage(settled);
  const [q, setQ] = useState('');

  const rows = useMemo<Row[]>(() => {
    const at = new Map(pages.map((p, i) => [p.id, { id: p.id, name: p.name, n: i + 1 }]));
    return nets
      .filter((n) => n.wires.length || n.pins.length)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((net) => ({
        net,
        pages: netPages(settled, net).flatMap((id) => {
          const page = at.get(id);
          return page ? [page] : [];
        }),
      }));
  }, [nets, settled, pages]);

  const query = q.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!query) return rows;
    const words = query.split(/\s+/);
    return rows.filter(({ net, pages: on }) => {
      const hay = [net.name, ...net.names, ...net.pins.flatMap((p) => [p.ref, p.portName]), ...on.map((p) => p.name)].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [rows, query]);

  const open = (net: Net) => {
    const here = goToItems([...net.wires, ...net.pins.map((p) => p.comp)]);
    select(here);
    set({ highlight: net.wires.length ? new Set(net.wires) : null });
    A.revealItems(here);
  };

  return (
    <div className="layers">
      <div className="search">
        <Search size={14} />
        <input
          placeholder="Search nets, pins and pages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQ('');
              (e.target as HTMLElement).blur();
            }
          }}
        />
        {q && (
          <button className="clear" onClick={() => setQ('')} title="Clear search">
            <X size={13} />
          </button>
        )}
      </div>
      <div className="lib-scroll">
        {shown.map(({ net, pages: on }) => (
          <button key={`${net.name}:${net.wires[0] ?? net.pins[0]?.comp ?? ''}`} className="layer-row net-row" onClick={() => open(net)} title="Select this net and show it">
            <span className="layer-name">{net.name}</span>
            <span className="layer-tag" title="Pins">
              {net.pins.length} pin{net.pins.length === 1 ? '' : 's'}
            </span>
            <span className="layer-tag" title="Wires">
              {net.wires.length} wire{net.wires.length === 1 ? '' : 's'}
            </span>
            {multi &&
              on.map((page) => (
                <span key={page.id} className="layer-tag" title={page.name}>
                  {page.n}
                </span>
              ))}
          </button>
        ))}
        {!shown.length && (
          <div className="empty-note">
            {query ? `No nets match “${q.trim()}”.` : 'No nets yet. Wires, labels and part pins make nets.'}
          </div>
        )}
      </div>
      <div className="layer-foot muted small">Click a net to select and show it{multi ? ' · badges are page numbers' : ''}</div>
    </div>
  );
}

import { Pencil, Search, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { computeNets, netItemsOnPage, netPages, type Net } from '../model/netlist';
import { docPages, multiPage } from '../model/pages';
import * as A from '../store/actions';
import { activePage, goToItems, readOnly, select, set, setPage, useStore } from '../store/store';
import { useSettledDoc } from './useSettledDoc';

interface Row {
  net: Net;
  pages: { id: string; name: string; n: number }[];
}

const rowKey = (net: Net) => `${net.name}:${net.wires[0] ?? net.pins[0]?.comp ?? ''}`;

/** Every net in the whole circuit, with its pin and wire counts and the pages it spans. */
export function NetsPanel() {
  // clicks act on the live document; the list itself recomputes once edits settle
  const doc = useStore((s) => s.doc);
  const settled = useSettledDoc();
  const nets = useMemo(() => computeNets(settled), [settled]);
  const pages = useMemo(() => docPages(settled), [settled]);
  const multi = multiPage(settled);
  const [q, setQ] = useState('');
  const canEdit = useStore((s) => !readOnly(s));
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const cancelRename = useRef(false);

  const startRename = (key: string, name: string) => {
    cancelRename.current = false;
    setEditing({ key, value: name });
  };

  const commitRename = (from: string, value: string) => {
    setEditing(null);
    const to = value.trim();
    if (to && to !== from) void A.renameNet(from, to);
  };

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

  const open = (net: Net, page?: string) => {
    let here: string[];
    if (page) {
      if (!docPages(doc).some((p) => p.id === page)) return;
      setPage(page);
      if (activePage() !== page) return;
      here = netItemsOnPage(doc, net, page);
    } else {
      here = goToItems([...net.wires, ...net.pins.map((p) => p.comp)]);
    }
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
        {shown.map(({ net, pages: on }) => {
          const key = rowKey(net);
          const editingHere = editing?.key === key;
          return (
            <div key={key} className="layer-row net-row">
              {editingHere ? (
                <input
                  className="net-rename-input"
                  value={editing.value}
                  autoFocus
                  aria-label={`Rename net ${net.name}`}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setEditing({ key, value: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelRename.current = true;
                      setEditing(null);
                    }
                  }}
                  onBlur={(e) => {
                    if (cancelRename.current) {
                      cancelRename.current = false;
                      return;
                    }
                    commitRename(net.name, e.currentTarget.value);
                  }}
                />
              ) : (
                <button type="button" className="net-row-main" onClick={() => open(net)} title="Select this net and show it">
                  <span className="layer-name">{net.name}</span>
                  <span className="layer-tag" title="Pins">
                    {net.pins.length} pin{net.pins.length === 1 ? '' : 's'}
                  </span>
                  <span className="layer-tag" title="Wires">
                    {net.wires.length} wire{net.wires.length === 1 ? '' : 's'}
                  </span>
                </button>
              )}
              {!editingHere && canEdit && net.names.length === 1 && (
                <button
                  type="button"
                  className="net-rename layer-act"
                  title={`Rename net “${net.name}”`}
                  aria-label={`Rename net ${net.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(key, net.name);
                  }}
                >
                  <Pencil size={12} />
                </button>
              )}
              {multi &&
                on.map((page) => (
                  <button
                    key={page.id}
                    type="button"
                    className="layer-tag net-page"
                    title={`Show page ${page.n}: ${page.name}`}
                    aria-label={`Show page ${page.n}: ${page.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      open(net, page.id);
                    }}
                  >
                    {page.n}
                  </button>
                ))}
            </div>
          );
        })}
        {!shown.length && (
          <div className="empty-note">
            {query ? `No nets match “${q.trim()}”.` : 'No nets yet. Wires, labels and part pins make nets.'}
          </div>
        )}
      </div>
      <div className="layer-foot muted small">Click a net to select and show it{multi ? ' · page numbers open that page' : ''}</div>
    </div>
  );
}

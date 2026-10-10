import { ChevronDown, ChevronRight, Eye, EyeOff, Lock, LockOpen, Pencil, Plus, Search, Star, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { computeNets } from '../model/netlist';
import { getSymbol } from '../model/registry';
import { BUILTIN_SYMBOLS, CATEGORY_ORDER } from '../model/symbols';
import type { CircuitDoc, Item, SymbolDef } from '../model/types';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import * as A from '../store/actions';
import { S, deleteUserSymbol, mutate, select, set, toggleFavorite, useStore } from '../store/store';

function Tile({ def }: { def: SymbolDef }) {
  const fav = useStore((s) => s.favorites.includes(def.id));
  const placing = useStore((s) => s.placing?.symbol === def.id);
  return (
    <div
      className={placing ? 'tile active' : 'tile'}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-nodal-symbol', def.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => A.startPlacing(def.id)}
      onDoubleClick={() => {
        set({ placing: null });
        A.placeAtCenter(def.id);
      }}
      title={`${def.name}${def.value ? ` — ${def.value}` : ''}\nClick to place · drag onto canvas · double-click to drop in view centre`}
    >
      <SymbolPreview def={def} size={44} />
      <span className="tile-name">{def.name}</span>
      <button
        className={fav ? 'tile-fav on' : 'tile-fav'}
        onClick={(e) => {
          e.stopPropagation();
          toggleFavorite(def.id);
        }}
        title={fav ? 'Remove from favourites' : 'Add to favourites'}
      >
        <Star size={11} fill={fav ? 'currentColor' : 'none'} />
      </button>
      {def.custom && (
        <span className="tile-actions">
          <button
            title="Edit symbol"
            onClick={(e) => {
              e.stopPropagation();
              set({ dialog: 'symbol-editor', editingSymbol: def.id });
            }}
          >
            <Pencil size={11} />
          </button>
          <button
            title="Delete from my library"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete "${def.name}" from your library? Circuits that use it keep their copy.`)) deleteUserSymbol(def.id);
            }}
          >
            <Trash2 size={11} />
          </button>
        </span>
      )}
    </div>
  );
}

function Category({ name, defs, defaultOpen = true }: { name: string; defs: SymbolDef[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!defs.length) return null;
  return (
    <div className="lib-cat">
      <button className="lib-cat-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{name}</span>
        <span className="count">{defs.length}</span>
      </button>
      {open && (
        <div className="tiles">
          {defs.map((d) => (
            <Tile key={d.id} def={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function score(def: SymbolDef, q: string) {
  const name = def.name.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (def.id.includes(q)) return 50;
  if (def.prefix.toLowerCase() === q) return 45;
  if ((def.keywords ?? '').toLowerCase().includes(q)) return 40;
  if (def.category.toLowerCase().includes(q)) return 20;
  return 0;
}

function Library() {
  const [q, setQ] = useState('');
  const userLib = useStore((s) => s.userLibrary);
  const favorites = useStore((s) => s.favorites);
  const recent = useStore((s) => s.recent);
  const docSymbols = useStore((s) => s.doc.symbols);
  const all = useMemo(() => {
    const user = Object.values(userLib);
    const docOnly = Object.values(docSymbols).filter((d) => !userLib[d.id]);
    return [...user, ...docOnly, ...BUILTIN_SYMBOLS];
  }, [userLib, docSymbols]);
  const query = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!query) return [];
    const words = query.split(/\s+/);
    return all
      .map((d) => ({ d, s: words.reduce((acc, w) => (acc < 0 ? acc : score(d, w) || -1), 0) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.d);
  }, [all, query]);
  const lookup = (id: string) => getSymbol(S().doc, id);
  const byCat = useMemo(() => {
    const m = new Map<string, SymbolDef[]>();
    for (const d of BUILTIN_SYMBOLS) m.set(d.category, [...(m.get(d.category) ?? []), d]);
    return m;
  }, []);
  const mine = all.filter((d) => d.custom);
  return (
    <div className="library">
      <div className="search">
        <Search size={14} />
        <input
          id="library-search"
          placeholder={`Search ${all.length} symbols…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQ('');
              (e.target as HTMLElement).blur();
            }
            if (e.key === 'Enter' && results[0]) {
              A.startPlacing(results[0].id);
              (e.target as HTMLElement).blur();
            }
          }}
        />
        {q && (
          <button className="clear" onClick={() => setQ('')}>
            <X size={13} />
          </button>
        )}
      </div>
      <div className="lib-scroll">
        {query ? (
          results.length ? (
            <div className="tiles">
              {results.map((d) => (
                <Tile key={d.id} def={d} />
              ))}
            </div>
          ) : (
            <div className="empty-note">
              No symbol matches “{q}”.
              <button className="link-btn" onClick={() => set({ dialog: 'symbol-editor', editingSymbol: null })}>
                Create one →
              </button>
            </div>
          )
        ) : (
          <>
            <Category name="Favourites" defs={favorites.map(lookup).filter((d) => d.id !== '__missing')} />
            <Category name="Recently used" defs={recent.map(lookup).filter((d) => d.id !== '__missing')} />
            <div className="lib-cat">
              <div className="lib-cat-head static">
                <span>My symbols</span>
                <span className="count">{mine.length}</span>
                <button className="mini-btn" onClick={() => set({ dialog: 'symbol-editor', editingSymbol: null })} title="Create a new symbol (Ctrl+Shift+N)">
                  <Plus size={12} /> New
                </button>
              </div>
              {mine.length ? (
                <div className="tiles">
                  {mine.map((d) => (
                    <Tile key={d.id} def={d} />
                  ))}
                </div>
              ) : (
                <div className="empty-note small">Draw your own parts, or duplicate any built-in symbol and tweak it.</div>
              )}
            </div>
            {CATEGORY_ORDER.map((c) => (
              <Category key={c} name={c} defs={byCat.get(c) ?? []} defaultOpen={c === 'Passive' || c === 'Semiconductors' || c === 'Power & Sources'} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Layers                                                              */
/* ------------------------------------------------------------------ */

function itemLabel(doc: CircuitDoc, it: Item, netName?: string): string {
  switch (it.type) {
    case 'component': {
      const def = getSymbol(doc, it.symbol);
      return `${def.valueIsLabel ? it.value : it.ref} · ${def.name}`;
    }
    case 'wire':
      return `Wire · ${netName ?? 'net?'}${it.label && it.label !== netName ? ` “${it.label}”` : ''}`;
    case 'junction':
      return 'Junction';
    case 'shape':
      return it.text ? `${kindName(it.kind)} “${it.text.split('\n')[0].slice(0, 24)}”` : kindName(it.kind);
  }
}

const kindName = (k: string) => ({ rect: 'Rectangle', zone: 'Zone', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', text: 'Text' })[k] ?? k;

function Layers() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const [filter, setFilter] = useState<'all' | 'component' | 'wire' | 'shape'>('all');
  const sel = new Set(selection);
  // wires are listed by their net's name (automatic netN when unnamed)
  const netByWire = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of computeNets(doc)) for (const w of n.wires) m.set(w, n.name);
    return m;
  }, [doc]);
  const items = Object.values(doc.items).filter((i) => i.type !== 'junction' && (filter === 'all' || i.type === filter));
  const groups = Object.values(doc.groups);
  const childrenOf = (gid: string | undefined) => ({
    groups: groups.filter((g) => g.group === gid),
    items: items.filter((i) => i.group === gid),
  });

  const Row = ({ it, depth }: { it: Item; depth: number }) => (
    <div
      className={sel.has(it.id) ? 'layer-row selected' : 'layer-row'}
      style={{ paddingLeft: 10 + depth * 14 }}
      onClick={(e) => {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          const s = new Set(S().selection);
          if (s.has(it.id)) s.delete(it.id);
          else s.add(it.id);
          set({ selection: [...s] });
        } else set({ selection: [it.id] });
      }}
      onDoubleClick={() => A.fitView([it.id])}
    >
      <span className={`layer-icon ${it.type}`} />
      <span className="layer-name">{itemLabel(doc, it, netByWire.get(it.id))}</span>
      {it.type === 'shape' && <span className="layer-tag">{it.layer === 'above' ? 'above' : 'below'}</span>}
      {it.type === 'wire' && !!it.hopLayer && (
        <span className="layer-tag" title={`Crossing layer ${it.hopLayer > 0 ? '+' : ''}${it.hopLayer}`}>
          {it.hopLayer > 0 ? 'over' : 'under'}
        </span>
      )}
      <button className="layer-act" title={it.hidden ? 'Show' : 'Hide'} onClick={(e) => (e.stopPropagation(), A.toggleHidden([it.id]))}>
        {it.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
      </button>
      <button
        className="layer-act"
        title={it.locked ? 'Unlock' : 'Lock'}
        onClick={(e) => {
          e.stopPropagation();
          mutate((d) => void (d.items[it.id].locked = !it.locked));
        }}
      >
        {it.locked ? <Lock size={12} /> : <LockOpen size={12} />}
      </button>
    </div>
  );

  const GroupNode = ({ gid, depth }: { gid: string; depth: number }) => {
    const [open, setOpen] = useState(true);
    const g = doc.groups[gid];
    const ch = childrenOf(gid);
    const [editing, setEditing] = useState(false);
    return (
      <div>
        <div className="layer-row group" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => select(Object.values(doc.items).filter((i) => i.group === gid).map((i) => i.id))}>
          <button className="layer-caret" onClick={(e) => (e.stopPropagation(), setOpen(!open))}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {editing ? (
            <input
              className="layer-rename"
              autoFocus
              defaultValue={g.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const v = e.target.value.trim();
                setEditing(false);
                if (v) mutate((d) => void (d.groups[gid].name = v));
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <span className="layer-name" onDoubleClick={(e) => (e.stopPropagation(), setEditing(true))} title="Double-click to rename">
              {g.name}
            </span>
          )}
        </div>
        {open && (
          <>
            {ch.groups.map((sg) => (
              <GroupNode key={sg.id} gid={sg.id} depth={depth + 1} />
            ))}
            {ch.items.map((it) => (
              <Row key={it.id} it={it} depth={depth + 1} />
            ))}
          </>
        )}
      </div>
    );
  };

  const root = childrenOf(undefined);
  return (
    <div className="layers">
      <div className="layer-filter">
        {(['all', 'component', 'wire', 'shape'] as const).map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'component' ? 'Parts' : f === 'wire' ? 'Wires' : 'Shapes'}
          </button>
        ))}
      </div>
      <div className="lib-scroll">
        {root.groups.map((g) => (
          <GroupNode key={g.id} gid={g.id} depth={0} />
        ))}
        {root.items.map((it) => (
          <Row key={it.id} it={it} depth={0} />
        ))}
        {!items.length && <div className="empty-note">Nothing here yet.</div>}
      </div>
    </div>
  );
}

export function LeftPanel() {
  const tab = useStore((s) => s.leftTab);
  return (
    <aside className="panel left-panel">
      <div className="tabs">
        <button className={tab === 'library' ? 'active' : ''} onClick={() => set({ leftTab: 'library' })}>
          Library
        </button>
        <button className={tab === 'layers' ? 'active' : ''} onClick={() => set({ leftTab: 'layers' })}>
          Layers
        </button>
      </div>
      {tab === 'library' ? <Library /> : <Layers />}
    </aside>
  );
}

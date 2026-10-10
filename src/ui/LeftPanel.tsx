import { Boxes, ChevronDown, ChevronRight, Eye, EyeOff, Lock, LockOpen, Pencil, Plus, Search, Share2, Star, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { drawOrder } from '../model/doc';
import { computeNets } from '../model/netlist';
import { reorderItem } from '../model/ops';
import { getSymbol, librarySymbols, variantDefs } from '../model/registry';
import { CATEGORY_ORDER } from '../model/symbols';
import type { CircuitDoc, Item, SymbolDef } from '../model/types';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import * as A from '../store/actions';
import { S, deleteUserSymbol, mutate, select, set, toggleFavorite, useStore } from '../store/store';
import { SymbolPopup, anchorOf, type SymbolPopupState } from './SymbolHover';

function Tile({ def }: { def: SymbolDef }) {
  const fav = useStore((s) => s.favorites.includes(def.id));
  const placing = useStore((s) => s.placing?.symbol === def.id);
  const docSymbols = useStore((s) => s.doc.symbols);
  const variants = useMemo(() => variantDefs({ symbols: docSymbols }, def), [def, docSymbols]);
  const [pop, setPop] = useState<SymbolPopupState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearTimer = () => clearTimeout(timer.current);
  // grace period so the pointer can travel from the tile into the popup
  const clearClose = () => clearTimeout(closeTimer.current);
  const scheduleClose = () => {
    clearClose();
    closeTimer.current = setTimeout(() => setPop((p) => (p && !p.pinned ? null : p)), 180);
  };
  useEffect(() => () => (clearTimer(), clearClose()), []);

  // a pinned picker also closes on Esc
  useEffect(() => {
    if (!pop?.pinned) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPop(null);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pop?.pinned]);

  const place = (d: SymbolDef) => {
    setPop(null);
    A.startPlacing(d.id);
  };

  return (
    <>
      <div
        className={placing ? 'tile active' : 'tile'}
        draggable
        onDragStart={(e) => {
          setPop(null);
          e.dataTransfer.setData('application/x-nodal-symbol', def.id);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onMouseEnter={(e) => {
          clearClose();
          if (pop) return;
          const el = e.currentTarget;
          clearTimer();
          timer.current = setTimeout(() => setPop({ def, variants, anchor: anchorOf(el), pinned: false }), 140);
        }}
        onMouseLeave={() => {
          clearTimer();
          scheduleClose();
        }}
        onClick={(e) => {
          clearTimer();
          clearClose();
          if (!variants.length) return A.startPlacing(def.id);
          const anchor = anchorOf(e.currentTarget);
          setPop((p) => (p?.pinned ? null : { def, variants, anchor, pinned: true }));
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          clearTimer();
          setPop(null);
          set({ placing: null });
          A.placeAtCenter(def.id);
        }}
        title={`${def.name}${def.value ? ` — ${def.value}` : ''}${variants.length ? `\n${variants.length + 1} types — click to choose` : ''}\nClick to place · drag onto canvas · double-click to drop in view centre`}
      >
        <SymbolPreview def={def} size={44} />
        <span className="tile-name">{def.name}</span>
        {variants.length > 0 && (
          <span className="tile-types" title={`${variants.length + 1} types available`}>
            <Boxes size={9} />
            {variants.length + 1}
          </span>
        )}
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
      {pop && <SymbolPopup {...pop} onPick={place} onClose={() => setPop(null)} onEnter={clearClose} />}
    </>
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

function score(def: SymbolDef, q: string, extra = '') {
  const name = def.name.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (def.id.includes(q)) return 50;
  if (def.prefix.toLowerCase() === q) return 45;
  if ((def.keywords ?? '').toLowerCase().includes(q)) return 40;
  if (extra.includes(q)) return 34;
  if (def.category.toLowerCase().includes(q)) return 20;
  return 0;
}

function Library() {
  const [q, setQ] = useState('');
  const favorites = useStore((s) => s.favorites);
  const recent = useStore((s) => s.recent);
  const docSymbols = useStore((s) => s.doc.symbols);
  const userLibrary = useStore((s) => s.userLibrary);
  const all = useMemo(() => librarySymbols({ symbols: docSymbols }), [docSymbols, userLibrary]);
  const extras = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of all) {
      m.set(
        d.id,
        variantDefs({ symbols: docSymbols }, d)
          .map((v) => `${v.name} ${v.variantName ?? ''} ${v.keywords ?? ''}`)
          .join(' ')
          .toLowerCase(),
      );
    }
    return m;
  }, [all, docSymbols]);
  const query = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!query) return [];
    const words = query.split(/\s+/);
    return all
      .map((d) => ({ d, s: words.reduce((acc, w) => (acc < 0 ? acc : score(d, w, extras.get(d.id) ?? '') || -1), 0) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.d);
  }, [all, query, extras]);
  const lookup = (id: string) => getSymbol(S().doc, id);
  const byCat = useMemo(() => {
    const m = new Map<string, SymbolDef[]>();
    for (const d of all) if (d.category !== 'My symbols') m.set(d.category, [...(m.get(d.category) ?? []), d]);
    return m;
  }, [all]);
  const mine = all.filter((d) => d.custom);
  return (
    <div className="library">
      <div className="lib-actions">
        <button className="lib-action" onClick={() => set({ dialog: 'share' })} title="Share or import your symbols and templates">
          <Share2 size={12} /> Share & collaborate
        </button>
      </div>
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

type VisFilter = 'any' | 'shown' | 'hidden';
type LockFilter = 'any' | 'locked' | 'unlocked';

function Layers() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const [filter, setFilter] = useState<'all' | 'component' | 'wire' | 'shape'>('all');
  const [vis, setVis] = useState<VisFilter>('any');
  const [lock, setLock] = useState<LockFilter>('any');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  // row dragging (pointer based): which row, where it would drop, and whether it actually moved
  const [drag, setDrag] = useState<{ id: string; startY: number; moved: boolean } | null>(null);
  const [drop, setDrop] = useState<{ id: string; place: 'before' | 'after' } | null>(null);
  const sel = new Set(selection);
  // wires are listed by their net's name (automatic netN when unnamed)
  const netByWire = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of computeNets(doc)) for (const w of n.wires) m.set(w, n.name);
    return m;
  }, [doc]);
  const order = useMemo(() => drawOrder(doc), [doc]);
  const filtering = filter !== 'all' || vis !== 'any' || lock !== 'any';
  // front-most first, like most layer panels
  const items = Object.values(doc.items)
    .filter((i) => i.type !== 'junction' && (filter === 'all' || i.type === filter))
    .filter((i) => vis === 'any' || (vis === 'hidden') === !!i.hidden)
    .filter((i) => lock === 'any' || (lock === 'locked') === !!i.locked)
    .sort((a, b) => order.get(b.id)! - order.get(a.id)!);
  const groups = Object.values(doc.groups);
  const childrenOf = (gid: string | undefined) => ({
    groups: groups.filter((g) => g.group === gid),
    items: items.filter((i) => i.group === gid),
  });
  const groupHasItems = (gid: string): boolean => childrenOf(gid).items.length > 0 || childrenOf(gid).groups.some((g) => groupHasItems(g.id));
  const groupItemIds = (gid: string) => Object.values(doc.items).filter((i) => i.group === gid).map((i) => i.id);

  const hover = (ids: string[]) => set({ layerHover: ids });
  useEffect(() => () => set({ layerHover: [] }), []);

  const endDrag = () => {
    if (drag?.moved && drop) {
      const { id } = drag;
      mutate((d) => void reorderItem(d as CircuitDoc, id, drop.id, drop.place));
    }
    setDrag(null);
    setDrop(null);
  };

  const row = (it: Item, depth: number) => {
    const dropHere = drag?.moved && drop?.id === it.id ? ` drop-${drop.place}` : '';
    return (
      <div
        key={it.id}
        data-layer-id={it.id}
        className={`layer-row${sel.has(it.id) ? ' selected' : ''}${it.hidden ? ' is-hidden' : ''}${drag?.moved && drag.id === it.id ? ' dragging' : ''}${dropHere}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onPointerEnter={() => !drag && hover([it.id])}
        onPointerLeave={() => !drag && hover([])}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag({ id: it.id, startY: e.clientY, moved: false });
        }}
        onPointerMove={(e) => {
          if (!drag || drag.id !== it.id) return;
          if (!drag.moved && Math.abs(e.clientY - drag.startY) < 4) return;
          if (!drag.moved) setDrag({ ...drag, moved: true });
          // the row under the pointer (pointer capture keeps events on the dragged row)
          const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-layer-id]') as HTMLElement | null;
          const tid = el?.dataset.layerId;
          const target = tid ? doc.items[tid] : null;
          if (!el || !target || tid === it.id || target.group !== it.group) return setDrop(null);
          const r = el.getBoundingClientRect();
          setDrop({ id: tid!, place: e.clientY < r.top + r.height / 2 ? 'before' : 'after' });
        }}
        onPointerUp={() => drag?.id === it.id && endDrag()}
        onPointerCancel={() => {
          setDrag(null);
          setDrop(null);
        }}
        onClick={(e) => {
          if (drag?.moved) return;
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
        <button className={it.hidden ? 'layer-act on' : 'layer-act'} title={it.hidden ? 'Show' : 'Hide'} onClick={(e) => (e.stopPropagation(), A.toggleHidden([it.id]))}>
          {it.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
        <button
          className={it.locked ? 'layer-act locked' : 'layer-act'}
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
  };

  const groupNode = (gid: string, depth: number): JSX.Element | null => {
    const g = doc.groups[gid];
    if (filtering && !groupHasItems(gid)) return null;
    const ch = childrenOf(gid);
    const open = !collapsed.has(gid);
    return (
      <div key={gid}>
        <div
          className="layer-row group"
          style={{ paddingLeft: 6 + depth * 14 }}
          onPointerEnter={() => !drag && hover(groupItemIds(gid))}
          onPointerLeave={() => !drag && hover([])}
          onClick={() => select(groupItemIds(gid))}
        >
          <button
            className="layer-caret"
            onClick={(e) => {
              e.stopPropagation();
              const next = new Set(collapsed);
              if (open) next.add(gid);
              else next.delete(gid);
              setCollapsed(next);
            }}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {renaming === gid ? (
            <input
              className="layer-rename"
              autoFocus
              defaultValue={g.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const v = e.target.value.trim();
                setRenaming(null);
                if (v) mutate((d) => void (d.groups[gid].name = v));
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <span className="layer-name" onDoubleClick={(e) => (e.stopPropagation(), setRenaming(gid))} title="Double-click to rename">
              {g.name}
            </span>
          )}
        </div>
        {open && (
          <>
            {ch.groups.map((sg) => groupNode(sg.id, depth + 1))}
            {ch.items.map((it) => row(it, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const chip = <T extends string>(cur: T, setCur: (v: T) => void, value: T, icon: JSX.Element, label: string) => (
    <button className={cur === value ? 'active' : ''} title={`Only ${label.toLowerCase()} items (click again for all)`} onClick={() => setCur((cur === value ? 'any' : value) as T)}>
      {icon}
      {label}
    </button>
  );

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
      <div className="layer-filter secondary">
        {chip(vis, setVis, 'shown', <Eye size={11} />, 'Shown')}
        {chip(vis, setVis, 'hidden', <EyeOff size={11} />, 'Hidden')}
        <span className="layer-filter-sep" />
        {chip(lock, setLock, 'locked', <Lock size={11} />, 'Locked')}
        {chip(lock, setLock, 'unlocked', <LockOpen size={11} />, 'Unlocked')}
      </div>
      <div className="lib-scroll" onPointerLeave={() => !drag && hover([])}>
        {root.groups.map((g) => groupNode(g.id, 0))}
        {root.items.map((it) => row(it, 0))}
        {!items.length && <div className="empty-note">{filtering ? 'Nothing matches these filters.' : 'Nothing here yet.'}</div>}
      </div>
      <div className="layer-foot muted small">Top of the list is in front · drag rows to reorder</div>
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

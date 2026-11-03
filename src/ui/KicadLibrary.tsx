import { ChevronDown, ChevronRight, Library } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  KICAD_GROUPS,
  kicadBase,
  kicadEntryOf,
  kicadEpoch,
  kicadLibParts,
  loadKicadEntries,
  loadKicadIndex,
  onKicadLoaded,
  searchKicad,
  type KicadEntry,
  type KicadIndex,
} from '../model/kicadLibrary';
import { kicadSymbol } from '../model/registry';
import type { SymbolDef } from '../model/types';
import { useFold } from './controls';
import { Tile } from './LeftPanel';

/*
 * The KiCad symbol library in the Library panel: matches for the search, and
 * a browser by group and library. The index and drawings are fetched only
 * when they are first needed.
 */

/** Re-renders when KiCad symbols are loaded. */
export const useKicadEpoch = () => useSyncExternalStore(onKicadLoaded, kicadEpoch);

function useKicadIndex(want: boolean): { ix: KicadIndex | null; error: string | null } {
  const [ix, setIx] = useState<KicadIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!want || ix) return;
    let live = true;
    loadKicadIndex()
      .then((v) => live && (setIx(v), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [want, ix]);
  return { ix, error };
}

/** The first units of `entries`, loading them as needed (null while loading). */
function useEntryDefs(ix: KicadIndex | null, entries: KicadEntry[]): SymbolDef[] | null {
  const [defs, setDefs] = useState<SymbolDef[] | null>(null);
  useEffect(() => {
    if (!ix) return;
    let live = true;
    setDefs(null);
    void loadKicadEntries(ix, entries).then((d) => live && setDefs(d));
    return () => {
      live = false;
    };
  }, [ix, entries]);
  return defs;
}

const Credit = () => (
  <a className="kicad-credit" href={`${kicadBase()}LICENSE.md`} target="_blank" rel="noreferrer" title="Converted from the KiCad symbol libraries, CC-BY-SA 4.0 (designs that use them are not affected)">
    KiCad libraries · CC-BY-SA 4.0
  </a>
);

/** KiCad parts matching the search. */
export function KicadResults({ query }: { query: string }) {
  const [deferred, setDeferred] = useState(query);
  // wait for a pause in typing before searching 20 000 parts
  useEffect(() => {
    const t = setTimeout(() => setDeferred(query), 160);
    return () => clearTimeout(t);
  }, [query]);
  const want = deferred.length >= 2;
  const { ix, error } = useKicadIndex(want);
  const entries = useMemo(() => (ix && want ? searchKicad(ix, deferred, 48) : []), [ix, deferred, want]);
  const defs = useEntryDefs(ix, entries);
  if (!want) return null;
  return (
    <div className="lib-cat kicad-results">
      <div className="lib-cat-head static">
        <Library size={13} />
        <span>KiCad library</span>
        <span className="count">{ix ? entries.length : '…'}</span>
      </div>
      {error ? (
        <div className="empty-note small">{error}</div>
      ) : !ix || !defs ? (
        <div className="empty-note small">Searching {ix ? ix.parts.length.toLocaleString() : ''} KiCad parts…</div>
      ) : defs.length ? (
        <>
          <div className="tiles">
            {defs.map((d) => (
              <Tile key={d.id} def={d} />
            ))}
          </div>
          <div className="empty-note small">
            <Credit />
          </div>
        </>
      ) : (
        <div className="empty-note small">No KiCad part matches “{deferred}”.</div>
      )}
    </div>
  );
}

const PAGE = 60;

function KicadLib({ ix, lib }: { ix: KicadIndex; lib: number }) {
  const name = ix.libs[lib].name;
  const [open, setOpen] = useFold(`kicad:${name}`, false);
  const [shown, setShown] = useState(PAGE);
  const all = useMemo(() => kicadLibParts(ix, lib), [ix, lib]);
  const page = useMemo(() => (open ? all.slice(0, shown) : []), [open, all, shown]);
  const defs = useEntryDefs(open ? ix : null, page);
  return (
    <div className="kicad-lib">
      <button className="lib-cat-head sub" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{name.replace(/_/g, ' ')}</span>
        <span className="count">{all.length}</span>
      </button>
      {open &&
        (defs ? (
          <>
            <div className="tiles">
              {defs.map((d) => (
                <Tile key={d.id} def={d} />
              ))}
            </div>
            {shown < all.length && (
              <button className="link-btn kicad-more" onClick={() => setShown(shown + PAGE)}>
                Show {Math.min(PAGE, all.length - shown)} more of {all.length - shown}
              </button>
            )}
          </>
        ) : (
          <div className="empty-note small">Loading…</div>
        ))}
    </div>
  );
}

function KicadGroup({ ix, group, libs }: { ix: KicadIndex; group: string; libs: number[] }) {
  const [open, setOpen] = useFold(`kicad-group:${group}`, false);
  const count = useMemo(() => {
    const set = new Set(libs);
    return ix.parts.reduce((n, e) => n + (set.has(e[0]) ? 1 : 0), 0);
  }, [ix, libs]);
  return (
    <div className="kicad-group">
      <button className="lib-cat-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{group}</span>
        <span className="count">{count.toLocaleString()}</span>
      </button>
      {open && libs.map((l) => <KicadLib key={l} ix={ix} lib={l} />)}
    </div>
  );
}

/** "KiCad library": every KiCad part, by group and library. */
export function KicadBrowser() {
  const [open, setOpen] = useFold('lib:KiCad library', false);
  const { ix, error } = useKicadIndex(open);
  const groups = useMemo(() => {
    if (!ix) return [];
    const by = new Map<string, number[]>();
    ix.libs.forEach((l, i) => by.set(l.group, [...(by.get(l.group) ?? []), i]));
    return [...KICAD_GROUPS, ...[...by.keys()].filter((g) => !(KICAD_GROUPS as readonly string[]).includes(g))].flatMap((g) => (by.has(g) ? [{ g, libs: by.get(g)! }] : []));
  }, [ix]);
  return (
    <div className="lib-cat kicad-browser">
      <button className="lib-cat-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Library size={13} />
        <span>KiCad library</span>
        <span className="count">{ix ? ix.parts.length.toLocaleString() : ''}</span>
      </button>
      {open && (
        <div className="kicad-body">
          {error ? (
            <div className="empty-note small">{error}</div>
          ) : !ix ? (
            <div className="empty-note small">Loading the KiCad library…</div>
          ) : (
            <>
              <div className="empty-note small">
                {ix.parts.length.toLocaleString()} parts from KiCad {ix.version}, fetched as you open them. <Credit />
              </div>
              {groups.map(({ g, libs }) => (
                <KicadGroup key={g} ix={ix} group={g} libs={libs} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Loads KiCad symbols that favourites, recently used or the open circuit refer
 * to but this session hasn't fetched yet (they are kept by id only).
 */
export function useRestoreKicad(ids: string[]) {
  const missing = useMemo(() => ids.filter((id) => id.startsWith('kicad:') && !kicadSymbol(id)), [ids]);
  const { ix } = useKicadIndex(missing.length > 0);
  useEffect(() => {
    if (!ix || !missing.length) return;
    const entries = [...new Set(missing.map((id) => kicadEntryOf(ix, id)).filter((e): e is KicadEntry => !!e))];
    if (entries.length) void loadKicadEntries(ix, entries);
  }, [ix, missing]);
}

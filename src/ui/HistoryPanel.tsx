import { Bookmark, ChevronDown, ChevronRight, Download, FolderOpen, History, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { exportSvg } from '../io/export';
import { viewDoc } from '../model/pages';
import { circuitToText, NODAL_FILTER, openFromHistory } from '../io/fileActions';
import { sanitizeName, saveFile } from '../io/files';
import { defaultLabel, deleteVersion, listOtherCircuits, listVersions, onVersionsChanged, renameVersion, restoreVersion, saveNamedVersion } from '../io/versionStore';
import { countParts, diffDocs, type Version } from '../model/versions';
import { toast, useStore } from '../store/store';
import { confirmDelete } from './Ask';

const dayOf = (t: number) => new Date(t).toDateString();

function dayTitle(t: number): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 864e5);
  if (dayOf(t) === today.toDateString()) return 'Today';
  if (dayOf(t) === yesterday.toDateString()) return 'Yesterday';
  return new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: new Date(t).getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

const timeOf = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Versions of the open document, kept fresh as they are saved. */
function useVersions(docId: string | undefined): Version[] | null {
  const [list, setList] = useState<Version[] | null>(null);
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    const load = () =>
      listVersions(docId).then(
        (vs) => alive && setList(vs),
        () => alive && setList([]),
      );
    void load();
    const off = onVersionsChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [docId]);
  return list;
}

/** Circuits closed or replaced earlier, so none of them is ever out of reach. */
function OtherCircuits({ docId }: { docId: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Version[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => listOtherCircuits(docId).then((vs) => alive && setList(vs), () => {});
    void load();
    const off = onVersionsChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [open, docId]);
  return (
    <section className="history-others">
      <button className="history-day history-others-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Other circuits on this device
      </button>
      {open &&
        (list.length ? (
          list.map((v) => (
            <div key={v.id} className="history-row auto" title={`Last kept ${new Date(v.t).toLocaleString()}`}>
              <FolderOpen size={13} />
              <span className="history-label">{v.doc.name}</span>
              <span className="history-time muted small">{dayTitle(v.t) === 'Today' ? timeOf(v.t) : dayTitle(v.t)}</span>
              <button className="chip" onClick={() => void openFromHistory(v.doc)}>
                Open
              </button>
            </div>
          ))
        ) : (
          <div className="empty-note small">No other circuits yet.</div>
        ))}
    </section>
  );
}

function Preview({ v }: { v: Version }) {
  const theme = useStore((s) => s.prefs.theme);
  const doc = useStore((s) => s.doc);
  const src = useMemo(() => {
    try {
      // the version's first page (a version restores every page)
      const { svg } = exportSvg(viewDoc(v.doc), { theme, background: false, padding: 20 });
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch {
      return null;
    }
  }, [v, theme]);
  // what changed between this version and now (debounced: the document changes while editing)
  const [now, setNow] = useState(doc);
  useEffect(() => {
    const t = setTimeout(() => setNow(doc), 300);
    return () => clearTimeout(t);
  }, [doc]);
  const diff = useMemo(() => diffDocs(v.doc, now), [v, now]);
  const same = !diff.added && !diff.removed && !diff.changed;
  const { parts, wires } = countParts(v.doc);

  const saveAsFile = async () => {
    try {
      const res = await saveFile(circuitToText({ ...v.doc, id: undefined }), `${sanitizeName(`${v.doc.name} (${v.label || defaultLabel(v.t)})`)}.nodal`, NODAL_FILTER);
      if (res !== false && res !== null) toast('Saved a copy of this version', 'success');
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <div className="history-preview">
      <div className="history-thumb">{src ? <img src={src} alt="" draggable={false} /> : <span className="muted small">No preview</span>}</div>
      <div className="history-facts small">
        <span>
          {parts} parts · {wires} wires
        </span>
        <span className="muted">{same ? 'Same as now' : `Since then: ${[diff.added && `+${diff.added}`, diff.removed && `−${diff.removed}`, diff.changed && `${diff.changed} changed`].filter(Boolean).join(' · ')}`}</span>
      </div>
      <div className="btn-row wrap">
        <button className="primary-btn" disabled={same} onClick={() => void restoreVersion(v)} title="Put this version back (undoable; the current state is kept as a version)">
          <RotateCcw size={14} /> Restore
        </button>
        <button className="secondary-btn" onClick={() => void saveAsFile()} title="Save this version as a separate file">
          <Download size={14} /> Save copy
        </button>
        <button
          className="secondary-btn danger"
          onClick={async () => {
            if (v.auto || (await confirmDelete(`Delete the version “${v.label}”?`, 'Named versions are otherwise kept forever. This cannot be undone.'))) void deleteVersion(v.id);
          }}
          title="Delete this version"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

export function HistoryPanel() {
  const docId = useStore((s) => s.doc.id);
  const versions = useVersions(docId);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const current = versions?.find((v) => v.id === picked) ?? null;

  const save = async () => {
    await saveNamedVersion(name.trim());
    setName('');
  };

  let lastDay = '';
  return (
    <div className="history-panel">
      <form
        className="history-save"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input className="input" data-focus="version-name" value={name} placeholder="Name this version…" onChange={(e) => setName(e.target.value)} />
        <button className="primary-btn" type="submit" title="Save the circuit as it is now (Ctrl+Alt+V)">
          <Bookmark size={14} /> Save
        </button>
      </form>
      {current && <Preview v={current} />}
      <div className="lib-scroll history-list">
        {versions?.map((v) => {
          const day = dayOf(v.t);
          const head = day !== lastDay ? <div className="history-day">{dayTitle(v.t)}</div> : null;
          lastDay = day;
          return (
            <div key={v.id}>
              {head}
              <button
                className={`history-row${v.id === picked ? ' active' : ''}${v.auto ? ' auto' : ''}`}
                onClick={() => setPicked(v.id === picked ? null : v.id)}
                onDoubleClick={() => setRenaming(v.id)}
                title={v.auto ? 'Automatic version · double-click to name it' : 'Double-click to rename'}
              >
                {v.auto ? <History size={13} /> : <Bookmark size={13} />}
                {renaming === v.id ? (
                  <input
                    className="input history-rename"
                    autoFocus
                    defaultValue={v.label}
                    placeholder="Version name"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') {
                        e.currentTarget.value = v.label;
                        e.currentTarget.blur();
                      }
                      e.stopPropagation();
                    }}
                    onBlur={(e) => {
                      if (renaming === v.id && e.currentTarget.value.trim() !== v.label) void renameVersion(v, e.currentTarget.value);
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="history-label">{v.label || 'Autosave'}</span>
                )}
                <span className="history-time muted small">{timeOf(v.t)}</span>
              </button>
            </div>
          );
        })}
        {versions && !versions.length && <div className="empty-note">No versions yet. They are saved automatically while you work, or name one above.</div>}
        <OtherCircuits docId={docId} />
      </div>
      <div className="layer-foot muted small">Kept on this device · saved automatically every few minutes</div>
    </div>
  );
}

import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { docPages, resolvePage } from '../model/pages';
import * as A from '../store/actions';
import { keysFor, prettyKey } from '../store/commands';
import { readOnly, useStore } from '../store/store';

/** Page tabs along the bottom of the canvas (like a spreadsheet's sheets): click to show, double-click to rename, right-click for more, drag to reorder. */
export function PageBar() {
  const pages = useStore((s) => docPages(s.doc));
  const active = useStore((s) => resolvePage(s.doc, s.page));
  // View mode or a view-only session: pages can be shown, not changed
  const viewOnly = useStore(readOnly);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    A.pageBar.rename = (id) => !viewOnly && setRenaming(id);
    return () => {
      A.pageBar.rename = null;
    };
  }, [viewOnly]);

  // keep the active tab in view
  useEffect(() => {
    listRef.current?.querySelector('.page-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, pages.length]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !(e.target as Element).closest?.('.page-menu') && setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  const index = (id: string) => pages.findIndex((p) => p.id === id);
  const run = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  return (
    <div className="page-bar" onContextMenu={(e) => e.preventDefault()}>
      <div className="page-tabs" ref={listRef} onWheel={(e) => listRef.current && (listRef.current.scrollLeft += e.deltaY)}>
        {pages.map((p, i) =>
          renaming === p.id ? (
            <input
              key={p.id}
              className="page-tab page-rename"
              autoFocus
              defaultValue={p.name}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                A.renamePageTo(p.id, e.target.value);
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                else if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <button
              key={p.id}
              className={`page-tab${p.id === active ? ' active' : ''}${drag && drag.id !== p.id && drag.over === i ? (index(drag.id) < i ? ' drop-after' : ' drop-before') : ''}`}
              title={p.name}
              draggable={!viewOnly && pages.length > 1}
              onClick={() => A.showPage(p.id)}
              onDoubleClick={() => !viewOnly && setRenaming(p.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                A.showPage(p.id);
                if (!viewOnly) setMenu({ id: p.id, x: e.clientX, y: e.clientY });
              }}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('application/x-nodal-page', p.id);
                setDrag({ id: p.id, over: i });
              }}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                if (drag.over !== i) setDrag({ ...drag, over: i });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag && drag.id !== p.id) A.movePageTo(drag.id, i);
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
            >
              {p.name}
            </button>
          ),
        )}
      </div>
      {!viewOnly && (
        <button className="page-add" onClick={A.newPage} title={`New page${keysFor('page.new')[0] ? ` (${prettyKey(keysFor('page.new')[0])})` : ''}`}>
          <Plus size={14} />
        </button>
      )}
      {menu &&
        // portalled to <body>: .stage is a size container (contain: layout), which would otherwise
        // make it the containing block for this fixed menu and offset its viewport coordinates
        createPortal(
          <div className="page-menu dropdown" style={{ left: menu.x, bottom: window.innerHeight - menu.y + 4 }} role="menu">
            <button className="dropdown-item" onClick={run(() => setRenaming(menu.id))}>
              Rename
            </button>
            <button className="dropdown-item" onClick={run(() => A.duplicatePageCmd(menu.id))}>
              Duplicate
            </button>
            <button className="dropdown-item" disabled={pages.length < 2} onClick={run(() => void A.deletePageCmd(menu.id))}>
              Delete
            </button>
            <div className="dropdown-sep" />
            <button className="dropdown-item" disabled={index(menu.id) === 0} onClick={run(() => A.movePageBy(menu.id, -1))}>
              Move left
            </button>
            <button className="dropdown-item" disabled={index(menu.id) === pages.length - 1} onClick={run(() => A.movePageBy(menu.id, 1))}>
              Move right
            </button>
            <div className="dropdown-sep" />
            <button className="dropdown-item" onClick={run(A.newPage)}>
              New page
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

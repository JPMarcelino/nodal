import { useEffect } from 'react';
import { Canvas, canvasKeys } from './canvas/Canvas';
import { isDesktop } from './io/files';
import { importDroppedFiles } from './io/importFiles';
import { eventToCombo, findCommand } from './store/commands';
import { S, useStore } from './store/store';
import { Dialogs } from './ui/Dialogs';
import { Inspector } from './ui/Inspector';
import { LeftPanel } from './ui/LeftPanel';
import { StatusBar, Toasts } from './ui/Overlays';
import { ContextMenu } from './ui/ContextMenu';
import { SymbolEditor } from './ui/SymbolEditor';
import { ToolRail, TopBar } from './ui/TopBar';
import { Presenter } from './ui/Presenter';
import { Timeline } from './ui/Timeline';
import { useExplain } from './store/explain';
import { AskHost } from './ui/Ask';

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/** Shortcuts that should work even while a text field has focus. */
const GLOBAL_WHILE_TYPING = new Set(['file.save', 'file.saveAs', 'help.palette', 'file.open']);

export function App() {
  const theme = useStore((s) => s.prefs.theme);
  const uiScale = useStore((s) => s.prefs.uiScale);
  const left = useStore((s) => s.leftPanel);
  const right = useStore((s) => s.rightPanel);
  const dialog = useStore((s) => s.dialog);
  const showTimeline = useExplain((s) => s.timelineOpen && s.presenting === null);
  const editingSymbol = useStore((s) => s.editingSymbol);
  const name = useStore((s) => s.doc.name);
  const dirty = useStore((s) => s.dirty);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.fontSize = `${13 * uiScale}px`;
  }, [theme, uiScale]);

  useEffect(() => {
    const title = `${dirty ? '• ' : ''}${name} — Nodal`;
    document.title = title;
    if (isDesktop()) {
      import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
        .catch(() => undefined);
    }
  }, [name, dirty]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const combo = eventToCombo(e);
      if (S().dialog) return; // dialogs own the keyboard
      if (isTyping(e)) {
        const cmd = findCommand(combo);
        if (cmd && GLOBAL_WHILE_TYPING.has(cmd.id)) {
          e.preventDefault();
          (e.target as HTMLElement).blur();
          cmd.run();
        }
        return;
      }
      if (canvasKeys.handle?.(combo)) {
        e.preventDefault();
        return;
      }
      const cmd = findCommand(combo);
      if (cmd) {
        e.preventDefault();
        cmd.run();
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDesktop() && S().dirty && !S().prefs.autosave) e.preventDefault();
    };
    // files dropped outside the canvas are imported too (and never navigate the page away)
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      void importDroppedFiles(e.dataTransfer.files);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <div className="app" onContextMenu={(e) => e.preventDefault()}>
      <TopBar />
      <div className="workspace">
        {left && <LeftPanel />}
        <main className={showTimeline ? 'stage with-timeline' : 'stage'}>
          <ToolRail />
          <Canvas />
          {showTimeline && <Timeline />}
        </main>
        {right && <Inspector />}
      </div>
      <StatusBar />
      <ContextMenu />
      <Dialogs />
      {dialog === 'symbol-editor' && <SymbolEditor key={editingSymbol ?? 'new'} />}
      <Presenter />
      <Toasts />
      <AskHost />
    </div>
  );
}

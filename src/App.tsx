import { useEffect } from 'react';
import { Canvas, canvasKeys } from './canvas/Canvas';
import { isDesktop } from './io/files';
import { eventToCombo, findCommand } from './store/commands';
import { S, useStore } from './store/store';
import { Dialogs } from './ui/Dialogs';
import { Inspector } from './ui/Inspector';
import { LeftPanel } from './ui/LeftPanel';
import { ContextMenu, StatusBar, Toasts } from './ui/Overlays';
import { SymbolEditor } from './ui/SymbolEditor';
import { ToolRail, TopBar } from './ui/TopBar';

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
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  return (
    <div className="app" onContextMenu={(e) => e.preventDefault()}>
      <TopBar />
      <div className="workspace">
        {left && <LeftPanel />}
        <main className="stage">
          <ToolRail />
          <Canvas />
        </main>
        {right && <Inspector />}
      </div>
      <StatusBar />
      <ContextMenu />
      <Dialogs />
      {dialog === 'symbol-editor' && <SymbolEditor />}
      <Toasts />
    </div>
  );
}

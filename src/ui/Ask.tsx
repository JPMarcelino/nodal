import { create } from 'zustand';

/*
 * In-app question dialog (the browser's confirm() can't offer "Save", looks out
 * of place, and isn't dependable in the desktop app's webview).
 */

export interface AskButton<T> {
  label: string;
  value: T;
  kind?: 'primary' | 'danger';
}

interface AskState {
  title: string;
  message?: string;
  buttons: AskButton<unknown>[];
  /** Value given when the question is dismissed (Esc, clicking outside). */
  dismiss: unknown;
  resolve: (v: unknown) => void;
}

const useAsk = create<{ q: AskState | null }>(() => ({ q: null }));

/** Asks a question; resolves with the chosen button's value (or `dismiss` on Esc). */
export function ask<T>(title: string, message: string | undefined, buttons: AskButton<T>[], dismiss: T): Promise<T> {
  return new Promise((resolve) => {
    // a question already showing counts as dismissed
    useAsk.getState().q?.resolve(useAsk.getState().q?.dismiss);
    useAsk.setState({ q: { title, message, buttons: buttons as AskButton<unknown>[], dismiss, resolve: resolve as (v: unknown) => void } });
  });
}

/** Asks before something is deleted; resolves true to go ahead. */
export const confirmDelete = (title: string, message?: string, label = 'Delete') =>
  ask(title, message, [
    { label: 'Cancel', value: false },
    { label, value: true, kind: 'danger' },
  ], false);

// Registered once at startup so it runs before every other key handler: while a
// question is up, Esc dismisses it and no shortcut reaches the app behind.
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      const q = useAsk.getState().q;
      if (!q) return;
      e.stopImmediatePropagation();
      if (e.key !== 'Escape') return;
      e.preventDefault();
      q.resolve(q.dismiss);
      useAsk.setState({ q: null });
    },
    true,
  );
}

export function AskHost() {
  const q = useAsk((s) => s.q);
  const answer = (v: unknown) => {
    q?.resolve(v);
    useAsk.setState({ q: null });
  };
  if (!q) return null;
  return (
    <div className="ask-backdrop" onPointerDown={(e) => e.target === e.currentTarget && answer(q.dismiss)}>
      <div className="ask" role="alertdialog" aria-label={q.title}>
        <strong>{q.title}</strong>
        {q.message && <span className="muted small">{q.message}</span>}
        <div className="btn-row">
          {q.buttons.map((b, i) => (
            <button
              key={i}
              className={b.kind === 'primary' ? 'primary-btn' : b.kind === 'danger' ? 'secondary-btn danger' : 'secondary-btn'}
              autoFocus={b.kind === 'primary' || (!q.buttons.some((x) => x.kind === 'primary') && b.value === q.dismiss)}
              onClick={() => answer(b.value)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

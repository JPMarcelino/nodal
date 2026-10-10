import { SymbolPreview } from '../canvas/SymbolGraphic';
import { BUILTIN_SYMBOLS } from '../model/symbols';

/** Developer view (#gallery): every built-in symbol with its pins, for visual review. */
export function Gallery() {
  return (
    <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 128px)', gap: 8, overflow: 'auto', height: '100%', background: 'var(--canvas)', color: 'var(--sym)', ['--sym-bg' as string]: 'var(--canvas)' }}>
      {BUILTIN_SYMBOLS.map((s) => (
        <div key={s.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 6, textAlign: 'center' }}>
          <SymbolPreview def={s} size={100} ports />
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{s.id}</div>
        </div>
      ))}
    </div>
  );
}

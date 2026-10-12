import { SymbolPreview } from '../canvas/SymbolGraphic';
import { BUILTIN_SYMBOLS } from '../model/symbols';

/** Developer view (#gallery, or #gallery=id1,id2 for a few): built-in symbols with their pins, for visual review. */
export function Gallery() {
  const only = location.hash.split('=')[1]?.split(',').filter(Boolean);
  const list = only?.length ? BUILTIN_SYMBOLS.filter((s) => only.includes(s.id)) : BUILTIN_SYMBOLS;
  return (
    <div style={{ padding: 16, display: 'grid', gridTemplateColumns: `repeat(auto-fill, ${only?.length ? 220 : 128}px)`, gap: 8, overflow: 'auto', height: '100%', background: 'var(--canvas)', color: 'var(--sym)', ['--sym-bg' as string]: 'var(--canvas)' }}>
      {list.map((s) => (
        <div key={s.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 6, textAlign: 'center' }}>
          <SymbolPreview def={s} size={only?.length ? 190 : 100} ports />
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{s.id}</div>
        </div>
      ))}
    </div>
  );
}

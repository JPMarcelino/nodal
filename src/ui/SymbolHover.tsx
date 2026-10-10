import { Check, Layers } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SymbolPreview } from '../canvas/SymbolGraphic';
import type { SymbolDef } from '../model/types';

/** Where to anchor a popup: the bounding rect of the tile/item that spawned it. */
export interface PopupAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface SymbolPopupState {
  /** The base symbol (the one shown as the single tile/row). */
  def: SymbolDef;
  /** Its alternative drawings, in offer order (may be empty). */
  variants: SymbolDef[];
  anchor: PopupAnchor;
  /** Pinned popups stay open and are interactive; hover popups fade on leave. */
  pinned: boolean;
}

const WIDTH = 264;

/** Converts an element's bounding box into a popup anchor. */
export const anchorOf = (el: Element): PopupAnchor => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
};

/**
 * A clean, floating render of a symbol — and, when it has more than one
 * drawing, a type picker. Shown on hover anywhere a symbol can be placed, and
 * pinned open when a multi-drawing symbol is clicked.
 */
export function SymbolPopup({
  def,
  variants,
  anchor,
  pinned,
  onPick,
  onClose,
  onEnter,
}: SymbolPopupState & { onPick: (def: SymbolDef) => void; onClose: () => void; onEnter?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<SymbolDef>(def);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => setActive(def), [def]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.right + 10;
    if (left + WIDTH > vw - 8) left = anchor.left - WIDTH - 10;
    left = Math.max(8, Math.min(left, vw - WIDTH - 8));
    let top = anchor.top;
    if (top + h > vh - 8) top = vh - h - 8;
    top = Math.max(8, top);
    setPos({ left, top });
  }, [anchor, active, variants.length]);

  const options = variants.length ? [def, ...variants] : [];
  const hasTypes = options.length > 1;

  const card = (
    <div
      ref={ref}
      className={pinned ? 'sym-popup pinned' : 'sym-popup'}
      style={pos ? { left: pos.left, top: pos.top, width: WIDTH } : { left: -9999, top: -9999, width: WIDTH }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseEnter={onEnter}
      onMouseLeave={() => {
        setActive(def);
        if (!pinned) onClose();
      }}
    >
      <div className="sym-popup-head">
        <span className="sym-popup-name">{def.name}</span>
        <span className="sym-popup-cat">{def.category}</span>
      </div>
      <button className="sym-popup-stage" onClick={() => onPick(active)} title={pinned ? 'Place this type' : 'Click to place'}>
        <SymbolPreview def={active} size={pinned ? 150 : 136} ports />
        <span className="sym-popup-value">{active.value || active.prefix}</span>
      </button>
      {hasTypes ? (
        <div className="sym-popup-types">
          <div className="sym-popup-types-label">
            <Layers size={11} /> {options.length} types
          </div>
          {options.map((o, i) => {
            const label = i === 0 ? 'Type A · standard' : o.variantName || o.name;
            return (
              <button
                key={o.id}
                className={o.id === active.id ? 'sym-type active' : 'sym-type'}
                onMouseEnter={() => setActive(o)}
                onClick={() => onPick(o)}
                title={`Place ${label}`}
              >
                <span className="sym-type-prev">
                  <SymbolPreview def={o} size={34} />
                </span>
                <span className="sym-type-name">{label}</span>
                {o.id === active.id && <Check size={13} className="sym-type-check" />}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="sym-popup-hint">Click to place · drag onto the canvas</div>
      )}
    </div>
  );

  if (!pinned) return createPortal(card, document.body);
  return createPortal(
    <>
      <div className="sym-popup-backdrop" onPointerDown={onClose} />
      {card}
    </>,
    document.body,
  );
}

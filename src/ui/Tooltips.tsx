import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * One styled tooltip for the whole app. Every element with a `title` keeps
 * working as before (the attribute is moved to `data-tip` on hover, so the
 * browser's own tooltip never doubles it), and a trailing shortcut such as
 * "Wire (W)" is drawn as keycaps. `data-tip-desc` adds a quieter second line.
 * Mouse and pen only: touch screens get no hover tooltips.
 */

type Tip = { label: string; keys: string[]; desc: string; rect: DOMRect };

const DELAY = 450;
/** Moving from one tooltip to the next within this long shows the next straight away. */
const WARM = 400;

/** "→ / Space", "X or Y": alternatives (a bare "/" or "Ctrl+/" is a key). */
const ALTS = /\s+\/\s+|\s+or\s+/;
const KEY_NAME = /^(?:Ctrl|Alt|Shift|Cmd|Mod|Meta|⌘|⌥|⇧|Esc|Del|Delete|Space|Insert|Ins|Tab|Enter|Return|Backspace|Home|End|PgUp|PgDn|PageUp|PageDown|F\d{1,2})$/;

/** "Ctrl+Shift+K" or "X / Y" or "?": short, and made of key names, not words ("DXF (CAD)" is not a shortcut). */
function looksLikeKeys(s: string): boolean {
  if (s.length > 28 || !s) return false;
  return s.split(ALTS).every((part) => {
    if (!part || /\s/.test(part)) return false;
    return splitCombo(part).every((k) => [...k].length === 1 || KEY_NAME.test(k));
  });
}

export function parseTip(text: string): { label: string; keys: string[] } {
  const m = /^([\s\S]*?)\s*\(([^()]+)\)\s*$/.exec(text);
  if (m && m[1] && looksLikeKeys(m[2].trim())) return { label: m[1], keys: m[2].trim().split(ALTS) };
  return { label: text, keys: [] };
}

/** Text cut short by an ellipsis, in the element or the spans inside it. */
function clipped(el: HTMLElement): boolean {
  const over = (n: Element) => n.scrollWidth > n.clientWidth + 1;
  if (over(el)) return true;
  for (const c of el.children) if (over(c)) return true;
  return false;
}

function tipTarget(el: EventTarget | null): HTMLElement | null {
  let n = el as Element | null;
  while (n && n !== document.body) {
    if (n instanceof HTMLElement && (n.hasAttribute('title') || n.dataset.tip)) return n;
    n = n.parentElement;
  }
  return null;
}

/** Takes the title over so the native tooltip doesn't show too; keeps an accessible name for icon buttons. */
function adopt(el: HTMLElement): string {
  const title = el.getAttribute('title');
  if (title !== null) {
    el.removeAttribute('title');
    if (title) {
      el.dataset.tip = title;
      if (!el.hasAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
    }
  }
  return el.dataset.tip ?? '';
}

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastHidden = 0;
    let shown = false;
    const show = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (!text || !el.isConnected) return;
      const { label, keys } = parseTip(text);
      shown = true;
      setTip({ label, keys, desc: el.dataset.tipDesc ?? '', rect: el.getBoundingClientRect() });
    };
    const hide = () => {
      clearTimeout(timer);
      if (shown) lastHidden = performance.now();
      shown = false;
      current = null;
      setTip(null);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = tipTarget(e.target);
      if (el === current) return;
      const raw = el ? adopt(el) : '';
      // a tooltip that only repeats the button's own visible label adds nothing (unless that label is cut off)
      const text = raw && (raw.trim() !== el?.textContent?.trim() || (el && clipped(el))) ? raw : '';
      clearTimeout(timer);
      if (!el || !text) {
        if (shown) hide();
        current = null;
        return;
      }
      const warm = shown || performance.now() - lastHidden < WARM;
      if (shown) {
        shown = false;
        lastHidden = performance.now();
        setTip(null);
      }
      current = el;
      timer = setTimeout(() => current === el && show(el), warm ? 0 : DELAY);
    };
    const onOut = (e: PointerEvent) => {
      if (!current) return;
      const to = e.relatedTarget as Node | null;
      if (to && current.contains(to)) return;
      hide();
    };
    // a click, a key or a scroll means the pointer is doing something else now
    const onDown = () => {
      clearTimeout(timer);
      if (shown) {
        shown = false;
        setTip(null);
      }
    };
    window.addEventListener('pointerover', onOver, true);
    window.addEventListener('pointerout', onOut, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('wheel', onDown, { capture: true, passive: true });
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerover', onOver, true);
      window.removeEventListener('pointerout', onOut, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('wheel', onDown, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !ref.current) return setPos(null);
    const box = ref.current.getBoundingClientRect();
    const m = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // under the element unless it sits low on the screen or there's no room
    const below = tip.rect.bottom + 8 + box.height <= vh - m && tip.rect.top < vh * 0.7;
    const y = below ? tip.rect.bottom + 8 : tip.rect.top - 8 - box.height;
    const x = Math.min(vw - m - box.width, Math.max(m, tip.rect.left + tip.rect.width / 2 - box.width / 2));
    setPos({ x, y: Math.max(m, y), below });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={ref}
      className={pos ? `ui-tip ${pos.below ? 'below' : 'above'}` : 'ui-tip measuring'}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      role="tooltip"
    >
      <div className="ui-tip-row">
        <span className="ui-tip-label">{tip.label}</span>
        {tip.keys.length > 0 && (
          <span className="ui-tip-keys">
            {tip.keys.map((k, i) => (
              <span key={i} className="ui-tip-combo">
                {i > 0 && <span className="ui-tip-or">/</span>}
                {splitCombo(k).map((p, j) => (
                  <kbd key={j}>{p}</kbd>
                ))}
              </span>
            ))}
          </span>
        )}
      </div>
      {tip.desc && <div className="ui-tip-desc">{tip.desc}</div>}
    </div>
  );
}

/** "Ctrl+Shift++" → Ctrl, Shift, + */
function splitCombo(k: string): string[] {
  const parts = k.split('+');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i < parts.length - 1) {
      out.push('+');
      i++;
    } else if (parts[i] !== '') out.push(parts[i]);
  }
  return out.length ? out : [k];
}

import { useLayoutEffect, type RefObject } from 'react';

/**
 * Grows a canvas text editor to fit what it shows: its source text, wrapped at its
 * width. (Sizing it by the typeset text made it jump while a formula was typed.)
 */
export function useFitHeight(ref: RefObject<HTMLTextAreaElement>, min = 0) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.max(min, el.scrollHeight + 2)}px`;
  });
}

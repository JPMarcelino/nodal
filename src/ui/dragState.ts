/**
 * The library part being dragged right now. A drag's data can't be read until
 * the drop, so the canvas looks here to draw the part where it will land.
 */
export const libraryDrag: { symbol: string | null } = { symbol: null };

/**
 * Where a double-click on empty canvas asked for a part: the command palette
 * opened from it places the part it picks right there.
 */
export const placeHere: { at: { x: number; y: number } | null } = { at: null };

/** Canvas operations that need the live pointer / gesture state, registered by the Canvas. */
export const canvasActions: {
  /** Picks up the selection (or the item under the pointer) and moves it with the pointer until the next click. */
  floatMove: ((opts: { detach: boolean; copy: boolean }) => void) | null;
  /** Opens the in-place name editor on a group's tag. */
  renameGroup: ((gid: string) => void) | null;
} = { floatMove: null, renameGroup: null };

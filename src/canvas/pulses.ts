import { useSyncExternalStore } from 'react';

/**
 * Short-lived rings on the canvas that confirm an action landed: a part set
 * down, a wire snapped onto a pin. Purely visual; they fade on their own.
 */
export interface Pulse {
  id: number;
  x: number;
  y: number;
  /** place: something set down; snap: a wire snapped onto a pin; solder: a joint was made or broken. */
  kind: 'place' | 'snap' | 'solder';
}

const LIFE = 650;
let pulses: Pulse[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function pulseAt(x: number, y: number, kind: Pulse['kind']) {
  if (typeof window === 'undefined') return;
  const p = { id: ++nextId, x, y, kind };
  pulses = [...pulses.slice(-5), p];
  emit();
  setTimeout(() => {
    pulses = pulses.filter((q) => q !== p);
    emit();
  }, LIFE);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function usePulses(): Pulse[] {
  return useSyncExternalStore(
    subscribe,
    () => pulses,
    () => pulses,
  );
}

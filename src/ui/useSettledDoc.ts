import { useEffect, useState } from 'react';
import type { CircuitDoc } from '../model/types';
import { useStore } from '../store/store';

/**
 * The document as it was when edits settled. Canvas gestures replace `s.doc`
 * on every pointer move, so panels that compute over the whole circuit read
 * this instead of the live document: they update once a drag pauses, not at
 * pointer rate.
 */
export function useSettledDoc(delay = 250): CircuitDoc {
  const doc = useStore((s) => s.doc);
  const [settled, setSettled] = useState(doc);
  useEffect(() => {
    if (doc === settled) return;
    const t = setTimeout(() => setSettled(doc), delay);
    return () => clearTimeout(t);
  }, [doc, settled, delay]);
  return settled;
}

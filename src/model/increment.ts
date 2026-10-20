import type { Draft } from 'immer';
import { getSymbol } from './registry';
import type { CircuitDoc } from './types';

/**
 * Bumps the trailing decimal number of a label name, keeping zero padding
 * unless the number grows past it ('P099' → 'P100'). Names without a
 * trailing number, empty names and names ending in a LaTeX formula (an
 * unescaped closing `$`) are returned unchanged (trimmed of trailing
 * whitespace).
 */
export function incrementName(name: string): string {
  const s = name.replace(/\s+$/, '');
  if (!s) return s;
  // Maths is never rewritten: a trailing unescaped `$` closes a formula.
  if (s.endsWith('$')) {
    let bs = 0;
    for (let i = s.length - 2; i >= 0 && s[i] === '\\'; i--) bs++;
    if (bs % 2 === 0) return s;
  }
  const m = s.match(/(\d+)$/);
  if (!m) return s;
  const digits = m[1];
  const prefix = s.slice(0, s.length - digits.length);
  const next = String(parseInt(digits, 10) + 1);
  return prefix + (next.length < digits.length ? next.padStart(digits.length, '0') : next);
}

/**
 * Applies incrementName to the copies with `ids`: components whose symbol
 * has valueIsLabel and whose prefix does not start with '#PWR' (net labels,
 * global labels, ports and off-page connectors; power rails are left alone),
 * via `value`; and wires with a non-empty `label`. Parts, rails and shapes
 * are not touched. Returns true when at least one name was bumped.
 */
export function incrementLabels(doc: Draft<CircuitDoc>, ids: string[]): boolean {
  let bumped = false;
  for (const id of ids) {
    const it = doc.items[id];
    if (!it) continue;
    if (it.type === 'component') {
      const def = getSymbol(doc, it.symbol);
      if (!def.valueIsLabel || def.prefix.startsWith('#PWR')) continue;
      const next = incrementName(it.value);
      if (next !== it.value) {
        it.value = next;
        bumped = true;
      }
    } else if (it.type === 'wire') {
      if (!it.label) continue;
      const next = incrementName(it.label);
      if (next !== it.label) {
        it.label = next;
        bumped = true;
      }
    }
  }
  return bumped;
}

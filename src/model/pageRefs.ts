import { itemPage, multiPage, pageIndex, resolvePage } from './pages';
import { instanceSymbol } from './registry';
import type { CircuitDoc, ComponentItem } from './types';

/**
 * Cross-page references of net labels ("[2, 3]" after the name on multi-sheet
 * schematics). Maps each label component id on `page` to the sorted 1-based
 * numbers of the *other* pages where the same name appears.
 */
const EMPTY: ReadonlyMap<string, string> = new Map();

const cache = new WeakMap<CircuitDoc, Map<string, ReadonlyMap<string, string>>>();

export function pageCrossRefs(doc: CircuitDoc, page?: string | null): ReadonlyMap<string, string> {
  if (!multiPage(doc)) return EMPTY;
  const cur = resolvePage(doc, page);
  let byPage = cache.get(doc);
  const hit = byPage?.get(cur);
  if (hit) return hit;
  const result = compute(doc, cur);
  if (!byPage) cache.set(doc, (byPage = new Map()));
  byPage.set(cur, result);
  return result;
}

/** Name a component contributes to the net-name index (mirrors computeNets naming). */
function compName(doc: CircuitDoc, c: ComponentItem): string | null {
  const def = instanceSymbol(doc, c);
  if (!def.valueIsLabel && !def.prefix.startsWith('#PWR')) return null;
  const name = (c.value || def.value || '').trim();
  return name || null;
}

function compute(doc: CircuitDoc, cur: string): ReadonlyMap<string, string> {
  const curIdx = pageIndex(doc, cur);
  // every page (by 0-based index) each trimmed net name appears on
  const pagesOf = new Map<string, Set<number>>();
  const note = (name: string, idx: number) => {
    let set = pagesOf.get(name);
    if (!set) pagesOf.set(name, (set = new Set()));
    set.add(idx);
  };
  for (const it of Object.values(doc.items)) {
    if (it.hidden) continue;
    if (it.type === 'component') {
      const name = compName(doc, it);
      if (name !== null) note(name, pageIndex(doc, itemPage(doc, it)));
    } else if (it.type === 'wire') {
      const name = (it.label ?? '').trim();
      if (name) note(name, pageIndex(doc, itemPage(doc, it)));
    }
  }
  const out = new Map<string, string>();
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'component' || it.hidden) continue;
    if (itemPage(doc, it) !== cur) continue;
    const def = instanceSymbol(doc, it);
    // power rails are on every page; annotating them would only add noise
    if (!def.valueIsLabel || def.prefix.startsWith('#PWR')) continue;
    const name = (it.value || def.value || '').trim();
    if (!name) continue;
    const others = [...(pagesOf.get(name) ?? [])].filter((i) => i !== curIdx).sort((a, b) => a - b);
    if (!others.length) continue;
    out.set(it.id, `[${others.map((i) => i + 1).join(', ')}]`);
  }
  return out;
}

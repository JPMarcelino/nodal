import { BUILTIN, BUILTIN_SYMBOLS, MISSING_SYMBOL } from './symbols';
import { gridAlignSymbol, scaleSymbol } from './symbols/scale';
import type { CircuitDoc, ComponentItem, SymbolDef } from './types';

let userLibrary: Record<string, SymbolDef> = {};

export function setUserLibrary(lib: Record<string, SymbolDef>) {
  userLibrary = lib;
}

export function getUserLibrary(): Record<string, SymbolDef> {
  return userLibrary;
}

export function getSymbol(doc: Pick<CircuitDoc, 'symbols'>, id: string): SymbolDef {
  return doc.symbols[id] ?? userLibrary[id] ?? BUILTIN[id] ?? MISSING_SYMBOL;
}

const closedDefs = new WeakMap<SymbolDef, SymbolDef>();

/** The symbol in a part's switch state: its closed drawing when the part is closed and has one. */
export function stateSymbol(def: SymbolDef, c: Pick<ComponentItem, 'closed'>): SymbolDef {
  if (!c.closed || !def.closedPrims) return def;
  let out = closedDefs.get(def);
  if (!out) closedDefs.set(def, (out = { ...def, prims: def.closedPrims }));
  return out;
}

/** The drawing a placed part uses: its symbol in its switch state, at the part's size, pins on the grid. */
export function instanceSymbol(doc: Pick<CircuitDoc, 'symbols'>, c: Pick<ComponentItem, 'symbol' | 'scale' | 'closed'>): SymbolDef {
  return gridAlignSymbol(scaleSymbol(stateSymbol(getSymbol(doc, c.symbol), c), c.scale ?? 1));
}

/** A symbol that is an alternative drawing ("type") of another symbol. */
export const isVariant = (def: SymbolDef) => !!def.variantOf;

/** Resolves a symbol's declared alternative drawings to full symbol defs. */
export function variantDefs(doc: Pick<CircuitDoc, 'symbols'>, def: SymbolDef): SymbolDef[] {
  if (!def.variants?.length) return [];
  return def.variants.map((v) => getSymbol(doc, v.id)).filter((d) => d.id !== MISSING_SYMBOL.id);
}

/**
 * Every symbol the library should show as a top-level tile: user + document
 * symbols first, then built-ins, with variant drawings folded into their base
 * symbol and duplicates removed by id.
 */
export function librarySymbols(doc: Pick<CircuitDoc, 'symbols'> & Partial<Pick<CircuitDoc, 'items'>>): SymbolDef[] {
  const byId = new Map<string, SymbolDef>();
  for (const d of Object.values(userLibrary)) byId.set(d.id, d);
  // with the circuit's items given, its own symbols are listed only while parts use them
  // (so a symbol deleted from "My symbols" disappears once nothing uses it)
  const used = doc.items ? usedSymbols(doc as Pick<CircuitDoc, 'symbols' | 'items'>) : null;
  for (const d of Object.values(doc.symbols)) if (!byId.has(d.id) && (!used || used.has(d.id))) byId.set(d.id, d);
  for (const d of BUILTIN_SYMBOLS) if (!byId.has(d.id)) byId.set(d.id, d);
  return [...byId.values()].filter((d) => !isVariant(d));
}

/** Symbols that can act as a base for a new "type" in the symbol editor. */
export function baseSymbols(doc: Pick<CircuitDoc, 'symbols'>): SymbolDef[] {
  return librarySymbols(doc).sort((a, b) => a.name.localeCompare(b.name));
}

/** Symbols placed in the circuit, counting a base symbol as used when one of its types is. */
export function usedSymbols(doc: Pick<CircuitDoc, 'symbols' | 'items'>): Set<string> {
  const used = new Set<string>();
  for (const it of Object.values(doc.items)) {
    if (it.type !== 'component') continue;
    used.add(it.symbol);
    const base = doc.symbols[it.symbol]?.variantOf;
    if (base) used.add(base);
  }
  return used;
}

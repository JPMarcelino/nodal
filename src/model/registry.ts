import { BUILTIN, BUILTIN_SYMBOLS, MISSING_SYMBOL } from './symbols';
import type { CircuitDoc, SymbolDef } from './types';

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
export function librarySymbols(doc: Pick<CircuitDoc, 'symbols'>): SymbolDef[] {
  const byId = new Map<string, SymbolDef>();
  for (const d of Object.values(userLibrary)) byId.set(d.id, d);
  for (const d of Object.values(doc.symbols)) if (!byId.has(d.id)) byId.set(d.id, d);
  for (const d of BUILTIN_SYMBOLS) if (!byId.has(d.id)) byId.set(d.id, d);
  return [...byId.values()].filter((d) => !isVariant(d));
}

/** Symbols that can act as a base for a new "type" in the symbol editor. */
export function baseSymbols(doc: Pick<CircuitDoc, 'symbols'>): SymbolDef[] {
  return librarySymbols(doc).sort((a, b) => a.name.localeCompare(b.name));
}

import { BUILTIN, MISSING_SYMBOL } from './symbols';
import type { CircuitDoc, SymbolDef } from './types';

let userLibrary: Record<string, SymbolDef> = {};

export function setUserLibrary(lib: Record<string, SymbolDef>) {
  userLibrary = lib;
}

export function getSymbol(doc: Pick<CircuitDoc, 'symbols'>, id: string): SymbolDef {
  return doc.symbols[id] ?? userLibrary[id] ?? BUILTIN[id] ?? MISSING_SYMBOL;
}

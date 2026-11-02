import type { SymbolDef } from '../types';
import { sym } from './dsl';
import { passive } from './library/passive';
import { power } from './library/power';
import { semiconductors } from './library/semiconductors';
import { ics } from './library/ics';
import { logic } from './library/logic';
import { electromechanical } from './library/electromechanical';
import { output } from './library/output';
import { meters } from './library/meters';
import { connectors } from './library/connectors';

export const CATEGORY_ORDER = [
  'Passive',
  'Semiconductors',
  'ICs & Analog',
  'Logic',
  'Power & Sources',
  'Switches & Relays',
  'Output & Sensors',
  'Meters & Test',
  'Connectors & Labels',
];

export const BUILTIN_SYMBOLS: SymbolDef[] = [
  ...passive,
  ...semiconductors,
  ...ics,
  ...logic,
  ...power,
  ...electromechanical,
  ...output,
  ...meters,
  ...connectors,
];

/**
 * Pin marker of the symbol editor's page (see model/symbolPage): a tiny symbol
 * whose single port is the pin, named by its reference. Not in the library.
 */
export const PIN_SYMBOL = '__pin';
export const PIN_DEF: SymbolDef = sym(PIN_SYMBOL, 'Pin', 'Symbol pins', {
  w: 20,
  h: 20,
  prefix: '',
  draw: 'SC #f7768e\nW 1.5\nC 10 10 4\nL 10 4 10 16\nL 4 10 16 10',
  ports: 'p:10,10',
});

export const BUILTIN: Record<string, SymbolDef> = { ...Object.fromEntries(BUILTIN_SYMBOLS.map((s) => [s.id, s])), [PIN_SYMBOL]: PIN_DEF };

export const MISSING_SYMBOL: SymbolDef = sym('__missing', 'Missing symbol', 'Other', {
  w: 40,
  h: 40,
  prefix: 'U',
  draw: 'R 2 2 36 36; T 20 26 18 m ?',
  ports: '',
});

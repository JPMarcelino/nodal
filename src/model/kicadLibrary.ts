import { partSymbols, type KicadPart, type UnitDrawing } from '../io/kicadSymbols';
import { registerKicadSymbols } from './registry';
import type { SymbolDef } from './types';

/*
 * The KiCad symbol library online: an index of every part (fetched the first
 * time the library is searched or browsed) and one small file per drawing,
 * fetched when a part is shown. Built by scripts/build-kicad-library.ts and
 * served by the web app at ./kicad/ (the desktop app reads the hosted copy).
 */

export const KICAD_FORMAT = 1;

/** [library, name, drawing file, reference, value ('' = the name), description, keywords, units, power, datasheet, footprint] */
export type KicadEntry = [number, string, number, string, string, string, string, number, 0 | 1, string, string];

export interface KicadIndex {
  format: number;
  /** The kicad-symbols release the library was built from. */
  version: string;
  libs: { name: string; group: string }[];
  parts: KicadEntry[];
}

/** Browsing groups, in the order the library lists them. */
export const KICAD_GROUPS = [
  'Basic components',
  'Power symbols',
  'Diodes & transistors',
  'Amplifiers & comparators',
  'Analog, ADC & DAC',
  'Logic',
  'Microcontrollers & processors',
  'FPGAs & CPLDs',
  'Memory',
  'Power management',
  'Drivers',
  'Interfaces',
  'Isolators',
  'RF & wireless',
  'Sensors',
  'Timing & oscillators',
  'Displays & LEDs',
  'Audio & video',
  'Switches, relays & electromechanical',
  'Connectors',
  'Simulation',
  'Other',
] as const;

const GROUP_RULES: [RegExp, (typeof KICAD_GROUPS)[number]][] = [
  [/^(Device|Jumper|Potentiometer_Digital|Filter|Transformer)$/, 'Basic components'],
  [/^power$/, 'Power symbols'],
  [/^(Diode|Diode_|Transistor_|Triac_Thyristor|Valve)/, 'Diodes & transistors'],
  [/^(Amplifier_|Comparator|Buffer)/, 'Amplifiers & comparators'],
  [/^(Analog|Reference_)/, 'Analog, ADC & DAC'],
  [/^(74|4xxx|Logic_)/, 'Logic'],
  [/^(MCU_|CPU|DSP_|GPU)/, 'Microcontrollers & processors'],
  [/^(FPGA_|CPLD_)/, 'FPGAs & CPLDs'],
  [/^Memory_/, 'Memory'],
  [/^(Regulator_|Power_|Converter_|Battery_Management)/, 'Power management'],
  [/^Driver/, 'Drivers'],
  [/^(Interface|Fiber_Optic)/, 'Interfaces'],
  [/^Isolator/, 'Isolators'],
  [/^RF/, 'RF & wireless'],
  [/^Sensor/, 'Sensors'],
  [/^(Oscillator|Timer)/, 'Timing & oscillators'],
  [/^(Display_|LED)/, 'Displays & LEDs'],
  [/^(Audio|Video)$/, 'Audio & video'],
  [/^(Switch|Relay|Motor|Mechanical)/, 'Switches, relays & electromechanical'],
  [/^Connector/, 'Connectors'],
  [/^Simulation_/, 'Simulation'],
];

/** The browsing group of a KiCad library. */
export function kicadGroup(lib: string): string {
  return GROUP_RULES.find(([re]) => re.test(lib))?.[1] ?? 'Other';
}

/** Where the library is served: next to the web app, or the hosted copy for the desktop app. */
export function kicadBase(): string {
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  // a company build can serve the library from its own host (VITE_KICAD_URL=https://…/kicad/)
  const own = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_KICAD_URL : undefined;
  if (own) return own.endsWith('/') ? own : `${own}/`;
  if (tauri) return 'https://jpmarcelino.github.io/nodal/kicad/';
  const base = typeof import.meta !== 'undefined' ? (import.meta.env?.BASE_URL ?? './') : './';
  return `${base}kicad/`;
}

let indexPromise: Promise<KicadIndex> | null = null;

/** The index of every part (fetched once). */
export function loadKicadIndex(fetcher: typeof fetch = fetch): Promise<KicadIndex> {
  if (!indexPromise) {
    indexPromise = fetcher(`${kicadBase()}index.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`The KiCad library could not be loaded (${r.status})`);
        return r.json() as Promise<KicadIndex>;
      })
      .then((ix) => {
        if (ix.format !== KICAD_FORMAT) throw new Error('The KiCad library is a newer format: reload Nodal');
        return ix;
      })
      .catch((e) => {
        indexPromise = null;
        throw e;
      });
  }
  return indexPromise;
}

const entryPart = (e: KicadEntry): KicadPart => ({
  name: e[1],
  root: '',
  ref: e[3],
  value: e[4] || e[1],
  ...(e[5] ? { description: e[5] } : {}),
  ...(e[6] ? { keywords: e[6] } : {}),
  ...(e[8] ? { power: true } : {}),
  ...(e[9] ? { datasheet: e[9] } : {}),
  ...(e[10] ? { footprint: e[10] } : {}),
});

/** Search text of each entry, lower-cased (built once per index). */
const haystacks = new WeakMap<KicadIndex, string[]>();

/**
 * Parts matching every word of `query`, best first: exact names, then names
 * starting with a word, then names containing it, then keywords, descriptions
 * and library names.
 */
export function searchKicad(ix: KicadIndex, query: string, limit = 60): KicadEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  let hay = haystacks.get(ix);
  if (!hay) {
    hay = ix.parts.map((e) => `${e[1]} ${e[4]} ${e[3]} ${e[6]} ${e[5]} ${ix.libs[e[0]].name.replace(/_/g, ' ')}`.toLowerCase());
    haystacks.set(ix, hay);
  }
  const scored: { e: KicadEntry; s: number }[] = [];
  for (let i = 0; i < ix.parts.length; i++) {
    const h = hay[i];
    if (!words.every((w) => h.includes(w))) continue;
    const e = ix.parts[i];
    const name = e[1].toLowerCase();
    let s = 0;
    for (const w of words) s += name === w ? 100 : name.startsWith(w) ? 60 : name.includes(w) ? 40 : 10;
    // generic parts (the Device and power libraries) before specific ones
    const lib = ix.libs[e[0]].name;
    if (lib === 'Device' || lib === 'power') s += 15;
    // shorter names are the more general match
    s -= Math.min(10, name.length / 4);
    scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s || a.e[1].localeCompare(b.e[1]));
  return scored.slice(0, limit).map((x) => x.e);
}

/** Parts of one library, by name. */
export function kicadLibParts(ix: KicadIndex, lib: number): KicadEntry[] {
  return ix.parts.filter((e) => e[0] === lib).sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true }));
}

const drawings = new Map<string, Promise<UnitDrawing[]>>();

/** Every symbol (first unit, then the other units as its types) of an entry, fetching its drawing if needed. */
export async function loadKicadPart(ix: KicadIndex, e: KicadEntry, fetcher: typeof fetch = fetch): Promise<SymbolDef[]> {
  const lib = ix.libs[e[0]].name;
  const key = `${lib}/${e[2]}`;
  let p = drawings.get(key);
  if (!p) {
    p = fetcher(`${kicadBase()}d/${key}.json`).then((r) => {
      if (!r.ok) throw new Error(`Symbol ${e[1]} could not be loaded (${r.status})`);
      return r.json() as Promise<UnitDrawing[]>;
    });
    drawings.set(key, p);
    p.catch(() => drawings.delete(key));
  }
  return partSymbols(lib, entryPart(e), await p, `KiCad: ${lib}`);
}

/* ------------------------------------------------------------------ */
/* Loaded symbols                                                      */
/* ------------------------------------------------------------------ */

const listeners = new Set<() => void>();
let epoch = 0;

/** Subscribes to "more KiCad symbols were loaded" (for useSyncExternalStore). */
export function onKicadLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A number that changes whenever KiCad symbols are loaded. */
export const kicadEpoch = () => epoch;

/** Loads the entries' symbols and makes them available to getSymbol; returns each entry's first unit. */
export async function loadKicadEntries(ix: KicadIndex, entries: KicadEntry[], fetcher: typeof fetch = fetch): Promise<SymbolDef[]> {
  const loaded = await Promise.all(entries.map((e) => loadKicadPart(ix, e, fetcher).catch(() => [] as SymbolDef[])));
  registerKicadSymbols(loaded.flat());
  epoch++;
  for (const fn of listeners) fn();
  return loaded.flatMap((defs) => (defs[0] ? [defs[0]] : []));
}

/** The entry a symbol id (`kicad:Library:Name`, maybe with a `#unit`) came from. */
export function kicadEntryOf(ix: KicadIndex, id: string): KicadEntry | undefined {
  const m = /^kicad:([^:]+):(.+?)(?:#[A-Z])?$/.exec(id);
  if (!m) return undefined;
  const li = ix.libs.findIndex((l) => l.name === m[1]);
  return li < 0 ? undefined : ix.parts.find((e) => e[0] === li && e[1] === m[2]);
}

import type { ComponentItem, SymbolDef } from './types';

/** Sourcing / layout fields every real part can carry (stored in `props` under these keys). */
export const PART_FIELDS = [
  { key: 'footprint', label: 'Footprint', placeholder: 'e.g. R_0603' },
  { key: 'manufacturer', label: 'Manufacturer', placeholder: 'e.g. Yageo' },
  { key: 'mpn', label: 'Part number', placeholder: 'Manufacturer part no.' },
  { key: 'supplier', label: 'Supplier', placeholder: 'e.g. Digi-Key' },
  { key: 'supplier_pn', label: 'Supplier no.', placeholder: 'Supplier part no.' },
  { key: 'datasheet', label: 'Datasheet', placeholder: 'https://…' },
] as const;

/** "Do not populate" flag key; the part stays in the drawing but is left off the board. */
export const DNP = 'dnp';

const STANDARD = new Set<string>([...PART_FIELDS.map((f) => f.key), DNP]);

export const isDnp = (c: Pick<ComponentItem, 'props'>) => c.props[DNP] === '1';

/** Real parts (not labels, rails or flags) get sourcing fields. */
export const hasPartFields = (def: SymbolDef) => !def.prefix.startsWith('#') && !def.valueIsLabel;

/** Fields the user added themselves: any prop that is neither a symbol field nor a standard one. */
export function customFieldKeys(c: Pick<ComponentItem, 'props'>, def: SymbolDef): string[] {
  const own = new Set((def.fields ?? []).map((f) => f.key));
  return Object.keys(c.props).filter((k) => !own.has(k) && !STANDARD.has(k));
}

/** Label for any prop key of a part. */
export function fieldLabel(key: string, def: SymbolDef): string {
  return def.fields?.find((f) => f.key === key)?.label ?? PART_FIELDS.find((f) => f.key === key)?.label ?? key;
}

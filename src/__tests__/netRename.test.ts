import { describe, expect, it } from 'vitest';
import { createDoc, makeComponent, uid } from '../model/doc';
import { netLabelsNamed, renameNetLabels } from '../model/netlist';
import { addPage, docPages } from '../model/pages';
import type { CircuitDoc, ComponentItem, WireItem } from '../model/types';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

function place(doc: CircuitDoc, symbol: string, x: number, y: number, page?: string): ComponentItem {
  const c = makeComponent(doc, symbol, x, y);
  if (page) c.page = page;
  doc.items[c.id] = c;
  return c;
}

function freeWire(doc: CircuitDoc, label: string, page?: string, extra: Partial<WireItem> = {}): WireItem {
  const w: WireItem = {
    id: uid('w'),
    type: 'wire',
    a: { kind: 'free', x: 0, y: 0 },
    b: { kind: 'free', x: 100, y: 0 },
    pts: [],
    label,
    ...(page ? { page } : {}),
    ...extra,
  };
  doc.items[w.id] = w;
  return w;
}

async function setup(doc: CircuitDoc) {
  const store = await import('../store/store');
  const A = await import('../store/actions');
  store.set({ doc, page: undefined, scope: undefined, selection: [], past: [], future: [], viewOnly: false, viewMode: false, tool: 'select', placing: null, toasts: [] });
  return { ...store, A };
}

describe('netLabelsNamed', () => {
  it('finds wire labels and net-label / rail parts on every page, hidden or not', () => {
    const doc = createDoc();
    const second = addPage(doc, 'Sheet 2');
    const first = docPages(doc)[0].id;
    const wire1 = freeWire(doc, 'SDA', first);
    const wire2 = freeWire(doc, '  SDA  ', second, { labelHidden: true });
    const label1 = place(doc, 'net-label', 0, 0, first);
    label1.value = 'SDA';
    const label2 = place(doc, 'net-label', 0, 0, second);
    label2.value = 'SDA';
    const rail = place(doc, 'vcc', 0, 0, second);
    rail.value = 'SDA';
    const other = freeWire(doc, 'SCL', first);

    const ids = netLabelsNamed(doc, ' SDA ');
    expect(ids).toHaveLength(5);
    expect(ids).toEqual(expect.arrayContaining([wire1.id, wire2.id, label1.id, label2.id, rail.id]));
    expect(ids).not.toContain(other.id);
    expect(netLabelsNamed(doc, '')).toEqual([]);
  });
});

describe('renameNetLabels', () => {
  it('renames every wire label, net label and rail across pages and leaves other nets alone', () => {
    const doc = createDoc();
    const second = addPage(doc, 'Sheet 2');
    const first = docPages(doc)[0].id;
    const wire1 = freeWire(doc, 'SDA', first);
    const wire2 = freeWire(doc, 'SDA', second, { labelHidden: true });
    const label = place(doc, 'net-label', 0, 0, second);
    label.value = 'SDA';
    const rail = place(doc, 'vcc', 0, 0, second);
    rail.value = 'SDA';
    const other = freeWire(doc, 'SCL', first);

    expect(renameNetLabels(doc, ' SDA ', ' MOSI ')).toEqual({ changed: 4, locked: 0 });

    expect(wire1.label).toBe('MOSI');
    expect(wire2.label).toBe('MOSI');
    expect(label.value).toBe('MOSI');
    expect(rail.value).toBe('MOSI');
    expect(other.label).toBe('SCL');
    expect(netLabelsNamed(doc, 'SDA')).toEqual([]);
    expect(netLabelsNamed(doc, 'MOSI')).toHaveLength(4);
  });

  it('matches a symbol default when the part value is empty, then writes an explicit value', () => {
    const doc = createDoc();
    const label = place(doc, 'net-label', 0, 0);
    label.value = '';
    const rail = place(doc, 'vcc', 0, 0);
    rail.value = '';

    expect(netLabelsNamed(doc, 'NET')).toEqual([label.id]);
    expect(netLabelsNamed(doc, 'VCC')).toEqual([rail.id]);

    expect(renameNetLabels(doc, ' NET ', ' MISO ')).toEqual({ changed: 1, locked: 0 });
    expect(label.value).toBe('MISO');
    expect(rail.value).toBe('');

    expect(renameNetLabels(doc, 'VCC', '+3V3')).toEqual({ changed: 1, locked: 0 });
    expect(rail.value).toBe('+3V3');
  });

  it('does nothing for empty or effectively unchanged names', () => {
    const doc = createDoc();
    const wire = freeWire(doc, '  SDA  ');
    expect(renameNetLabels(doc, ' SDA ', 'SDA')).toEqual({ changed: 0, locked: 0 });
    expect(wire.label).toBe('  SDA  ');
    expect(renameNetLabels(doc, '', 'MOSI')).toEqual({ changed: 0, locked: 0 });
    expect(renameNetLabels(doc, 'SDA', '  ')).toEqual({ changed: 0, locked: 0 });
    expect(wire.label).toBe('  SDA  ');
  });

  it('reports locked matches and leaves them unchanged', () => {
    const doc = createDoc();
    const free = freeWire(doc, 'SDA');
    const locked = freeWire(doc, 'SDA', undefined, { locked: true });

    expect(renameNetLabels(doc, 'SDA', 'MOSI')).toEqual({ changed: 1, locked: 1 });
    expect(free.label).toBe('MOSI');
    expect(locked.label).toBe('SDA');
  });
});

describe('renameNet action', () => {
  it('renames every page as one undo step', async () => {
    const doc = createDoc();
    const second = addPage(doc, 'Sheet 2');
    const first = docPages(doc)[0].id;
    const wire1 = freeWire(doc, 'SDA', first);
    const wire2 = freeWire(doc, 'SDA', second);
    const label = place(doc, 'net-label', 0, 0, second);
    label.value = 'SDA';

    const { S, A, undo } = await setup(doc);
    await A.renameNet('SDA', 'MOSI');

    expect((S().doc.items[wire1.id] as WireItem).label).toBe('MOSI');
    expect((S().doc.items[wire2.id] as WireItem).label).toBe('MOSI');
    expect((S().doc.items[label.id] as ComponentItem).value).toBe('MOSI');
    expect(S().past).toHaveLength(1);

    undo();
    expect(S().doc).toBe(doc);
    expect((S().doc.items[wire1.id] as WireItem).label).toBe('SDA');
    expect((S().doc.items[wire2.id] as WireItem).label).toBe('SDA');
  });

  it('touches nothing and asks the user to unlock a locked match', async () => {
    const doc = createDoc();
    const free = freeWire(doc, 'SDA');
    freeWire(doc, 'SDA', undefined, { locked: true });

    const { S, A } = await setup(doc);
    const before = JSON.stringify(S().doc);
    await A.renameNet('SDA', 'MOSI');

    expect(JSON.stringify(S().doc)).toBe(before);
    expect(S().past).toHaveLength(0);
    expect(S().toasts.some((t) => /locked/i.test(t.text))).toBe(true);
  });

  it('asks before joining a name already used by another net, and cancelling leaves the document alone', async () => {
    const doc = createDoc();
    freeWire(doc, 'SDA');
    freeWire(doc, 'SCL');

    const { S, A } = await setup(doc);
    const before = JSON.stringify(S().doc);
    const pending = A.renameNet('SDA', 'SCL');
    const askMod = await import('../ui/Ask');
    expect(askMod.useAsk.getState().q?.title).toBe('Rename and join?');
    askMod.useAsk.getState().q!.resolve(false);
    askMod.useAsk.setState({ q: null });
    await pending;

    expect(JSON.stringify(S().doc)).toBe(before);
    expect(S().past).toHaveLength(0);
  });

  it('cannot rename in a view-only live session', async () => {
    const doc = createDoc();
    freeWire(doc, 'SDA');
    const { S, A, set } = await setup(doc);
    set({ viewOnly: true });
    const before = JSON.stringify(S().doc);

    await A.renameNet('SDA', 'MOSI');

    expect(JSON.stringify(S().doc)).toBe(before);
    expect(S().past).toHaveLength(0);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

// the store touches window / localStorage when it loads
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
(g.window as Record<string, unknown>).addEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { createDoc } = await import('../model/doc');
const store = await import('../store/store');
const { runCall } = await import('../agent/run');
const { installGuard } = await import('../agent/guard');
const { A, setAgent } = await import('../agent/state');
const { clearSteps } = await import('../agent/tx');
const { default: catalog } = await import('../agent/catalog.json');
const { METHODS } = await import('../agent/api');
const { paramSchema, methodSchema, toolResult } = await import('../../agent-bridge/nodal-agent.mjs');

const { S, mutate, undo, beginGesture, gestureUpdate, endGesture } = store;

/** Runs a call and returns its result, failing the test on an error. */
async function call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await runCall(method, params);
  if (r.error) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
}

beforeEach(() => {
  store.replaceDoc(createDoc('Test'));
  store.set({ viewOnly: false, viewMode: false });
  clearSteps();
  setAgent({ status: 'idle', owned: new Set(), page: undefined, guard: 'items', follow: false, log: [], cursor: null });
  installGuard();
});

describe('agent catalog', () => {
  it('has a handler for every method and a method for every handler', () => {
    const names = catalog.methods.map((m) => m.name).sort();
    expect(Object.keys(METHODS).sort()).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
  });

  it('turns compact parameter specs into JSON schemas', () => {
    expect(paramSchema('number — centre')).toEqual({ type: 'number', description: 'centre' });
    expect(paramSchema('0|90|180|270')).toEqual({ type: 'number', enum: [0, 90, 180, 270] });
    expect(paramSchema('ortho|45|any')).toEqual({ type: 'string', enum: ['ortho', '45', 'any'] });
    expect(paramSchema('string[]')).toEqual({ type: 'array', items: { type: 'string' } });
    expect(paramSchema('any — doc')).toEqual({ description: 'doc' });
    const s = methodSchema({ params: { 'ids': 'string[]', 'page?': 'string' } });
    expect(s.required).toEqual(['ids']);
    for (const m of catalog.methods) expect(() => methodSchema(m as unknown as { params: Record<string, string> })).not.toThrow();
  });

  it('gives MCP an image for screenshots and an error flag for failures', () => {
    const img = toolResult({ result: { mime: 'image/png', base64: 'AAA', bounds: { x: 0 } } });
    expect(img.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'AAA' });
    expect(toolResult({ error: { code: 'x', message: 'y' } }).isError).toBe(true);
  });
});

describe('agent edits', () => {
  it('places parts, wires them by pin and reads the net back', async () => {
    await call('session.start', { name: 'Tester', goal: 'RC filter' });
    const r = await call<{ id: string; ref: string; pins: { id: string; x: number; y: number }[] }>('components.place', { symbol: 'resistor', x: 100, y: 100, value: '10k' });
    const c = await call<{ id: string; ref: string }>('components.place', { symbol: 'capacitor', x: 260, y: 160, rot: 90, value: '100n' });
    expect(r.ref).toBe('R1');
    expect(r.pins.length).toBe(2);
    const w = await call<{ id: string }>('wires.connect', { from: { ref: 'R1', port: '2' }, to: { ref: c.ref, port: 1 }, label: 'OUT' });
    const doc = S().doc;
    expect(doc.items[w.id]).toMatchObject({ type: 'wire', label: 'OUT', a: { kind: 'port', comp: r.id }, b: { kind: 'port', comp: c.id } });
    const net = await call<{ name: string; pins: string[] }>('nets.of', { comp: 'R1', port: '2' });
    expect(net.pins.sort()).toEqual(['C1.1', 'R1.2'].sort());
    // the user's selection, tool and undo stack are untouched
    expect(S().selection).toEqual([]);
    expect(S().past.length).toBe(0);
    expect(A().owned.has(r.id) && A().owned.has(w.id)).toBe(true);
  });

  it('runs a batch as one step, with references to earlier results', async () => {
    const res = await call<{ results: { id: string }[] }>('batch', {
      label: 'divider',
      calls: [
        { method: 'components.place', params: { symbol: 'resistor', x: 0, y: 0 } },
        { method: 'components.place', params: { symbol: 'resistor', x: 0, y: 120, rot: 90 } },
        { method: 'wires.connect', params: { from: { comp: '$0.id', port: '2' }, to: { comp: '$1.id', port: '1' } } },
      ],
    });
    expect(res.results).toHaveLength(3);
    expect(S().doc.items[res.results[2].id]?.type).toBe('wire');
    expect((await call<unknown[]>('history.steps')).length).toBe(1);
  });

  it('rolls a failing batch back completely', async () => {
    const r = await runCall('batch', { calls: [{ method: 'components.place', params: { symbol: 'resistor', x: 0, y: 0 } }, { method: 'items.delete', params: { ids: ['nope'] } }] });
    expect(r.error?.message).toMatch(/calls\[1\]/);
    expect(Object.keys(S().doc.items)).toHaveLength(0);
  });

  it('keeps its own undo apart from the user’s', async () => {
    const { id } = await call<{ id: string }>('components.place', { symbol: 'resistor', x: 0, y: 0 });
    // the user's own edit, then the user's undo: the agent's part stays
    mutate((d) => void (d.name = 'Renamed by user'));
    undo();
    expect(S().doc.items[id]).toBeTruthy();
    await call('history.undo');
    expect(S().doc.items[id]).toBeUndefined();
    await call('history.redo');
    expect(S().doc.items[id]).toBeTruthy();
  });

  it('refuses to undo over the user’s later change unless forced', async () => {
    setAgent({ guard: 'off' });
    const { id } = await call<{ id: string }>('components.place', { symbol: 'resistor', x: 0, y: 0 });
    mutate((d) => void ((d.items[id] as { value: string }).value = '1M'));
    const r = await runCall('history.undo');
    expect(r.error?.code).toBe('conflict');
    await call('history.undo', { force: true });
    expect(S().doc.items[id]).toBeUndefined();
  });

  it('works on its own page without moving the user', async () => {
    const pg = await call<{ id: string }>('pages.add', { name: 'Power' });
    await call('session.setPage', { page: 'power' });
    const { id } = await call<{ id: string }>('components.place', { symbol: 'resistor', x: 0, y: 0 });
    expect(S().doc.items[id].page).toBe(pg.id);
    expect(store.activePage()).not.toBe(pg.id);
    const listed = await call<{ id: string; agentPage: boolean }[]>('pages.list');
    expect(listed.find((p) => p.id === pg.id)?.agentPage).toBe(true);
  });

  it('updates, moves, styles and deletes by id or reference', async () => {
    const { id } = await call<{ id: string }>('components.place', { symbol: 'resistor', x: 0, y: 0 });
    await call('items.update', { ids: ['R1'], patch: { value: '47k', props: {} } });
    await call('items.move', { ids: [id], dx: 20, dy: 10 });
    await call('items.style', { ids: [id], look: { line: '#ff0000' } });
    const it = S().doc.items[id] as { value: string; x: number; y: number; color?: string };
    expect(it).toMatchObject({ value: '47k', x: 20, y: 10, color: '#ff0000' });
    await call('items.delete', { ids: ['R1'] });
    expect(S().doc.items[id]).toBeUndefined();
  });

  it('adds shapes, connectors and notes', async () => {
    const a = await call<{ id: string }>('shapes.add', { kind: 'rect', x: 0, y: 0, w: 100, h: 60, text: 'Input' });
    const b = await call<{ id: string }>('shapes.add', { kind: 'ellipse', x: 300, y: 0, w: 80, h: 80 });
    const arrow = await call<{ id: string }>('shapes.connect', { from: a.id, to: b.id });
    expect(S().doc.items[arrow.id]).toMatchObject({ kind: 'arrow', from: { id: a.id }, to: { id: b.id } });
    const poly = await call<{ id: string }>('shapes.add', { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 }] });
    expect((S().doc.items[poly.id] as { poly: number[] }).poly).toHaveLength(6);
    const note = await call<{ id: string }>('shapes.note', { ids: [a.id], text: 'Signal enters here' });
    expect(S().doc.items[note.id]).toMatchObject({ kind: 'callout', text: 'Signal enters here' });
  });

  it('creates a custom symbol from DSL and places it', async () => {
    const s = await call<{ id: string; pins: unknown[] }>('symbols.create', { name: 'Box', w: 40, h: 40, draw: 'R 0 0 40 40', ports: 'in:0,20 out:40,20', saveToLibrary: false });
    expect(s.pins).toHaveLength(2);
    const p = await call<{ pins: { name: string }[] }>('components.place', { symbol: s.id, x: 0, y: 0 });
    expect(p.pins.map((q) => q.name)).toEqual(['in', 'out']);
  });

  it('copies items out as a template and back in', async () => {
    await call('components.place', { symbol: 'resistor', x: 0, y: 0 });
    await call('components.place', { symbol: 'resistor', x: 200, y: 0 });
    await call('wires.connect', { from: { ref: 'R1', port: '2' }, to: { ref: 'R2', port: '1' } });
    const all = Object.keys(S().doc.items);
    const tpl = await call('items.template', { ids: all });
    const back = await call<{ ids: string[] }>('doc.insert', { doc: tpl, dy: 200 });
    expect(back.ids.length).toBe(all.length);
    expect(Object.keys(S().doc.items).length).toBe(all.length * 2);
  });

  it('cuts a wire segment and turns a box into a path', async () => {
    const w = await call<{ id: string }>('wires.path', { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }] });
    await call('wires.deletePart', { id: w.id, kind: 'segment', index: 1 });
    expect(Object.values(S().doc.items).filter((i) => i.type === 'wire')).toHaveLength(2);
    const r = await call<{ id: string }>('shapes.add', { kind: 'rect', x: 0, y: 0, w: 50, h: 50 });
    await call('shapes.toPath', { ids: [r.id] });
    expect(S().doc.items[r.id]).toMatchObject({ kind: 'polygon' });
  });

  it('reports errors with codes', async () => {
    expect((await runCall('nope.nope')).error?.code).toBe('unknown_method');
    expect((await runCall('components.place', { symbol: 'no-such-symbol', x: 0, y: 0 })).error?.code).toBe('not_found');
    expect((await runCall('wires.connect', { from: { ref: 'R9', port: 1 }, to: { x: 0, y: 0 } })).error?.code).toBe('not_found');
  });

  it('respects a read-only app', async () => {
    store.set({ viewMode: true });
    expect((await runCall('components.place', { symbol: 'resistor', x: 0, y: 0 })).error?.code).toBe('read_only');
    // reading still works
    expect((await runCall('doc.summary')).error).toBeUndefined();
  });
});

describe('the guard', () => {
  it('keeps the user’s edits off the agent’s items while it works', async () => {
    await call('session.start', { name: 'Tester' });
    const { id } = await call<{ id: string }>('components.place', { symbol: 'resistor', x: 0, y: 0 });
    expect(mutate((d) => void ((d.items[id] as { value: string }).value = 'user'))).toBe(false);
    expect((S().doc.items[id] as { value: string }).value).not.toBe('user');
    // other edits are fine
    expect(mutate((d) => void (d.name = 'mine'))).toBe(true);
    // a drag of the agent's part is held back, and dropped on release
    beginGesture();
    gestureUpdate((d) => void ((d.items[id] as { x: number }).x = 500));
    endGesture();
    expect((S().doc.items[id] as { x: number }).x).toBe(0);
    // done lifts it
    await call('session.done', { summary: 'ok' });
    expect(mutate((d) => void ((d.items[id] as { value: string }).value = 'user'))).toBe(true);
  });

  it('locks the whole circuit in "all" mode and nothing when off', async () => {
    await call('session.start');
    setAgent({ guard: 'all' });
    expect(mutate((d) => void (d.name = 'x'))).toBe(false);
    setAgent({ guard: 'off' });
    expect(mutate((d) => void (d.name = 'x'))).toBe(true);
  });
});

describe('agent setup', () => {
  it('gives PowerShell steps on Windows and shell steps elsewhere', async () => {
    const { agentSetupPrompt, setupSteps } = await import('../agent/setup');
    const win = setupSteps('windows');
    expect(win.download).toMatch(/^iwr https:\/\/jpmarcelino\.github\.io\/nodal\/nodal-agent\.mjs -OutFile "\$env:USERPROFILE\\nodal-agent\.mjs"$/);
    expect(win.run).toBe('Start-Process node -ArgumentList "$env:USERPROFILE\\nodal-agent.mjs" -WindowStyle Hidden');
    expect(setupSteps('unix').download).toBe('curl -fsSL https://jpmarcelino.github.io/nodal/nodal-agent.mjs -o ~/nodal-agent.mjs');
    setAgent({ url: 'ws://127.0.0.1:5000/app' });
    expect(setupSteps('windows').call).toBe('node "$env:USERPROFILE\\nodal-agent.mjs" --port 5000 call');
    expect(agentSetupPrompt('windows')).toContain('http://127.0.0.1:5000/rpc');
    setAgent({ url: 'ws://127.0.0.1:47821/app' });
  });
});

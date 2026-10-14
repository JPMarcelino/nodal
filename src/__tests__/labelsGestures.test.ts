import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, labelsShown, normalizeDoc } from '../model/doc';
import type { CircuitDoc } from '../model/types';

const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

afterEach(async () => {
  const { endGesture, inGesture } = await import('../store/store');
  if (inGesture()) endGesture(false);
});

describe('labelsShown doc-wide hide switches', () => {
  const both = { showRef: true, showValue: true };
  const plain = { valueIsLabel: false };
  const asLabel = { valueIsLabel: true };

  it('shows both labels by default', () => {
    expect(labelsShown({}, both, plain)).toEqual({ ref: true, value: true });
  });

  it('hideRefs hides refs but leaves values alone', () => {
    expect(labelsShown({ hideRefs: true }, both, plain)).toEqual({ ref: false, value: true });
  });

  it('hideValues hides values but leaves refs alone', () => {
    expect(labelsShown({ hideValues: true }, both, plain)).toEqual({ ref: true, value: false });
  });

  it('keeps valueIsLabel names visible under hideValues', () => {
    expect(labelsShown({ hideValues: true }, both, asLabel)).toEqual({ ref: true, value: true });
  });

  it('hideRefs still hides the ref of a valueIsLabel part', () => {
    expect(labelsShown({ hideRefs: true, hideValues: true }, both, asLabel)).toEqual({ ref: false, value: true });
  });

  it('per-part flags hide regardless of the doc switches', () => {
    expect(labelsShown({}, { showRef: false, showValue: true }, plain)).toEqual({ ref: false, value: true });
    expect(labelsShown({}, { showRef: true, showValue: false }, asLabel)).toEqual({ ref: true, value: false });
    expect(labelsShown({ hideRefs: true, hideValues: true }, { showRef: false, showValue: false }, asLabel)).toEqual({
      ref: false,
      value: false,
    });
  });
});

describe('hide switches ride along with the doc', () => {
  it('defaults to visible and survives normalizeDoc', () => {
    expect(DEFAULT_SETTINGS.hideWireLabels).toBeFalsy();
    const doc = normalizeDoc({
      format: 'nodal',
      items: {},
      settings: { hideRefs: true, hideValues: true, hideWireLabels: true },
    });
    expect(doc.settings.hideRefs).toBe(true);
    expect(doc.settings.hideValues).toBe(true);
    expect(doc.settings.hideWireLabels).toBe(true);
  });
});

describe('gesture undo/rebase semantics', () => {
  async function freshStore() {
    const store = await import('../store/store');
    const { createDoc, makeShape } = await import('../model/doc');
    const { produce } = await import('immer');
    const doc = produce(createDoc('T'), (d) => {
      const a = makeShape(d as CircuitDoc, 'rect', 0, 0, 20, 20);
      a.id = 'a';
      d.items[a.id] = a;
    });
    store.replaceDoc(doc);
    return store;
  }

  const moveA = (x: number) => (d: { items: Record<string, unknown> }) =>
    void (((d.items['a'] as unknown as { x: number }).x = x));
  const xOf = (doc: CircuitDoc, id: string) => (doc.items[id] as unknown as { x: number }).x;

  it('records no history mid-gesture; commit pushes the pre-gesture doc once', async () => {
    const { S, mutate, beginGesture, gestureUpdate, endGesture, undo } = await freshStore();
    const before = S().doc;
    beginGesture();
    gestureUpdate(moveA(50));
    expect(xOf(S().doc, 'a')).toBe(50);
    expect(S().past).toHaveLength(0);
    mutate((d) => void (d.name = 'mid-gesture'));
    expect(S().past).toHaveLength(0);
    gestureUpdate(moveA(70));
    expect(xOf(S().doc, 'a')).toBe(70);
    endGesture(true);
    expect(S().past).toHaveLength(1);
    expect(S().past[0]).toBe(before);
    expect(xOf(S().past[0], 'a')).toBe(0);
    undo();
    expect(xOf(S().doc, 'a')).toBe(0);
  });

  it('cancel restores the exact pre-gesture doc, not the latest base', async () => {
    const { S, beginGesture, gestureUpdate, rebaseGesture, endGesture } = await freshStore();
    const before = S().doc;
    beginGesture();
    gestureUpdate(moveA(50));
    rebaseGesture();
    gestureUpdate(moveA(90));
    expect(xOf(S().doc, 'a')).toBe(90);
    endGesture(false);
    expect(S().doc).toBe(before);
    expect(xOf(S().doc, 'a')).toBe(0);
    expect(S().past).toHaveLength(0);
  });

  it('rebaseGesture chains updates while undo stays anchored at the gesture start', async () => {
    const { S, beginGesture, gestureUpdate, rebaseGesture, endGesture, undo } = await freshStore();
    beginGesture();
    gestureUpdate((d) => void (((d.items['a'] as unknown as { x: number }).x += 50)));
    expect(xOf(S().doc, 'a')).toBe(50);
    rebaseGesture();
    gestureUpdate((d) => void (((d.items['a'] as unknown as { x: number }).x += 10)));
    expect(xOf(S().doc, 'a')).toBe(60);
    endGesture(true);
    expect(S().past).toHaveLength(1);
    expect(xOf(S().past[0], 'a')).toBe(0);
    undo();
    expect(xOf(S().doc, 'a')).toBe(0);
  });

  it('copyInPlace stages with no history; Esc discards the staged items', async () => {
    const { S, set, beginGesture, gestureUpdate, endGesture } = await freshStore();
    const { copyInPlace } = await import('../store/actions');
    set({ selection: ['a'] });
    const pre = S().doc;
    const ids = copyInPlace();
    expect(ids).toHaveLength(1);
    expect(Object.keys(S().doc.items)).toHaveLength(2);
    expect(S().past).toHaveLength(0);
    beginGesture(pre);
    gestureUpdate((d) => void (((d.items[ids[0]] as unknown as { x: number }).x = 999)));
    expect(xOf(S().doc, ids[0])).toBe(999);
    endGesture(false);
    expect(S().doc).toBe(pre);
    expect(S().doc.items[ids[0]]).toBeUndefined();
    expect(S().past).toHaveLength(0);
  });

  it('copyInPlace commit keeps the staged items under a single undo step', async () => {
    const { S, set, beginGesture, gestureUpdate, endGesture, undo } = await freshStore();
    const { copyInPlace } = await import('../store/actions');
    set({ selection: ['a'] });
    const pre = S().doc;
    const ids = copyInPlace();
    beginGesture(pre);
    gestureUpdate((d) => void (((d.items[ids[0]] as unknown as { x: number }).x = 999)));
    endGesture(true);
    expect(Object.keys(S().doc.items)).toHaveLength(2);
    expect(xOf(S().doc, ids[0])).toBe(999);
    expect(S().past).toHaveLength(1);
    expect(S().past[0]).toBe(pre);
    undo();
    expect(S().doc).toBe(pre);
    expect(Object.keys(S().doc.items)).toHaveLength(1);
  });
});

import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Eye, EyeOff, OctagonAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ERC_RULES, runErc, splitIgnored, type ErcIssue, type ErcRule } from '../model/erc';
import type { CircuitDoc } from '../model/types';
import * as A from '../store/actions';
import { goToItems, mutate, select, set, useStore } from '../store/store';
import { useSettledDoc } from './useSettledDoc';

/** One rule check per document, shared by the tab badge, the panel and the canvas markers. */
const ercCache = new WeakMap<CircuitDoc, ErcIssue[]>();
function ercOf(doc: CircuitDoc): ErcIssue[] {
  let issues = ercCache.get(doc);
  if (!issues) ercCache.set(doc, (issues = runErc(doc)));
  return issues;
}

/** Rule-check findings for the current circuit, re-run once edits pause (not on every drag frame). */
export function useErcResult(enabled = true): { active: ErcIssue[]; ignored: ErcIssue[] } {
  const checked = useSettledDoc();
  const all = useMemo(() => (enabled ? ercOf(checked) : []), [checked, enabled]);
  const ignoredKeys = useStore((s) => s.doc.settings.ercIgnored);
  return useMemo(() => splitIgnored(all, ignoredKeys), [all, ignoredKeys]);
}

export function useErcIssues(enabled = true): ErcIssue[] {
  return useErcResult(enabled).active;
}

function ignoreIssue(key: string) {
  mutate((d) => {
    const list = d.settings.ercIgnored ?? [];
    if (!list.includes(key)) d.settings.ercIgnored = [...list, key];
  });
}

function restoreIssue(key: string) {
  mutate((d) => {
    d.settings.ercIgnored = (d.settings.ercIgnored ?? []).filter((k) => k !== key);
  });
}

function restoreAll() {
  mutate((d) => {
    d.settings.ercIgnored = [];
  });
}

/** Electrical rules check: a live list of likely mistakes; click one to select and show it. */
export function CheckPanel() {
  const doc = useStore((s) => s.doc);
  const { active: issues, ignored } = useErcResult();
  const [only, setOnly] = useState<'all' | 'error'>('all');
  const [closed, setClosed] = useState<Set<ErcRule>>(new Set());
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  useEffect(() => () => set({ layerHover: [] }), []);

  const shown = only === 'error' ? issues.filter((i) => i.severity === 'error') : issues;
  const groups = new Map<ErcRule, ErcIssue[]>();
  for (const i of shown) groups.set(i.rule, [...(groups.get(i.rule) ?? []), i]);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;

  const reveal = (i: ErcIssue) => {
    // a finding on another page switches to it
    const ids = goToItems(i.items.filter((id) => doc.items[id]));
    select(ids);
    A.revealItems(ids, i.at);
  };

  return (
    <div className="check-panel">
      <div className="check-summary">
        {issues.length ? (
          <>
            <span className={errors ? 'check-count error' : 'check-count'}>
              <OctagonAlert size={14} /> {errors} error{errors === 1 ? '' : 's'}
            </span>
            <span className="check-count warning">
              <AlertTriangle size={14} /> {warnings} warning{warnings === 1 ? '' : 's'}
            </span>
            <span className="spacer" />
            <button className={only === 'error' ? 'chip active' : 'chip'} onClick={() => setOnly(only === 'error' ? 'all' : 'error')} title="Show only errors">
              Errors only
            </button>
          </>
        ) : (
          <span className="check-ok">
            <CheckCircle2 size={16} /> No problems found
            {ignored.length > 0 && <span className="muted small">· {ignored.length} ignored</span>}
          </span>
        )}
      </div>
      <div className="check-list">
        {[...groups].map(([rule, list]) => {
          const open = !closed.has(rule);
          return (
            <section key={rule} className="check-group">
              <button
                className="check-group-head"
                onClick={() =>
                  setClosed((c) => {
                    const n = new Set(c);
                    if (n.has(rule)) n.delete(rule);
                    else n.add(rule);
                    return n;
                  })
                }
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="check-group-title">{ERC_RULES[rule]}</span>
                <span className="count">{list.length}</span>
              </button>
              {open &&
                list.map((i) => (
                  <div key={i.key} className={`check-row-wrap ${i.severity}`}>
                    <button
                      className={`check-row ${i.severity}`}
                      onClick={() => reveal(i)}
                      onMouseEnter={() => set({ layerHover: i.items })}
                      onMouseLeave={() => set({ layerHover: [] })}
                      title="Select and show on the canvas"
                    >
                      {i.severity === 'error' ? <OctagonAlert size={13} /> : <AlertTriangle size={13} />}
                      <span>{i.message}</span>
                    </button>
                    <button
                      className="check-ignore"
                      title="Ignore this finding"
                      onClick={(e) => {
                        e.stopPropagation();
                        ignoreIssue(i.key);
                        set({ layerHover: [] });
                      }}
                      onMouseEnter={() => set({ layerHover: i.items })}
                      onMouseLeave={() => set({ layerHover: [] })}
                    >
                      <EyeOff size={13} />
                    </button>
                  </div>
                ))}
            </section>
          );
        })}
        {!issues.length && !ignored.length && (
          <div className="empty-note">
            Every pin is wired or flagged no-connect, nets and labels line up, and no part name is used twice.
          </div>
        )}
        {ignored.length > 0 && (
          <section className="check-group check-ignored">
            <div className="check-ignored-head">
              <button className="check-group-head" onClick={() => setIgnoredOpen((o) => !o)}>
                {ignoredOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="check-group-title">Ignored ({ignored.length})</span>
              </button>
              {ignoredOpen && (
                <button className="chip restore-all" title="Restore all ignored findings" onClick={restoreAll}>
                  Restore all
                </button>
              )}
            </div>
            {ignoredOpen &&
              ignored.map((i) => (
                <div key={i.key} className={`check-row-wrap ignored ${i.severity}`}>
                  <button
                    className={`check-row ignored ${i.severity}`}
                    onClick={() => reveal(i)}
                    onMouseEnter={() => set({ layerHover: i.items })}
                    onMouseLeave={() => set({ layerHover: [] })}
                    title="Select and show on the canvas"
                  >
                    {i.severity === 'error' ? <OctagonAlert size={13} /> : <AlertTriangle size={13} />}
                    <span>{i.message}</span>
                  </button>
                  <button
                    className="check-ignore"
                    title="Restore this finding"
                    onClick={(e) => {
                      e.stopPropagation();
                      restoreIssue(i.key);
                    }}
                  >
                    <Eye size={13} />
                  </button>
                </div>
              ))}
          </section>
        )}
      </div>
      <div className="layer-foot muted small">Updates as you edit · place a no-connect flag (Shift+X) on pins left open on purpose</div>
    </div>
  );
}

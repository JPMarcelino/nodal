import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, OctagonAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ERC_RULES, runErc, type ErcIssue, type ErcRule } from '../model/erc';
import * as A from '../store/actions';
import { select, set, useStore } from '../store/store';

/** Rule-check findings for the current circuit, re-run once edits pause (not on every drag frame). */
export function useErcIssues(enabled = true): ErcIssue[] {
  const doc = useStore((s) => s.doc);
  const [checked, setChecked] = useState(doc);
  useEffect(() => {
    if (doc === checked) return;
    const t = setTimeout(() => setChecked(doc), 250);
    return () => clearTimeout(t);
  }, [doc, checked]);
  return useMemo(() => (enabled ? runErc(checked) : []), [checked, enabled]);
}

/** Electrical rules check: a live list of likely mistakes; click one to select and show it. */
export function CheckPanel() {
  const doc = useStore((s) => s.doc);
  const issues = useErcIssues();
  const [only, setOnly] = useState<'all' | 'error'>('all');
  const [closed, setClosed] = useState<Set<ErcRule>>(new Set());
  useEffect(() => () => set({ layerHover: [] }), []);

  const shown = only === 'error' ? issues.filter((i) => i.severity === 'error') : issues;
  const groups = new Map<ErcRule, ErcIssue[]>();
  for (const i of shown) groups.set(i.rule, [...(groups.get(i.rule) ?? []), i]);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;

  const reveal = (i: ErcIssue) => {
    const ids = i.items.filter((id) => doc.items[id]);
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
                  <button
                    key={i.key}
                    className={`check-row ${i.severity}`}
                    onClick={() => reveal(i)}
                    onMouseEnter={() => set({ layerHover: i.items })}
                    onMouseLeave={() => set({ layerHover: [] })}
                    title="Select and show on the canvas"
                  >
                    {i.severity === 'error' ? <OctagonAlert size={13} /> : <AlertTriangle size={13} />}
                    <span>{i.message}</span>
                  </button>
                ))}
            </section>
          );
        })}
        {!issues.length && (
          <div className="empty-note">
            Every pin is wired or flagged no-connect, nets and labels line up, and no reference is used twice.
          </div>
        )}
      </div>
      <div className="layer-foot muted small">Updates as you edit · place a no-connect flag (Shift+X) on pins left open on purpose</div>
    </div>
  );
}

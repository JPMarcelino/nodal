import type { CircuitDoc } from '../model/types';
import { editGuard, S, toast } from '../store/store';
import { A, guardActive, logAgent } from './state';
import { agentApplying } from './tx';

/**
 * The guard: while an agent works (session.start … session.done), the user's
 * own edits may not change what the agent made or changed ('items'), or
 * anything at all ('all'). The user picks the mode, or turns it off, in the
 * agent panel; it lifts by itself when the agent is done.
 */

/** Why the user's edit from `before` to `after` is refused, or null to let it through. */
export function guardCheck(before: CircuitDoc, after: CircuitDoc): string | null {
  const a = A();
  if (agentApplying || !guardActive(a)) return null;
  // the symbol editor page is a separate drawing; the circuit behind it is untouched
  if (S().symbolSession) return null;
  if (a.guard === 'all') return `${a.name} is working on this circuit — it can’t be changed until the agent is done`;
  if (before.items === after.items || !a.owned.size) return null;
  for (const id of a.owned) {
    if (before.items[id] !== after.items[id]) return `${a.name} is still working on that — it can’t be changed until the agent is done`;
  }
  return null;
}

let lastNotice = 0;
function guardNotice(why: string) {
  if (Date.now() - lastNotice < 2500) return;
  lastNotice = Date.now();
  toast(`${why} (agent panel: turn the guard off or mark it done)`, 'info');
  logAgent({ kind: 'user', text: 'Blocked an edit of the agent’s work (guard)' });
}

export function installGuard() {
  editGuard.check = guardCheck;
  editGuard.notice = guardNotice;
}

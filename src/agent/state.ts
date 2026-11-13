import { isLoopbackAgentUrl } from './url';
import { create } from 'zustand';
import type { Point } from '../model/types';

/**
 * State of the AI agent link (see agent/link.ts): who the agent is, what it is
 * doing, the activity log the user sees, and the guard that keeps the user's
 * own edits off the agent's work while it runs. Kept apart from the app store
 * so agent bookkeeping never lands in the document or its undo history.
 */

/** idle: connected, not started; working: between session.start and session.done; done: finished. */
export type AgentStatus = 'idle' | 'working' | 'done';

/**
 * What the user may not change while the agent works: nothing (off), what the
 * agent made or changed (items), or the whole circuit (all).
 */
export type GuardMode = 'off' | 'items' | 'all';

export interface AgentLogEntry {
  id: number;
  t: number;
  kind: 'call' | 'say' | 'error' | 'system' | 'user';
  /** Method of a call. */
  method?: string;
  text: string;
  /** Say messages: how it reads. */
  tone?: 'info' | 'success' | 'warning' | 'error';
  ms?: number;
  /** Items the call touched (click to show them). */
  ids?: string[];
  page?: string;
}

export interface AgentQuestion {
  id: number;
  text: string;
  choices: string[];
}

export interface AgentState {
  /** The link to the agent bridge (a local program the agent talks to). */
  enabled: boolean;
  url: string;
  connected: boolean;
  /** Last connection problem, for the panel. */
  linkError: string | null;
  /** Agents connected to the bridge right now. */
  clients: number;
  status: AgentStatus;
  name: string;
  color: string;
  goal: string;
  progress: { text: string; fraction?: number } | null;
  /** Page the agent edits by default (its own; never the user's page). */
  page?: string;
  /** Where the agent is "looking": its cursor on the canvas. */
  cursor: (Point & { page: string }) | null;
  /** Last message, shown as a bubble at the cursor for a few seconds. */
  bubble: { text: string; tone: AgentLogEntry['tone']; t: number } | null;
  /** Items the last edit touched, outlined briefly. */
  flash: { ids: string[]; page: string; t: number } | null;
  /** Items the agent made or changed during this session (what the 'items' guard protects). */
  owned: ReadonlySet<string>;
  guard: GuardMode;
  /** The user's view follows the agent's edits. */
  follow: boolean;
  log: AgentLogEntry[];
  /** A question waiting for the user's reply (session.waitForUser). */
  question: AgentQuestion | null;
  /** Panel collapsed to its header. */
  collapsed: boolean;
  /** Undoable agent steps (and how many are redoable). */
  steps: number;
  redoable: number;
}

const LS = 'nodal.agent';
interface Saved {
  enabled?: boolean;
  url?: string;
  guard?: GuardMode;
  follow?: boolean;
  collapsed?: boolean;
}

function loadSaved(): Saved {
  try {
    return JSON.parse(localStorage.getItem(LS) ?? '{}') as Saved;
  } catch {
    return {};
  }
}

export const DEFAULT_AGENT_URL = 'ws://127.0.0.1:47821/app';
export const AGENT_COLOR = '#c084fc';

const saved = typeof localStorage !== 'undefined' ? loadSaved() : {};

export const useAgent = create<AgentState>(() => ({
  enabled: saved.enabled ?? false,
  // a remote URL saved by an older version (e.g. from a crafted #agent= link) is dropped
  url: saved.url && isLoopbackAgentUrl(saved.url) ? saved.url : DEFAULT_AGENT_URL,
  connected: false,
  linkError: null,
  clients: 0,
  status: 'idle',
  name: 'AI agent',
  color: AGENT_COLOR,
  goal: '',
  progress: null,
  page: undefined,
  cursor: null,
  bubble: null,
  flash: null,
  owned: new Set(),
  guard: saved.guard ?? 'items',
  follow: saved.follow ?? true,
  log: [],
  question: null,
  collapsed: saved.collapsed ?? false,
  steps: 0,
  redoable: 0,
}));

export const A = () => useAgent.getState();
export const setAgent = (p: Partial<AgentState> | ((s: AgentState) => Partial<AgentState>)) => useAgent.setState(p);

/** Keeps the user's link and guard choices across visits. */
useAgent.subscribe((s, prev) => {
  if (s.enabled === prev.enabled && s.url === prev.url && s.guard === prev.guard && s.follow === prev.follow && s.collapsed === prev.collapsed) return;
  try {
    localStorage.setItem(LS, JSON.stringify({ enabled: s.enabled, url: s.url, guard: s.guard, follow: s.follow, collapsed: s.collapsed } satisfies Saved));
  } catch {
    /* ignore */
  }
});

const LOG_LIMIT = 300;
let logId = 0;

export function logAgent(entry: Omit<AgentLogEntry, 'id' | 't'>): AgentLogEntry {
  const e = { ...entry, id: ++logId, t: Date.now() };
  setAgent((s) => ({ log: [...s.log.slice(-(LOG_LIMIT - 1)), e] }));
  return e;
}

/** The guard is in force: the agent is working and the user has not turned it off. */
export const guardActive = (s: Pick<AgentState, 'status' | 'guard'> = A()) => s.status === 'working' && s.guard !== 'off';

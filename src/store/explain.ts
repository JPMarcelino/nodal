import { create } from 'zustand';
import { EXPLAIN_COLORS, HIGHLIGHTER_COLOR } from '../model/ink';
import type { Point, Rect, Tool } from '../model/types';

/** A net lit up by the trace tool; current "flows" outward from `origin`. */
export interface Trace {
  id: string;
  /** What was clicked: the net is looked up from it every time, so it survives edits and renames. */
  seed: { wire?: string; comp?: string; port?: string };
  color: string;
  origin: Point;
}

/** Explain-mode state; none of it is saved with the circuit. */
export interface ExplainState {
  /** Pen colour; highlighter keeps its own. */
  color: string;
  highlightColor: string;
  /** Stroke size in screen pixels (converted to world units at the zoom it was drawn at). */
  size: number;
  /** Pen strokes fade away a few seconds after they're drawn instead of being kept. */
  vanish: boolean;
  traces: Trace[];
  /** Items lit by the spotlight; everything else is dimmed. */
  focus: string[];
  /** Free rectangles lit by the spotlight. */
  regions: Rect[];
  /** Callout whose note is being typed. */
  editing: string | null;
  /** Walkthrough: index into the steps (-1 = title card), or null when not presenting. */
  presenting: number | null;
  /** Last explain tool used, so the rail button returns to it. */
  lastTool: ExplainTool;
  /** Laser button held (shared with collaborators so they see the trail). */
  laserDown: boolean;
}

export type ExplainTool = Extract<Tool, 'pen' | 'highlighter' | 'laser' | 'eraser' | 'trace' | 'spotlight' | 'callout'>;
export const EXPLAIN_TOOLS: ExplainTool[] = ['pen', 'highlighter', 'laser', 'eraser', 'trace', 'spotlight', 'callout'];
export const isExplainTool = (t: Tool): t is ExplainTool => (EXPLAIN_TOOLS as Tool[]).includes(t);

/** Colours given to successive traces. */
export const TRACE_COLORS = ['#ff6b2c', '#22b8cf', '#a855f7', '#40c057', '#f03e8c', '#fab005'];

export const useExplain = create<ExplainState>(() => ({
  color: EXPLAIN_COLORS[1],
  highlightColor: HIGHLIGHTER_COLOR,
  size: 3,
  vanish: false,
  traces: [],
  focus: [],
  regions: [],
  editing: null,
  presenting: null,
  lastTool: 'pen',
  laserDown: false,
}));

export const X = () => useExplain.getState();
export const setX = (p: Partial<ExplainState> | ((s: ExplainState) => Partial<ExplainState>)) => useExplain.setState(p);

/** Clears traces and the spotlight; returns whether there was anything to clear. */
export function clearExplainOverlays(): boolean {
  const s = X();
  if (!s.traces.length && !s.focus.length && !s.regions.length) return false;
  setX({ traces: [], focus: [], regions: [] });
  return true;
}

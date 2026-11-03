import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronUp, Copy, Eye, Lock, Undo2, X } from 'lucide-react';
import { docPages, resolvePage } from '../model/pages';
import { goToItems, select, setPage, sharedDoc, toast, useStore } from '../store/store';
import { revealItems } from '../store/actions';
import { answerQuestion } from './api';
import { releaseAgent, setAgentLink } from './link';
import { DEFAULT_AGENT_URL, setAgent, useAgent, type AgentLogEntry, type GuardMode } from './state';
import { runCall } from './run';
import { agentSetupPrompt, bridgeFileUrl, setupSteps } from './setup';
import './agent.css';

const GUARDS: { value: GuardMode; label: string; title: string }[] = [
  { value: 'off', label: 'Off', title: 'You can edit anything while the agent works' },
  { value: 'items', label: 'Its work', title: 'While the agent works, you can’t change what it made or changed' },
  { value: 'all', label: 'Everything', title: 'While the agent works, the circuit is read-only for you' },
];

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Shows items of a log entry to the user. */
function showEntry(e: AgentLogEntry) {
  if (!e.ids?.length) return;
  const on = goToItems(e.ids);
  if (!on.length) return;
  select(on);
  revealItems(on);
}

/**
 * The AI agent panel: whether an agent is linked, what it is doing (goal,
 * progress, its messages and every call as it happens), a reply box for its
 * questions, and the user's controls: follow its work, guard it from your own
 * edits, mark it done, undo its last step, or cut the link.
 */
export function AgentPanel() {
  const a = useAgent();
  const userPage = useStore((s) => s.page);
  const doc = useStore((s) => s.doc);
  const logRef = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState('');
  const [url, setUrl] = useState(a.url);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [a.log.length, a.collapsed]);

  if (!a.enabled && a.status === 'idle') return null;

  const working = a.status === 'working';
  const state = !a.connected ? (a.enabled ? 'waiting' : 'off') : working ? 'working' : a.status === 'done' ? 'done' : 'idle';
  const stateLabel = { off: 'Link off', waiting: 'Waiting for the bridge', idle: a.clients ? 'Agent connected' : 'Bridge ready', working: 'Working', done: 'Done' }[state];
  const steps = setupSteps();
  const shared = sharedDoc();
  const agentPage = a.page && resolvePage(shared, a.page);
  const cursorPage = a.cursor?.page ?? agentPage;
  const elsewhere = working && cursorPage && cursorPage !== resolvePage(doc, userPage) ? docPages(shared).find((p) => p.id === cursorPage) : null;
  const send = (text: string | null) => {
    answerQuestion(text);
    setReply('');
  };
  // conflicts with the user's later edits are explained in the log
  const undoStep = () => void runCall('history.undo');

  return (
    <div className={`agent-panel${a.collapsed ? ' collapsed' : ''}`} style={{ '--agent': a.color } as React.CSSProperties} data-state={state}>
      <div className="agent-head">
        <span className="agent-dot" />
        <Bot size={15} />
        <span className="agent-name" title={a.goal || undefined}>
          {a.connected && a.status !== 'idle' ? a.name : 'AI agent'}
        </span>
        <span className="agent-state">{stateLabel}</span>
        <button className="agent-icon" title={a.collapsed ? 'Expand' : 'Collapse'} onClick={() => setAgent({ collapsed: !a.collapsed })}>
          {a.collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <button
          className="agent-icon"
          title="Turn the agent link off"
          onClick={() => {
            releaseAgent();
            setAgentLink(false);
            setAgent({ status: 'idle' });
          }}
        >
          <X size={14} />
        </button>
      </div>
      {a.progress?.fraction !== undefined && working && (
        <div className="agent-bar">
          <span style={{ width: `${Math.round(a.progress.fraction * 100)}%` }} />
        </div>
      )}
      {!a.collapsed && (
        <div className="agent-body">
          {!a.connected && (
            <div className="agent-setup">
              <p>Agents reach Nodal through a small bridge program on this computer (Node.js 18+).</p>
              <ol className="agent-steps">
                <li>
                  <a href={bridgeFileUrl()} download="nodal-agent.mjs">
                    Download the bridge
                  </a>{' '}
                  or: <code>{steps.download}</code>
                </li>
                <li>
                  Run it and leave it running: <code>{steps.runForeground}</code>
                </li>
                <li>
                  Your agent calls it from the command line, over HTTP, or as an MCP server: <code>{steps.mcp}</code>
                </li>
              </ol>
              <button
                className="agent-btn primary agent-copy"
                title="Instructions an AI agent (ChatGPT, Codex, Claude…) can follow to download the bridge, start it and connect"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(agentSetupPrompt())
                    .then(() => toast('Copied — paste it to your AI agent', 'success'))
                    .catch(() => toast('Couldn’t copy to the clipboard', 'error'))
                }
              >
                <Copy size={13} /> Copy setup for your AI agent
              </button>
              <label className="agent-url">
                Bridge
                <input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => url !== a.url && setAgentLink(true, url || DEFAULT_AGENT_URL)} spellCheck={false} />
              </label>
              {a.linkError && <p className="agent-error">{a.linkError} — retrying…</p>}
            </div>
          )}
          {(a.goal || a.progress?.text) && (
            <div className="agent-goal">
              {a.goal && <div>{a.goal}</div>}
              {a.progress?.text && working && <div className="agent-now">{a.progress.text}</div>}
            </div>
          )}
          {elsewhere && (
            <button className="agent-elsewhere" onClick={() => setPage(elsewhere.id)}>
              <Eye size={13} /> Working on page “{elsewhere.name}” — show it
            </button>
          )}
          {a.question && (
            <div className="agent-question">
              <div className="agent-q-text">{a.question.text}</div>
              {!!a.question.choices.length && (
                <div className="agent-choices">
                  {a.question.choices.map((c) => (
                    <button key={c} onClick={() => send(c)}>
                      {c}
                    </button>
                  ))}
                </div>
              )}
              <form
                className="agent-reply"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reply.trim()) send(reply.trim());
                }}
              >
                <input autoFocus value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to the agent…" onKeyDown={(e) => e.stopPropagation()} />
                <button type="submit" disabled={!reply.trim()}>
                  Send
                </button>
                <button type="button" className="agent-skip" onClick={() => send(null)}>
                  Skip
                </button>
              </form>
            </div>
          )}
          <div className="agent-log" ref={logRef}>
            {!a.log.length && <div className="agent-empty">Nothing yet. What the agent does shows up here as it happens.</div>}
            {a.log.map((e) => (
              <div key={e.id} className={`agent-entry k-${e.kind}${e.tone ? ` t-${e.tone}` : ''}${e.ids?.length ? ' has-ids' : ''}`} onClick={() => showEntry(e)} title={e.ids?.length ? 'Show these items' : time(e.t)}>
                <span className="agent-time">{time(e.t)}</span>
                <span className="agent-text">{e.text}</span>
              </div>
            ))}
          </div>
          <div className="agent-controls">
            <div className="agent-guard" title="Keeps your own edits off the agent’s drawing until it is done">
              <Lock size={12} />
              <span>Protect</span>
              <div className="agent-seg">
                {GUARDS.map((g) => (
                  <button key={g.value} className={a.guard === g.value ? 'on' : ''} title={g.title} onClick={() => setAgent({ guard: g.value })}>
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="agent-row">
              <label className="agent-check" title="Your view follows the agent’s edits (pauses while you move the view yourself)">
                <input type="checkbox" checked={a.follow} onChange={(e) => setAgent({ follow: e.target.checked })} /> Follow
              </label>
              <button className="agent-btn" disabled={!a.steps} title="Undo the agent’s last step" onClick={undoStep}>
                <Undo2 size={13} /> Undo step
              </button>
              {working && (
                <button className="agent-btn primary" title="End the agent’s session now: the guard lifts" onClick={releaseAgent}>
                  Mark done
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

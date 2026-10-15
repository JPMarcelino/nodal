import { Copy, CopyPlus, LogIn, LogOut, Radio } from 'lucide-react';
import { useState } from 'react';
import { PEER_COLORS, isHost, joinSession, leaveSession, parseLink, setMyColor, setMyName, startSession, useCollab } from '../collab/session';
import { toast, useStore } from '../store/store';
import { ask } from './Ask';

/** The host leaving ends the session for everyone, so they confirm first. */
async function leave() {
  if (isHost()) {
    const others = Object.keys(useCollab.getState().peers).length;
    const end = await ask(
      'End the live session?',
      `Leaving ends the session for everyone${others ? ` (${others} ${others === 1 ? 'person is' : 'people are'} watching)` : ''}. The link stops working and the shared copy is deleted. Your circuit stays open here.`,
      [
        { label: 'Cancel', value: false },
        { label: 'End session', value: true, kind: 'danger' },
      ],
      false,
    );
    if (!end) return;
  }
  await leaveSession();
}

async function copyLink(link: string) {
  try {
    await navigator.clipboard.writeText(link);
    toast('Session link copied', 'success');
  } catch {
    toast('Could not copy: select the link and copy it by hand', 'error');
  }
}

/** Top of the Share dialog: start, join or manage a live session. */
export function LiveSession() {
  const status = useCollab((s) => s.status);
  const link = useCollab((s) => s.link);
  const me = useCollab((s) => s.me);
  const peers = useCollab((s) => s.peers);
  const viewOnly = useStore((s) => s.viewOnly);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(me.name);
  const count = Object.keys(peers).length;

  const start = async () => {
    setBusy(true);
    try {
      const l = await startSession();
      await copyLink(l);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="live-session">
      <div className="live-head">
        <Radio size={18} />
        <div>
          <b>Live collaboration</b>
          <div className="muted small">
            {status === 'off'
              ? 'Share a view-only link: others watch this circuit live as you edit it, with everyone’s cursor shown. They can’t change it, and it closes for them when they leave. The circuit is end-to-end encrypted: the key is in the link, so only people you send it to can open it.'
              : viewOnly
                ? 'You are viewing someone else’s circuit. You can’t change it. Leaving brings back your own circuit, or choose “Leave and keep a copy” to keep the shared one as your own new circuit.'
                : count
                  ? `${count} other ${count === 1 ? 'person' : 'people'} here. Click an avatar in the top bar to follow their view.`
                  : 'Nobody else is here yet. Send them the link.'}
          </div>
        </div>
      </div>

      {status === 'off' ? (
        <div className="live-actions">
          <button className="primary-btn" disabled={busy} onClick={start}>
            <Radio size={14} /> Start live session
          </button>
          <div className="row-gap live-join">
            <input className="input mono" placeholder="…or paste a session link to join" value={paste} onChange={(e) => setPaste(e.target.value)} />
            <button
              className="secondary-btn"
              disabled={!parseLink(paste)}
              onClick={() => {
                void joinSession(paste);
                setPaste('');
              }}
            >
              <LogIn size={14} /> Join
            </button>
          </div>
        </div>
      ) : (
        <div className="live-actions">
          <div className="row-gap">
            <input className="input mono" readOnly value={link ?? ''} onFocus={(e) => e.currentTarget.select()} />
            <button className="primary-btn" onClick={() => link && copyLink(link)}>
              <Copy size={14} /> Copy link
            </button>
          </div>
          <div className="row-gap live-me">
            <span className="muted small">Your name</span>
            <input
              className="input"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setMyName(name)}
              onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            />
            <div className="swatches">
              {PEER_COLORS.map((c) => (
                <button key={c} className={c === me.color ? 'swatch active' : 'swatch'} style={{ background: c }} title="Your cursor colour" onClick={() => setMyColor(c)} />
              ))}
            </div>
            <button className="secondary-btn danger" onClick={() => void leave()}>
              <LogOut size={14} /> {viewOnly ? 'Leave' : 'End session'}
            </button>
            {viewOnly && (
              <button className="secondary-btn" onClick={() => void leaveSession({ keepCopy: true })}>
                <CopyPlus size={14} /> Leave and keep a copy
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

import { Users } from 'lucide-react';
import { follow, useCollab, type Me, type Peer } from '../collab/session';
import { set, useStore } from '../store/store';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

function Avatar({ who, title, onClick, ring }: { who: Me | Peer; title: string; onClick: () => void; ring?: boolean }) {
  return (
    <button className={ring ? 'avatar following' : 'avatar'} style={{ background: who.color, ['--ring' as string]: who.color }} title={title} onClick={onClick}>
      {initials(who.name)}
    </button>
  );
}

/** Top-bar presence: the Share button, or once live, everyone in the session. */
export function CollabBar() {
  const status = useCollab((s) => s.status);
  const me = useCollab((s) => s.me);
  const peers = useCollab((s) => s.peers);
  const following = useCollab((s) => s.following);
  const viewOnly = useStore((s) => s.viewOnly);
  const openShare = () => set({ dialog: 'share' });
  if (status === 'off') {
    return (
      <button className="secondary-btn share-btn" onClick={openShare} title="Share & collaborate live">
        <Users size={15} /> Share
      </button>
    );
  }
  const list = Object.values(peers);
  const shown = list.slice(0, 5);
  const label = status === 'live' ? (viewOnly ? 'Live · View only' : 'Live') : status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <div className="collab-bar">
      <div className="avatars">
        {shown.map((p) => (
          <Avatar key={p.id} who={p} ring={following === p.id} title={`${p.name}${p.edit ? '' : ' (viewing)'}, click to ${following === p.id ? 'stop following' : 'follow'}`} onClick={() => follow(p.id)} />
        ))}
        {list.length > shown.length && (
          <button className="avatar more" onClick={openShare} title={list.slice(5).map((p) => p.name).join(', ')}>
            +{list.length - shown.length}
          </button>
        )}
        <Avatar who={me} title={`${me.name} (you)`} onClick={openShare} />
      </div>
      <button className={`live-chip ${status}`} onClick={openShare} title="Session link, your name, leave">
        <span className="live-dot" />
        {label}
      </button>
    </div>
  );
}

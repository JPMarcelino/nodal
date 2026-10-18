import { Users } from 'lucide-react';
import { follow, useCollab, type Me, type Peer } from '../collab/session';
import { docPages, samePage } from '../model/pages';
import { set, useStore } from '../store/store';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

function Avatar({ who, title, onClick, ring, away }: { who: Me | Peer; title: string; onClick: () => void; ring?: boolean; away?: boolean }) {
  return (
    <button className={`avatar${ring ? ' following' : ''}${away ? ' away' : ''}`} style={{ background: who.color, ['--ring' as string]: who.color }} title={title} onClick={onClick}>
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
  const doc = useStore((s) => s.doc);
  const page = useStore((s) => s.page);
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
        {shown.map((p) => {
          // someone on another page: dimmed, with the page named in the hint
          const away = !samePage(doc, p.page, page);
          const where = away ? ` · on ${docPages(doc).find((g) => g.id === p.page)?.name ?? 'another page'}` : '';
          return <Avatar key={p.id} who={p} ring={following === p.id} away={away} title={`${p.name}${p.edit ? '' : ' (viewing)'}${where}, click to ${following === p.id ? 'stop following' : 'follow'}`} onClick={() => follow(p.id)} />;
        })}
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

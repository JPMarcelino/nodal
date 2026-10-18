import { follow, useCollab } from '../collab/session';
import { itemBounds } from '../model/doc';
import { samePage } from '../model/pages';
import { useStore } from '../store/store';
import type { CircuitDoc, Point } from '../model/types';
import { buildWirePath } from '../model/wires';

/** Other people's selections and cursors, drawn in world coordinates (inside the view transform). */
export function RemotePresence({ doc, polys, z }: { doc: CircuitDoc; polys: Map<string, Point[]>; z: number }) {
  const peers = useCollab((s) => s.peers);
  const page = useStore((s) => s.page);
  // only people on the page you are looking at (their cursor and selection mean nothing on another)
  const list = Object.values(peers).filter((p) => samePage(doc, p.page, page));
  if (!list.length) return null;
  return (
    <g className="remote-presence" pointerEvents="none">
      {list.map((p) =>
        p.selection.map((id) => {
          const it = doc.items[id];
          if (!it) return null;
          if (it.type === 'wire') {
            return <path key={`${p.id}:${id}`} d={buildWirePath(polys.get(id) ?? [], 0)} fill="none" stroke={p.color} strokeOpacity={0.45} strokeWidth={Math.max(6 / z, 4)} strokeLinecap="round" />;
          }
          const b = itemBounds(doc, it);
          if (!b) return null;
          return <rect key={`${p.id}:${id}`} x={b.x - 5} y={b.y - 5} width={b.w + 10} height={b.h + 10} rx={4} fill="none" stroke={p.color} strokeWidth={1.5 / z} />;
        }),
      )}
      {list.map((p) =>
        p.cursor && Number.isFinite(p.cursor.x) && Number.isFinite(p.cursor.y) ? (
          <g key={p.id} className="remote-cursor" transform={`translate(${p.cursor.x} ${p.cursor.y}) scale(${1 / z})`}>
            <path d="M0 0 L0 16 L4.5 12 L7.5 19 L10.5 17.7 L7.6 11 L13 11 Z" fill={p.color} stroke="#fff" strokeWidth={1.2} strokeLinejoin="round" />
            <g transform="translate(12 20)">
              <rect width={p.name.length * 6.6 + 14} height={19} rx={9.5} fill={p.color} />
              <text x={7} y={13.2} fill="#fff" fontSize={11.5} fontWeight={600}>
                {p.name}
              </text>
            </g>
          </g>
        ) : null,
      )}
    </g>
  );
}

/** Coloured frame around the canvas while mirroring someone's viewport. */
export function FollowFrame() {
  const peer = useCollab((s) => (s.following ? s.peers[s.following] : undefined));
  if (!peer) return null;
  return (
    <div className="follow-frame" style={{ borderColor: peer.color }}>
      <button className="follow-tag" style={{ background: peer.color }} onClick={() => follow(null)} title="Stop following">
        Following {peer.name} · ×
      </button>
    </div>
  );
}

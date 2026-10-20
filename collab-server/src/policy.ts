/*
 * Pure decision logic for the Nodal live-session relay.
 *
 * This module is the single source of truth for the room's security-critical
 * rules; collab-server/src/index.ts (the real Durable Object) and the
 * FakeSocket in src/__tests__/collabSession.test.ts (the test double) must
 * both implement exactly these. It deliberately depends on nothing —
 * no Worker APIs, no storage — so the app's vitest suite can exercise the
 * real enforcement rules directly (see src/__tests__/relayPolicy.test.ts).
 * If you change a rule here, change the callers to match, not the reverse.
 */

export const MAX_PEERS = 32;
// storage.put takes at most 128 keys at once: 12 MB in 100 kB chunks stays under that
export const MAX_SNAPSHOT = 12 * 1024 * 1024;
// Frames carry a small JSON envelope around the snapshot ({ t, d }), so this
// pre-parse cap must clear the largest snapshot gateMessage allows —
// otherwise saves between the two limits are silently dropped before gating.
export const MAX_MESSAGE = MAX_SNAPSHOT + 64 * 1024;
/** Rooms nobody has saved to for this long are deleted (and an ended room's marker is forgotten). */
export const EXPIRE_MS = 24 * 3600 * 1000;

/** A `?w=` token is only eligible to claim a room when it looks like one. */
export function isWellFormedToken(token: string | null): token is string {
  return !!token && token.length >= 16 && token.length <= 128;
}

/**
 * Pure half of ownership claim. `presentedHash` is the sha256 of the
 * connection's token, or null when it was missing/ill-formed; `storedOwner`
 * is the room's recorded owner hash, or null when unclaimed. Returns whether
 * the connection may edit, plus the hash to persist when this connection
 * claims a previously unowned room (null = store nothing).
 */
export function resolveOwnership(
  storedOwner: string | null,
  presentedHash: string | null,
): { edit: boolean; claim: string | null } {
  if (!presentedHash) return { edit: false, claim: null };
  if (storedOwner) return { edit: storedOwner === presentedHash, claim: null };
  return { edit: true, claim: presentedHash };
}

export type RelayDecision = 'end' | 'relay' | 'save' | 'drop';

/**
 * Which action a parsed client message gets. Mirrors Room.webSocketMessage:
 * 'end' from an editor closes the room; presence ('p') relays from anyone;
 * scene ('b') and 'save' need the edit token; anything else (unknown kind,
 * missing data, oversized snapshot, viewer's edit) is dropped.
 */
export function gateMessage(t: unknown, d: unknown, isEditor: boolean): RelayDecision {
  if (t === 'end' && isEditor) return 'end';
  if (typeof d !== 'string') return 'drop';
  if (t === 'p') return 'relay';
  if (!isEditor) return 'drop';
  if (t === 'b') return 'relay';
  if (t === 'save' && d.length <= MAX_SNAPSHOT) return 'save';
  return 'drop';
}

/** Room.fetch rejects newcomers once the room is this full. */
export function isRoomFull(peerCount: number): boolean {
  return peerCount >= MAX_PEERS;
}

/**
 * Mirrors Room.alarm: an ended room's marker and an empty room's state are
 * deleted; a live room with peers re-arms its expiry alarm instead.
 * Returns true when the caller should delete everything.
 */
export function shouldReapOnAlarm(ended: boolean, peerCount: number): boolean {
  return ended || peerCount === 0;
}

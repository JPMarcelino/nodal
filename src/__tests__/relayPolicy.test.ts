import { describe, expect, it } from 'vitest';
import {
  EXPIRE_MS,
  MAX_PEERS,
  MAX_SNAPSHOT,
  gateMessage,
  isRoomFull,
  isWellFormedToken,
  resolveOwnership,
  shouldReapOnAlarm,
} from '../../collab-server/src/policy';

/*
 * Direct tests for the relay's view-only/enforcement rules. These run
 * against the real decision logic in collab-server/src/policy.ts — the same
 * module Room (collab-server/src/index.ts) and the FakeSocket test double
 * (collabSession.test.ts) both implement — so a regression in edit-gating,
 * ownership claim, or room expiry fails CI instead of silently drifting.
 */

describe('relayPolicy', () => {
  it('only well-formed edit tokens can claim a room', () => {
    expect(isWellFormedToken(null)).toBe(false);
    expect(isWellFormedToken('')).toBe(false);
    expect(isWellFormedToken('x'.repeat(15))).toBe(false);
    expect(isWellFormedToken('x'.repeat(16))).toBe(true);
    expect(isWellFormedToken('x'.repeat(128))).toBe(true);
    expect(isWellFormedToken('x'.repeat(129))).toBe(false);
  });

  it('the first well-formed token owns the room; later ones must match', () => {
    // nobody home and no token: viewer
    expect(resolveOwnership(null, null)).toEqual({ edit: false, claim: null });
    // first token claims it
    expect(resolveOwnership(null, 'hash-a')).toEqual({ edit: true, claim: 'hash-a' });
    // same token still edits (nothing new to store)
    expect(resolveOwnership('hash-a', 'hash-a')).toEqual({ edit: true, claim: null });
    // any other token is view-only, even a well-formed one
    expect(resolveOwnership('hash-a', 'hash-b')).toEqual({ edit: false, claim: null });
    // a missing token never edits, even in an unclaimed room
    expect(resolveOwnership('hash-a', null)).toEqual({ edit: false, claim: null });
  });

  it('only editors can send scene updates, snapshots, or end the room', () => {
    // presence relays for everyone
    expect(gateMessage('p', 'cursor', false)).toBe('relay');
    expect(gateMessage('p', 'cursor', true)).toBe('relay');
    // scene updates need the edit token
    expect(gateMessage('b', 'scene', true)).toBe('relay');
    expect(gateMessage('b', 'scene', false)).toBe('drop');
    // snapshots need the edit token and must fit the storage budget
    expect(gateMessage('save', 'snap', true)).toBe('save');
    expect(gateMessage('save', 'snap', false)).toBe('drop');
    expect(gateMessage('save', 'x'.repeat(MAX_SNAPSHOT), true)).toBe('save');
    expect(gateMessage('save', 'x'.repeat(MAX_SNAPSHOT + 1), true)).toBe('drop');
    // ending needs the edit token — and never needs a payload
    expect(gateMessage('end', undefined, true)).toBe('end');
    expect(gateMessage('end', 'x', true)).toBe('end');
    expect(gateMessage('end', undefined, false)).toBe('drop');
    expect(gateMessage('end', 'x', false)).toBe('drop');
  });

  it('drops malformed and unknown messages', () => {
    expect(gateMessage('b', undefined, true)).toBe('drop');
    expect(gateMessage('b', 42, true)).toBe('drop');
    expect(gateMessage('p', undefined, false)).toBe('drop');
    expect(gateMessage('nope', 'x', true)).toBe('drop');
    expect(gateMessage('nope', 'x', false)).toBe('drop');
  });

  it('caps the room size and expires idle rooms after 24h', () => {
    expect(isRoomFull(MAX_PEERS - 1)).toBe(false);
    expect(isRoomFull(MAX_PEERS)).toBe(true);
    expect(EXPIRE_MS).toBe(24 * 3600 * 1000);
    // a live room with peers re-arms its alarm; anything else is deleted
    expect(shouldReapOnAlarm(false, 2)).toBe(false);
    expect(shouldReapOnAlarm(false, 0)).toBe(true);
    expect(shouldReapOnAlarm(true, 0)).toBe(true);
    expect(shouldReapOnAlarm(true, 2)).toBe(true);
  });
});

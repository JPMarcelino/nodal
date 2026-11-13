import { describe, expect, it } from 'vitest';
import { isLoopbackAgentUrl } from '../agent/url';

describe('agent link stays on this machine', () => {
  it('accepts only loopback bridge URLs', () => {
    expect(isLoopbackAgentUrl('ws://127.0.0.1:47821/app')).toBe(true);
    expect(isLoopbackAgentUrl('ws://localhost:5000/app')).toBe(true);
    expect(isLoopbackAgentUrl('ws://[::1]:47821/app')).toBe(true);
    expect(isLoopbackAgentUrl('wss://evil.example/app')).toBe(false);
    expect(isLoopbackAgentUrl('ws://127.0.0.1.evil.example/app')).toBe(false);
    expect(isLoopbackAgentUrl('ws://user@127.0.0.1:47821/app')).toBe(false);
    expect(isLoopbackAgentUrl('http://127.0.0.1:47821/app')).toBe(false);
    expect(isLoopbackAgentUrl('not a url')).toBe(false);
  });
});

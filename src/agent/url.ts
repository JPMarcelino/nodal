/**
 * Only a bridge on this machine may drive the app. The bridge can read and
 * export the whole open circuit, so a link like `#agent=wss://elsewhere` (or a
 * URL saved by one) must never connect anywhere off the loopback interface.
 */
export function isLoopbackAgentUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'ws:' || u.protocol === 'wss:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

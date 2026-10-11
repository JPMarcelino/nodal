/*
 * End-to-end encryption for live sessions. The room key lives only in the
 * share link's #fragment, which browsers never send to a server, so the relay
 * only ever sees ciphertext. Payloads are JSON, gzip-compressed when the
 * runtime supports it, then sealed with AES-GCM.
 *
 * Wire format (base64): [flag: 0 raw | 1 gzip][12-byte IV][ciphertext]
 */

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** A random URL-safe id (`bytes` of entropy). */
export function randomId(bytes = 10): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A fresh 128-bit room key, encoded for the share link. */
export function newRoomKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function importRoomKey(encoded: string): Promise<CryptoKey> {
  const raw = fromB64url(encoded);
  if (raw.length !== 16) throw new Error('Invalid session key');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const canGzip = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function seal(key: CryptoKey, data: unknown): Promise<string> {
  let body = new TextEncoder().encode(JSON.stringify(data));
  // tiny messages (cursors) don't benefit from compression
  const gzip = canGzip && body.length > 512;
  if (gzip) body = await pipe(body, new CompressionStream('gzip'));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body));
  const out = new Uint8Array(1 + iv.length + ct.length);
  out[0] = gzip ? 1 : 0;
  out.set(iv, 1);
  out.set(ct, 13);
  return toB64(out);
}

export async function open<T = unknown>(key: CryptoKey, sealed: string): Promise<T> {
  const bytes = fromB64(sealed);
  const iv = bytes.subarray(1, 13);
  let body = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.subarray(13)));
  if (bytes[0] === 1) body = await pipe(body, new DecompressionStream('gzip'));
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

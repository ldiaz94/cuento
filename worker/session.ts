/* Sessions and the guard on the account routes (worker/auth.ts). A
 * session is a cookie the Worker signs and nobody else can make:
 *
 *   cuento_session = base64url({"a": account, "e": expiry ms}) . base64url(HMAC-SHA256)
 *
 * The key is the SESSION_KEY secret; nothing about a session is stored,
 * so a session lasts until it expires (SESSION_TTL) or its cookie is
 * cleared. The guard keeps other sites from posting to the account
 * routes: a write must be JSON, sent from cuento's own origin. Depends
 * on WebCrypto alone, so it runs in the Worker and in Node's tests.
 * Leaves out ending a session on the server before it expires. */

/** The session cookie's name. */
export const SESSION = 'cuento_session';
/** How long a session lasts, in ms: 90 days. */
export const SESSION_TTL = 90 * 24 * 60 * 60_000;

/** bytes in base64url, unpadded. */
export function toBase64url(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes in base64url text; throws when it is not base64url. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[\w-]*$/.test(text)) throw Error('Not base64url.');
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

/** key as an HMAC-SHA256 key. */
function hmacKey(key: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(key);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** A session for account, from now until SESSION_TTL later, signed with key. */
export async function sign(key: string, account: string, now: number): Promise<string> {
  const payload = toBase64url(
    new TextEncoder().encode(JSON.stringify({ a: account, e: now + SESSION_TTL })),
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(key),
    new TextEncoder().encode(payload),
  );
  return payload + '.' + toBase64url(new Uint8Array(mac));
}

/** The account of session, or null when key did not sign it or it has
 * expired. WebCrypto's verify compares the signatures in constant time. */
export async function verify(key: string, session: string, now: number): Promise<string | null> {
  const [payload, mac, extra] = session.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  try {
    const good = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(key),
      fromBase64url(mac),
      new TextEncoder().encode(payload),
    );
    if (!good) return null;
    const { a, e } = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as {
      a?: unknown;
      e?: unknown;
    };
    return typeof a === 'string' && typeof e === 'number' && e > now ? a : null;
  } catch {
    return null; // not base64url, or not JSON: not a session
  }
}

/** The value of cookie name in request, or ''. */
export function cookie(request: Request, name: string): string {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

/** A Set-Cookie header: name=value, sent back only to path over HTTPS,
 * hidden from scripts, kept for maxAge ms (0: removed). */
export function setCookie(
  name: string,
  value: string,
  path: string,
  maxAge: number,
  sameSite: 'Lax' | 'Strict' = 'Lax',
): string {
  const seconds = Math.floor(maxAge / 1000);
  return `${name}=${value}; Max-Age=${seconds}; Path=${path}; HttpOnly; Secure; SameSite=${sameSite}`;
}

/** Why request may not change anything, or null when it may: a write
 * (POST, DELETE) must say it is JSON, which a plain form can't, and come
 * from the page's own origin. */
export function refused(request: Request): string | null {
  if (request.method !== 'POST' && request.method !== 'DELETE') return null;
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) return 'JSON only.';
  if (request.headers.get('Origin') !== new URL(request.url).origin) return 'Not from cuento.';
  return null;
}

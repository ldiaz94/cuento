/* Web Push from the Worker: a message encrypted for one browser (RFC 8291,
 * aes128gcm) and signed for by cuento's VAPID key (RFC 8292), posted to
 * the browser's push service.
 *
 *   body = salt(16) │ record size(4) │ key length(1) │ our one-off public key(65) │ AES-GCM(text │ 0x02)
 *
 * Each message has its own ECDH key pair and salt; with the browser's key
 * (p256dh) and secret (auth) they give, through HKDF, the AES key and
 * nonce. The VAPID token is an ES256 JWT for the push service's origin.
 * Written here on WebCrypto, about a hundred lines, instead of the
 * web-push package, which needs Node's crypto and http and so does not
 * run on workerd. Depends on WebCrypto and session.ts's base64url, so it
 * runs in the Worker and in Node's tests. Leaves out messages longer than
 * one record (4 KB, far more than a notification needs) and the Topic
 * header. */
import { toBase64url, fromBase64url } from './session.ts';

/** A browser's push subscription: where to post, and its keys (base64url). */
export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The record size the header announces: one record holds the message. */
const RECORD = 4096;
/** How long a push service may hold a message for an offline device, in s. */
const TTL = 4 * 60 * 60;
/** How long a VAPID token lasts, in s (RFC 8292 allows up to 24 h). */
const TOKEN_LIFE = 12 * 60 * 60;

/** text as UTF-8 bytes. */
const utf8 = (text: string) => new Uint8Array(new TextEncoder().encode(text));

/** The parts, end to end. */
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** HKDF-SHA256 (RFC 5869): length bytes from ikm, salt and info. */
async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** A P-256 key as a JWK, from its public point (65 bytes, uncompressed)
 * and, for a private key, its d (base64url). */
export function jwk(point: Uint8Array, d?: string): JsonWebKey {
  const x = toBase64url(point.slice(1, 33));
  const y = toBase64url(point.slice(33, 65));
  return { kty: 'EC', crv: 'P-256', x, y, ...(d ? { d } : {}) };
}

/** text encrypted for the browser with the keys of to (RFC 8291). The
 * salt and our key pair are made fresh; the tests pass the RFC's. */
export async function encrypt(
  text: Uint8Array,
  to: Subscription['keys'],
  salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16)),
  ours?: CryptoKeyPair,
): Promise<Uint8Array<ArrayBuffer>> {
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
  const pair =
    ours ?? ((await crypto.subtle.generateKey(ecdh, true, ['deriveBits'])) as CryptoKeyPair);
  const ourPublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  const theirPublic = fromBase64url(to.p256dh);
  const theirKey = await crypto.subtle.importKey('raw', theirPublic, ecdh, false, []);
  // (Cast: the Workers types misname ECDH's public key "$public".)
  const params = { name: 'ECDH', public: theirKey } as Parameters<
    typeof crypto.subtle.deriveBits
  >[0];
  const shared = new Uint8Array(await crypto.subtle.deriveBits(params, pair.privateKey, 256));

  // The shared secret and the browser's auth secret make the key material;
  // that and the salt make the AES key and the nonce.
  const keyInfo = concat(utf8('WebPush: info\0'), theirPublic, ourPublic);
  const ikm = await hkdf(fromBase64url(to.auth), shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  // One record, the last: the text, then the delimiter 2 (no padding).
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    aes,
    concat(text, new Uint8Array([2])),
  );
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, RECORD);
  return concat(salt, size, new Uint8Array([ourPublic.length]), ourPublic, new Uint8Array(sealed));
}

/** The Authorization header for a push to endpoint (RFC 8292): a JWT
 * for its origin, signed with the private key d, and the public key, both
 * base64url. WebCrypto's ECDSA signature is r and s end to end, as JWT's
 * ES256 wants. */
export async function vapid(
  endpoint: string,
  publicKey: string,
  d: string,
  subject: string,
  now: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk(fromBase64url(publicKey), d),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const part = (value: object) => toBase64url(utf8(JSON.stringify(value)));
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + TOKEN_LIFE,
    sub: subject,
  };
  const unsigned = part({ typ: 'JWT', alg: 'ES256' }) + '.' + part(claims);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(unsigned),
  );
  return `vapid t=${unsigned}.${toBase64url(new Uint8Array(signature))}, k=${publicKey}`;
}

/** cuento's VAPID key pair (base64url) and who to contact about it. */
export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** Posts message (JSON) to the browser behind to; gives the push
 * service's HTTP status (404 and 410: the subscription is gone). */
export async function send(to: Subscription, message: object, keys: Vapid): Promise<number> {
  const body = await encrypt(utf8(JSON.stringify(message)), to.keys);
  const response = await fetch(to.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapid(
        to.endpoint,
        keys.publicKey,
        keys.privateKey,
        keys.subject,
        Date.now(),
      ),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(TTL),
      Urgency: 'normal',
    },
    body,
  });
  return response.status;
}

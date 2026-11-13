/* Accounts made of passkeys: the routes that make and sign in to one, and
 * the Durable Object (Accounts, one for all) that keeps them.
 *
 *   POST   /api/auth/register/options  {}                       ─► creation options
 *   POST   /api/auth/register/verify   {response, shelf?, name?} ─► {ok}, a session
 *   POST   /api/auth/login/options     {}                       ─► request options
 *   POST   /api/auth/login/verify      {response}               ─► {ok}, a session
 *   POST   /api/auth/logout            {}                       ─► {ok}, no session
 *   DELETE /api/auth/passkeys/<id>                              ─► {ok}
 *   GET    /api/me                                              ─► {passkeys, shelf} or 401
 *   POST   /api/me/shelf               {shelf}                  ─► {ok}
 *
 * Registering with no session makes an account that owns shelf (the
 * device's sync code, which the client always has by then); registering
 * while signed in adds a passkey to that account. Each options call keeps
 * its challenge in Accounts for five minutes and puts the challenge's id
 * in an HttpOnly cookie, cuento_chal, sent only to /api/auth; the verify
 * that follows takes it, once. The passkey is checked by @simplewebauthn/
 * server: the challenge, the origin and RP ID (the page's own host), the
 * signature, user presence, and that the signature counter went up. User
 * verification (Face ID, a PIN) is asked for but not required, as
 * userVerification 'preferred' means. Sessions and the guard against other
 * sites are session.ts's. Depends on accounts.ts, session.ts,
 * @simplewebauthn/server, and Cloudflare's Durable Objects with SQLite.
 * Leaves out attestation (which maker's authenticator it is), rate
 * limits, and ending other devices' sessions. */
import { DurableObject } from 'cloudflare:workers';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import * as store from './accounts.ts';
import type { Sql, NewCredential } from './accounts.ts';
import {
  SESSION,
  SESSION_TTL,
  sign,
  verify,
  cookie,
  setCookie,
  refused,
  fromBase64url,
} from './session.ts';

/** The challenge cookie's name. */
const CHALLENGE = 'cuento_chal';
/** The relying party's name, as a passkey manager shows it. */
const RP_NAME = 'cuento';
/** The name a passkey is saved under (an account has no other). */
const USER_NAME = 'cuento reader';
/** A sync code: 26 characters of Crockford's base32, upper case. */
const CODE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** The largest body taken by an account route, in bytes. */
const MAX_BODY = 64 * 1024;
/** The longest name a passkey keeps. */
const MAX_NAME = 40;

/** Every account: one object, its own SQLite, its methods the store's. */
export class Accounts extends DurableObject<Env> {
  /** The store's SQL, on this object's own database (a blob goes in as an
   * ArrayBuffer). */
  private sql: Sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = (query, ...params) =>
      ctx.storage.sql
        .exec(query, ...params.map(p => (p instanceof Uint8Array ? p.slice().buffer : p)))
        .toArray();
    store.setUp(this.sql);
  }

  keepChallenge(challenge: string, account: string | null) {
    return store.keepChallenge(this.sql, challenge, account, Date.now());
  }
  takeChallenge(id: string) {
    return store.takeChallenge(this.sql, id, Date.now());
  }
  addCredential(account: string, shelf: string | null, c: NewCredential) {
    return this.ctx.storage.transactionSync(() =>
      store.addCredential(this.sql, account, shelf, c, Date.now()),
    );
  }
  credential(id: string) {
    return store.credential(this.sql, id);
  }
  used(id: string, counter: number) {
    store.used(this.sql, id, counter, Date.now());
  }
  credentialIds(account: string) {
    return store.credentialIds(this.sql, account);
  }
  me(account: string) {
    return store.me(this.sql, account);
  }
  removeCredential(account: string, id: string) {
    return store.removeCredential(this.sql, account, id);
  }
  setShelf(account: string, shelf: string) {
    store.setShelf(this.sql, account, shelf);
  }
}

/** An answer in JSON (a sentence, for an error), never cached, with
 * cookies to set. */
function answer(status: number, body: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return Response.json(status < 400 ? body : { error: body }, { status, headers });
}

/** The request's body as JSON (an object), or null when it is not one or
 * is too big. */
async function body(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const value: unknown = JSON.parse(text || '{}');
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Answers an account route (path starts /api/auth/ or is /api/me...). */
export async function auth(request: Request, env: Env, path: string): Promise<Response> {
  const key = (env as Env & { SESSION_KEY?: string }).SESSION_KEY;
  if (!key) return answer(503, 'Accounts are not set up on this server: it has no SESSION_KEY.');
  const why = refused(request);
  if (why) return answer(403, why);

  const url = new URL(request.url);
  const rp = { rpID: url.hostname, origin: url.origin };
  const accounts = env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts'));
  const now = Date.now();
  const signedIn = await verify(key, cookie(request, SESSION), now);
  const route = request.method + ' ' + path;

  /** A session for account, as cookies: the challenge's cleared too. */
  const session = async (account: string) => [
    setCookie(SESSION, await sign(key, account, now), '/api', SESSION_TTL),
    setCookie(CHALLENGE, '', '/api/auth', 0, 'Strict'),
  ];
  /** Options sent with their challenge, kept for account, in a cookie. */
  const withChallenge = async (options: { challenge: string }, account: string | null) => {
    const id = await accounts.keepChallenge(options.challenge, account);
    return answer(200, options, [
      setCookie(CHALLENGE, id, '/api/auth', store.CHALLENGE_TTL, 'Strict'),
    ]);
  };
  /** The challenge this browser was given, taken: answered once only. */
  const challenge = () => accounts.takeChallenge(cookie(request, CHALLENGE));

  if (route === 'POST /api/auth/register/options') {
    // Signed in: another passkey for the same account (the same user id).
    const account = signedIn && (await accounts.me(signedIn)) ? signedIn : store.randomId();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp.rpID,
      userName: USER_NAME,
      userDisplayName: USER_NAME,
      userID: fromBase64url(account),
      attestationType: 'none',
      excludeCredentials: (await accounts.credentialIds(account)).map(id => ({ id })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    return withChallenge(options, account);
  }

  if (route === 'POST /api/auth/register/verify') {
    const given = await body(request);
    const kept = await challenge();
    if (!given || !kept?.account) return answer(400, 'That took too long: try again.');
    const account = kept.account;
    const exists = (await accounts.me(account)) !== null;
    if (exists && signedIn !== account) return answer(403, 'Sign in again to add a passkey.');
    const shelf = typeof given.shelf === 'string' && CODE.test(given.shelf) ? given.shelf : null;
    if (!exists && !shelf) return answer(400, 'A new account needs a shelf: turn sync on first.');
    let info;
    try {
      const v = await verifyRegistrationResponse({
        response: given.response as RegistrationResponseJSON,
        expectedChallenge: kept.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      });
      info = v.verified ? v.registrationInfo : null;
    } catch {
      info = null; // malformed, or signed for another challenge, origin or site
    }
    if (!info) return answer(400, 'The passkey could not be checked.');
    const name =
      typeof given.name === 'string' && given.name.trim()
        ? given.name.trim().slice(0, MAX_NAME)
        : 'Passkey';
    const added = await accounts.addCredential(account, shelf, {
      id: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      name,
    });
    if (!added) return answer(409, 'That passkey is already kept.');
    return answer(200, { ok: true }, await session(account));
  }

  if (route === 'POST /api/auth/login/options') {
    // No allowCredentials: the passkey says whose it is (discoverable).
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: 'preferred',
    });
    return withChallenge(options, null);
  }

  if (route === 'POST /api/auth/login/verify') {
    const given = await body(request);
    const kept = await challenge();
    if (!given || !kept || kept.account !== null)
      return answer(400, 'That took too long: try again.');
    const response = given.response as AuthenticationResponseJSON | undefined;
    const found = typeof response?.id === 'string' ? await accounts.credential(response.id) : null;
    if (!response || !found)
      return answer(404, 'cuento does not know this passkey: it may have been removed.');
    // The user handle, when given, must be the account the passkey belongs to.
    const handle = response.response?.userHandle;
    if (handle && handle !== found.account) return answer(400, 'The passkey could not be checked.');
    let counter: number | null = null;
    try {
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: kept.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: found,
        requireUserVerification: false,
      });
      if (v.verified) counter = v.authenticationInfo.newCounter;
    } catch {
      // malformed, signed for another challenge or site, or a counter gone back: a cloned key?
    }
    if (counter === null) return answer(400, 'The passkey could not be checked.');
    await accounts.used(found.id, counter);
    return answer(200, { ok: true }, await session(found.account));
  }

  if (route === 'POST /api/auth/logout')
    return answer(200, { ok: true }, [setCookie(SESSION, '', '/api', 0)]);

  // The rest is for a signed-in device only.
  const me = signedIn ? await accounts.me(signedIn) : null;
  if (!signedIn || !me) return answer(401, 'Not signed in.');

  if (route === 'GET /api/me') return answer(200, me);

  if (route === 'POST /api/me/shelf') {
    const given = await body(request);
    if (typeof given?.shelf !== 'string' || !CODE.test(given.shelf))
      return answer(400, 'Not a sync code.');
    await accounts.setShelf(signedIn, given.shelf);
    return answer(200, { ok: true });
  }

  const passkey = /^DELETE \/api\/auth\/passkeys\/([\w-]+)$/.exec(route);
  if (passkey) {
    const removed = await accounts.removeCredential(signedIn, passkey[1]!);
    if (removed === 'last') return answer(409, 'This is your only passkey: add another first.');
    if (removed === 'missing') return answer(404, 'No such passkey.');
    return answer(200, { ok: true });
  }

  return answer(404, 'No such route.');
}

/* An account: passkeys that own a shelf, so signing in on a new device
 * finds the shelf with no sync code. A passkey is the phone's Face ID,
 * fingerprint or screen lock; there is no email, name or password.
 *
 *   signUp:  sync on (a code) ─► create a passkey ─► the account owns the code
 *   signIn:  a passkey ─► the account ─► join its shelf (sync.ts)
 *
 * The server (worker/auth.ts) keeps the session in an HttpOnly cookie,
 * so this module only asks it who is signed in (me). The browser's side
 * of WebAuthn is navigator.credentials, with the options and answers
 * turned to and from JSON here (base64url for the bytes): a few lines,
 * instead of a library to vendor and load. Depends on spark and sync.ts.
 * Leaves out recovery without a passkey, and renaming a passkey. */
import { signal } from './spark/index.js';
import { code, enable, join } from './sync.ts';

/** A passkey, as the account lists it (times in ms since 1970). */
export interface Passkey {
  id: string;
  name: string;
  created: number;
  lastUsed: number;
}

/** The signed-in account: its passkeys, and its shelf's sync code. */
export interface Me {
  passkeys: Passkey[];
  shelf: string;
}

const [me, setMe] = signal<Me | null>(null);
/** The signed-in account, or null when signed out (or not yet asked). */
export { me };

// ---- Bytes as text -----------------------------------------------------------

/** base64url text as bytes. */
function bytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

/** buffer as base64url text, unpadded. */
function text(buffer: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- The server ----------------------------------------------------------------

/** Asks the server: the reply's JSON. Throws an Error in words when it
 * can't be reached or refuses (with the HTTP status, when refused). */
async function api(path: string, body?: object, method = body ? 'POST' : 'GET'): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw Error("Couldn't reach cuento's server: are you online?");
  }
  const reply = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok)
    throw Object.assign(
      Error(
        response.status >= 500
          ? 'Accounts are not available just now.'
          : reply.error || 'The server said no.',
      ),
      { status: response.status },
    );
  return reply;
}

/** Asks the server who is signed in. Throws (keeping me as it was) when
 * the server can't be reached. */
export async function refresh() {
  try {
    setMe((await api('/api/me')) as Me);
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error;
    setMe(null);
  }
}

/** Keeps a signed-in device on its account's shelf. Another device may
 * have given the account another shelf; on opening, and on coming back
 * to the screen, a device syncing a different one joins the account's (a
 * merge: books only here go to it). A device that stopped syncing stays
 * stopped. */
export function follow() {
  const check = async () => {
    try {
      await refresh();
    } catch {
      return; // offline, or the server is away: next time
    }
    const shelf = me()?.shelf;
    if (shelf && code() && shelf !== code()) await join(shelf).catch(() => {});
  };
  check();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}

// ---- Passkeys ------------------------------------------------------------------

/** Why a passkey couldn't be made or used, in words. */
function passkeyTrouble(error: unknown): Error {
  const name = (error as DOMException)?.name;
  if (name === 'NotAllowedError') return Error('Cancelled, or the passkey took too long.');
  if (name === 'InvalidStateError') return Error('This device already has a passkey for cuento.');
  if (name === 'SecurityError') return Error('Passkeys need cuento on a secure (https) page.');
  return Error('The passkey did not work: ' + ((error as Error)?.message || 'unknown trouble.'));
}

/** Throws unless this browser can use passkeys. */
function needPasskeys() {
  if (!('PublicKeyCredential' in window) || !navigator.credentials)
    throw Error('This browser cannot use passkeys.');
}

/** A guess at what this device is, to name its passkey. */
function deviceName(): string {
  const ua = navigator.userAgent;
  for (const [pattern, name] of [
    [/iPhone/, 'iPhone'],
    [/iPad/, 'iPad'],
    [/Android/, 'Android'],
    [/Macintosh/, 'Mac'],
    [/Windows/, 'Windows'],
    [/CrOS/, 'Chromebook'],
    [/Linux/, 'Linux'],
  ] as const)
    if (pattern.test(ua)) return name;
  return 'Passkey';
}

/** Makes a passkey from the server's options, and sends it back with
 * extra (the shelf, the device's name). */
async function register(extra: object) {
  needPasskeys();
  const o = (await api('/api/auth/register/options', {})) as PublicKeyCredentialCreationOptionsJSON;
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...o,
    challenge: bytes(o.challenge),
    user: { ...o.user, id: bytes(o.user.id) },
    excludeCredentials: o.excludeCredentials?.map(c => ({ ...c, id: bytes(c.id) })),
  } as PublicKeyCredentialCreationOptions;
  let made: PublicKeyCredential;
  try {
    made = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential;
  } catch (error) {
    throw passkeyTrouble(error);
  }
  const r = made.response as AuthenticatorAttestationResponse;
  const response = {
    id: made.id,
    rawId: text(made.rawId),
    type: made.type,
    authenticatorAttachment: made.authenticatorAttachment ?? undefined,
    clientExtensionResults: made.getClientExtensionResults(),
    response: {
      clientDataJSON: text(r.clientDataJSON),
      attestationObject: text(r.attestationObject),
      transports: r.getTransports?.() ?? [],
    },
  };
  await api('/api/auth/register/verify', { response, name: deviceName(), ...extra });
}

/** Creates an account with a passkey made here. It owns this device's
 * shelf: sync is turned on first, when it is off. */
export async function signUp() {
  needPasskeys();
  if (!code()) await enable();
  await register({ shelf: code() });
  await refresh();
}

/** Adds a passkey to the signed-in account: on this device, or on a
 * phone nearby, as the browser offers. */
export async function addPasskey() {
  await register({});
  await refresh();
}

/** Signs in with a passkey, then syncs the account's shelf here (joining
 * it, when this device syncs another or none). */
export async function signIn() {
  needPasskeys();
  const o = (await api('/api/auth/login/options', {})) as PublicKeyCredentialRequestOptionsJSON;
  const publicKey = { ...o, challenge: bytes(o.challenge) } as PublicKeyCredentialRequestOptions;
  let used: PublicKeyCredential;
  try {
    used = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential;
  } catch (error) {
    throw passkeyTrouble(error);
  }
  const r = used.response as AuthenticatorAssertionResponse;
  const response = {
    id: used.id,
    rawId: text(used.rawId),
    type: used.type,
    authenticatorAttachment: used.authenticatorAttachment ?? undefined,
    clientExtensionResults: used.getClientExtensionResults(),
    response: {
      clientDataJSON: text(r.clientDataJSON),
      authenticatorData: text(r.authenticatorData),
      signature: text(r.signature),
      userHandle: r.userHandle ? text(r.userHandle) : undefined,
    },
  };
  await api('/api/auth/login/verify', { response });
  await refresh();
  const shelf = me()?.shelf;
  if (shelf && shelf !== code()) await join(shelf);
}

/** Removes a passkey from the account (the server keeps the last one). */
export async function removePasskey(id: string) {
  await api('/api/auth/passkeys/' + encodeURIComponent(id), {}, 'DELETE');
  await refresh();
}

/** Makes this device's shelf the account's: for after joining another. */
export async function adopt() {
  await api('/api/me/shelf', { shelf: code() });
  await refresh();
}

/** Signs out of this device: its books and sync code stay. */
export async function signOut() {
  await api('/api/auth/logout', {});
  setMe(null);
}

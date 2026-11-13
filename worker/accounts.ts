/* The accounts' store on the server: who owns which shelf, the passkeys
 * that sign them in, and the challenges a passkey must sign. Pure: it runs
 * over a tiny SQL interface, so the Accounts Durable Object (worker/auth.ts)
 * gives it SQLite and the tests give it node:sqlite.
 *
 *   accounts:    id │ created │ shelf (its sync code)
 *   credentials: id │ account │ publicKey │ counter │ transports │ created │ lastUsed │ name
 *   challenges:  id │ challenge │ account (null when signing in) │ expires
 *
 * An account's id is also its WebAuthn user handle: 16 random bytes, in
 * base64url. An account has no name, email or password; more ways to
 * reach one (a recovery email) would be a table beside credentials. A
 * challenge is taken once: reading it deletes it. Depends on session.ts
 * (for base64url).
 * Leaves out deleting an account, and renaming a passkey. */
import type { Row } from './store.ts';
import { toBase64url } from './session.ts';

/** What a query's parameters may be: a blob is a Uint8Array. */
export type Param = string | number | null | Uint8Array;
/** Runs a query with its parameters, and gives back its rows. */
export type Sql = (query: string, ...params: Param[]) => Row[];

/** How long a challenge may be answered, in ms. */
export const CHALLENGE_TTL = 5 * 60_000;

/** A passkey as the account's page lists it. */
export interface Passkey {
  id: string;
  name: string;
  created: number;
  lastUsed: number;
}

/** What a signed-in device sees of its account. */
export interface Me {
  passkeys: Passkey[];
  shelf: string;
}

/** A passkey as kept to check what it signs. */
export interface Credential {
  id: string;
  account: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
}

/** A new passkey, as a registration gives it. */
export interface NewCredential {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
  name: string;
}

/** Makes the tables, when the store is new. */
export function setUp(sql: Sql) {
  sql('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, created INTEGER, shelf TEXT)');
  sql(`CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY, account TEXT, publicKey BLOB, counter INTEGER, transports TEXT,
    created INTEGER, lastUsed INTEGER, name TEXT)`);
  sql('CREATE INDEX IF NOT EXISTS credentials_account ON credentials (account)');
  sql(`CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY, challenge TEXT, account TEXT, expires INTEGER)`);
}

/** n random bytes, in base64url. */
export function randomId(n = 16): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(n)));
}

// ---- Challenges -------------------------------------------------------------

/** Keeps a challenge for CHALLENGE_TTL, for account (null: anyone signing
 * in); the id to take it back by. Forgets the expired ones meanwhile. */
export function keepChallenge(
  sql: Sql,
  challenge: string,
  account: string | null,
  now: number,
): string {
  sql('DELETE FROM challenges WHERE expires <= ?', now);
  const id = randomId();
  sql('INSERT INTO challenges VALUES (?, ?, ?, ?)', id, challenge, account, now + CHALLENGE_TTL);
  return id;
}

/** The challenge kept as id, now no longer kept; null when there is none
 * or it has expired. */
export function takeChallenge(
  sql: Sql,
  id: string,
  now: number,
): { challenge: string; account: string | null } | null {
  const row = sql('DELETE FROM challenges WHERE id = ? RETURNING *', id)[0];
  if (!row || Number(row.expires) <= now) return null;
  return {
    challenge: String(row.challenge),
    account: row.account === null ? null : String(row.account),
  };
}

// ---- Accounts and their passkeys --------------------------------------------

/** Keeps a new passkey for account. An account not yet kept is made, with
 * shelf as its shelf; with no shelf, it is not. False when nothing was
 * kept: no such account and no shelf, or a passkey already kept. */
export function addCredential(
  sql: Sql,
  account: string,
  shelf: string | null,
  c: NewCredential,
  now: number,
): boolean {
  if (sql('SELECT 1 FROM credentials WHERE id = ?', c.id).length) return false;
  if (!sql('SELECT 1 FROM accounts WHERE id = ?', account).length) {
    if (!shelf) return false;
    sql('INSERT INTO accounts VALUES (?, ?, ?)', account, now, shelf);
  }
  sql(
    'INSERT INTO credentials VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    c.id,
    account,
    c.publicKey,
    c.counter,
    c.transports.join(','),
    now,
    now,
    c.name,
  );
  return true;
}

/** The passkey whose id this is, or null. */
export function credential(sql: Sql, id: string): Credential | null {
  const row = sql('SELECT * FROM credentials WHERE id = ?', id)[0];
  if (!row) return null;
  return {
    id,
    account: String(row.account),
    publicKey: new Uint8Array(row.publicKey as ArrayBuffer),
    counter: Number(row.counter),
    transports: String(row.transports).split(',').filter(Boolean),
  };
}

/** Records a sign-in with passkey id: its signature counter, and when. */
export function used(sql: Sql, id: string, counter: number, now: number) {
  sql(
    'UPDATE credentials SET counter = MAX(counter, ?), lastUsed = ? WHERE id = ?',
    counter,
    now,
    id,
  );
}

/** The ids of account's passkeys (a new one must not repeat them). */
export function credentialIds(sql: Sql, account: string): string[] {
  return sql('SELECT id FROM credentials WHERE account = ?', account).map(r => String(r.id));
}

/** What account's page shows, or null when there is no such account. */
export function me(sql: Sql, account: string): Me | null {
  const row = sql('SELECT shelf FROM accounts WHERE id = ?', account)[0];
  if (!row) return null;
  const passkeys = sql(
    'SELECT id, name, created, lastUsed FROM credentials WHERE account = ? ORDER BY created',
    account,
  ).map(r => ({
    id: String(r.id),
    name: String(r.name),
    created: Number(r.created),
    lastUsed: Number(r.lastUsed),
  }));
  return { passkeys, shelf: String(row.shelf) };
}

/** Removes account's passkey id, unless it is the account's last one
 * (which would lock the account for good). */
export function removeCredential(
  sql: Sql,
  account: string,
  id: string,
): 'removed' | 'last' | 'missing' {
  const ids = credentialIds(sql, account);
  if (!ids.includes(id)) return 'missing';
  if (ids.length === 1) return 'last';
  sql('DELETE FROM credentials WHERE id = ? AND account = ?', id, account);
  return 'removed';
}

/** Makes shelf (a sync code) account's shelf. */
export function setShelf(sql: Sql, account: string, shelf: string) {
  sql('UPDATE accounts SET shelf = ? WHERE id = ?', shelf, account);
}

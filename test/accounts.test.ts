/* Accounts, without a network or a passkey: the store (worker/accounts.ts)
 * on node:sqlite, sessions that can't be forged or outlive their time,
 * and the guard that keeps other sites from writing (worker/session.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as accounts from '../worker/accounts.ts';
import type { Sql, NewCredential } from '../worker/accounts.ts';
import { sign, verify, refused, cookie, toBase64url, SESSION_TTL } from '../worker/session.ts';

/** A new, empty store in memory. */
function store(): Sql {
  const db = new DatabaseSync(':memory:');
  const sql: Sql = (query, ...params) => db.prepare(query).all(...params);
  accounts.setUp(sql);
  return sql;
}

/** A passkey with this id. */
const passkey = (id: string): NewCredential => ({
  id,
  publicKey: new Uint8Array([1, 2, 3, 255]),
  counter: 0,
  transports: ['internal', 'hybrid'],
  name: 'Phone',
});
const SHELF = '0123456789ABCDEFGHJKMNPQRS';

test('challenges: answered once, and not after they expire', () => {
  const sql = store();
  const id = accounts.keepChallenge(sql, 'c1', 'acct', 1000);
  assert.deepEqual(accounts.takeChallenge(sql, id, 1001), { challenge: 'c1', account: 'acct' });
  assert.equal(accounts.takeChallenge(sql, id, 1002), null); // single use
  const late = accounts.keepChallenge(sql, 'c2', null, 1000);
  assert.equal(accounts.takeChallenge(sql, late, 1000 + accounts.CHALLENGE_TTL), null);
  assert.equal(accounts.takeChallenge(sql, '', 1000), null);
});

test('accounts: a new one needs a shelf; more passkeys join it; the last stays', () => {
  const sql = store();
  assert.equal(accounts.addCredential(sql, 'a', null, passkey('k1'), 1), false);
  assert.equal(accounts.me(sql, 'a'), null);
  assert.ok(accounts.addCredential(sql, 'a', SHELF, passkey('k1'), 1));
  assert.ok(accounts.addCredential(sql, 'a', null, passkey('k2'), 2));
  assert.equal(accounts.addCredential(sql, 'b', SHELF, passkey('k2'), 3), false); // k2 is a's
  assert.equal(accounts.me(sql, 'b'), null); // and no account was left behind

  const k1 = accounts.credential(sql, 'k1');
  assert.deepEqual([...k1!.publicKey], [1, 2, 3, 255]);
  assert.deepEqual(k1!.transports, ['internal', 'hybrid']);
  accounts.used(sql, 'k1', 7, 50);
  accounts.used(sql, 'k1', 3, 60); // a counter never goes back
  assert.equal(accounts.credential(sql, 'k1')?.counter, 7);

  const me = accounts.me(sql, 'a')!;
  assert.equal(me.shelf, SHELF);
  assert.deepEqual(
    me.passkeys.map(p => [p.id, p.lastUsed]),
    [
      ['k1', 60],
      ['k2', 2],
    ],
  );
  assert.equal(accounts.removeCredential(sql, 'b', 'k1'), 'missing'); // not b's to remove
  assert.equal(accounts.removeCredential(sql, 'a', 'k1'), 'removed');
  assert.equal(accounts.removeCredential(sql, 'a', 'k2'), 'last');
  accounts.setShelf(sql, 'a', 'Z'.repeat(26));
  assert.equal(accounts.me(sql, 'a')?.shelf, 'Z'.repeat(26));
});

test('sessions: signed, not forged, tampered with or kept past their time', async () => {
  const s = await sign('key', 'acct', 1000);
  assert.equal(await verify('key', s, 1001), 'acct');
  assert.equal(await verify('other key', s, 1001), null);
  assert.equal(await verify('key', s, 1000 + SESSION_TTL), null);
  const [, mac] = s.split('.');
  const forged = toBase64url(new TextEncoder().encode('{"a":"evil","e":1e15}'));
  assert.equal(await verify('key', forged + '.' + mac, 1001), null);
  assert.equal(await verify('key', s + '.x', 1001), null);
  assert.equal(await verify('key', '', 1001), null);
  assert.equal(await verify('key', 'a.b', 1001), null);
});

test('guard: only JSON from cuento’s own origin may write', () => {
  const at = 'https://cuento.example/api/auth/logout';
  const req = (method: string, headers: Record<string, string>) =>
    new Request(at, { method, headers });
  const json = { 'Content-Type': 'application/json', Origin: 'https://cuento.example' };
  assert.equal(refused(req('POST', json)), null);
  assert.equal(refused(req('DELETE', json)), null);
  assert.equal(refused(req('GET', {})), null);
  assert.ok(refused(req('POST', { ...json, 'Content-Type': 'text/plain' })));
  assert.ok(refused(req('POST', { ...json, 'Content-Type': 'application/jsonx' })));
  assert.ok(refused(req('POST', { ...json, Origin: 'https://evil.example' })));
  assert.ok(refused(req('POST', { ...json, Origin: 'https://cuento.example:8443' })));
  assert.ok(refused(req('DELETE', { 'Content-Type': 'application/json' }))); // no Origin
});

test('cookies: found by exact name', () => {
  const r = new Request('https://x/', {
    headers: { Cookie: 'xcuento_session=bad; cuento_session=good.mac; other=1' },
  });
  assert.equal(cookie(r, 'cuento_session'), 'good.mac');
  assert.equal(cookie(r, 'missing'), '');
});

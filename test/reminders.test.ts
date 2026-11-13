/* Reminders, without a push service: the message encryption against RFC
 * 8291's own example, a VAPID token that verifies, what the routes take,
 * and who is due when (time zones, summer time, weekdays, once a day, the
 * Year in review nudge), on node:sqlite. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { encrypt, vapid, jwk } from '../worker/push.ts';
import * as reminders from '../worker/reminders.ts';
import type { Prefs } from '../worker/reminders.ts';
import type { Sql } from '../worker/store.ts';
import { toBase64url, fromBase64url } from '../worker/session.ts';

/** RFC 8291's example (Section 5, Appendix A), base64url. */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('encryption gives RFC 8291 example, byte for byte', async () => {
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
  const point = fromBase64url(RFC.asPublic);
  const ours = {
    publicKey: await crypto.subtle.importKey('jwk', jwk(point), ecdh, true, []),
    privateKey: await crypto.subtle.importKey('jwk', jwk(point, RFC.asPrivate), ecdh, false, [
      'deriveBits',
    ]),
  };
  const body = await encrypt(
    new TextEncoder().encode(RFC.plaintext),
    { p256dh: RFC.uaPublic, auth: RFC.auth },
    fromBase64url(RFC.salt),
    ours,
  );
  assert.equal(toBase64url(body), RFC.body);
});

test('a VAPID token is for the push service, and verifies with the public key', async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = toBase64url(
    new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
  );
  const d = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d!;
  const now = Date.UTC(2026, 10, 13);
  const header = await vapid(
    'https://push.example/send/abc',
    publicKey,
    d,
    'https://cuento.page',
    now,
  );
  const [, token, k] = /^vapid t=(\S+), k=(\S+)$/.exec(header)!;
  assert.equal(k, publicKey);
  const [head, claims, signature] = token!.split('.') as [string, string, string];
  const json = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  assert.deepEqual(json(head), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(json(claims), {
    aud: 'https://push.example',
    exp: now / 1000 + 12 * 3600,
    sub: 'https://cuento.page',
  });
  const good = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.publicKey,
    fromBase64url(signature),
    new TextEncoder().encode(head + '.' + claims),
  );
  assert.ok(good);
});

/** A subscription as a browser sends it (keys of the right lengths). */
const SUB = {
  endpoint: 'https://push.example/send/abc',
  keys: { p256dh: RFC.uaPublic, auth: RFC.auth },
};
/** Prefs: reminders at 21:00 every day, no review nudge. */
const PREFS: Prefs = { enabled: true, time: '21:00', days: [0, 1, 2, 3, 4, 5, 6], review: false };

test('the routes take only well-formed subscriptions, prefs and time zones', () => {
  assert.deepEqual(reminders.parseSubscription(SUB), SUB);
  assert.equal(reminders.parseSubscription({ ...SUB, endpoint: 'http://push.example/x' }), null);
  assert.equal(reminders.parseSubscription({ ...SUB, endpoint: 'not a url' }), null);
  assert.equal(
    reminders.parseSubscription({ ...SUB, keys: { p256dh: 'AAAA', auth: RFC.auth } }),
    null,
  );
  assert.equal(reminders.parseSubscription(null), null);
  assert.equal(reminders.parseEndpoint('https://x/' + 'a'.repeat(2000)), null);

  assert.deepEqual(reminders.parsePrefs(PREFS), PREFS);
  for (const bad of [
    { ...PREFS, time: '24:00' },
    { ...PREFS, time: '9:00' },
    { ...PREFS, days: [7] },
    { ...PREFS, days: [1, 1] },
    { ...PREFS, days: [1.5] },
    { ...PREFS, enabled: 'yes' },
    { ...PREFS, review: undefined },
  ])
    assert.equal(reminders.parsePrefs(bad), null, JSON.stringify(bad));

  assert.equal(reminders.parseTz('Europe/Madrid'), 'Europe/Madrid');
  assert.equal(reminders.parseTz('Mars/Olympus'), null);
  assert.equal(reminders.parseTz(42), null);
});

/** A store in memory, with one browser subscribed with prefs in tz. */
function store(prefs: Prefs, tz: string): Sql {
  const db = new DatabaseSync(':memory:');
  const sql: Sql = (query, ...params) => db.prepare(query).all(...params);
  reminders.setUp(sql);
  reminders.subscribe(sql, SUB, prefs, tz, 0);
  return sql;
}
/** The notices due at the UTC time iso in sql, sending them. */
function send(sql: Sql, iso: string) {
  const due = reminders.due(sql, Date.parse(iso));
  for (const d of due) reminders.sent(sql, d.subscription.endpoint, d.day);
  return due.map(d => d.notice.tag);
}

test('a reminder comes in the quarter hour of its local time, once a day', () => {
  const sql = store({ ...PREFS, time: '21:10' }, 'Europe/Madrid'); // UTC+1 in November
  assert.deepEqual(send(sql, '2026-11-13T19:59:59Z'), []); // 20:59 there
  assert.deepEqual(send(sql, '2026-11-13T20:00:00Z'), ['reminder']); // 21:00: the window holds 21:10
  assert.deepEqual(send(sql, '2026-11-13T20:14:00Z'), []); // sent today already
  assert.deepEqual(send(sql, '2026-11-14T20:15:00Z'), []); // next day, window past
  assert.deepEqual(send(sql, '2026-11-15T20:05:00Z'), ['reminder']); // a late cron, same window
});

test('a reminder keeps to local time across summer time, and to its days', () => {
  // New York: 21:00 is 01:00 UTC before 1 November 2026, 02:00 after.
  const sql = store({ ...PREFS, days: [6] }, 'America/New_York'); // Saturdays
  assert.deepEqual(send(sql, '2026-10-25T01:00:00Z'), ['reminder']); // Sat 24 Oct, 21:00 EDT
  assert.deepEqual(send(sql, '2026-11-01T01:00:00Z'), ['reminder']); // Sat 31 Oct, 21:00 EDT
  assert.deepEqual(send(sql, '2026-11-08T01:00:00Z'), []); // Sat 7 Nov, 20:00 EST
  assert.deepEqual(send(sql, '2026-11-08T02:00:00Z'), ['reminder']); // 21:00 EST
  assert.deepEqual(send(sql, '2026-11-09T02:00:00Z'), []); // Sunday
  // A time of day in the hour that repeats (01:30 on 1 November) comes once.
  const twice = store({ ...PREFS, time: '01:30' }, 'America/New_York');
  assert.deepEqual(send(twice, '2026-11-01T05:30:00Z'), ['reminder']); // 01:30 EDT
  assert.deepEqual(send(twice, '2026-11-01T06:30:00Z'), []); // 01:30 EST, same day
  // A zone 45 minutes off the hour: Kathmandu is UTC+5:45.
  const nepal = store(PREFS, 'Asia/Kathmandu');
  assert.deepEqual(send(nepal, '2026-11-13T15:15:00Z'), ['reminder']);
});

test('reminders off, or no browser asking: nothing is due', () => {
  const sql = store({ ...PREFS, enabled: false }, 'UTC');
  assert.deepEqual(send(sql, '2026-11-13T21:00:00Z'), []);
  reminders.unsubscribe(sql, SUB.endpoint);
  assert.equal(reminders.subscription(sql, SUB.endpoint), null);
  assert.equal(reminders.setPrefs(sql, SUB.endpoint, PREFS, 'UTC'), false);
});

test('the Year in review nudge comes on 15 December, at the reminder time or 19:00', () => {
  const alone = store({ ...PREFS, enabled: false, review: true }, 'Europe/Madrid');
  assert.deepEqual(send(alone, '2026-12-14T18:00:00Z'), []); // 19:00 the day before
  assert.deepEqual(send(alone, '2026-12-15T18:00:00Z'), ['review']); // 19:00 local
  const due = reminders.due(
    store({ ...PREFS, enabled: false, review: true }, 'UTC'),
    Date.parse('2026-12-15T19:00:00Z'),
  );
  assert.equal(due[0]?.notice.title, 'Your 2026 in books is ready');

  // With reminders, the nudge takes the reminder's place, on any weekday.
  const both = store({ ...PREFS, days: [1], review: true }, 'Europe/Madrid'); // 15 Dec is a Tuesday
  assert.deepEqual(send(both, '2026-12-15T18:00:00Z'), []);
  assert.deepEqual(send(both, '2026-12-15T20:00:00Z'), ['review']);
  assert.deepEqual(send(both, '2026-12-15T20:10:00Z'), []); // once
  // Without the opt-in, 15 December is a day like any other.
  const plain = store({ ...PREFS, review: false }, 'Europe/Madrid');
  assert.deepEqual(send(plain, '2026-12-15T20:00:00Z'), ['reminder']);
});

test('reminders vary from day to day', () => {
  const sql = store(PREFS, 'UTC');
  const said = new Set<string>();
  for (let day = 1; day <= 7; day++) {
    const due = reminders.due(sql, Date.UTC(2026, 10, day, 21));
    said.add(due[0]!.notice.body);
  }
  assert.equal(said.size, 7);
});

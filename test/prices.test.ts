/* Where to buy's prices, without the network: what /api/prices takes, the
 * stores' real answers read (fixtures from Gandhi's VTEX catalog API and
 * the iTunes Search API, 2026-11), a day's cache on node:sqlite (fresh,
 * expired, errors never kept, regions apart), the page reading the
 * server's answer, and money in the reader's locale. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as prices from '../worker/prices.ts';
import type { Sql } from '../worker/store.ts';
import { STORES } from '../src/stores.ts';
import { readReply, money, editionLabel } from '../src/offers.ts';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL('fixtures/prices/' + name, import.meta.url), 'utf8'));
const GANDHI = fixture('gandhi-9780241972359.json');
const GANDHI_OUT = fixture('gandhi-out-of-stock-9780307474728.json');
const ITUNES = fixture('itunes-es-9780141182636.json');
const ITUNES_NONE = fixture('itunes-us-empty.json');

/** A new, empty cache on an in-memory SQLite. */
function newSql(): Sql {
  const db = new DatabaseSync(':memory:');
  const sql: Sql = (query, ...params) =>
    db.prepare(query).all(...params) as Record<string, unknown>[];
  prices.setUp(sql);
  return sql;
}
const query = (s: string) => prices.parseQuery(new URL('https://cuento.page/api/prices?' + s));

test('the query: a checked ISBN-13, a two-letter region, known stores, a few at most', () => {
  assert.deepEqual(query('isbn=9780241972359&region=MX&stores=gandhi,apple-books,gandhi'), {
    isbn: '9780241972359',
    region: 'MX',
    stores: ['gandhi', 'apple-books'],
  });
  assert.deepEqual(query('isbn=9780241972359&stores=kobo'), {
    isbn: '9780241972359',
    region: '',
    stores: ['kobo'],
  });
  for (const bad of [
    'isbn=9780241972358&stores=gandhi', // wrong check digit
    'isbn=0241972353&stores=gandhi', // an ISBN-10: the page sends 13
    'isbn=978024197235X&stores=gandhi',
    'stores=gandhi',
    'isbn=9780241972359&region=mx&stores=gandhi',
    'isbn=9780241972359&region=MEX&stores=gandhi',
    'isbn=9780241972359&region=Leeds&stores=gandhi',
    'isbn=9780241972359&stores=',
    'isbn=9780241972359&stores=gandhi,nope',
    'isbn=9780241972359&stores=' + STORES.map(s => s.id).join(','),
  ])
    assert.equal(typeof query(bad), 'string', bad);
});

test('the catalogue and the server agree on which stores have prices', () => {
  const priced = STORES.filter(s => s.priced).map(s => s.id);
  assert.deepEqual(priced.sort(), Object.keys(prices.SOURCES).sort());
});

test('Gandhi: the item with the ISBN as its EAN, its price, list price, cover and edition', () => {
  const offer = prices.readVtex(GANDHI, '9780241972359', 'gandhi.com.mx', 'MXN');
  assert.deepEqual(offer, {
    price: 149,
    listPrice: 260,
    currency: 'MXN',
    url: 'https://www.gandhi.com.mx/one-hundred-years-of-solitude-9780241972359/p',
    image: 'https://gandhi.vteximg.com.br/arquivos/ids/11621767/Imagen.jpg?v=639246277519570000',
    format: 'print',
    edition: 'Tapa blanda',
  });
  // Listed, but out of stock: no price, still its page.
  const out = prices.readVtex(GANDHI_OUT, '9780307474728', 'gandhi.com.mx', 'MXN');
  assert.equal(out?.price, null);
  assert.equal(out?.listPrice, undefined);
  assert.match(out!.url, /^https:\/\/www\.gandhi\.com\.mx\//);
  // Another book's EAN, an empty search, a link to another site: nothing.
  assert.equal(prices.readVtex(GANDHI, '9780307474728', 'gandhi.com.mx', 'MXN'), null);
  assert.equal(prices.readVtex([], '9780241972359', 'gandhi.com.mx', 'MXN'), null);
  const moved = structuredClone(GANDHI) as { link: string }[];
  moved[0]!.link = 'https://evil.example/p';
  assert.equal(prices.readVtex(moved, '9780241972359', 'gandhi.com.mx', 'MXN'), null);
  assert.throws(() => prices.readVtex({ error: 'x' }, '9780241972359', 'gandhi.com.mx', 'MXN'));
});

test('Apple Books: the ebook, its price in the store’s currency, a bigger cover', () => {
  assert.deepEqual(prices.readItunes(ITUNES), {
    price: 8.49,
    currency: 'EUR',
    url: 'https://books.apple.com/es/book/the-great-gatsby/id374291694?uo=4',
    image:
      'https://is1-ssl.mzstatic.com/image/thumb/Publication211/v4/a7/6b/21/a76b21b4-a5ea-0626-38f4-342e0e89cf0f/9780141913414.jpg/200x300bb.jpg',
    format: 'ebook',
  });
  assert.equal(prices.readItunes(ITUNES_NONE), null);
  assert.throws(() => prices.readItunes('<html>'));
  assert.equal(
    prices.SOURCES['apple-books']!.url('9780141182636', 'ES'),
    'https://itunes.apple.com/lookup?isbn=9780141182636&country=es',
  );
});

test('answers are kept a day, by ISBN, store and region; errors are not kept', async () => {
  const sql = newSql();
  const asked: string[] = [];
  let fail = false;
  const get: prices.GetJson = async url => {
    asked.push(url);
    if (fail) throw new Error('down');
    return url.includes('gandhi') ? GANDHI : url.includes('country=es') ? ITUNES : ITUNES_NONE;
  };
  const q = { isbn: '9780241972359', region: 'ES', stores: ['gandhi', 'apple-books', 'kobo'] };
  const t0 = Date.UTC(2026, 10, 15);
  const first = await prices.prices(sql, get, q, t0);
  assert.equal(first.gandhi?.status, 'found');
  assert.equal(first['apple-books']?.status, 'found');
  assert.deepEqual(first.kobo, { status: 'unpriced' });
  assert.equal(asked.length, 2);
  assert.ok(asked.every(u => u.startsWith('https://')));
  assert.ok(!asked.some(u => /kobo/.test(u)));

  // Within the day: from the cache, the same answer.
  assert.deepEqual(await prices.prices(sql, get, q, t0 + prices.TTL - 1), first);
  assert.equal(asked.length, 2);
  // Another region: Gandhi's answer is the same everywhere, Apple's is asked again.
  const us = await prices.prices(sql, get, { ...q, region: 'US' }, t0 + 1);
  assert.equal(us['apple-books']?.status, 'none');
  assert.equal(asked.length, 3);
  // No region: Apple's US store, already kept.
  await prices.prices(sql, get, { ...q, region: '' }, t0 + 2);
  assert.equal(asked.length, 3);

  // After a day, asked again; a store that fails is an error, and not kept.
  fail = true;
  const later = await prices.prices(sql, get, q, t0 + prices.TTL);
  assert.deepEqual(later.gandhi, { status: 'error' });
  assert.equal(asked.length, 5);
  await prices.prices(sql, get, q, t0 + prices.TTL + 1);
  assert.equal(asked.length, 7, 'an error is asked again');
  fail = false;
  const back = await prices.prices(sql, get, q, t0 + prices.TTL + 2);
  assert.equal(back.gandhi?.status, 'found');
  assert.equal(back.gandhi?.status === 'found' && back.gandhi.checked, t0 + prices.TTL + 2);
});

test('prune forgets what expired and says when the next answer will', () => {
  const sql = newSql();
  assert.equal(prices.prune(sql, 0), null);
  prices.keep(sql, '9780241972359', 'gandhi', '*', { status: 'none', checked: 1 }, 1000);
  prices.keep(sql, '9780241972359', 'apple-books', 'US', { status: 'none', checked: 1 }, 5000);
  prices.keep(sql, '9780241972359', 'apple-books', 'GB', { status: 'error' }, 5000);
  assert.equal(prices.prune(sql, 1000), 1000 + prices.TTL);
  assert.equal(prices.prune(sql, 1000 + prices.TTL), 5000 + prices.TTL);
  assert.equal(prices.cached(sql, '9780241972359', 'gandhi', '*', 2000), null);
  assert.equal(prices.prune(sql, 5000 + prices.TTL), null);
});

test('fetchJson: JSON only from a good answer, with a timeout, nothing too big', async () => {
  const calls: RequestInit[] = [];
  const fake = (body: string, status = 200) =>
    (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(body, { status });
    }) as unknown as typeof fetch;
  assert.deepEqual(await prices.fetchJson(fake('{"a":1}'))('https://x/'), { a: 1 });
  assert.ok(calls[0]!.signal instanceof AbortSignal);
  await assert.rejects(prices.fetchJson(fake('{}', 503))('https://x/'));
  await assert.rejects(prices.fetchJson(fake('<html>'))('https://x/'));
  await assert.rejects(prices.fetchJson(fake(' '.repeat(600 * 1024)))('https://x/'));
});

test('the page reads the answer, keeping only what is asked and safe', () => {
  const offer = prices.readVtex(GANDHI, '9780241972359', 'gandhi.com.mx', 'MXN');
  const read = readReply(
    {
      results: {
        gandhi: { status: 'found', offer, checked: 5 },
        'apple-books': { status: 'found', offer: { ...offer, url: 'javascript:alert(1)' } },
        kobo: { status: 'unpriced' },
        extra: { status: 'none', checked: 1 },
      },
    },
    ['gandhi', 'apple-books', 'kobo', 'bn'],
  );
  assert.deepEqual(Object.keys(read), ['gandhi', 'apple-books', 'kobo', 'bn']);
  assert.deepEqual(read.gandhi, { status: 'found', offer, checked: 5 });
  assert.deepEqual(read['apple-books'], { status: 'error' });
  assert.deepEqual(read.kobo, { status: 'unpriced' });
  assert.deepEqual(read.bn, { status: 'error' });
  assert.deepEqual(readReply('nonsense', ['gandhi']), { gandhi: { status: 'error' } });
});

test('money in the reader’s locale, and the edition in words', () => {
  assert.equal(money(149, 'MXN', 'es-MX'), '$149.00');
  assert.equal(money(149, 'MXN', 'en-GB'), 'MX$149.00');
  assert.equal(money(8.49, 'EUR', 'es-ES'), '8,49 €');
  assert.equal(money(1, 'XYZW', 'en'), '1.00 XYZW');
  assert.equal(
    editionLabel({ price: 1, currency: 'MXN', url: '', image: '', edition: 'Tapa blanda' }),
    'Paperback',
  );
  assert.equal(
    editionLabel({ price: 1, currency: 'EUR', url: '', image: '', format: 'ebook' }),
    'Ebook',
  );
  assert.equal(editionLabel({ price: 1, currency: 'EUR', url: '', image: '' }), '');
});

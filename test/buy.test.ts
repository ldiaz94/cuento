/* Where to buy and the store catalogue: encoding, ISBN or title search, the
 * order of favourites and formats, custom stores, nearby links only with a
 * location, regions, and tolerant reading of preferences. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whereToBuy, DISCLAIMER } from '../src/buy.ts';
import { NO_PREFS, STORES, readPrefs, regionOf, suggestedStores } from '../src/stores.ts';
import type { ShoppingPrefs } from '../src/stores.ts';
import type { Book } from '../src/shelf.ts';

const book: Book = {
  v: 2,
  isbn: '9780141182636',
  title: 'The Great Gatsby & Co',
  authors: ['F. Scott Fitzgerald', 'Other'],
  cover: '',
  pages: null,
  published: '',
  status: 'want',
  added: '2026-01-01',
  acquired: '',
  readings: [],
  started: '',
  finished: '',
  rating: 0,
  notes: '',
  upNext: false,
};
const prefs = (p: Partial<ShoppingPrefs>): ShoppingPrefs => ({ ...NO_PREFS, ...p });
const ids = (links: { store: string }[]) => links.map(l => l.store);

test('every link is https and every store has a unique id', () => {
  const links = whereToBuy(book, prefs({ stores: ['My Shop'], location: 'Zürich & co' }), 'ES');
  for (const l of links) assert.match(l.url, /^https:\/\//);
  assert.equal(new Set(STORES.map(s => s.id)).size, STORES.length);
  assert.match(DISCLAIMER, /not prices/);
});

test('stores search by ISBN, or by title and first author without one', () => {
  const links = whereToBuy(book, NO_PREFS, 'US');
  assert.ok(links.find(l => l.store === 'bookshop-us')!.url.endsWith('=9780141182636'));
  assert.equal(
    STORES.find(s => s.id === 'casadellibro-mx')!.search({
      isbn: book.isbn,
      title: '',
      author: '',
    }),
    'https://latam.casadellibro.com/9780141182636?_q=9780141182636&map=ft',
  );
  const bare = whereToBuy({ ...book, isbn: '' }, NO_PREFS, 'US');
  const want = '=' + encodeURIComponent('The Great Gatsby & Co F. Scott Fitzgerald');
  assert.ok(bare.find(l => l.store === 'bookshop-us')!.url.endsWith(want));
  assert.ok(!bare.some(l => l.url.includes('Other')));
});

test('query parts are encoded', () => {
  const l = whereToBuy({ ...book, isbn: '' }, NO_PREFS, 'US')[0]!;
  assert.ok(!l.url.includes(' ') && !l.url.includes('& '));
  assert.ok(l.url.includes('%26'));
});

test('links are labelled as searches', () => {
  for (const l of whereToBuy(book, prefs({ location: 'Leeds' }), 'GB'))
    assert.match(l.label, /^(Search|Find)/);
});

test("favourites come first in the reader's order, then the rest, without duplicates", () => {
  const links = whereToBuy(book, prefs({ stores: ['Kobo', 'bookshop-gb', 'kobo'] }), 'GB');
  assert.deepEqual(ids(links).slice(0, 2), ['kobo', 'bookshop-gb']);
  assert.equal(new Set(ids(links)).size, links.length);
  assert.equal(new Set(links.map(l => l.url)).size, links.length);
});

test('a format preference puts those stores ahead', () => {
  const at = (links: { store: string }[], id: string) => links.findIndex(l => l.store === id);
  const ebook = whereToBuy(book, prefs({ format: 'ebook' }), 'GB');
  assert.equal(ebook[0]!.format, 'ebook');
  assert.equal(ebook.find(l => l.store === 'bookshop-gb')?.format, undefined);
  assert.ok(at(ebook, 'bookshop-gb') > at(ebook, 'kobo'));
  const print = whereToBuy(book, prefs({ format: 'print' }), 'GB');
  assert.ok(at(print, 'bookshop-gb') < at(print, 'kobo'));
  assert.equal(print.find(l => l.store === 'kobo')?.format, undefined);
});

test('a favourite beats a format preference', () => {
  const links = whereToBuy(book, prefs({ format: 'ebook', stores: ['bookshop-gb'] }), 'GB');
  assert.equal(links[0]!.store, 'bookshop-gb');
});

test('a custom store becomes a web search for its name and the ISBN', () => {
  const links = whereToBuy(book, prefs({ stores: ['Corner Books & Café'] }), 'US');
  assert.equal(links[0]!.store, 'Corner Books & Café');
  assert.equal(links[0]!.kind, 'online');
  assert.equal(
    links[0]!.url,
    'https://duckduckgo.com/?q=' + encodeURIComponent('Corner Books & Café 9780141182636'),
  );
});

test('nearby links need a location', () => {
  assert.ok(!whereToBuy(book, NO_PREFS, 'ES').some(l => l.kind === 'nearby'));
  const near = whereToBuy(book, prefs({ location: 'Madrid, 28001' }), 'ES').filter(
    l => l.kind === 'nearby',
  );
  assert.ok(near.some(l => l.url.includes(encodeURIComponent('bookshops near Madrid, 28001'))));
  assert.ok(
    near.some(
      l => l.store === 'worldcat' && l.url.includes(encodeURIComponent('bn:9780141182636')),
    ),
  );
  assert.ok(near.some(l => l.store === 'casadellibro-es'));
  assert.ok(whereToBuy(book, prefs({ location: '   ' }), 'ES').every(l => l.kind === 'online'));
});

test('regions: locales, suggestions and Spanish stores', () => {
  assert.equal(regionOf('en-GB'), 'GB');
  assert.equal(regionOf('es_MX'), 'MX');
  assert.equal(regionOf('zh-Hant-TW'), 'TW');
  assert.equal(regionOf('en'), '');
  assert.equal(regionOf(''), '');
  const names = (r: string) => suggestedStores(r).map(s => s.name);
  assert.ok(names('US').includes('Bookshop.org') && names('US').includes('Barnes & Noble'));
  assert.ok(names('GB').includes('Waterstones'));
  assert.ok(names('ES').includes('Casa del Libro'));
  assert.ok(names('MX').includes('Gandhi'));
  assert.ok(!names('US').includes('Gandhi'));
  assert.ok(names('').includes('Kobo'));
  assert.deepEqual(suggestedStores('GB')[0]!.regions, ['GB']);
  assert.equal(new Set(names('GB')).size, names('GB').length);
  assert.ok(whereToBuy(book, NO_PREFS, '').length > 0);
});

test('readPrefs tolerates anything', () => {
  assert.deepEqual(readPrefs(null), NO_PREFS);
  assert.deepEqual(readPrefs('x'), NO_PREFS);
  assert.deepEqual(readPrefs({ format: 'paper', stores: 'kobo', location: 5 }), NO_PREFS);
  assert.deepEqual(
    readPrefs({ format: 'ebook', stores: [' Kobo ', 'kobo', 3, '', 'Mine'], location: ' Leeds ' }),
    {
      format: 'ebook',
      stores: ['Kobo', 'Mine'],
      location: 'Leeds',
    },
  );
  const p = readPrefs(undefined);
  p.stores.push('x');
  assert.deepEqual(NO_PREFS.stores, []);
  assert.equal(
    readPrefs({ stores: Array.from({ length: 50 }, (_, i) => 's' + i) }).stores.length,
    20,
  );
});

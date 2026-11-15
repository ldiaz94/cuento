/* Where to buy and the store catalogue: which stores a book is shown at
 * (favourites only, else the region's, in a preferred format), More
 * stores, encoding, ISBN or title search, custom stores, nearby links only
 * with a location, the price query (nothing typed in it), regions, and
 * tolerant reading of preferences. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shopsFor, nearby, priceQuery, NOTE } from '../src/buy.ts';
import {
  NO_PREFS,
  STORES,
  readPrefs,
  regionOf,
  storeNamed,
  suggestedStores,
} from '../src/stores.ts';
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
const ids = (shops: { id: string }[]) => shops.map(s => s.id);
const shown = (p: ShoppingPrefs, region: string, b = book) => shopsFor(b, p, region).shown;
const search = (id: string, b = book) => shown(prefs({ stores: [id] }), 'US', b)[0]!.search;

test('every search is https, every store has a unique id, and the note is honest', () => {
  const p = prefs({ stores: ['My Shop', 'kobo'], location: 'Zürich & co' });
  const { shown: s, more } = shopsFor(book, p, 'ES');
  for (const shop of [...s, ...more]) assert.match(shop.search, /^https:\/\//);
  for (const l of nearby(book, p, s, 'ES')) assert.match(l.url, /^https:\/\//);
  assert.equal(new Set(STORES.map(s => s.id)).size, STORES.length);
  assert.match(NOTE, /from each store/);
  assert.match(NOTE, /change/);
});

test('with favourites only they are shown, in order, once; the region’s others are More stores', () => {
  const { shown: s, more } = shopsFor(
    book,
    prefs({ stores: ['Kobo', 'bookshop-gb', 'kobo'] }),
    'GB',
  );
  assert.deepEqual(ids(s), ['kobo', 'bookshop-gb']);
  assert.ok(ids(more).includes('waterstones'));
  assert.ok(!ids(more).some(id => ids(s).includes(id)));
});

test('without favourites, the region’s stores, in the preferred format when it has some', () => {
  const gb = shopsFor(book, NO_PREFS, 'GB');
  assert.deepEqual(
    ids(gb.shown),
    suggestedStores('GB').map(s => s.id),
  );
  assert.deepEqual(gb.more, []);
  assert.ok(!ids(gb.shown).includes('gandhi') && !ids(gb.shown).includes('bookshop-us'));
  const ebook = shown(prefs({ format: 'ebook' }), 'GB');
  assert.ok(ebook.every(s => s.formats.includes('ebook')));
  assert.ok(!ids(ebook).includes('bookshop-gb'));
  assert.ok(ids(ebook).includes('kobo'));
  assert.ok(ids(shown(prefs({ format: 'print' }), 'GB')).includes('bookshop-gb'));
  // A favourite beats the format.
  assert.deepEqual(ids(shown(prefs({ format: 'ebook', stores: ['bookshop-gb'] }), 'GB')), [
    'bookshop-gb',
  ]);
});

test('Mexico shows Gandhi, priced; Apple Books is priced everywhere', () => {
  const mx = shown(NO_PREFS, 'MX');
  assert.ok(mx.find(s => s.id === 'gandhi')?.priced);
  assert.ok(mx.find(s => s.id === 'apple-books')?.priced);
  assert.equal(mx.find(s => s.id === 'amazon-mx')?.priced, false);
});

test('stores search by ISBN, or by title and first author without one', () => {
  assert.ok(search('bookshop-us').endsWith('=9780141182636'));
  assert.equal(
    STORES.find(s => s.id === 'casadellibro-mx')!.search({
      isbn: book.isbn,
      title: '',
      author: '',
    }),
    'https://latam.casadellibro.com/9780141182636?_q=9780141182636&map=ft',
  );
  assert.equal(
    STORES.find(s => s.id === 'gandhi')!.search({
      isbn: book.isbn,
      title: 'The Great Gatsby & Co',
      author: 'F. Scott Fitzgerald',
    }),
    'https://www.gandhi.com.mx/' +
      encodeURIComponent('The Great Gatsby & Co F. Scott Fitzgerald') +
      '?_q=' +
      encodeURIComponent('The Great Gatsby & Co F. Scott Fitzgerald') +
      '&map=ft',
  );
  const bare = { ...book, isbn: '' };
  const want = '=' + encodeURIComponent('The Great Gatsby & Co F. Scott Fitzgerald');
  assert.ok(search('bookshop-us', bare).endsWith(want));
  assert.ok(!search('bookshop-us', bare).includes('Other'));
  assert.ok(!search('bookshop-us', bare).includes(' '));
});

test('Barnes & Noble, Casa del Libro and Apple Books search their sites through DuckDuckGo', () => {
  const site = (id: string, isbn: string) =>
    STORES.find(s => s.id === id)!.search({ isbn, title: '', author: '' });
  assert.equal(
    site('bn', book.isbn),
    'https://duckduckgo.com/?q=' + encodeURIComponent('site:barnesandnoble.com 9780141182636'),
  );
  assert.equal(
    site('casadellibro-es', book.isbn),
    'https://duckduckgo.com/?q=' + encodeURIComponent('site:casadellibro.com 9780141182636'),
  );
  assert.equal(
    site('apple-books', book.isbn),
    'https://duckduckgo.com/?q=' + encodeURIComponent('site:books.apple.com 9780141182636'),
  );
  assert.equal(STORES.find(s => s.id === 'bn')!.byIsbn, true);
  assert.ok(
    search('bn', { ...book, isbn: '' }).includes(encodeURIComponent('site:barnesandnoble.com')),
  );
});

test('a custom store becomes a web search for its name and the ISBN', () => {
  const [custom] = shown(prefs({ stores: ['Corner Books & Café'] }), 'US');
  assert.deepEqual(custom, {
    id: 'Corner Books & Café',
    name: 'Corner Books & Café',
    search: 'https://duckduckgo.com/?q=' + encodeURIComponent('Corner Books & Café 9780141182636'),
    priced: false,
    formats: [],
  });
});

test('nearby links need a location', () => {
  const s = shown(NO_PREFS, 'ES');
  assert.deepEqual(nearby(book, NO_PREFS, s, 'ES'), []);
  assert.deepEqual(nearby(book, prefs({ location: '   ' }), s, 'ES'), []);
  const near = nearby(book, prefs({ location: 'Madrid, 28001' }), s, 'ES');
  assert.ok(near.some(l => l.url.includes(encodeURIComponent('bookshops near Madrid, 28001'))));
  assert.ok(
    near.some(
      l => l.store === 'worldcat' && l.url.includes(encodeURIComponent('bn:9780141182636')),
    ),
  );
  assert.ok(near.some(l => l.store === 'casadellibro-es'));
});

test('the price query: the ISBN, the priced stores and the region, never the location', () => {
  const p = prefs({ stores: ['kobo', 'Gandhi', 'apple-books'], location: 'Calle 5, CDMX' });
  const s = shown(p, 'MX');
  assert.equal(
    priceQuery(book, s, 'MX'),
    'isbn=9780141182636&region=MX&stores=gandhi%2Capple-books',
  );
  assert.ok(!priceQuery(book, s, 'MX').includes('Calle'));
  assert.equal(priceQuery(book, s, ''), 'isbn=9780141182636&stores=gandhi%2Capple-books');
  assert.equal(priceQuery(book, shown(prefs({ stores: ['kobo'] }), 'GB'), 'GB'), '');
  assert.equal(priceQuery({ ...book, isbn: '' }, s, 'MX'), '');
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
  assert.ok(shown(NO_PREFS, '').length > 0);
  assert.ok(names('').includes('Apple Books'));
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

test('favourites saved by name resolve to the reader’s region, and ids stay exact', () => {
  const stores = ['Amazon', 'Bookshop.org', 'Casa del Libro'];
  const gb = shown(prefs({ stores }), 'GB');
  assert.deepEqual(ids(gb).slice(0, 2), ['amazon-uk', 'bookshop-gb']);
  assert.match(gb[0]!.search, /amazon\.co\.uk/);
  const mx = shown(prefs({ stores }), 'MX');
  assert.equal(ids(mx)[0], 'amazon-mx');
  assert.ok(ids(mx).includes('casadellibro-mx'));
  assert.equal(ids(shown(prefs({ stores: ['amazon-mx'] }), 'GB'))[0], 'amazon-mx');
  assert.equal(storeNamed('Amazon', 'DE')?.id, 'amazon');
});

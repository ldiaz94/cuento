/* The pure modules on their own: ISBN check digits, the lookup's fallback
 * and its offline case, the dates a status brings, and imports. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIsbn13, show } from '../src/isbn.ts';
import { bookCode } from '../src/scan.ts';
import { lookup, search } from '../src/lookup.ts';
import { newBook, withStatus, imported, exported, merge, load, save } from '../src/shelf.ts';

test('ISBNs: both lengths, an X check digit, and wrong digits refused', () => {
  assert.equal(toIsbn13('0-306-40615-2'), '9780306406157');
  assert.equal(toIsbn13('080442957x'), '9780804429573');
  assert.equal(toIsbn13('979-10-90636-07-1'), '9791090636071');
  assert.equal(toIsbn13('9780306406158'), null); // last digit off by one
  assert.equal(toIsbn13('0306406153'), null);
  assert.equal(toIsbn13('9770306406157'), null); // a magazine's prefix, not a book's
  assert.equal(show('9780306406157'), '978-030640615-7');
});

/** A fetch that answers each service from replies (a value: its JSON; an
 * Error: unreachable), recording the URLs asked. */
function fakeFetch(replies: { ol: unknown; gb: unknown }) {
  const asked: string[] = [];
  const get = async (url: string) => {
    asked.push(url);
    const r = replies[url.includes('openlibrary') ? 'ol' : 'gb'];
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r));
  };
  return { get, asked };
}

test('lookup: Open Library first, Google Books when it has no record', async () => {
  const isbn = '9780306406157';
  const ol = {
    ['ISBN:' + isbn]: {
      title: 'Dune',
      authors: [{ name: 'Frank Herbert' }],
      cover: { medium: 'http://covers.example/d.jpg' },
    },
  };
  const first = fakeFetch({ ol, gb: new Error('not asked') });
  const book = await lookup(isbn, first.get);
  assert.equal(book?.title, 'Dune');
  assert.equal(book?.cover, 'https://covers.example/d.jpg'); // moved to https
  assert.equal(first.asked.length, 1);

  const gb = {
    items: [{ volumeInfo: { title: 'Dune', imageLinks: { thumbnail: 'javascript:alert(1)' } } }],
  };
  const second = fakeFetch({ ol: {}, gb });
  assert.equal((await lookup(isbn, second.get))?.cover, ''); // never a javascript: URL
  assert.equal(await lookup(isbn, fakeFetch({ ol: {}, gb: { totalItems: 0 } }).get), null);
});

test('lookup: unreachable services throw, so "offline" is not "no such book"', async () => {
  const down = fakeFetch({ ol: new TypeError('offline'), gb: new TypeError('offline') });
  await assert.rejects(lookup('9780306406157', down.get), /Could not reach/);
  const half = fakeFetch({ ol: new TypeError('offline'), gb: { totalItems: 0 } });
  assert.equal(await lookup('9780306406157', half.get), null);
});

test('statuses date a book: started when begun, finished when read', () => {
  const b = newBook('9780306406157', { title: 'T' }, 'want', '2026-01-01');
  assert.deepEqual([b.added, b.started, b.finished], ['2026-01-01', '', '']);
  const read = withStatus(b, 'read', '2026-02-02');
  assert.deepEqual([read.started, read.finished], ['2026-02-02', '2026-02-02']);
  const again = withStatus(read, 'reading', '2026-03-03');
  assert.deepEqual([again.started, again.finished], ['2026-02-02', '']);
  assert.equal(withStatus(again, 'want').started, '2026-02-02'); // a slip keeps its dates
});

test('import: an export comes back; junk and broken books are refused', () => {
  const a = newBook('9780306406157', { title: 'A' }),
    b = newBook('9780804429573', { title: 'B' });
  assert.deepEqual(imported(exported([a, b])), [a, b]);
  assert.throws(() => imported('not json'), /not a cuento export/);
  assert.throws(() => imported('{"books": []}'), /not a cuento export/);
  const text = JSON.stringify({
    cuento: 1,
    books: [a, { isbn: '123', title: 'x', status: 'read' }],
  });
  assert.deepEqual(imported(text), [a]);
  assert.deepEqual(
    merge([a], [{ ...a, notes: 'new' }, b]).map(x => x.notes || x.title),
    ['B', 'new'],
  );
});

test('storage: a damaged shelf loads as empty, a full one says it failed', () => {
  const bad = { getItem: () => '{oops', setItem() {} };
  assert.deepEqual(load(bad as unknown as Storage), []);
  const full = {
    getItem: () => null,
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  assert.equal(save([], full as unknown as Storage), false);
});

test('scanned codes: only an ISBN-13 with the right check digit is a book', () => {
  assert.equal(bookCode('9780306406157'), '9780306406157');
  assert.equal(bookCode('9780306406158'), null); // wrong check digit
  assert.equal(bookCode('5012345678900'), null); // a product, not a book
  assert.equal(bookCode('0306406152'), null); // ISBN-10 is not an EAN-13
});

test('search: Open Library hits mapped, no-ISBN docs skipped, duplicates dropped', async () => {
  const ol = {
    docs: [
      {
        title: 'Dune',
        subtitle: 'Book One',
        author_name: ['Frank Herbert'],
        isbn: ['0306406152', 'bad'],
        cover_i: 42,
        first_publish_year: 1965,
        number_of_pages_median: 412,
      },
      { title: 'No ISBN', isbn: ['123'] },
      { title: 'Dune again', isbn: ['9780306406157'] },
    ],
  };
  const hits = await search('dune', fakeFetch({ ol, gb: new Error('not asked') }).get);
  assert.deepEqual(hits, [
    {
      isbn: '9780306406157',
      title: 'Dune: Book One',
      authors: ['Frank Herbert'],
      cover: 'https://covers.openlibrary.org/b/id/42-M.jpg',
      pages: 412,
      published: '1965',
    },
  ]);
});

test('search: Google Books when Open Library finds none; ISBN-13 preferred', async () => {
  const volumeInfo = {
    title: 'Dune',
    industryIdentifiers: [
      { type: 'ISBN_10', identifier: '0804429573' },
      { type: 'ISBN_13', identifier: '9780306406157' },
    ],
  };
  const fake = fakeFetch({ ol: { docs: [] }, gb: { items: [{ volumeInfo }] } });
  const hits = await search('dune', fake.get);
  assert.deepEqual(
    hits.map(h => h.isbn),
    ['9780306406157'],
  );
  assert.match(fake.asked[1] ?? '', /q=dune/);
});

test('search: unreachable services throw', async () => {
  const down = fakeFetch({ ol: new TypeError('offline'), gb: new TypeError('offline') });
  await assert.rejects(search('dune', down.get), /Could not reach/);
});

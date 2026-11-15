/* The pure modules on their own: ISBN check digits, the lookup's fallback
 * and its offline case, the dates a status brings, and imports. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIsbn13, show } from '../src/isbn.ts';
import { bookCode } from '../src/scan.ts';
import { lookup, search } from '../src/lookup.ts';
import {
  newBook,
  withStatus,
  imported,
  exported,
  merge,
  load,
  save,
  readBook,
  isBook,
  lastRead,
  readCount,
  owns,
  withSessionDate,
  withPastRead,
  withoutSession,
} from '../src/shelf.ts';
import type { Book } from '../src/shelf.ts';

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

test('statuses date a book: acquisition, reading sessions and rereads', () => {
  const b = newBook('9780306406157', { title: 'T' }, 'want', '2026-01-01');
  assert.deepEqual([b.added, b.started, b.finished, b.acquired], ['2026-01-01', '', '', '']);
  assert.deepEqual(b.readings, []);
  const owned = withStatus(b, 'owned', '2026-01-15');
  assert.equal(owned.acquired, '2026-01-15');
  const read = withStatus(owned, 'read', '2026-02-02');
  assert.deepEqual([read.started, read.finished], ['2026-02-02', '2026-02-02']);
  assert.deepEqual(read.readings, [{ started: '2026-02-02', finished: '2026-02-02' }]);
  assert.equal(read.acquired, '2026-01-15');
  const again = withStatus(read, 'reading', '2026-03-03');
  assert.deepEqual([again.started, again.finished], ['2026-03-03', '']);
  assert.equal(again.readings.length, 2);
  assert.deepEqual(again.readings[0], read.readings[0]); // the earlier read survives
  const finished = withStatus(again, 'read', '2026-03-10');
  assert.deepEqual(finished.readings[1], { started: '2026-03-03', finished: '2026-03-10' });
  assert.equal(withStatus(again, 'want').started, '2026-03-03'); // a slip keeps its dates
});

test('Owned: acquisition dates it once, may be edited or blank, and survives later moves', () => {
  const b = newBook('9780306406157', { title: 'T' }, 'want', '2026-01-01');
  assert.equal(newBook(b.isbn, { title: 'T' }, 'owned', '2026-01-01').acquired, '2026-01-01');
  const owned = withStatus(b, 'owned', '2026-01-15');
  const edited = { ...owned, acquired: '2025-12-24' };
  assert.equal(
    withStatus(withStatus(edited, 'want', '2026-02-01'), 'owned', '2026-03-01').acquired,
    '2025-12-24',
  );
  const blank = { ...owned, acquired: '' };
  assert.equal(withStatus(blank, 'reading', '2026-02-01').acquired, ''); // only Want to Owned dates it
  assert.equal(withStatus(b, 'reading', '2026-02-01').acquired, '');
  assert.equal(isBook(blank), true);
  assert.deepEqual(
    (['want', 'owned', 'reading', 'read'] as const).map(s => owns(withStatus(b, s, '2026-02-01'))),
    [false, true, true, true],
  );
});

test('Up next survives shelving and clears when reading starts', () => {
  const wanted = { ...newBook('9780306406157', { title: 'T' }), upNext: true };
  const owned = withStatus(wanted, 'owned', '2026-01-02');
  assert.equal(owned.upNext, true);
  assert.equal(withStatus(owned, 'reading', '2026-01-03').upNext, false);
});

test('import: v2 exports round-trip and legacy books migrate with their dates', () => {
  const a = newBook('9780306406157', { title: 'A' }),
    b = newBook('9780804429573', { title: 'B' });
  assert.deepEqual(imported(exported([a, b])), [a, b]);
  assert.equal(JSON.parse(exported([a])).cuento, 2);
  assert.throws(() => imported('not json'), /not a cuento export/);
  assert.throws(() => imported('{"books": []}'), /not a cuento export/);
  assert.throws(() => imported('{"cuento":3,"books":[]}'), /not a cuento export/);
  const legacy = {
    isbn: a.isbn,
    title: a.title,
    authors: a.authors,
    cover: '',
    pages: null,
    published: '',
    status: 'read',
    added: '2020-01-01',
    started: '2020-02-01',
    finished: '2020-02-10',
    rating: 4,
    notes: 'old',
  };
  const migrated = imported(JSON.stringify({ cuento: 1, books: [legacy] }))[0];
  assert.equal(migrated?.v, 2);
  assert.deepEqual(migrated?.readings, [{ started: '2020-02-01', finished: '2020-02-10' }]);
  assert.deepEqual([migrated?.started, migrated?.finished], ['2020-02-01', '2020-02-10']);
  assert.equal(migrated?.acquired, '');
  assert.equal(migrated?.upNext, false);
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

test('storage: damaged data loads as empty; legacy books migrate and save intact', () => {
  const bad = { getItem: () => '{oops', setItem() {} };
  assert.deepEqual(load(bad as unknown as Storage), []);
  const legacy = newBook('9780306406157', { title: 'Old' });
  const old = {
    ...legacy,
    v: undefined,
    readings: undefined,
    acquired: undefined,
    upNext: undefined,
  };
  const stored = {
    value: JSON.stringify([old]),
    getItem() {
      return this.value;
    },
    setItem(_key: string, value: string) {
      this.value = value;
    },
  };
  const loaded = load(stored as unknown as Storage);
  assert.equal(loaded[0]?.v, 2);
  assert.deepEqual(loaded[0]?.readings, []);
  assert.equal(save(loaded, stored as unknown as Storage), true);
  assert.equal(JSON.parse(stored.value)[0].v, 2);
  assert.equal(isBook({ ...loaded[0], readings: [{ started: '' }] }), false);
  assert.equal(readBook({ ...loaded[0], v: 3 }), null);
  const full = {
    getItem: () => null,
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  assert.equal(save([], full as unknown as Storage), false);
});

test('reading history derives last read and completed count', () => {
  const book = newBook('9780306406157', { title: 'T' }, 'read', '2025-01-02');
  const reread = withStatus(withStatus(book, 'reading', '2026-02-01'), 'read', '2026-02-05');
  assert.equal(lastRead(reread), '2026-02-05');
  assert.equal(readCount(reread), 2);
  assert.equal(lastRead(withStatus(reread, 'reading', '2026-03-01')), '2026-02-05');
  assert.equal(readCount(withStatus(reread, 'reading', '2026-03-01')), 2);
});

/** result as a book, failing the test when it is a refusal. */
function ok(result: Book | string): Book {
  assert.equal(typeof result, 'object', String(result));
  return result as Book;
}

test('Read again starts a session and keeps every earlier read', () => {
  const read = newBook('9780306406157', { title: 'T' }, 'read', '2025-01-02');
  const again = withStatus(read, 'reading', '2026-04-01');
  assert.equal(again.status, 'reading');
  assert.deepEqual(again.readings, [
    { started: '2025-01-02', finished: '2025-01-02' },
    { started: '2026-04-01', finished: '' },
  ]);
  assert.equal(readCount(again), 1);
  assert.equal(isBook(again), true);
});

test('history: dates edited, kept in order, and refused when they cannot stand', () => {
  const read = newBook('9780306406157', { title: 'T' }, 'read', '2026-02-02');
  const edited = ok(withSessionDate(read, 0, 'started', '2026-01-20'));
  assert.deepEqual(edited.readings, [{ started: '2026-01-20', finished: '2026-02-02' }]);
  assert.equal(edited.started, '2026-01-20');
  assert.match(withSessionDate(read, 0, 'started', '2026-03-01') as string, /before it starts/);
  const backfilled = ok(withPastRead(edited, '2019-05-01', '2019-06-01'));
  assert.deepEqual(
    backfilled.readings.map(r => r.finished),
    ['2019-06-01', '2026-02-02'],
  ); // oldest first, whatever order they came in
  assert.deepEqual([backfilled.started, backfilled.finished], ['2026-01-20', '2026-02-02']);
  assert.equal(readCount(backfilled), 2);
  assert.equal(lastRead(backfilled), '2026-02-02');
  assert.equal(ok(withPastRead(backfilled, '', '2020-01-01')).readings[1]?.started, ''); // start unknown
  assert.match(withPastRead(backfilled, '2020-01-01', '') as string, /finished/);
  assert.match(withPastRead(backfilled, '2020-02-01', '2020-01-01') as string, /before it starts/);
  // Moving a read later than another reorders them, and the mirrors follow.
  const later = ok(withSessionDate(backfilled, 0, 'finished', '2026-05-01'));
  const moved = ok(withSessionDate(later, 0, 'started', '2026-04-01'));
  assert.deepEqual(moved.readings[1], { started: '2026-04-01', finished: '2026-05-01' });
  assert.deepEqual([moved.started, moved.finished], ['2026-04-01', '2026-05-01']);
  assert.equal(isBook(moved), true);
});

test('history: one read underway at most, and the status follows the history', () => {
  const read = ok(
    withPastRead(newBook('9780306406157', { title: 'T' }, 'read', '2026-02-02'), '', '2025-01-01'),
  );
  // Clearing the latest finish: still reading it.
  const reopened = ok(withSessionDate({ ...read, upNext: true }, 1, 'finished', ''));
  assert.equal(reopened.status, 'reading');
  assert.equal(reopened.upNext, false);
  assert.equal(reopened.finished, '');
  assert.match(withSessionDate(reopened, 0, 'finished', '') as string, /one read/);
  // Finishing the open one by its date: Read.
  assert.equal(ok(withSessionDate(reopened, 1, 'finished', '2026-03-01')).status, 'read');
  // Removing the open session of a Reading book: Read with earlier reads, else Owned.
  const removed = withoutSession(reopened, 1);
  assert.deepEqual([removed.status, removed.readings.length], ['read', 1]);
  assert.equal(isBook(removed), true);
  const first = withStatus(newBook('9780804429573', { title: 'U' }), 'reading', '2026-01-01');
  const dropped = withoutSession(first, 0);
  assert.deepEqual([dropped.status, dropped.started], ['owned', '']);
  // Removing a Read book's only read: Owned.
  assert.equal(withoutSession(newBook(read.isbn, { title: 'T' }, 'read'), 0).status, 'owned');
  // A past read on a Want book leaves it wanted; a slip back keeps its open session.
  const wanted = ok(withPastRead(newBook(read.isbn, { title: 'T' }), '', '2020-01-01'));
  assert.equal(wanted.status, 'want');
  const slip = withStatus(first, 'want', '2026-01-02');
  assert.equal(ok(withSessionDate(slip, 0, 'started', '2025-12-30')).status, 'want');
});

test('Up next and history travel in exports and through a merge', () => {
  const next = { ...newBook('9780306406157', { title: 'T' }, 'owned', '2026-01-01'), upNext: true };
  const back = imported(exported([next]))[0];
  assert.equal(back?.upNext, true);
  assert.deepEqual(merge([], [next])[0], next);
  const reading = withStatus(next, 'reading', '2026-01-02');
  assert.equal(imported(exported([reading]))[0]?.upNext, false);
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

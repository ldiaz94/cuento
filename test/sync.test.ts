/* Sync, without a network: the server's store (worker/store.ts) on
 * node:sqlite, the client's diff and merge (src/sync.ts), and two devices
 * passing a shelf back and forth through one store. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setUp, parse, apply, changedSince, MAX_CHANGES } from '../worker/store.ts';
import type { Sql } from '../worker/store.ts';
import { diff, recorded, received, readCode, newCode, grouped } from '../src/sync.ts';
import type { Snapshot, Reply, Change } from '../src/sync.ts';
import { newBook, withStatus } from '../src/shelf.ts';
import type { Book } from '../src/shelf.ts';

/** A new, empty store in memory. */
function store(): Sql {
  const db = new DatabaseSync(':memory:');
  const sql: Sql = (query, ...params) => db.prepare(query).all(...params);
  setUp(sql);
  return sql;
}

/** A book with this ISBN and title, added on day. */
const book = (isbn: string, title = 'T', day = '2026-01-01') =>
  newBook(isbn, { title }, 'want', day);
const DUNE = '9780306406157';
const EMMA = '9780804429573';

test('store: the later change wins, a tie keeps the server’s, deletions travel', () => {
  const sql = store();
  assert.equal(apply(sql, [{ isbn: DUNE, book: book(DUNE, 'A'), updated: 10 }]), 1);
  assert.equal(apply(sql, [{ isbn: DUNE, book: book(DUNE, 'old'), updated: 5 }]), 0);
  assert.equal(apply(sql, [{ isbn: DUNE, book: book(DUNE, 'tie'), updated: 10 }]), 0);
  assert.equal(apply(sql, [{ isbn: DUNE, book: null, updated: 20 }]), 1);
  apply(sql, [{ isbn: EMMA, book: book(EMMA), updated: 15 }]);

  const all = changedSince(sql, 0);
  assert.equal(all.seq, 3);
  assert.deepEqual(
    all.changes.map(c => [c.isbn, c.book && 'book', c.updated]),
    [
      [DUNE, null, 20],
      [EMMA, 'book', 15],
    ],
  );
  assert.deepEqual(changedSince(sql, 3).changes, []);
  assert.equal(changedSince(sql, 2).changes.length, 1);
  assert.equal(changedSince(sql, 99).changes.length, 2); // a store reset: everything again
});

test('store: requests are checked before they are kept', () => {
  const ok = { since: 0, changes: [{ isbn: DUNE, book: book(DUNE), updated: 1 }] };
  assert.ok(parse(ok));
  assert.ok(parse({ since: 0, changes: [{ isbn: DUNE, book: null, updated: 1 }] }));
  assert.equal(parse({ since: 0, changes: [{ isbn: DUNE, book: book(EMMA), updated: 1 }] }), null);
  assert.equal(parse({ since: -1, changes: [] }), null);
  assert.equal(parse({ since: 0, changes: [{ isbn: 'x', book: null, updated: 1 }] }), null);
  assert.equal(parse({ since: 0, changes: [{ isbn: DUNE, book: 'x', updated: 1 }] }), null);
  const many = Array.from({ length: MAX_CHANGES + 1 }, () => ok.changes[0]);
  assert.equal(parse({ since: 0, changes: many }), null);
});

test('codes: read back through dashes, case, misread letters and links', () => {
  const code = newCode(new Uint8Array(26).map((_, i) => i * 37));
  assert.equal(code.length, 26);
  assert.equal(readCode(grouped(code).toLowerCase()), code);
  assert.equal(readCode('https://cuento.example/#sync=' + code), code);
  assert.equal(readCode('O'.repeat(13) + 'il'.repeat(6) + 'L'), '0'.repeat(13) + '1'.repeat(13));
  assert.equal(readCode(code.slice(1)), null);
  assert.equal(readCode('U'.repeat(26)), null); // no U in Crockford's base32
});

test('diff: changed and new books, and deletions; unchanged ones are not sent', () => {
  const kept = [book(DUNE), book(EMMA)];
  const snapshot = recorded({ seq: 4, books: {} }, diff(kept, { seq: 0, books: {} }, 1));
  assert.deepEqual(diff(kept, snapshot, 2), []);
  const read = withStatus(book(DUNE), 'read', '2026-02-02');
  const changes = diff([read], snapshot, 2);
  assert.deepEqual(
    changes.map(c => [c.isbn, c.book?.status ?? null, c.updated]),
    [
      [DUNE, 'read', 2],
      [EMMA, null, 2],
    ],
  );
});

test('received: others’ changes come in, echoes and edits made meanwhile do not', () => {
  const mine = [book(DUNE, 'mine')];
  const snapshot = recorded({ seq: 1, books: {} }, diff(mine, { seq: 0, books: {} }, 1));
  const echo: Reply = { seq: 1, changes: [{ isbn: DUNE, book: book(DUNE, 'mine'), updated: 1 }] };
  assert.equal(received(mine, snapshot, echo).books, null);

  const theirs: Change[] = [
    { isbn: DUNE, book: book(DUNE, 'theirs'), updated: 5 },
    { isbn: EMMA, book: book(EMMA, 'new'), updated: 6 },
  ];
  const r = received(mine, snapshot, { seq: 3, changes: theirs });
  assert.deepEqual(
    r.books?.map(b => b.title),
    ['new', 'theirs'],
  );
  assert.equal(r.snapshot.seq, 3);
  assert.deepEqual(diff(r.books!, r.snapshot, 9), []); // no bounce back as a change

  const edited = [book(DUNE, 'edited meanwhile')];
  const kept = received(edited, snapshot, { seq: 2, changes: theirs.slice(0, 1) });
  assert.equal(kept.books, null);
  assert.equal(diff(edited, kept.snapshot, 9)[0]?.book?.title, 'edited meanwhile'); // sent next

  const junk = { isbn: EMMA, book: { isbn: EMMA } as Book, updated: 7 };
  assert.equal(received(mine, snapshot, { seq: 4, changes: [junk] }).books, null);
});

/** A device: its shelf and snapshot, syncing straight into sql. */
function device(sql: Sql, books: Book[] = []) {
  const d = { books, snapshot: { seq: 0, books: {} } as Snapshot };
  const sync = (now: number) => {
    const changes = diff(d.books, d.snapshot, now);
    apply(sql, changes);
    const r = received(
      d.books,
      recorded(d.snapshot, changes),
      changedSince(sql, d.snapshot.seq) as Reply,
    );
    d.snapshot = r.snapshot;
    if (r.books) d.books = r.books;
  };
  return { d, sync };
}

test('two devices: adds, edits and deletions reach the other, in shelf order', () => {
  const sql = store();
  const a = device(sql, [book(EMMA, 'Emma', '2026-01-02'), book(DUNE, 'Dune', '2026-01-01')]);
  const b = device(sql);
  a.sync(1);
  b.sync(2);
  assert.deepEqual(
    b.d.books.map(x => x.title),
    ['Emma', 'Dune'],
  );

  b.d.books = b.d.books.map(x => (x.isbn === DUNE ? withStatus(x, 'read', '2026-03-03') : x));
  b.sync(3);
  a.sync(4);
  assert.equal(a.d.books.find(x => x.isbn === DUNE)?.status, 'read');

  a.d.books = a.d.books.filter(x => x.isbn !== EMMA);
  a.sync(5);
  b.sync(6);
  assert.deepEqual(
    b.d.books.map(x => x.title),
    ['Dune'],
  );
  assert.deepEqual(diff(a.d.books, a.d.snapshot, 7), []);
  assert.deepEqual(diff(b.d.books, b.d.snapshot, 7), []);
});

/* Sync, without a network: the server's store (worker/store.ts) on
 * node:sqlite, the client's diff and merge (src/sync.ts), and two devices
 * passing a shelf back and forth through one store. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setUp, parse, apply, applySettings, changedSince, MAX_CHANGES } from '../worker/store.ts';
import type { Sql } from '../worker/store.ts';
import { diff, diffSettings, recorded, received, readCode, newCode, grouped } from '../src/sync.ts';
import type { Snapshot, Reply, Change, Goals } from '../src/sync.ts';
import { newBook, readBook, withStatus } from '../src/shelf.ts';
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
/** The v1 shape of book, as an old device or store would hold it. */
function legacyBook(value: Book): Book {
  const old = { ...value } as Record<string, unknown>;
  for (const key of ['v', 'acquired', 'readings', 'upNext']) delete old[key];
  return old as unknown as Book;
}
const DUNE = '9780306406157';
const EMMA = '9780804429573';

test('store: the later change wins, a tie keeps the server’s, deletions travel', () => {
  const sql = store();
  assert.equal(apply(sql, [{ v: 2, isbn: DUNE, book: book(DUNE, 'A'), updated: 10 }]), 1);
  assert.equal(apply(sql, [{ v: 2, isbn: DUNE, book: book(DUNE, 'old'), updated: 5 }]), 0);
  assert.equal(apply(sql, [{ v: 2, isbn: DUNE, book: book(DUNE, 'tie'), updated: 10 }]), 0);
  assert.equal(apply(sql, [{ v: 2, isbn: DUNE, book: null, updated: 20 }]), 1);
  apply(sql, [{ v: 2, isbn: EMMA, book: book(EMMA), updated: 15 }]);

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
  const ok = { since: 0, changes: [{ isbn: DUNE, book: legacyBook(book(DUNE)), updated: 1 }] };
  const current = {
    version: 2,
    since: 0,
    changes: [{ v: 2, isbn: DUNE, book: book(DUNE), updated: 1 }],
  };
  assert.ok(parse(ok));
  assert.equal(parse(current)?.version, 2);
  assert.ok(parse({ ...current, changes: [{ v: 2, isbn: DUNE, book: null, updated: 1 }] }));
  assert.ok(parse({ since: 0, changes: [{ isbn: DUNE, book: null, updated: 1 }] }));
  assert.equal(parse({ ...current, version: 1 }), null);
  assert.equal(parse({ ...current, version: 3 }), null);
  assert.equal(parse({ since: 0, changes: [{ v: 1, isbn: DUNE, book: null, updated: 1 }] }), null);
  assert.equal(parse({ since: 0, changes: [{ isbn: DUNE, book: book(EMMA), updated: 1 }] }), null);
  assert.equal(parse({ since: -1, changes: [] }), null);
  assert.equal(parse({ since: 0, changes: [{ isbn: 'x', book: null, updated: 1 }] }), null);
  assert.equal(parse({ since: 0, changes: [{ isbn: DUNE, book: 'x', updated: 1 }] }), null);
  const many = Array.from({ length: MAX_CHANGES + 1 }, () => ok.changes[0]);
  assert.equal(parse({ since: 0, changes: many }), null);
});

test('store: v2 accepts upgrades and deletions, legacy cannot downgrade or delete it', () => {
  const sql = store();
  const old = (title: string) => legacyBook(book(DUNE, title));
  assert.equal(apply(sql, [{ isbn: DUNE, book: old('one'), updated: 1 }]), 1);
  assert.equal(apply(sql, [{ isbn: DUNE, book: old('legacy update'), updated: 2 }]), 1);
  assert.equal(apply(sql, [{ v: 2, isbn: DUNE, book: book(DUNE, 'v2'), updated: 3 }]), 1);
  assert.equal(apply(sql, [{ isbn: DUNE, book: old('downgrade'), updated: 4 }]), 0);
  assert.equal(apply(sql, [{ isbn: DUNE, book: null, updated: 5 }]), 0);

  const current = changedSince(sql, 0);
  assert.equal(current.seq, 3); // refused changes take no sequence
  assert.equal((current.changes[0]?.book as Book).title, 'v2');
  assert.equal(apply(sql, [{ v: 2, isbn: DUNE, book: null, updated: 6 }]), 1);
  assert.equal(changedSince(sql, 0).changes[0]?.book, null);
  assert.equal(apply(sql, [{ isbn: DUNE, book: old('resurrect'), updated: 7 }]), 0);
  assert.equal(changedSince(sql, 0).changes[0]?.book, null);

  apply(sql, [{ isbn: EMMA, book: legacyBook(book(EMMA)), updated: 1 }]);
  apply(sql, [{ isbn: EMMA, book: null, updated: 2 }]);
  assert.equal(apply(sql, [{ isbn: EMMA, book: legacyBook(book(EMMA)), updated: 3 }]), 1);
});

test('store: legacy replies hide live v2 books, current replies include them', () => {
  const sql = store();
  apply(sql, [{ isbn: DUNE, book: legacyBook(book(DUNE)), updated: 1 }]);
  apply(sql, [{ v: 2, isbn: EMMA, book: book(EMMA), updated: 2 }]);

  const old = changedSince(sql, 0, undefined);
  assert.equal(old.seq, 2);
  assert.deepEqual(
    old.changes.map(c => [c.isbn, c.v]),
    [[DUNE, undefined]],
  );
  const current = changedSince(sql, 0);
  assert.deepEqual(
    current.changes.map(c => [c.isbn, c.v]),
    [
      [DUNE, 2],
      [EMMA, 2],
    ],
  );

  apply(sql, [{ v: 2, isbn: EMMA, book: null, updated: 3 }]);
  const tombstone = changedSince(sql, 0, undefined).changes.find(c => c.isbn === EMMA);
  assert.equal(tombstone?.book, null); // a deletion, not a hidden live book
  assert.equal(tombstone?.v, undefined);
  assert.equal(changedSince(sql, 0).changes.find(c => c.isbn === EMMA)?.v, 2);
});

/** Settings holding goals, written at updated. */
const settings = (goals: Goals, updated: number) => ({ data: { goals }, updated });

test('store: settings, the later write wins whole, and a since query returns them', () => {
  const sql = store();
  apply(sql, [{ isbn: DUNE, book: book(DUNE), updated: 1 }]); // seq 1
  assert.equal(changedSince(sql, 0).settings, undefined);
  assert.equal(applySettings(sql, settings({ '2026': 20 }, 10)), true); // seq 2
  assert.equal(applySettings(sql, settings({ '2026': 5 }, 5)), false); // older
  assert.equal(applySettings(sql, settings({ '2026': 9 }, 10)), false); // not newer: a tie
  assert.equal(applySettings(sql, settings({ '2026': 30, '2025': 12 }, 11)), true); // seq 3
  const all = changedSince(sql, 0);
  assert.equal(all.seq, 3);
  assert.deepEqual(all.settings, settings({ '2026': 30, '2025': 12 }, 11));
  assert.deepEqual(changedSince(sql, 2).settings, all.settings);
  assert.equal(changedSince(sql, 3).settings, undefined);
  apply(sql, [{ isbn: EMMA, book: book(EMMA), updated: 2 }]); // seq 4, after the settings
  assert.equal(changedSince(sql, 3).settings, undefined);
  assert.equal(changedSince(sql, 99).settings?.updated, 11); // a store reset: everything again
});

test('store: settings are checked before they are kept', () => {
  const ask = (s: unknown) => parse({ since: 0, changes: [], settings: s });
  assert.deepEqual(
    ask(settings({ '2026': 20, '2025': 0 }, 1))?.settings,
    settings({ '2026': 20, '2025': 0 }, 1),
  );
  assert.ok(ask(settings({}, 1)));
  assert.equal(parse({ since: 0, changes: [] })?.settings, undefined);
  assert.equal(ask(settings({ '26': 20 }, 1)), null); // not a 4-digit year
  assert.equal(ask(settings({ '2026': 1000 }, 1)), null);
  assert.equal(ask(settings({ '2026': -1 }, 1)), null);
  assert.equal(ask(settings({ '2026': 1.5 }, 1)), null);
  assert.equal(ask(settings({ '2026': '9' } as unknown as Goals, 1)), null);
  assert.equal(ask(settings({ '2026': 9 }, 0)), null);
  assert.equal(ask({ data: {}, updated: 1 }), null);
  assert.equal(ask({ data: { goals: [] }, updated: 1 }), null);
  assert.equal(ask('x'), null);
  const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [String(2000 + i), 1]));
  assert.ok(ask(settings(fifty, 1)));
  assert.equal(ask(settings({ ...fifty, '2050': 1 }, 1)), null);
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
    changes.map(c => [c.v, c.isbn, c.book?.status ?? null, c.updated]),
    [
      [2, DUNE, 'read', 2],
      [2, EMMA, null, 2],
    ],
  );
});

test('received: others’ changes come in, echoes and edits made meanwhile do not', () => {
  const mine = [book(DUNE, 'mine')];
  const snapshot = recorded({ seq: 1, books: {} }, diff(mine, { seq: 0, books: {} }, 1));
  const echo: Reply = {
    seq: 1,
    changes: [{ v: 2, isbn: DUNE, book: book(DUNE, 'mine'), updated: 1 }],
  };
  assert.equal(received(mine, snapshot, echo).books, null);

  const theirs: Change[] = [
    { v: 2, isbn: DUNE, book: book(DUNE, 'theirs'), updated: 5 },
    { v: 2, isbn: EMMA, book: book(EMMA, 'new'), updated: 6 },
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

  const junk: Change = { v: 2, isbn: EMMA, book: { isbn: EMMA } as Book, updated: 7 };
  assert.equal(received(mine, snapshot, { seq: 4, changes: [junk] }).books, null);
});

test('received: an incoming legacy book migrates without bouncing back', () => {
  const old = legacyBook(book(EMMA, 'Emma'));
  const migrated = readBook(old);
  assert.ok(migrated);
  const reply: Reply = {
    seq: 1,
    changes: [{ v: 2, isbn: EMMA, book: old, updated: 1 }],
  };
  const r = received([], { seq: 0, books: {} }, reply);
  assert.deepEqual(r.books, [migrated]);
  assert.deepEqual(diff(r.books!, r.snapshot, 2), []);
});

/** A device: its shelf, goals and snapshot, syncing straight into sql. */
function device(sql: Sql, books: Book[] = []) {
  const d = { books, goals: {} as Goals, snapshot: { seq: 0, books: {} } as Snapshot };
  const sync = (now: number) => {
    const changes = diff(d.books, d.snapshot, now);
    const mine = diffSettings(d.goals, d.snapshot, now);
    apply(sql, changes);
    if (mine) applySettings(sql, mine);
    const r = received(
      d.books,
      recorded(d.snapshot, changes, d.snapshot.seq, mine),
      changedSince(sql, d.snapshot.seq) as Reply,
      d.goals,
    );
    d.snapshot = r.snapshot;
    if (r.books) d.books = r.books;
    if (r.goals) d.goals = r.goals;
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

test('diffSettings: goals changed here are sent once; none and none synced is nothing', () => {
  const empty: Snapshot = { seq: 0, books: {} };
  assert.equal(diffSettings({}, empty, 1), null); // a new device must not wipe the shelf's goals
  const mine = diffSettings({ '2026': 12 }, empty, 1);
  assert.deepEqual(mine, settings({ '2026': 12 }, 1));
  const synced = recorded(empty, [], 1, mine);
  assert.equal(diffSettings({ '2026': 12 }, synced, 2), null);
  assert.deepEqual(diffSettings({ '2026': 13 }, synced, 2), settings({ '2026': 13 }, 2));
});

test('received: settings come in unless echoed or changed here meanwhile', () => {
  const none: Snapshot = { seq: 0, books: {} };
  const synced = recorded(none, [], 1, settings({ '2026': 12 }, 1));
  const theirs: Reply = { seq: 2, changes: [], settings: settings({ '2026': 20 }, 5) };
  const r = received([], synced, theirs, { '2026': 12 });
  assert.deepEqual(r.goals, { '2026': 20 });
  assert.deepEqual(diffSettings(r.goals!, r.snapshot, 9), null); // no bounce back

  const echo: Reply = { seq: 1, changes: [], settings: settings({ '2026': 12 }, 1) };
  assert.equal(received([], synced, echo, { '2026': 12 }).goals, null);

  const edited = received([], synced, theirs, { '2026': 15 }); // changed here meanwhile
  assert.equal(edited.goals, null);
  assert.deepEqual(diffSettings({ '2026': 15 }, edited.snapshot, 9)?.data.goals, { '2026': 15 }); // sent next

  assert.equal(received([], none, { seq: 1, changes: [] }, { '2026': 12 }).goals, null);
});

test('two devices: a goal set on one reaches the other, and the later goal wins', () => {
  const sql = store();
  const a = device(sql);
  const b = device(sql);
  a.d.goals = { '2026': 20 };
  a.sync(1);
  b.sync(2);
  assert.deepEqual(b.d.goals, { '2026': 20 });
  assert.equal(diffSettings(b.d.goals, b.d.snapshot, 3), null); // b does not send it back

  b.d.goals = { '2026': 20, '2025': 10 };
  b.sync(4);
  a.sync(5);
  assert.deepEqual(a.d.goals, { '2026': 20, '2025': 10 });

  a.d.goals = { '2026': 25, '2025': 10 };
  a.sync(6);
  b.sync(7);
  assert.deepEqual(b.d.goals, { '2026': 25, '2025': 10 });
  assert.deepEqual(changedSince(sql, a.d.snapshot.seq).settings, undefined); // all caught up
});

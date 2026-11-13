/* A shelf's store on the server: the books one sync code holds, and the
 * rule that merges what devices send. Pure: it runs over a tiny SQL
 * interface, so the Durable Object (worker/index.ts) gives it SQLite and
 * the tests give it node:sqlite.
 *
 *   books: isbn │ data (a book's JSON, or '') │ updated │ deleted │ seq
 *
 * Each device sends its changes stamped with the time it made them; the
 * later stamp wins (last writer wins), and a tie keeps the server's. Every
 * change kept takes the next seq, so "what changed since seq n" is one
 * query; a deleted book stays as a row (deleted = 1) so the deletion
 * reaches the other devices. Depends on nothing. Leaves out merging
 * within a book (the later book wins whole) and ever forgetting rows. */

/** Runs a query with its parameters, and gives back its rows. */
export type Sql = (query: string, ...params: (string | number | null)[]) => Row[];
/** A row as SQLite gives it. */
export type Row = Record<string, unknown>;

/** One book's change: the book as it now is, or null when it was deleted;
 * updated is when, in ms since 1970, by the clock of the device that made it. */
export interface Change {
  isbn: string;
  book: object | null;
  updated: number;
}

/** What a sync asks: the changes since seq it last saw, and its own. */
export interface SyncRequest {
  since: number;
  changes: Change[];
}

/** The most changes one sync may carry (the client sends them in batches). */
export const MAX_CHANGES = 500;
/** What an ISBN looks like (13 digits, as the shelf keeps them). */
const ISBN = /^97[89]\d{10}$/;

/** Makes the table, when the store is new. */
export function setUp(sql: Sql) {
  sql(`CREATE TABLE IF NOT EXISTS books (
    isbn TEXT PRIMARY KEY, data TEXT, updated INTEGER, deleted INTEGER, seq INTEGER)`);
  sql('CREATE INDEX IF NOT EXISTS books_seq ON books (seq)');
}

/** The request in body (parsed JSON), or null when it is not one. A book
 * is checked only loosely: an object whose isbn is the change's. */
export function parse(body: unknown): SyncRequest | null {
  const r = body as { since?: unknown; changes?: unknown } | null;
  if (typeof r !== 'object' || r === null) return null;
  if (!Number.isSafeInteger(r.since) || (r.since as number) < 0) return null;
  if (!Array.isArray(r.changes) || r.changes.length > MAX_CHANGES) return null;
  const valid = (c: Change) =>
    typeof c === 'object' &&
    c !== null &&
    typeof c.isbn === 'string' &&
    ISBN.test(c.isbn) &&
    Number.isSafeInteger(c.updated) &&
    c.updated > 0 &&
    (c.book === null ||
      (typeof c.book === 'object' && (c.book as { isbn?: unknown }).isbn === c.isbn));
  if (!r.changes.every(valid)) return null;
  return { since: r.since as number, changes: r.changes as Change[] };
}

/** The last seq given out (0 for a new store). */
function lastSeq(sql: Sql): number {
  return Number(sql('SELECT COALESCE(MAX(seq), 0) AS seq FROM books')[0]?.seq ?? 0);
}

/** Keeps each change that is newer than the store's copy of its book;
 * says how many it kept. */
export function apply(sql: Sql, changes: Change[]): number {
  let seq = lastSeq(sql);
  let kept = 0;
  for (const c of changes) {
    const had = sql('SELECT updated FROM books WHERE isbn = ?', c.isbn)[0];
    if (had && Number(had.updated) >= c.updated) continue; // ours is as new: keep it
    sql(
      'INSERT OR REPLACE INTO books (isbn, data, updated, deleted, seq) VALUES (?, ?, ?, ?, ?)',
      c.isbn,
      c.book ? JSON.stringify(c.book) : '',
      c.updated,
      c.book ? 0 : 1,
      ++seq,
    );
    kept++;
  }
  return kept;
}

/** The store's last seq, and every book changed after since, oldest
 * change first. */
export function changedSince(sql: Sql, since: number): { seq: number; changes: Change[] } {
  const seq = lastSeq(sql);
  if (since > seq) since = 0; // a store that lost its rows: start again
  const rows = sql(
    'SELECT isbn, data, updated, deleted FROM books WHERE seq > ? ORDER BY seq',
    since,
  );
  const changes = rows.map(r => ({
    isbn: String(r.isbn),
    book: r.deleted ? null : (JSON.parse(String(r.data)) as object),
    updated: Number(r.updated),
  }));
  return { seq, changes };
}

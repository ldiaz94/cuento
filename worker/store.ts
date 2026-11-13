/* A shelf's store on the server: the books one sync code holds, and the
 * rule that merges what devices send. Pure: it runs over a tiny SQL
 * interface, so the Durable Object (worker/index.ts) gives it SQLite and
 * the tests give it node:sqlite.
 *
 *   books:    isbn │ data (a book's JSON, or '') │ updated │ deleted │ seq
 *   settings: one row: data (the shelf's settings JSON) │ updated │ seq
 *
 * Each device sends its changes stamped with the time it made them; the
 * later stamp wins (last writer wins), and a tie keeps the server's. Every
 * change kept takes the next seq, so "what changed since seq n" is one
 * query; a deleted book stays as a row (deleted = 1) so the deletion
 * reaches the other devices. The settings (reading goals) are one more
 * record, the later write winning whole and taking a seq of its own.
 * Depends on nothing. Leaves out merging within a book or within the
 * settings (the later one wins whole) and ever forgetting rows. */

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

/** The shelf's settings: reading goals by year (books to finish). */
export interface SettingsData {
  goals: Record<string, number>;
}

/** The settings as a device wrote them, at updated (ms, by its clock). */
export interface Settings {
  data: SettingsData;
  updated: number;
}

/** What a sync asks: the changes since seq it last saw, and its own,
 * with the settings when the device changed them. */
export interface SyncRequest {
  since: number;
  changes: Change[];
  settings?: Settings;
}

/** What a sync answers: the store's last seq, the books changed since,
 * and the settings when they changed since. */
export interface SyncReply {
  seq: number;
  changes: Change[];
  settings?: Settings;
}

/** The most changes one sync may carry (the client sends them in batches). */
export const MAX_CHANGES = 500;
/** What an ISBN looks like (13 digits, as the shelf keeps them). */
const ISBN = /^97[89]\d{10}$/;
/** The most goals the settings may hold (one a year). */
const MAX_GOALS = 50;
/** The most books a goal may name. */
const MAX_GOAL = 999;
/** What a goal's year looks like. */
const YEAR = /^\d{4}$/;

/** Makes the table, when the store is new. */
export function setUp(sql: Sql) {
  sql(`CREATE TABLE IF NOT EXISTS books (
    isbn TEXT PRIMARY KEY, data TEXT, updated INTEGER, deleted INTEGER, seq INTEGER)`);
  sql('CREATE INDEX IF NOT EXISTS books_seq ON books (seq)');
  sql(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT, updated INTEGER, seq INTEGER)`);
}

/** The settings in value, cleaned to what is kept, or null when they are
 * not settings: goals with 4-digit years and whole numbers 0 to 999. */
function parseSettings(value: unknown): Settings | null {
  const s = value as { data?: { goals?: unknown }; updated?: unknown } | null;
  if (typeof s !== 'object' || s === null || !Number.isSafeInteger(s.updated)) return null;
  if ((s.updated as number) <= 0) return null;
  const goals = s.data?.goals;
  if (typeof goals !== 'object' || goals === null || Array.isArray(goals)) return null;
  const entries = Object.entries(goals);
  const fine = ([year, n]: [string, unknown]) =>
    YEAR.test(year) && Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_GOAL;
  if (entries.length > MAX_GOALS || !entries.every(fine)) return null;
  const clean = Object.fromEntries(entries) as Record<string, number>;
  return { data: { goals: clean }, updated: s.updated as number };
}

/** The request in body (parsed JSON), or null when it is not one. A book
 * is checked only loosely: an object whose isbn is the change's. */
export function parse(body: unknown): SyncRequest | null {
  const r = body as { since?: unknown; changes?: unknown; settings?: unknown } | null;
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
  const request: SyncRequest = { since: r.since as number, changes: r.changes as Change[] };
  if (r.settings !== undefined) {
    const settings = parseSettings(r.settings);
    if (!settings) return null;
    request.settings = settings;
  }
  return request;
}

/** The last seq given out, by a book or the settings (0 for a new store). */
function lastSeq(sql: Sql): number {
  return Number(
    sql(`SELECT MAX(COALESCE((SELECT MAX(seq) FROM books), 0),
                   COALESCE((SELECT seq FROM settings), 0)) AS seq`)[0]?.seq ?? 0,
  );
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

/** Keeps settings when newer than the store's copy (a tie keeps the
 * store's); says whether it did. */
export function applySettings(sql: Sql, settings: Settings): boolean {
  const had = sql('SELECT updated FROM settings WHERE id = 1')[0];
  if (had && Number(had.updated) >= settings.updated) return false;
  sql(
    'INSERT OR REPLACE INTO settings (id, data, updated, seq) VALUES (1, ?, ?, ?)',
    JSON.stringify(settings.data),
    settings.updated,
    lastSeq(sql) + 1,
  );
  return true;
}

/** The store's last seq, every book changed after since, oldest change
 * first, and the settings if they changed after since. */
export function changedSince(sql: Sql, since: number): SyncReply {
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
  const row = sql('SELECT data, updated, seq FROM settings WHERE id = 1')[0];
  if (!row || Number(row.seq) <= since) return { seq, changes };
  const data = JSON.parse(String(row.data)) as SettingsData;
  return { seq, changes, settings: { data, updated: Number(row.updated) } };
}

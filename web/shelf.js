/* The shelf: the books, what each one is, and how they are kept.
 *
 *   book = { isbn,                  13 digits, the key
 *            title, authors[], cover, pages, published,   from the lookup
 *            status,                'want' | 'reading' | 'read'
 *            added, started, finished,   'YYYY-MM-DD' or ''
 *            rating,                0 (none) to 5
 *            notes }
 *
 * The shelf is kept in localStorage as JSON, newest first, and exported
 * and imported as {cuento: 1, exported, books}. Depends on nothing.
 * Leaves out sync between devices: export and import carry a shelf. */

/** @typedef {'want' | 'reading' | 'read'} Status */
/**
 * @typedef {object} Book
 * @property {string} isbn
 * @property {string} title
 * @property {string[]} authors
 * @property {string} cover an https: URL, or ''
 * @property {number | null} pages
 * @property {string} published as the service gave it
 * @property {Status} status
 * @property {string} added 'YYYY-MM-DD'
 * @property {string} started 'YYYY-MM-DD' or ''
 * @property {string} finished 'YYYY-MM-DD' or ''
 * @property {number} rating 0 to MAX_RATING
 * @property {string} notes
 */
/**
 * What a lookup (or a reader, by hand) knows of a book.
 * @typedef {object} Found
 * @property {string} title
 * @property {string[]} [authors]
 * @property {string} [cover]
 * @property {number | null} [pages]
 * @property {string} [published]
 */

/** The localStorage key the shelf is kept under. */
const KEY = 'cuento.books';
/** A book's statuses, in the order a reader goes through them.
 * @type {Status[]} */
export const STATUSES = ['want', 'reading', 'read'];
/** The highest rating. */
export const MAX_RATING = 5;

/** Today as 'YYYY-MM-DD', in the reader's own time zone.
 * @param {Date} [now] */
export function today(now = new Date()) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
}

/** A whole book from what a lookup or a reader gave (found), on the shelf
 * as status from day.
 * @param {string} isbn
 * @param {Found} found
 * @param {Status} [status]
 * @param {string} [day]
 * @returns {Book} */
export function newBook(isbn, found, status = 'want', day = today()) {
  return withStatus(
    {
      isbn,
      title: String(found.title || 'Untitled'),
      authors: (found.authors || []).map(String),
      cover: found.cover || '',
      pages: found.pages || null,
      published: found.published || '',
      status: 'want',
      added: day,
      started: '',
      finished: '',
      rating: 0,
      notes: '',
    },
    status,
    day,
  );
}

/** book moved to status on day: starting it dates it started, finishing
 * it dates it finished (and started, if it never was); moving back to
 * 'want' keeps the dates, in case it was a slip.
 * @param {Book} book
 * @param {Status} status
 * @param {string} [day]
 * @returns {Book} */
export function withStatus(book, status, day = today()) {
  const b = { ...book, status };
  if (status !== 'want' && !b.started) b.started = day;
  if (status === 'read' && !b.finished) b.finished = day;
  if (status === 'reading') b.finished = '';
  return b;
}

/** Whether v looks like a book (an import is checked before it is kept).
 * @param {any} v
 * @returns {v is Book} */
function isBook(v) {
  return (
    v &&
    typeof v === 'object' &&
    /^97[89]\d{10}$/.test(v.isbn) &&
    typeof v.title === 'string' &&
    STATUSES.includes(v.status)
  );
}

/** The shelf kept in storage, or [] when there is none or it is damaged.
 * @param {Storage} [storage]
 * @returns {Book[]} */
export function load(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(isBook) : [];
  } catch {
    return [];
  }
}

/** Keeps books in storage; false when it could not (storage full or off).
 * @param {Book[]} books
 * @param {Storage} [storage] */
export function save(books, storage = globalThis.localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(books));
    return true;
  } catch {
    return false;
  }
}

/** books as the text of an export file.
 * @param {Book[]} books
 * @param {string} [day] */
export function exported(books, day = today()) {
  return JSON.stringify({ cuento: 1, exported: day, books }, null, 2);
}

/** The books in an export file's text; throws when it is not one.
 * @param {string} text
 * @returns {Book[]} */
export function imported(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw Error('That file is not a cuento export.');
  }
  if (v?.cuento !== 1 || !Array.isArray(v.books)) throw Error('That file is not a cuento export.');
  return v.books.filter(isBook);
}

/** shelf with books added: a book already there is replaced by the
 * incoming one, new ones go first.
 * @param {Book[]} shelf
 * @param {Book[]} books
 * @returns {Book[]} */
export function merge(shelf, books) {
  const incoming = new Map(books.map(b => [b.isbn, b]));
  return [
    ...books.filter(b => !shelf.some(s => s.isbn === b.isbn)),
    ...shelf.map(s => incoming.get(s.isbn) || s),
  ];
}

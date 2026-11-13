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

/** Where a reader is with a book. */
export type Status = 'want' | 'reading' | 'read';

/** A book on the shelf. */
export interface Book {
  isbn: string;
  title: string;
  authors: string[];
  /** An https: URL, or ''. */
  cover: string;
  pages: number | null;
  /** As the service gave it. */
  published: string;
  status: Status;
  /** 'YYYY-MM-DD'. */
  added: string;
  /** 'YYYY-MM-DD' or ''. */
  started: string;
  /** 'YYYY-MM-DD' or ''. */
  finished: string;
  /** 0 (none) to MAX_RATING. */
  rating: number;
  notes: string;
}

/** What a lookup (or a reader, by hand) knows of a book. */
export interface Found {
  title: string;
  authors?: string[];
  cover?: string;
  pages?: number | null;
  published?: string;
}

/** The localStorage key the shelf is kept under. */
const KEY = 'cuento.books';
/** A book's statuses, in the order a reader goes through them. */
export const STATUSES: readonly Status[] = ['want', 'reading', 'read'];
/** The highest rating. */
export const MAX_RATING = 5;

/** Today as 'YYYY-MM-DD', in the reader's own time zone. */
export function today(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
}

/** A whole book from what a lookup or a reader gave (found), on the shelf
 * as status from day. */
export function newBook(isbn: string, found: Found, status: Status = 'want', day = today()): Book {
  const book: Book = {
    isbn,
    title: found.title || 'Untitled',
    authors: found.authors || [],
    cover: found.cover || '',
    pages: found.pages || null,
    published: found.published || '',
    status: 'want',
    added: day,
    started: '',
    finished: '',
    rating: 0,
    notes: '',
  };
  return withStatus(book, status, day);
}

/** book moved to status on day: starting it dates it started, finishing
 * it dates it finished (and started, if it never was); moving back to
 * 'want' keeps the dates, in case it was a slip. */
export function withStatus(book: Book, status: Status, day = today()): Book {
  const b = { ...book, status };
  if (status !== 'want' && !b.started) b.started = day;
  if (status === 'read' && !b.finished) b.finished = day;
  if (status === 'reading') b.finished = '';
  return b;
}

/** Whether v looks like a book (an import is checked before it is kept). */
function isBook(v: unknown): v is Book {
  const b = v as Partial<Book> | null;
  return (
    typeof b === 'object' &&
    b !== null &&
    /^97[89]\d{10}$/.test(String(b.isbn)) &&
    typeof b.title === 'string' &&
    STATUSES.includes(b.status as Status)
  );
}

/** The shelf kept in storage, or [] when there is none or it is damaged. */
export function load(storage: Storage = globalThis.localStorage): Book[] {
  try {
    const v: unknown = JSON.parse(storage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(isBook) : [];
  } catch {
    return [];
  }
}

/** Keeps books in storage; false when it could not (storage full or off). */
export function save(books: Book[], storage: Storage = globalThis.localStorage): boolean {
  try {
    storage.setItem(KEY, JSON.stringify(books));
    return true;
  } catch {
    return false;
  }
}

/** books as the text of an export file. */
export function exported(books: Book[], day = today()): string {
  return JSON.stringify({ cuento: 1, exported: day, books }, null, 2);
}

/** The books in an export file's text; throws when it is not one. */
export function imported(text: string): Book[] {
  let v: { cuento?: unknown; books?: unknown } | null;
  try {
    v = JSON.parse(text);
  } catch {
    throw Error('That file is not a cuento export.');
  }
  if (v?.cuento !== 1 || !Array.isArray(v.books)) throw Error('That file is not a cuento export.');
  return v.books.filter(isBook);
}

/** shelf with books added: a book already there is replaced by the
 * incoming one, new ones go first. */
export function merge(shelf: Book[], books: Book[]): Book[] {
  const incoming = new Map(books.map(b => [b.isbn, b]));
  return [
    ...books.filter(b => !shelf.some(s => s.isbn === b.isbn)),
    ...shelf.map(s => incoming.get(s.isbn) || s),
  ];
}

/* The shelf: the books, what each one is, and how they are kept.
 *
 *   book = { v: 2,                   the model version
 *            isbn,                  13 digits, the key
 *            title, authors[], cover, pages, published,   from the lookup
 *            status,                'want' | 'owned' | 'reading' | 'read'
 *            added, acquired,        'YYYY-MM-DD' or acquired ''
 *            readings[],             {started, finished: 'YYYY-MM-DD' or ''}
 *            started, finished,      mirrors of the latest reading, for old readers
 *            rating,                0 (none) to 5
 *            notes, upNext }
 *
 * The shelf is kept in localStorage as JSON, newest first, and exported
 * and imported as {cuento: 2, exported, books}; cuento 1 files are migrated.
 * Depends on nothing. Syncing between devices is sync.ts's. */

/** Where a reader is with a book. Reading and read books are owned too. */
export type Status = 'want' | 'owned' | 'reading' | 'read';

/** One time through a book; finished is '' while it is underway. */
export interface Reading {
  started: string;
  finished: string;
}

/** A book on the shelf. */
export interface Book {
  v: 2;
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
  acquired: string;
  /** Every time through the book, oldest first. */
  readings: Reading[];
  /** Mirrors of the latest reading, kept so old exports remain readable. */
  started: string;
  finished: string;
  /** 0 (none) to MAX_RATING. */
  rating: number;
  notes: string;
  upNext: boolean;
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
export const STATUSES: readonly Status[] = ['want', 'owned', 'reading', 'read'];
/** The current stored/exported book model. */
export const BOOK_VERSION = 2;
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
    v: BOOK_VERSION,
    isbn,
    title: found.title || 'Untitled',
    authors: found.authors || [],
    cover: found.cover || '',
    pages: found.pages || null,
    published: found.published || '',
    status: 'want',
    added: day,
    acquired: '',
    readings: [],
    started: '',
    finished: '',
    rating: 0,
    notes: '',
    upNext: false,
  };
  return withStatus(book, status, day);
}

/** The latest reading's dates, mirrored onto the book for old readers. */
function mirrored(book: Book): Book {
  const reading = book.readings.at(-1);
  return { ...book, started: reading?.started ?? '', finished: reading?.finished ?? '' };
}

/** book moved to status on day. Starting a read book begins another session;
 * finishing one closes its open session. Moving back to Want or Owned keeps
 * the reading history, in case it was a slip, and clears Up next on starting. */
export function withStatus(book: Book, status: Status, day = today()): Book {
  let b = { ...book, status, readings: book.readings.map(r => ({ ...r })) };
  if (status === book.status) return b;
  if (status === 'owned' && book.status === 'want' && !b.acquired) b.acquired = day;
  if (status === 'reading' && !currentReading(b)) b.readings.push({ started: day, finished: '' });
  if (status === 'reading' || status === 'read') b.upNext = false;
  if (status === 'read') {
    const open = currentReading(b);
    if (open) open.finished = day;
    else b.readings.push({ started: b.readings.at(-1)?.finished || day, finished: day });
  }
  return mirrored(b);
}

/** Change one date on the latest session, creating it when necessary. */
export function withReadingDate(book: Book, key: keyof Reading, value: string): Book {
  const readings = book.readings.map(r => ({ ...r }));
  if (!readings.length) readings.push({ started: '', finished: '' });
  readings[readings.length - 1]![key] = value;
  return mirrored({ ...book, readings });
}

/** The open session, or null when there is none. */
export function currentReading(book: Book): Reading | null {
  return book.readings.find(r => !r.finished) ?? null;
}

/** Every completed session finished in year. */
export function readingsInYear(book: Book, year: number): Reading[] {
  return book.readings.filter(r => r.finished.startsWith(year + '-'));
}

/** When the book was last finished, or ''. */
export function lastRead(book: Book): string {
  return book.readings.reduce((last, r) => (r.finished > last ? r.finished : last), '');
}

/** How many times the book has been finished. */
export function readCount(book: Book): number {
  return book.readings.filter(r => r.finished).length;
}

/** Whether value is a complete current book (imports and sync are checked). */
export function isBook(value: unknown): value is Book {
  const b = value as Partial<Book> | null;
  if (
    typeof b !== 'object' ||
    b === null ||
    b.v !== BOOK_VERSION ||
    !/^97[89]\d{10}$/.test(String(b.isbn)) ||
    typeof b.title !== 'string' ||
    !Array.isArray(b.authors) ||
    !b.authors.every(a => typeof a === 'string') ||
    typeof b.cover !== 'string' ||
    !(typeof b.pages === 'number' || b.pages === null) ||
    typeof b.published !== 'string' ||
    !STATUSES.includes(b.status as Status) ||
    !date(b.added, false) ||
    !date(b.acquired) ||
    !Array.isArray(b.readings) ||
    !b.readings.every(r => date(r?.started) && date(r?.finished)) ||
    typeof b.started !== 'string' ||
    typeof b.finished !== 'string' ||
    !Number.isInteger(b.rating) ||
    (b.rating as number) < 0 ||
    (b.rating as number) > MAX_RATING ||
    typeof b.notes !== 'string' ||
    typeof b.upNext !== 'boolean'
  )
    return false;
  const latest = b.readings.at(-1);
  return b.started === (latest?.started ?? '') && b.finished === (latest?.finished ?? '');
}

/** A stored/exported date, or an allowed blank. */
function date(value: unknown, blank = true): boolean {
  return (
    typeof value === 'string' && ((blank && value === '') || /^\d{4}-\d{2}-\d{2}$/.test(value))
  );
}

/** A current book, or a legacy one migrated to v2; null when unusable. */
export function readBook(value: unknown): Book | null {
  const old = value as (Partial<Book> & { v?: unknown }) | null;
  if (typeof old !== 'object' || old === null) return null;
  if (old.v === BOOK_VERSION) return isBook(old) ? old : null;
  if (old.v !== undefined && old.v !== 1) return null;
  if (!/^97[89]\d{10}$/.test(String(old.isbn)) || typeof old.title !== 'string') return null;
  if (!STATUSES.includes(old.status as Status)) return null;
  const status = old.status as Status;
  const added = date(old.added, false) ? (old.added as string) : '';
  let readings: Reading[] = [];
  if (Array.isArray(old.readings) && old.readings.every(r => date(r?.started) && date(r?.finished)))
    readings = old.readings.map(r => ({ started: r.started, finished: r.finished }));
  else if (date(old.started) && date(old.finished) && (old.started || old.finished))
    readings = [{ started: old.started as string, finished: old.finished as string }];
  const book: Book = {
    v: BOOK_VERSION,
    isbn: old.isbn as string,
    title: old.title,
    authors: Array.isArray(old.authors) ? old.authors.filter(a => typeof a === 'string') : [],
    cover: typeof old.cover === 'string' ? old.cover : '',
    pages: typeof old.pages === 'number' ? old.pages : null,
    published: typeof old.published === 'string' ? old.published : '',
    status,
    added,
    acquired: date(old.acquired) ? (old.acquired as string) : '',
    readings,
    started: typeof old.started === 'string' ? old.started : '',
    finished: typeof old.finished === 'string' ? old.finished : '',
    rating:
      typeof old.rating === 'number' && Number.isInteger(old.rating)
        ? Math.max(0, Math.min(MAX_RATING, old.rating))
        : 0,
    notes: typeof old.notes === 'string' ? old.notes : '',
    upNext: old.upNext === true && (status === 'want' || status === 'owned'),
  };
  return mirrored(book);
}

/** The shelf kept in storage, or [] when there is none or it is damaged. */
export function load(storage: Storage = globalThis.localStorage): Book[] {
  try {
    const v: unknown = JSON.parse(storage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.flatMap(b => readBook(b) ?? []) : [];
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
  return JSON.stringify({ cuento: BOOK_VERSION, exported: day, books }, null, 2);
}

/** The books in an export file's text; throws when it is not one. */
export function imported(text: string): Book[] {
  let v: { cuento?: unknown; books?: unknown } | null;
  try {
    v = JSON.parse(text);
  } catch {
    throw Error('That file is not a cuento export.');
  }
  if ((v?.cuento !== 1 && v?.cuento !== BOOK_VERSION) || !Array.isArray(v.books))
    throw Error('That file is not a cuento export.');
  return v.books.flatMap(b => readBook(b) ?? []);
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

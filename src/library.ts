/* Your library, worked out: the books the reader has (Owned, Reading and
 * Read), found by title, author or ISBN, perhaps only those Up next, and
 * put in order by title, acquisition or last read.
 *
 *   books ──owns──► upNext? ──matches(query)──► sorted(key, reverse)
 *
 *   "0-306-40615-2", "0306406152", "9780306406157"   all find one book
 *   "30640"                                          any ISBN holding it
 *   "tolkien hobbit"                                 every word, anywhere
 *
 * Titles go A to Z, dates newest first; reversed, the other way. A book
 * whose date is unknown goes last either way. Depends on shelf.ts and
 * isbn.ts. Leaves out the page, which is libraryView.ts's. */
import { owns, lastRead } from './shelf.ts';
import type { Book } from './shelf.ts';
import { toIsbn13, clean } from './isbn.ts';

/** What the library can be put in order by. */
export type SortKey = 'title' | 'acquired' | 'lastRead';
/** The orders, as offered. */
export const SORT_KEYS: readonly SortKey[] = ['title', 'acquired', 'lastRead'];

/** How the library is being looked at. */
export interface LibraryQuery {
  /** Words or an ISBN; '' for every book. */
  search: string;
  sort: SortKey;
  /** The other way round from the usual. */
  reverse: boolean;
  /** Only the books marked Up next. */
  upNext: boolean;
}

/** The ISBN-10 of a 978 ISBN-13, or '' (979 books have none). */
function isbn10(isbn13: string): string {
  if (!isbn13.startsWith('978')) return '';
  const nine = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(nine[i]);
  const check = (11 - (sum % 11)) % 11;
  return nine + (check === 10 ? 'X' : String(check));
}

/** Whether book is found by search: a whole ISBN (either length, hyphens
 * or not) finds its book; digits find the ISBNs holding them; words must
 * each be in the title or an author. */
export function matches(book: Book, search: string): boolean {
  const s = search.trim();
  if (!s) return true;
  const isbn = toIsbn13(s);
  if (isbn) return book.isbn === isbn;
  const digits = clean(s);
  if (/^\d{3,}X?$/.test(digits) && (book.isbn + ' ' + isbn10(book.isbn)).includes(digits))
    return true;
  const text = (book.title + ' ' + book.authors.join(' ')).toLowerCase();
  return s
    .toLowerCase()
    .split(/\s+/)
    .every(w => text.includes(w));
}

/** What book is sorted on by key ('' for an unknown date). */
const sortValue = (book: Book, key: SortKey) =>
  key === 'title' ? book.title : key === 'acquired' ? book.acquired : lastRead(book);

/** books in order of key: titles A to Z, dates newest first, or the other
 * way when reverse; unknown dates last either way, and ties by title. */
export function sorted(books: Book[], key: SortKey, reverse = false): Book[] {
  const byTitle = (a: Book, b: Book) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
  return [...books].sort((a, b) => {
    if (key === 'title') return reverse ? byTitle(b, a) : byTitle(a, b);
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1) || byTitle(a, b);
    const order = reverse ? x.localeCompare(y) : y.localeCompare(x);
    return order || byTitle(a, b);
  });
}

/** The books of the library that q lets through, in its order. */
export function library(books: Book[], q: LibraryQuery): Book[] {
  return sorted(
    books.filter(b => owns(b) && (!q.upNext || b.upNext) && matches(b, q.search)),
    q.sort,
    q.reverse,
  );
}

/** day ('YYYY-MM-DD') written for reading, as in "3 Mar 2026"; "—" when
 * it is unknown. */
export function shownDate(day: string, locale?: string): string {
  if (!day) return '—';
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

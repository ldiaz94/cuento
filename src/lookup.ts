/* Finding a book by its ISBN-13, or by words of its title or author:
 * Open Library first, Google Books when Open Library has nothing. Neither
 * needs a key.
 *
 *   isbn  ─► openlibrary.org/api/books ─ found ─► {title, authors, ...}
 *               └ not found ─► googleapis.com/books ─ found ─► {...}
 *                                 └ not found ─► null
 *   words ─► openlibrary.org/search.json ─ some ─► [{isbn, title, ...}]
 *               └ none ─► googleapis.com/books?q= ─ some ─► [...]
 *                                 └ none ─► []
 *
 * A lookup or search that reached neither (offline, both down) throws, so
 * the app can tell "nothing found" from "try again". Only https: cover
 * URLs are kept: a cover goes into an <img src>, which spark does not
 * sanitise. Depends on isbn.ts and fetch. Leaves out editions, subjects,
 * descriptions and paging through more results. */

import { clean, toIsbn13 } from './isbn.ts';
import type { Found } from './shelf.ts';

/** What lookup fetches with: fetch, or a test's own. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** How long one service may take, in ms. */
const TIMEOUT = 8000;

/** url when it is an https: URL (http: is moved to https:), else ''. */
function safeUrl(url: unknown): string {
  const s = String(url || '').replace(/^http:\/\//, 'https://');
  return /^https:\/\//.test(s) ? s : '';
}

/** Open Library's jscmd=data record of one book, as far as cuento reads it. */
interface OpenLibraryBook {
  title?: string;
  subtitle?: string;
  authors?: { name?: string }[];
  cover?: { small?: string; medium?: string; large?: string };
  number_of_pages?: number;
  publish_date?: string;
}

/** Google Books' volume record, as far as cuento reads it. */
interface GoogleVolume {
  title?: string;
  subtitle?: string;
  authors?: string[];
  imageLinks?: { thumbnail?: string; smallThumbnail?: string };
  pageCount?: number;
  publishedDate?: string;
  industryIdentifiers?: { type?: string; identifier?: string }[];
}

/** How many hits a search returns at most. */
const LIMIT = 12;

/** A book a search found: what a lookup finds, and its ISBN-13. */
export interface Hit extends Found {
  isbn: string;
}

/** title and subtitle as one title. */
function joinTitle(title: string, subtitle?: string): string {
  return subtitle ? title + ': ' + subtitle : title;
}

/** One doc of Open Library's search.json reply, as far as cuento reads it. */
interface OpenLibraryDoc {
  title?: string;
  subtitle?: string;
  author_name?: string[];
  isbn?: string[];
  cover_i?: number;
  first_publish_year?: number;
  number_of_pages_median?: number;
}

/** A book from Open Library's jscmd=data reply for isbn, or null. */
export function fromOpenLibrary(reply: unknown, isbn: string): Found | null {
  const d = (reply as Record<string, OpenLibraryBook> | null)?.['ISBN:' + isbn];
  if (!d?.title) return null;
  return {
    title: joinTitle(d.title, d.subtitle),
    authors: (d.authors || []).flatMap(a => (a.name ? [a.name] : [])),
    cover: safeUrl(d.cover?.medium || d.cover?.large || d.cover?.small),
    pages: d.number_of_pages || null,
    published: d.publish_date || '',
  };
}

/** The book a Google Books volumeInfo describes, or null. */
function fromVolume(v: GoogleVolume | undefined): Found | null {
  if (!v?.title) return null;
  return {
    title: joinTitle(v.title, v.subtitle),
    authors: v.authors || [],
    cover: safeUrl(v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail),
    pages: v.pageCount || null,
    published: v.publishedDate || '',
  };
}

/** A book from Google Books' volumes reply, or null. */
export function fromGoogleBooks(reply: unknown): Found | null {
  const items = (reply as { items?: { volumeInfo?: GoogleVolume }[] } | null)?.items;
  return fromVolume(items?.[0]?.volumeInfo);
}

/** The JSON at url (null for an error status), or undefined when the
 * service could not be reached. */
async function getJson(url: string, get: Fetch): Promise<unknown> {
  try {
    const r = await get(url, { signal: AbortSignal.timeout(TIMEOUT) });
    return r.ok ? await r.json() : null;
  } catch {
    return undefined;
  }
}

/** The book with ISBN-13 isbn, or null when neither service knows it;
 * throws when neither could be reached. get is fetch, or a test's own. */
export async function lookup(isbn: string, get: Fetch = fetch): Promise<Found | null> {
  const ol = await getJson(
    'https://openlibrary.org/api/books?format=json&jscmd=data&bibkeys=ISBN:' + isbn,
    get,
  );
  const found = ol ? fromOpenLibrary(ol, isbn) : null;
  if (found) return found;
  const gb = await getJson('https://www.googleapis.com/books/v1/volumes?q=isbn:' + isbn, get);
  if (gb === undefined && ol === undefined) throw Error('Could not reach the book services');
  return gb ? fromGoogleBooks(gb) : null;
}

/** The ISBN-13 of one of isbns: the first valid ISBN-13, else the first
 * valid ISBN-10 converted; null when none is valid. */
function pickIsbn(isbns: string[]): string | null {
  const long = isbns.filter(i => clean(i).length === 13);
  const short = isbns.filter(i => clean(i).length !== 13);
  return [...long, ...short].flatMap(i => toIsbn13(i) ?? [])[0] ?? null;
}

/** The hits in Open Library's search.json reply, those with an ISBN. */
function hitsFromOpenLibrary(reply: unknown): Hit[] {
  const docs = (reply as { docs?: OpenLibraryDoc[] } | null)?.docs || [];
  return docs.flatMap(d => {
    const isbn = d.title ? pickIsbn(d.isbn || []) : null;
    if (!d.title || !isbn) return [];
    const cover =
      typeof d.cover_i === 'number' ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '';
    return {
      isbn,
      title: joinTitle(d.title, d.subtitle),
      authors: d.author_name || [],
      cover: safeUrl(cover),
      pages: d.number_of_pages_median || null,
      published: d.first_publish_year ? String(d.first_publish_year) : '',
    };
  });
}

/** The hits in Google Books' volumes reply, those with an ISBN. */
function hitsFromGoogleBooks(reply: unknown): Hit[] {
  const items = (reply as { items?: { volumeInfo?: GoogleVolume }[] } | null)?.items || [];
  return items.flatMap(item => {
    const found = fromVolume(item.volumeInfo);
    const ids = item.volumeInfo?.industryIdentifiers || [];
    const of = (type: string) =>
      ids.flatMap(i => (i.type === type && i.identifier ? [i.identifier] : []));
    const isbn = pickIsbn([...of('ISBN_13'), ...of('ISBN_10')]);
    return found && isbn ? [{ ...found, isbn }] : [];
  });
}

/** hits without a repeated ISBN (the first kept), at most LIMIT. */
function distinct(hits: Hit[]): Hit[] {
  const seen = new Set<string>();
  return hits.filter(h => !seen.has(h.isbn) && seen.add(h.isbn)).slice(0, LIMIT);
}

/** Books whose title or author match words, best first, at most LIMIT;
 * only those with an ISBN. Open Library's search; Google Books when Open
 * Library finds none. Throws when neither could be reached (as lookup
 * does), so the app can tell "nothing found" from "offline". */
export async function search(words: string, get: Fetch = fetch): Promise<Hit[]> {
  const q = encodeURIComponent(words);
  const fields =
    'title,subtitle,author_name,isbn,cover_i,first_publish_year,number_of_pages_median';
  const ol = await getJson(
    `https://openlibrary.org/search.json?q=${q}&fields=${fields}&limit=30`,
    get,
  );
  const found = distinct(hitsFromOpenLibrary(ol));
  if (found.length) return found;
  const gb = await getJson(
    `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=20&printType=books`,
    get,
  );
  if (gb === undefined && ol === undefined) throw Error('Could not reach the book services');
  return distinct(hitsFromGoogleBooks(gb));
}

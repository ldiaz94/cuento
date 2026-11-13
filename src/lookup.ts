/* Finding a book by its ISBN-13: Open Library first, Google Books when
 * Open Library has no record. Neither needs a key.
 *
 *   isbn ─► openlibrary.org/api/books ─ found ─► {title, authors, ...}
 *              └ not found ─► googleapis.com/books ─ found ─► {...}
 *                                └ not found ─► null
 *
 * A lookup that reached neither (offline, both down) throws, so the app
 * can tell "no such book" from "try again". Only https: cover URLs are
 * kept: a cover goes into an <img src>, which spark does not sanitise.
 * Depends on nothing but fetch. Leaves out editions, subjects and
 * descriptions. */

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
}

/** A book from Open Library's jscmd=data reply for isbn, or null. */
export function fromOpenLibrary(reply: unknown, isbn: string): Found | null {
  const d = (reply as Record<string, OpenLibraryBook> | null)?.['ISBN:' + isbn];
  if (!d?.title) return null;
  return {
    title: d.subtitle ? d.title + ': ' + d.subtitle : d.title,
    authors: (d.authors || []).flatMap(a => (a.name ? [a.name] : [])),
    cover: safeUrl(d.cover?.medium || d.cover?.large || d.cover?.small),
    pages: d.number_of_pages || null,
    published: d.publish_date || '',
  };
}

/** A book from Google Books' volumes reply, or null. */
export function fromGoogleBooks(reply: unknown): Found | null {
  const v = (reply as { items?: { volumeInfo?: GoogleVolume }[] } | null)?.items?.[0]?.volumeInfo;
  if (!v?.title) return null;
  return {
    title: v.subtitle ? v.title + ': ' + v.subtitle : v.title,
    authors: v.authors || [],
    cover: safeUrl(v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail),
    pages: v.pageCount || null,
    published: v.publishedDate || '',
  };
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

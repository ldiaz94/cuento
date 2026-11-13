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

/** @typedef {import('./shelf.js').Found} Found */

/** How long one service may take, in ms. */
const TIMEOUT = 8000;

/** url when it is an https: URL (http: is moved to https:), else ''.
 * @param {unknown} url */
function safeUrl(url) {
  const s = String(url || '').replace(/^http:\/\//, 'https://');
  return /^https:\/\//.test(s) ? s : '';
}

/** A book from Open Library's jscmd=data reply for isbn, or null.
 * @param {any} reply the service's JSON
 * @param {string} isbn
 * @returns {Found | null} */
export function fromOpenLibrary(reply, isbn) {
  const d = reply?.['ISBN:' + isbn];
  if (!d?.title) return null;
  return {
    title: d.subtitle ? d.title + ': ' + d.subtitle : d.title,
    authors: (d.authors || []).map((/** @type {{name?: string}} */ a) => a.name).filter(Boolean),
    cover: safeUrl(d.cover?.medium || d.cover?.large || d.cover?.small),
    pages: d.number_of_pages || null,
    published: d.publish_date || '',
  };
}

/** A book from Google Books' volumes reply, or null.
 * @param {any} reply the service's JSON
 * @returns {Found | null} */
export function fromGoogleBooks(reply) {
  const v = reply?.items?.[0]?.volumeInfo;
  if (!v?.title) return null;
  return {
    title: v.subtitle ? v.title + ': ' + v.subtitle : v.title,
    authors: v.authors || [],
    cover: safeUrl(v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail),
    pages: v.pageCount || null,
    published: v.publishedDate || '',
  };
}

/** The JSON at url, or undefined when the service could not be reached.
 * @param {string} url
 * @param {typeof fetch} get
 * @returns {Promise<any>} */
async function getJson(url, get) {
  try {
    const r = await get(url, { signal: AbortSignal.timeout(TIMEOUT) });
    return r.ok ? await r.json() : null;
  } catch {
    return undefined;
  }
}

/** The book with ISBN-13 isbn, or null when neither service knows it;
 * throws when neither could be reached. get is fetch, or a test's own.
 * @param {string} isbn
 * @param {typeof fetch} [get]
 * @returns {Promise<Found | null>} */
export async function lookup(isbn, get = fetch) {
  const ol = await getJson(
    'https://openlibrary.org/api/books?format=json&jscmd=data&bibkeys=ISBN:' + isbn,
    get,
  );
  const found = ol && fromOpenLibrary(ol, isbn);
  if (found) return found;
  const gb = await getJson('https://www.googleapis.com/books/v1/volumes?q=isbn:' + isbn, get);
  if (gb === undefined && ol === undefined) throw Error('Could not reach the book services');
  return (gb && fromGoogleBooks(gb)) || null;
}

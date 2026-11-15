/* Prices: what a store's public, published API says a book costs, and the
 * cache that keeps each answer a day. Pure: the network is a function
 * passed in and the cache runs over the store's tiny SQL interface, so the
 * Durable Object (worker/shop.ts) gives it fetch and SQLite and the tests
 * give it fixtures and node:sqlite.
 *
 *   GET /api/prices?isbn=<ISBN-13>&region=<XX>&stores=<id>,<id>
 *
 *   gandhi       VTEX's public catalog API on gandhi.com.mx, by EAN (MXN)
 *   apple-books  the iTunes Search API's lookup by ISBN, in region's store
 *
 *   prices: isbn │ store │ region │ data (a StoreResult's JSON) │ expires
 *
 * Only the ISBN, the store ids and a two-letter region are ever taken (the
 * reader's location never reaches the server). Found and not-found answers
 * are kept for TTL; a store that didn't answer isn't kept, so the next
 * reader asks again. Every outbound fetch has a timeout and a size limit,
 * and at most MAX_STORES stores are asked at once. Other stores have no
 * usable API: Google Books' saleInfo needs a key once its shared quota is
 * spent, and the rest publish none. Depends on src/isbn.ts, src/stores.ts
 * and src/offers.ts. Leaves out scraping any store's pages. */
import { toIsbn13 } from '../src/isbn.ts';
import { STORES } from '../src/stores.ts';
import type { Offer, StoreResult } from '../src/offers.ts';
import type { Sql } from './store.ts';

/** How long an answer is kept, in ms: a day. */
export const TTL = 24 * 60 * 60 * 1000;
/** The most stores one request may name. */
export const MAX_STORES = 8;
/** How long a store's API has to answer, in ms. */
export const TIMEOUT = 5000;
/** The most bytes read from a store's API. */
const MAX_BYTES = 512 * 1024;

/** What a request asks. */
export interface PriceQuery {
  isbn: string;
  /** Upper-case ISO 3166 alpha-2, or '' when the reader's browser names none. */
  region: string;
  /** Catalogue ids, each once, in the order asked. */
  stores: string[];
}

/** The query in url's search parameters, or a reason it is refused. */
export function parseQuery(url: URL): PriceQuery | string {
  const isbn = url.searchParams.get('isbn') ?? '';
  if (!/^\d{13}$/.test(isbn) || toIsbn13(isbn) !== isbn) return 'Not an ISBN-13.';
  const region = url.searchParams.get('region') ?? '';
  if (region && !/^[A-Z]{2}$/.test(region)) return 'Not a region.';
  const stores: string[] = [];
  for (const id of (url.searchParams.get('stores') ?? '').split(',')) {
    if (!STORES.some(s => s.id === id)) return 'No such store.';
    if (!stores.includes(id)) stores.push(id);
  }
  if (stores.length > MAX_STORES) return 'Too many stores.';
  return { isbn, region, stores };
}

/** Fetches a URL's JSON, or throws: the Durable Object's, with a timeout. */
export type GetJson = (url: string) => Promise<unknown>;

/** A store's API: where to ask, and how to read the answer. */
interface Source {
  /** Whether the answer depends on the region (the store's country). */
  regional: boolean;
  url(isbn: string, region: string): string;
  /** The offer for isbn in json, or null when the store doesn't list it. Throws when json isn't the API's. */
  read(json: unknown, isbn: string, region: string): Offer | null;
}

/** Whether url is https on host or a subdomain of it. */
function onHost(url: unknown, host: string): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === host || u.hostname.endsWith('.' + host));
  } catch {
    return false;
  }
}

/** Formats a VTEX store's edition type ('Tipo') is mapped to. */
function vtexFormat(tipo: string): Offer['format'] {
  const t = tipo.toLowerCase();
  if (t.includes('audio')) return 'audio';
  if (t.includes('ebook') || t.includes('digital')) return 'ebook';
  return 'print';
}

/** The offer in a VTEX catalog search (an array of products) for the item
 * whose EAN is isbn, on a store at host selling in currency. */
export function readVtex(
  json: unknown,
  isbn: string,
  host: string,
  currency: string,
): Offer | null {
  if (!Array.isArray(json)) throw new Error('Not a VTEX search.');
  for (const p of json as { link?: unknown; items?: unknown }[]) {
    if (!Array.isArray(p?.items)) continue;
    for (const item of p.items as Record<string, unknown>[]) {
      if (item?.ean !== isbn) continue;
      if (!onHost(p.link, host)) continue;
      const sellers = Array.isArray(item.sellers)
        ? (item.sellers as Record<string, unknown>[])
        : [];
      const offers = sellers.map(
        s =>
          (s?.commertialOffer ?? {}) as {
            Price?: unknown;
            ListPrice?: unknown;
            IsAvailable?: unknown;
          },
      );
      const selling = offers.find(o => o.IsAvailable === true && Number(o.Price) > 0);
      const images = Array.isArray(item.images) ? (item.images as { imageUrl?: unknown }[]) : [];
      const image = images.map(i => i?.imageUrl).find(u => onHost(u, 'vteximg.com.br'));
      const tipo = Array.isArray(item.Tipo) && typeof item.Tipo[0] === 'string' ? item.Tipo[0] : '';
      const offer: Offer = {
        price: selling ? Number(selling.Price) : null,
        currency,
        url: p.link,
        image: image ?? '',
        format: vtexFormat(tipo),
      };
      if (tipo) offer.edition = tipo.slice(0, 40);
      const list = Number(selling?.ListPrice);
      if (offer.price !== null && list > offer.price) offer.listPrice = list;
      return offer;
    }
  }
  return null;
}

/** The offer in an iTunes lookup answer: the first ebook with a price. */
export function readItunes(json: unknown): Offer | null {
  const results = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new Error('Not an iTunes answer.');
  for (const r of results as Record<string, unknown>[]) {
    if (r?.kind !== 'ebook') continue;
    const price = Number(r.price);
    if (!onHost(r.trackViewUrl, 'books.apple.com')) continue;
    if (typeof r.currency !== 'string' || !/^[A-Z]{3}$/.test(r.currency)) continue;
    const art = onHost(r.artworkUrl100, 'mzstatic.com') ? r.artworkUrl100 : '';
    return {
      // A free ebook is 0: shown as a price, not as out of stock.
      price: Number.isFinite(price) && price >= 0 ? price : null,
      currency: r.currency,
      url: r.trackViewUrl,
      image: art.replace(/\/100x100bb\./, '/200x300bb.'),
      format: 'ebook',
    };
  }
  return null;
}

/** The stores with an API, by catalogue id (stores.ts marks them priced). */
export const SOURCES: Record<string, Source> = {
  gandhi: {
    regional: false,
    url: isbn =>
      'https://www.gandhi.com.mx/api/catalog_system/pub/products/search?fq=alternateIds_Ean:' +
      isbn,
    read: (json, isbn) => readVtex(json, isbn, 'gandhi.com.mx', 'MXN'),
  },
  'apple-books': {
    regional: true,
    url: (isbn, region) =>
      `https://itunes.apple.com/lookup?isbn=${isbn}&country=${region.toLowerCase()}`,
    read: json => readItunes(json),
  },
};

/** The region an answer is kept under: '*' when the store's answer is the same everywhere. */
function regionKey(source: Source, region: string): string {
  return source.regional ? region || 'US' : '*';
}

/** Makes the table, when the cache is new. */
export function setUp(sql: Sql) {
  sql(`CREATE TABLE IF NOT EXISTS prices (
    isbn TEXT, store TEXT, region TEXT, data TEXT, expires INTEGER,
    PRIMARY KEY (isbn, store, region))`);
}

/** A kept answer still fresh at now, or null. */
export function cached(
  sql: Sql,
  isbn: string,
  store: string,
  region: string,
  now: number,
): StoreResult | null {
  const row = sql(
    'SELECT data FROM prices WHERE isbn = ? AND store = ? AND region = ? AND expires > ?',
    isbn,
    store,
    region,
    now,
  )[0];
  return row ? (JSON.parse(String(row.data)) as StoreResult) : null;
}

/** Keeps an answer until now + TTL. Errors are never kept. */
export function keep(
  sql: Sql,
  isbn: string,
  store: string,
  region: string,
  result: StoreResult,
  now: number,
) {
  if (result.status !== 'found' && result.status !== 'none') return;
  sql(
    'INSERT OR REPLACE INTO prices (isbn, store, region, data, expires) VALUES (?, ?, ?, ?, ?)',
    isbn,
    store,
    region,
    JSON.stringify(result),
    now + TTL,
  );
}

/** Forgets every answer expired at now; gives the soonest expiry left, or null when none is. */
export function prune(sql: Sql, now: number): number | null {
  sql('DELETE FROM prices WHERE expires <= ?', now);
  const next = sql('SELECT MIN(expires) AS next FROM prices')[0]?.next;
  return next === null || next === undefined ? null : Number(next);
}

/** Asks one store's API; an answer that can't be read is an error. */
async function ask(
  source: Source,
  get: GetJson,
  isbn: string,
  region: string,
  now: number,
): Promise<StoreResult> {
  try {
    const offer = source.read(await get(source.url(isbn, region)), isbn, region);
    return offer ? { status: 'found', offer, checked: now } : { status: 'none', checked: now };
  } catch (e) {
    // Logged for wrangler tail: which store failed, and why.
    const host = new URL(source.url(isbn, region)).hostname;
    console.warn(`prices: ${host} failed for ${isbn} (${region}): ${String(e)}`);
    return { status: 'error' };
  }
}

/** Every store's answer for q: kept ones while fresh, the rest asked at
 * once and kept; a store with no API is 'unpriced'. */
export async function prices(
  sql: Sql,
  get: GetJson,
  q: PriceQuery,
  now: number,
): Promise<Record<string, StoreResult>> {
  const entries = await Promise.all(
    q.stores.map(async (id): Promise<[string, StoreResult]> => {
      const source = SOURCES[id];
      if (!source) return [id, { status: 'unpriced' }];
      const region = regionKey(source, q.region);
      const kept = cached(sql, q.isbn, id, region, now);
      if (kept) return [id, kept];
      const result = await ask(source, get, q.isbn, region, now);
      keep(sql, q.isbn, id, region, result, now);
      return [id, result];
    }),
  );
  return Object.fromEntries(entries);
}

/** GetJson over fetch: a timeout, JSON only, at most MAX_BYTES. */
export function fetchJson(fetcher: typeof fetch): GetJson {
  return async url => {
    const response = await fetcher(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'cuento.page' },
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: 'manual', // a redirect is not ok: refused below
    });
    if (!response.ok) {
      const type = response.headers.get('Content-Type') || '-';
      const to = response.headers.get('Location') || '-';
      throw new Error(`HTTP ${response.status} (type ${type}, location ${to})`);
    }
    if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw new Error('Too big.');
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error('Too big.');
    return JSON.parse(text) as unknown;
  };
}

/* The store catalogue: where a book can be looked for, by region and format,
 * and the shopping preferences a reader keeps (format, favourite stores,
 * location).
 *
 * Every store knows how to make a search URL. A few also have a public,
 * published API that cuento's server asks for the book's price (priced:
 * worker/prices.ts); the rest are searches only, and nothing here claims a
 * price or that a book is in stock. Only search patterns that are stable
 * and public are used.
 *
 * All three sync with the reader's shelf (sync.ts), the location too: it
 * travels only to the reader's own shelf on cuento's server, never to a
 * store or the price API (/api/prices takes only the ISBN, store ids and
 * region), and is only ever put in a link the reader opens.
 * Depends on nothing. Turning stores into links for a book is buy.ts's. */

/** How a book is bought. */
export type Format = 'print' | 'ebook';

/** What the reader prefers when shopping. */
export interface ShoppingPrefs {
  /** '' for no preference. */
  format: '' | Format;
  /** Catalogue ids or custom names, in the reader's order. */
  stores: string[];
  /** Free text the reader typed, or ''. Synced with the shelf; never sent to a store or /api/prices. */
  location: string;
}

/** No preferences at all. */
export const NO_PREFS: ShoppingPrefs = { format: '', stores: [], location: '' };

/** The most favourite stores kept (the server's limit too, worker/store.ts). */
export const MAX_STORES = 20;
/** The longest store name kept. */
export const MAX_NAME = 60;
/** The longest location kept. */
export const MAX_LOCATION = 200;

/** Preferences from stored or synced JSON, dropping whatever is not usable. */
export function readPrefs(value: unknown): ShoppingPrefs {
  if (typeof value !== 'object' || value === null) return { ...NO_PREFS, stores: [] };
  const v = value as Record<string, unknown>;
  const format = v.format === 'print' || v.format === 'ebook' ? v.format : '';
  const stores: string[] = [];
  if (Array.isArray(v.stores)) {
    for (const s of v.stores) {
      if (typeof s !== 'string') continue;
      const name = s.trim().slice(0, MAX_NAME);
      if (name && !stores.some(t => t.toLowerCase() === name.toLowerCase())) stores.push(name);
      if (stores.length === MAX_STORES) break;
    }
  }
  const location = typeof v.location === 'string' ? v.location.trim().slice(0, MAX_LOCATION) : '';
  return { format, stores, location };
}

/** What a search is for. */
export interface Query {
  isbn: string;
  title: string;
  author: string;
}

/** A shop the catalogue can search. */
export interface Store {
  id: string;
  name: string;
  /** ISO 3166 alpha-2 codes, or '*' for anywhere. */
  regions: string[];
  formats: Format[];
  /** True when the store's search takes an ISBN. */
  byIsbn: boolean;
  /** True when cuento's server can ask the store's public API for a price (worker/prices.ts). */
  priced?: boolean;
  /** An https: search URL for the book. */
  search(q: Query): string;
  /** An https: search for the store's own shops near a place, when it has shops. */
  nearby?(location: string, q: Query): string;
}

const enc = encodeURIComponent;

/** The text a store is searched with: the ISBN, else title and first author. */
export function term(q: Query, byIsbn: boolean): string {
  return byIsbn && q.isbn ? q.isbn : [q.title, q.author].filter(Boolean).join(' ');
}

/** A DuckDuckGo search for the book's ISBN, limited to one site. */
function siteSearch(site: string, q: Query): string {
  return 'https://duckduckgo.com/?q=' + enc('site:' + site + ' ' + term(q, true));
}

/** A store whose search is base + the encoded term. */
function shop(
  id: string,
  name: string,
  regions: string[],
  formats: Format[],
  base: string,
  shops = false,
): Store {
  const store: Store = {
    id,
    name,
    regions,
    formats,
    byIsbn: true,
    search: q => base + enc(term(q, true)),
  };
  if (shops) {
    store.nearby = location =>
      `https://www.google.com/maps/search/?api=1&query=${enc(name + ' near ' + location)}`;
  }
  return store;
}

const BOTH: Format[] = ['print', 'ebook'];

/** The catalogue. */
export const STORES: readonly Store[] = [
  shop('bookshop-us', 'Bookshop.org', ['US'], ['print'], 'https://bookshop.org/search?keywords='),
  shop(
    'bookshop-gb',
    'Bookshop.org',
    ['GB'],
    ['print'],
    'https://uk.bookshop.org/search?keywords=',
  ),
  // Its own search couldn't be confirmed (2026-11): a site search instead.
  {
    ...shop('bn', 'Barnes & Noble', ['US'], BOTH, '', true),
    search: q => siteSearch('barnesandnoble.com', q),
  },
  shop(
    'waterstones',
    'Waterstones',
    ['GB'],
    BOTH,
    'https://www.waterstones.com/books/search/term/',
    true,
  ),
  shop('amazon-uk', 'Amazon', ['GB'], BOTH, 'https://www.amazon.co.uk/s?k='),
  shop('amazon-es', 'Amazon', ['ES'], BOTH, 'https://www.amazon.es/s?k='),
  shop('amazon-mx', 'Amazon', ['MX'], BOTH, 'https://www.amazon.com.mx/s?k='),
  shop('amazon', 'Amazon', ['US', '*'], BOTH, 'https://www.amazon.com/s?k='),
  // Its own search couldn't be confirmed (2026-11): a site search instead.
  {
    ...shop('casadellibro-es', 'Casa del Libro', ['ES'], BOTH, '', true),
    search: q => siteSearch('casadellibro.com', q),
  },
  {
    // The Mexican store is a VTEX site at latam.casadellibro.com; its search is the term as the path.
    ...shop('casadellibro-mx', 'Casa del Libro', ['MX'], BOTH, ''),
    search: q => {
      const t = enc(term(q, true));
      return `https://latam.casadellibro.com/${t}?_q=${t}&map=ft`;
    },
  },
  shop(
    'fnac-es',
    'Fnac',
    ['ES'],
    BOTH,
    'https://www.fnac.es/SearchResult/ResultList.aspx?Search=',
    true,
  ),
  {
    // A VTEX site: its search is the text as the path, repeated as _q. Searched by title and author.
    ...shop('gandhi', 'Gandhi', ['MX'], BOTH, '', true),
    byIsbn: false,
    priced: true,
    search: q => {
      const t = enc(term(q, false));
      return `https://www.gandhi.com.mx/${t}?_q=${t}&map=ft`;
    },
  },
  shop('kobo', 'Kobo', ['*'], ['ebook'], 'https://www.kobo.com/us/en/search?query='),
  shop(
    'google-play',
    'Google Play Books',
    ['*'],
    ['ebook'],
    'https://play.google.com/store/search?c=books&q=',
  ),
  // Apple Books has no web search; its prices come from the iTunes Search API.
  {
    ...shop('apple-books', 'Apple Books', ['*'], ['ebook'], ''),
    priced: true,
    search: q => siteSearch('books.apple.com', q),
  },
];

/** The ISO region of a locale: 'en-GB' gives 'GB'; '' when it names none. */
export function regionOf(locale: string): string {
  const parts = locale.split(/[-_]/).slice(1);
  const region = parts.find(p => /^[A-Za-z]{2}$/.test(p));
  return region ? region.toUpperCase() : '';
}

/** The catalogue's stores for a region: that region's own first, then the anywhere ones, one of each name. */
export function suggestedStores(region: string): Store[] {
  const r = region.toUpperCase();
  const own = r && r !== '*' ? STORES.filter(s => s.regions.includes(r)) : [];
  const any = STORES.filter(s => s.regions.includes('*'));
  const out: Store[] = [];
  for (const s of [...own, ...any]) if (!out.some(t => t.name === s.name)) out.push(s);
  return out;
}

/** The catalogue store a favourite names, by name or id; undefined for a custom one. Names are shared between countries, so a name resolves to the store for the region, then an anywhere one, then any. */
export function storeNamed(name: string, region = ''): Store | undefined {
  const n = name.trim().toLowerCase();
  const r = region.toUpperCase();
  const named = STORES.filter(s => s.name.toLowerCase() === n);
  return (
    (r ? named.find(s => s.regions.includes(r)) : undefined) ??
    named.find(s => s.regions.includes('*')) ??
    named[0] ??
    STORES.find(s => s.id === n)
  );
}

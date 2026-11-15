/* The store catalogue: where a book can be looked for, by region and format,
 * and the shopping preferences a reader keeps (format, favourite stores,
 * location).
 *
 * Every store knows how to make a search URL, never a product URL, so nothing
 * here claims a price or that a book is in stock. Only search patterns
 * that are stable and public are used.
 *
 * The location is typed by the reader and stays on this device: it is never
 * sent anywhere by cuento, and sync must never carry it. Format and stores
 * may sync later; the location may not.
 * Depends on nothing. Turning stores into links for a book is buy.ts's. */

/** How a book is bought. */
export type Format = 'print' | 'ebook';

/** What the reader prefers when shopping. */
export interface ShoppingPrefs {
  /** '' for no preference. */
  format: '' | Format;
  /** Catalogue ids or custom names, in the reader's order. */
  stores: string[];
  /** Free text the reader typed, or ''. Device-only: never synced. */
  location: string;
}

/** No preferences at all. */
export const NO_PREFS: ShoppingPrefs = { format: '', stores: [], location: '' };

const MAX_STORES = 20;
const MAX_NAME = 60;
const MAX_LOCATION = 200;

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
  shop('bn', 'Barnes & Noble', ['US'], BOTH, 'https://www.barnesandnoble.com/s/', true),
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
  shop(
    'casadellibro-es',
    'Casa del Libro',
    ['ES'],
    BOTH,
    'https://www.casadellibro.com/busqueda-generica?busqueda=',
    true,
  ),
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
  shop(
    'gandhi',
    'Gandhi',
    ['MX'],
    BOTH,
    'https://www.gandhi.com.mx/catalogsearch/result/?q=',
    true,
  ),
  shop('kobo', 'Kobo', ['*'], ['ebook'], 'https://www.kobo.com/us/en/search?query='),
  shop(
    'google-play',
    'Google Play Books',
    ['*'],
    ['ebook'],
    'https://play.google.com/store/search?c=books&q=',
  ),
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

/** The catalogue store a favourite names, by id or by name; undefined for a custom one. */
export function storeNamed(name: string): Store | undefined {
  const n = name.trim().toLowerCase();
  return STORES.find(s => s.id === n) ?? STORES.find(s => s.name.toLowerCase() === n);
}

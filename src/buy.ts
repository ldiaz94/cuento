/* Where to buy: which stores a book is shown at, and nearby searches.
 *
 * Only the reader's own stores are shown, in their order; with none, the
 * stores suggested for their region (in their preferred format, when they
 * have one and the region has such stores). The rest of the region's are
 * kept for a "More stores" list. A store with a public API (priced) has
 * its price asked of cuento's server (buyView.ts, worker/prices.ts); every
 * store keeps its search, so with no price there is still a way in. A
 * favourite that is not in the catalogue is a plain web search for its
 * name and the ISBN. With a location there are nearby searches too; the
 * location syncs with the shelf, but is only ever put in a link the reader
 * opens, never sent to a store or /api/prices.
 * Depends on shelf.ts (Book) and stores.ts. Showing them is buyView.ts's. */
import type { Book } from './shelf.ts';
import { storeNamed, suggestedStores, term } from './stores.ts';
import type { Format, Query, ShoppingPrefs, Store } from './stores.ts';

/** Shown under the stores. */
export const NOTE = 'Prices come from each store and can change: check before you buy.';

/** A store a book is shown at. */
export interface Shop {
  /** A catalogue id, or a custom store's name. */
  id: string;
  name: string;
  /** The store's search for the book: https. */
  search: string;
  /** True when cuento's server can ask the store for a price. */
  priced: boolean;
  /** The formats the store sells; [] for a custom store. */
  formats: Format[];
}

/** A nearby search to open. */
export interface BuyLink {
  label: string;
  /** An https: URL. */
  url: string;
  /** A catalogue id, 'maps' or 'worldcat'. */
  store: string;
}

const enc = encodeURIComponent;

/** What a store is searched with for book. */
function queryOf(book: Book): Query {
  return { isbn: book.isbn, title: book.title, author: book.authors[0] ?? '' };
}

/** A catalogue store as a Shop. */
function fromStore(store: Store, q: Query): Shop {
  return {
    id: store.id,
    name: store.name,
    search: store.search(q),
    priced: store.priced === true,
    formats: store.formats,
  };
}

/** The stores to show book at, and the rest of the region's for "More stores". */
export function shopsFor(
  book: Book,
  prefs: ShoppingPrefs,
  region: string,
): { shown: Shop[]; more: Shop[] } {
  const q = queryOf(book);
  const shown: Shop[] = [];
  const has = (name: string) => shown.some(s => s.name.toLowerCase() === name.toLowerCase());
  for (const fav of prefs.stores) {
    const store = storeNamed(fav, region);
    if (store && !has(store.name)) shown.push(fromStore(store, q));
    else if (!store && !has(fav)) {
      const text = fav + ' ' + (q.isbn || term(q, false));
      shown.push({
        id: fav,
        name: fav,
        search: 'https://duckduckgo.com/?q=' + enc(text),
        priced: false,
        formats: [],
      });
    }
  }
  const suggested = suggestedStores(region);
  if (!shown.length) {
    const fmt = prefs.format;
    const inFormat = fmt ? suggested.filter(s => s.formats.includes(fmt)) : [];
    for (const s of inFormat.length ? inFormat : suggested) shown.push(fromStore(s, q));
  }
  const more = suggested.filter(s => !has(s.name)).map(s => fromStore(s, q));
  return { shown, more };
}

/** Nearby searches for book: none without a location. */
export function nearby(book: Book, prefs: ShoppingPrefs, shops: Shop[], region: string): BuyLink[] {
  const where = prefs.location.trim();
  if (!where) return [];
  const q = queryOf(book);
  const links: BuyLink[] = [
    {
      label: 'Bookshops near ' + where,
      url: `https://www.google.com/maps/search/?api=1&query=${enc('bookshops near ' + where)}`,
      store: 'maps',
    },
  ];
  for (const shop of shops) {
    const store = storeNamed(shop.id, region);
    if (store?.id === shop.id && store.nearby)
      links.push({
        label: `${store.name} near ${where}`,
        url: store.nearby(where, q),
        store: store.id,
      });
  }
  links.push({
    label: 'Libraries on WorldCat',
    url: 'https://search.worldcat.org/search?q=' + enc(q.isbn ? 'bn:' + q.isbn : term(q, false)),
    store: 'worldcat',
  });
  return links;
}

/** The query string for the prices of book at shops: only the ISBN, the
 * priced stores' ids and the region, never anything the reader typed.
 * '' when there is nothing to ask. */
export function priceQuery(book: Book, shops: Shop[], region: string): string {
  const ids = shops.filter(s => s.priced).map(s => s.id);
  if (!/^97[89]\d{10}$/.test(book.isbn) || !ids.length) return '';
  const params = new URLSearchParams({ isbn: book.isbn });
  if (/^[A-Z]{2}$/.test(region)) params.set('region', region);
  params.set('stores', ids.join(','));
  return params.toString();
}

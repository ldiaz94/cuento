/* Where to buy: search links for a book, ordered by the reader's preferences.
 *
 * Every link is a search, never a price or a claim that the book is in stock;
 * the labels say so and so does DISCLAIMER. Stores search by ISBN where they
 * can, otherwise by title and first author. A favourite store that is not in
 * the catalogue becomes a plain web search for its name and the ISBN.
 * With a location there are also nearby links (bookshops on a map, stores' own
 * shops, a library search); without one there are none. The location is
 * device-only and is only ever put in a link the reader opens.
 * Depends on shelf.ts (Book) and stores.ts. Showing the links is the UI's. */
import type { Book } from './shelf.ts';
import { storeNamed, suggestedStores, term } from './stores.ts';
import type { Format, Query, ShoppingPrefs, Store } from './stores.ts';

/** Shown with the links. */
export const DISCLAIMER = 'Searches, not prices: check the store for stock.';

/** One link to open. */
export interface BuyLink {
  label: string;
  /** An https: URL. */
  url: string;
  kind: 'online' | 'nearby';
  /** A catalogue id or a custom name. */
  store: string;
  /** The format the reader prefers, when the store sells it. */
  format?: Format;
}

const enc = encodeURIComponent;

/** The links for a book, favourites first, then stores in the preferred format, then the rest of the region's. */
export function whereToBuy(book: Book, prefs: ShoppingPrefs, region: string): BuyLink[] {
  const q: Query = { isbn: book.isbn, title: book.title, author: book.authors[0] ?? '' };
  const entries: { store: Store | null; name: string }[] = [];
  const seen = new Set<string>();
  const add = (store: Store | null, name: string) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ store, name });
  };
  for (const fav of prefs.stores) {
    const store = storeNamed(fav, region);
    add(store ?? null, store ? store.name : fav);
  }
  const rest = suggestedStores(region);
  const fmt = prefs.format;
  for (const s of fmt ? rest.filter(s => s.formats.includes(fmt)) : []) add(s, s.name);
  for (const s of rest) add(s, s.name);

  const links: BuyLink[] = [];
  for (const { store, name } of entries) {
    if (store) {
      const link: BuyLink = {
        label: 'Search ' + store.name,
        url: store.search(q),
        kind: 'online',
        store: store.id,
      };
      if (fmt && store.formats.includes(fmt)) link.format = fmt;
      links.push(link);
    } else {
      const text = name + ' ' + (q.isbn || term(q, false));
      links.push({
        label: 'Search the web for ' + name,
        url: 'https://duckduckgo.com/?q=' + enc(text),
        kind: 'online',
        store: name,
      });
    }
  }

  const where = prefs.location.trim();
  if (where) {
    links.push({
      label: 'Find bookshops near ' + where,
      url: `https://www.google.com/maps/search/?api=1&query=${enc('bookshops near ' + where)}`,
      kind: 'nearby',
      store: 'maps',
    });
    for (const { store } of entries) {
      if (store?.nearby) {
        links.push({
          label: `Find ${store.name} near ${where}`,
          url: store.nearby(where, q),
          kind: 'nearby',
          store: store.id,
        });
      }
    }
    links.push({
      label: 'Search libraries on WorldCat',
      url: 'https://search.worldcat.org/search?q=' + enc(q.isbn ? 'bn:' + q.isbn : term(q, false)),
      kind: 'nearby',
      store: 'worldcat',
    });
  }
  return links;
}

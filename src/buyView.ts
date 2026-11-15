/* Where to buy, shown: a card for each of the reader's stores (or their
 * region's), with the book, the store and, where the store has a public
 * API, its price; tapping a card opens the book at the store, or the
 * store's search.
 *
 *   [Where to buy]
 *   ┌──────┬──────────────────────────┬────────────┐
 *   │cover │ GANDHI                   │ MX$149.00  │   found: the price
 *   │      │ One Hundred Years of …   │  MX$260.00 │   (was, struck out);
 *   │      │ Paperback · In stock     │            │   a shimmer while asked
 *   └──────┴──────────────────────────┴────────────┘
 *   OR SEARCH  ┌ Amazon    Search ↗ ┐ ┌ Kobo      Search ↗ ┐   no API, not
 *              └───────────────────┘ └───────────────────┘   listed, no answer
 *   More stores ▸   Nearby: …   Prices come from each store …
 *
 * The prices come from cuento's server (GET /api/prices, worker/shop.ts)
 * with only the ISBN, the priced stores' ids and the region; while they
 * come, a priced card shimmers, and offline or on any failure every card
 * is its store's search. Answers are kept for the page's life. Laid out
 * for 320px and up (public/buy.css). Depends on spark, shelf.ts, tilde.ts,
 * buy.ts and offers.ts. */
import { signal, html } from './spark/index.js';
import type { Getter } from './spark/index.js';
import type { Book } from './shelf.ts';
import type { ShoppingPrefs } from './stores.ts';
import { cloth } from './tilde.ts';
import { shopsFor, nearby, priceQuery, NOTE } from './buy.ts';
import type { Shop } from './buy.ts';
import { readReply, money, editionLabel } from './offers.ts';
import type { StoreResult } from './offers.ts';

/** How long the server has to answer, in ms. */
const TIMEOUT = 10_000;

/** Answers asked for in this page's life, by query string. */
const asked = new Map<string, Promise<Record<string, StoreResult> | null>>();
/** The answers that came, by query string, so a card redrawn shows its price at once. */
const known = new Map<string, Record<string, StoreResult>>();

/** The stores' answers for a query string, or null when they couldn't be had. */
function fetchPrices(query: string, ids: string[]): Promise<Record<string, StoreResult> | null> {
  let p = asked.get(query);
  if (!p) {
    p = fetch('/api/prices?' + query, { signal: AbortSignal.timeout(TIMEOUT) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(json => {
        const results = readReply(json, ids);
        known.set(query, results);
        return results;
      })
      .catch(() => {
        asked.delete(query); // asked again next time
        return null;
      });
    asked.set(query, p);
  }
  return p;
}

/** What a card says on its right: the price, a shimmer, or "Search". */
type Deal = { kind: 'loading' } | { kind: 'search' } | { kind: 'result'; result: StoreResult };

const locale = () => navigator.language || undefined;

/** A card's cover: the store's picture, else the book's, else a cloth spine. */
function coverOf(book: Book, image: string) {
  const src = image || book.cover;
  const spine = html`<span class="wtb-spine" style=${{ '--cloth': cloth(book.isbn) }}></span>`;
  if (!src) return spine;
  const failed = (e: Event) => (e.target as HTMLImageElement).replaceWith(spine);
  return html`<img
    src=${src}
    alt=""
    loading="lazy"
    decoding="async"
    referrerpolicy="no-referrer"
    @error=${failed}
  />`;
}

/** The book found at a store (or being looked for): a card with the cover,
 * the store, the title, the edition and the price. */
function card(book: Book, shop: Shop, deal: Deal) {
  const r = deal.kind === 'result' ? deal.result : null;
  const offer = r?.status === 'found' ? r.offer : null;
  let meta = '';
  let right: Node;
  if (!offer) {
    right = html`<span class="wtb-skel" aria-label="Finding the price"></span>`;
  } else if (offer.price !== null) {
    const stock = offer.price === 0 ? 'Free' : offer.format === 'print' ? 'In stock' : '';
    meta = [editionLabel(offer), stock].filter(Boolean).join(' · ');
    right = html`<span class="wtb-price">${money(offer.price, offer.currency, locale())}</span>
      ${offer.listPrice
        ? html`<s class="wtb-was"
            ><span class="sr">was </span>${money(offer.listPrice, offer.currency, locale())}</s
          >`
        : ''}`;
  } else {
    meta = [editionLabel(offer), 'Out of stock'].filter(Boolean).join(' · ');
    right = html`<span class="wtb-go">View <span aria-hidden="true">↗</span></span>`;
  }
  return html`<li>
    <a
      class=${'wtb-card' + (offer ? '' : ' is-loading')}
      href=${offer?.url ?? shop.search}
      target="_blank"
      rel="noopener noreferrer"
      aria-busy=${offer ? 'false' : 'true'}
    >
      <span class="wtb-cover">${coverOf(book, offer?.image ?? '')}</span>
      <span class="wtb-body">
        <span class="wtb-store">${shop.name}</span>
        <span class="wtb-title">${book.title || 'This book'}</span>
        ${offer
          ? meta && html`<span class="wtb-meta">${meta}</span>`
          : html`<span class="wtb-skel wtb-skel-line"></span>`}
      </span>
      <span class="wtb-deal">${right}</span>
    </a>
  </li>`;
}

/** A store with no price to show: a tile opening its search. */
function tile(shop: Shop, deal: Deal) {
  const missing = deal.kind === 'result' && deal.result.status === 'none';
  const sells = shop.formats.length === 1 ? (shop.formats[0] === 'ebook' ? 'Ebooks' : 'Print') : '';
  const note = missing ? 'Not listed' : sells;
  return html`<li>
    <a class="wtb-tile" href=${shop.search} target="_blank" rel="noopener noreferrer">
      <span class="wtb-tile-name">${shop.name}${note ? html`<small>${note}</small>` : ''}</span>
      <span class="wtb-tile-go">Search <span aria-hidden="true">↗</span></span>
    </a>
  </li>`;
}

/** The cards, More stores, nearby searches and the note, for book. */
function cards(book: Book, prefs: ShoppingPrefs, region: string) {
  const { shown, more } = shopsFor(book, prefs, region);
  const query = priceQuery(book, shown, region);
  const ids = shown.filter(s => s.priced).map(s => s.id);
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const had = known.get(query);
  const [results, setResults] = signal<Record<string, StoreResult> | null | undefined>(
    had ?? (query && online ? undefined : null),
  );
  if (!had && query && online) void fetchPrices(query, ids).then(setResults);
  const dealOf = (shop: Shop): Deal => {
    const all = results();
    if (!shop.priced || all === null) return { kind: 'search' };
    if (all === undefined) return { kind: 'loading' };
    const r = all[shop.id];
    return r && r.status !== 'error' && r.status !== 'unpriced'
      ? { kind: 'result', result: r }
      : { kind: 'search' };
  };
  const near = nearby(book, prefs, shown, region);
  const linkList = (links: { label: string; url: string }[]) =>
    html`<ul class="wtb-links">
      ${links.map(
        l =>
          html`<li>
            <a href=${l.url} target="_blank" rel="noopener noreferrer"
              >${l.label} <span aria-hidden="true">↗</span></a
            >
          </li>`,
      )}
    </ul>`;
  const failed = () =>
    ids.length > 0 &&
    (results() === null || Object.values(results() ?? {}).some(r => r.status === 'error'));
  // The book where it was found (or is being looked for) first, as cards;
  // then every other store as a search, each group in the reader's order.
  const isCard = (d: Deal) =>
    d.kind === 'loading' || (d.kind === 'result' && d.result.status === 'found');
  const found = () => shown.filter(s => isCard(dealOf(s)));
  const searches = () => shown.filter(s => !isCard(dealOf(s)));
  return html`<section class="wtb" aria-label="Where to buy">
    ${() =>
      found().length > 0 &&
      html`<ul class="wtb-list">
        ${found().map(s => card(book, s, dealOf(s)))}
      </ul>`}
    ${() =>
      searches().length > 0 &&
      html`<div class="wtb-searches">
        <h4>${found().length ? 'Or search' : 'Search'}</h4>
        <ul class="wtb-tiles">
          ${searches().map(s => tile(s, dealOf(s)))}
        </ul>
      </div>`}
    ${() =>
      failed() &&
      html`<p class="wtb-status" role="status">
        ${online
          ? 'Couldn’t reach the stores for prices just now.'
          : 'Offline: prices when you’re back online.'}
      </p>`}
    ${more.length
      ? html`<details class="wtb-more">
          <summary>More stores</summary>
          ${linkList(more.map(s => ({ label: s.name, url: s.search })))}
        </details>`
      : ''}
    ${near.length
      ? html`<div class="wtb-near">
          <h4>Nearby</h4>
          ${linkList(near)}
        </div>`
      : ''}
    <p class="wtb-note">${NOTE}</p>
  </section>`;
}

/** Where to buy a Want book: a button revealing its stores. Nothing for any other status. */
export function whereToBuy(
  book: Getter<Book>,
  prefs: Getter<ShoppingPrefs>,
  region: () => string,
): Node {
  const [shown, setShown] = signal(false);
  return html`<div class="buy">
    ${() =>
      book().status === 'want' &&
      html`<button
          type="button"
          class="buy-toggle"
          aria-expanded=${() => String(shown())}
          @click=${() => setShown(!shown())}
        >
          <svg class="buy-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9z" />
            <path d="M9 10V7a3 3 0 0 1 6 0v3" />
          </svg>
          Where to buy
        </button>
        ${() => shown() && cards(book(), prefs(), region())}`}
  </div>`;
}

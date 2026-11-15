/* What cuento's server found at a store for a book (worker/prices.ts makes
 * them, GET /api/prices), and the page reading them back and showing a
 * price. Shared by the Worker and the page.
 *
 *   GET /api/prices?isbn=9780241972359&region=MX&stores=gandhi,apple-books
 *     ─► {isbn, region, results: {gandhi: {status: 'found', offer, checked}, ...}}
 *
 * A result is 'found' (the store has the book, with its price, or with
 * none when it is out of stock), 'none' (the store doesn't list it),
 * 'error' (the store didn't answer) or 'unpriced' (no API for that store).
 * Depends on nothing. */

/** How the store sells this edition. */
export type OfferFormat = 'print' | 'ebook' | 'audio';

/** The book at one store. */
export interface Offer {
  /** The price, in currency; null when the store lists the book but can't sell it now. */
  price: number | null;
  /** The price before a discount, when higher than price. */
  listPrice?: number;
  /** ISO 4217, e.g. 'MXN'. */
  currency: string;
  /** The book's page at the store: https. */
  url: string;
  /** The store's cover: https, or ''. */
  image: string;
  format?: OfferFormat;
  /** The store's own word for the edition, e.g. 'Tapa blanda'. */
  edition?: string;
}

/** What one store answered. */
export type StoreResult =
  | { status: 'found'; offer: Offer; checked: number }
  | { status: 'none'; checked: number }
  | { status: 'error' }
  | { status: 'unpriced' };

/** The server's answer. */
export interface PriceReply {
  isbn: string;
  region: string;
  results: Record<string, StoreResult>;
}

const HTTPS = /^https:\/\/[^\s/]+\//;

/** One offer from JSON, or null when it is not one. */
function readOffer(value: unknown): Offer | null {
  const o = value as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null) return null;
  const price = o.price === null ? null : Number(o.price);
  if (price !== null && !(Number.isFinite(price) && price >= 0)) return null;
  if (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency)) return null;
  if (typeof o.url !== 'string' || !HTTPS.test(o.url)) return null;
  const offer: Offer = {
    price,
    currency: o.currency,
    url: o.url,
    image: typeof o.image === 'string' && HTTPS.test(o.image) ? o.image : '',
  };
  const list = Number(o.listPrice);
  if (price !== null && Number.isFinite(list) && list > price) offer.listPrice = list;
  if (o.format === 'print' || o.format === 'ebook' || o.format === 'audio') offer.format = o.format;
  if (typeof o.edition === 'string' && o.edition) offer.edition = o.edition.slice(0, 40);
  return offer;
}

/** The server's answer from JSON, keeping only the stores asked about and
 * what reads as a result; a store missing or garbled is an 'error'. */
export function readReply(value: unknown, asked: string[]): Record<string, StoreResult> {
  const results = (value as { results?: unknown } | null)?.results;
  const out: Record<string, StoreResult> = {};
  for (const id of asked) {
    const r =
      typeof results === 'object' && results !== null
        ? (results as Record<string, { status?: unknown; offer?: unknown; checked?: unknown }>)[id]
        : undefined;
    const checked = Number(r?.checked) || 0;
    const offer = r?.status === 'found' ? readOffer(r.offer) : null;
    if (offer) out[id] = { status: 'found', offer, checked };
    else if (r?.status === 'none') out[id] = { status: 'none', checked };
    else if (r?.status === 'unpriced') out[id] = { status: 'unpriced' };
    else out[id] = { status: 'error' };
  }
  return out;
}

/** amount in currency, as the reader's locale writes money: 'MX$149.00'. */
export function money(amount: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
  } catch {
    return amount.toFixed(2) + ' ' + currency;
  }
}

/** Words for the edition: the format, or the store's word for it in English when known. */
export function editionLabel(offer: Offer): string {
  const words: Record<string, string> = {
    'tapa blanda': 'Paperback',
    'tapa dura': 'Hardcover',
    físico: 'Print',
    audiolibro: 'Audiobook',
    ebook: 'Ebook',
  };
  const known = offer.edition && words[offer.edition.toLowerCase()];
  if (known) return known;
  if (offer.format === 'ebook') return 'Ebook';
  if (offer.format === 'audio') return 'Audiobook';
  if (offer.format === 'print') return 'Print';
  return '';
}

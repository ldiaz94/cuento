/* Shopping's part of the app: the preferences section of Settings and the
 * Where to buy list in a Want book's details.
 *
 *   Settings:  Format [none|print|ebook] ── Favourite stores (+ suggestions,
 *              custom, up/down/remove) ── City or postcode
 *   Details:   [Where to buy] ── online search links, then nearby ones, and
 *              the disclaimer
 *
 * The preferences live in localStorage under their own key, on this device
 * only: not exported, not synced (the location least of all). Links open in
 * a new tab. Depends on spark, shelf.ts, stores.ts and buy.ts. Leaves out
 * prices, stock and GPS. */
import { signal, html } from './spark/index.js';
import type { Book } from './shelf.ts';
import { readPrefs, regionOf, storeNamed, suggestedStores } from './stores.ts';
import type { ShoppingPrefs } from './stores.ts';
import { whereToBuy, DISCLAIMER } from './buy.ts';

/** The localStorage key the preferences are kept under. */
export const SHOPPING_KEY = 'cuento.shopping';

/** The preferences as kept, or none if there are none or storage is unavailable. */
function load(): ShoppingPrefs {
  try {
    return readPrefs(JSON.parse(localStorage.getItem(SHOPPING_KEY) || 'null'));
  } catch {
    return readPrefs(null);
  }
}

const [prefs, setPrefs] = signal<ShoppingPrefs>(load());

/** Changes some of the preferences and keeps them. */
function change(some: Partial<ShoppingPrefs>) {
  const next = readPrefs({ ...prefs(), ...some });
  setPrefs(next);
  try {
    localStorage.setItem(SHOPPING_KEY, JSON.stringify(next));
  } catch {
    // Not kept this time; still in use until the page closes.
  }
}

/** The reader's region, from the browser's language. */
const region = () => regionOf(navigator.language);

const FORMATS: ['' | 'print' | 'ebook', string][] = [
  ['', 'No preference'],
  ['print', 'Print'],
  ['ebook', 'Ebook'],
];

/** The Shopping section of Settings. */
export function shoppingSection(): Node {
  const [custom, setCustom] = signal('');
  // A favourite is a catalogue id or a name; two are the same store when they resolve to one.
  const has = (name: string) => {
    const store = storeNamed(name, region());
    return prefs().stores.some(f => {
      const other = storeNamed(f, region());
      return store && other ? store.id === other.id : f.toLowerCase() === name.toLowerCase();
    });
  };
  const shown = (fav: string) => storeNamed(fav, region())?.name ?? fav;
  const add = (name: string) => {
    const n = name.trim();
    if (n && !has(n)) change({ stores: [...prefs().stores, n] });
  };
  const remove = (i: number) => change({ stores: prefs().stores.filter((_, j) => j !== i) });
  const move = (i: number, by: number) => {
    const s = [...prefs().stores];
    const j = i + by;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j]!, s[i]!];
    change({ stores: s });
  };
  const addCustom = (e: Event) => {
    e.preventDefault();
    add(custom());
    setCustom('');
  };
  const suggestions = () =>
    suggestedStores(region())
      .filter(s => !has(s.id))
      .map(
        s =>
          html`<button type="button" class="chip" @click=${() => add(s.id)}>+ ${s.name}</button>`,
      );
  return html`<section class="shopping">
    <h3>Shopping</h3>
    <p class="hint">Used by Where to buy on books you want. All optional.</p>
    <div class="shop-format" role="radiogroup" aria-label="Format">
      ${FORMATS.map(
        ([value, label]) =>
          html`<button
            type="button"
            role="radio"
            class=${() => 'chip' + (prefs().format === value ? ' on' : '')}
            aria-checked=${() => String(prefs().format === value)}
            @click=${() => change({ format: value })}
          >
            ${label}
          </button>`,
      )}
    </div>
    <ol class="shop-stores" aria-label="Favourite stores">
      ${() =>
        prefs().stores.map((fav, i) => {
          const name = shown(fav);
          return html`<li>
            <span>${name}</span>
            <button type="button" aria-label=${'Move ' + name + ' up'} @click=${() => move(i, -1)}>
              ↑
            </button>
            <button type="button" aria-label=${'Move ' + name + ' down'} @click=${() => move(i, 1)}>
              ↓
            </button>
            <button type="button" aria-label=${'Remove ' + name} @click=${() => remove(i)}>
              ✕
            </button>
          </li>`;
        })}
    </ol>
    <div class="shop-suggest">${suggestions}</div>
    <form class="shop-custom" @submit=${addCustom}>
      <input
        type="text"
        placeholder="Another store"
        aria-label="Another store"
        maxlength="60"
        .value=${custom}
        @input=${(e: Event) => setCustom((e.target as HTMLInputElement).value)}
      />
      <button type="submit">Add</button>
    </form>
    <label class="shop-location"
      >City or postcode
      <input
        type="text"
        maxlength="200"
        .value=${() => prefs().location}
        @change=${(e: Event) => change({ location: (e.target as HTMLInputElement).value })}
      />
    </label>
    <p class="hint">
      For nearby searches. It stays on this device: it isn’t exported or synced, and cuento never
      looks it up.
    </p>
  </section>`;
}

/** Where to buy a Want book: a button revealing search links. Nothing for any other status. */
export function whereToBuySection(book: () => Book): Node {
  const [shown, setShown] = signal(false);
  const list = () => {
    const links = whereToBuy(book(), prefs(), region());
    const group = (kind: 'online' | 'nearby') =>
      links
        .filter(l => l.kind === kind)
        .map(
          l =>
            html`<li>
              <a href=${l.url} target="_blank" rel="noopener noreferrer"
                >${l.label}${l.format ? ' (' + l.format + ')' : ''}</a
              >
            </li>`,
        );
    return html`<ul class="buy-links">
        ${group('online')} ${group('nearby')}
      </ul>
      <p class="hint">${DISCLAIMER}</p>`;
  };
  return html`<div class="buy">
    ${() =>
      book().status === 'want' &&
      html`<button
          type="button"
          class="buy-toggle"
          aria-expanded=${() => String(shown())}
          @click=${() => setShown(!shown())}
        >
          Where to buy
        </button>
        ${() => shown() && list()}`}
  </div>`;
}

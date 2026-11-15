/* Your library on the page: the books the reader has, to search, sort
 * and open, each with when it was acquired, last read and how often.
 *
 *   tools:  [Search titles, authors, ISBN]
 *           Sort  (Title ↑) (Acquired) (Last read)   (Up next n)
 *   list:   Dune                         Read
 *           Frank Herbert
 *           Acquired 1 Jan 2026 · Last read 20 Jan 2026 · Read 1×
 *           ▸ tapped: the history editor (historyView.ts)
 *
 * Tapping the sort already chosen turns it round. The tools sit with the
 * shelf's own (in the side column when wide) and the list in the main
 * one; app.ts puts them there and switches between Shelf and Library.
 * What is searched and how it is sorted last while the page is open, not
 * after. Depends on spark, shelf.ts, library.ts and historyView.ts.
 * Leaves out the status switch, rating, notes and removal: the shelf's. */
import { signal, computed, html, each } from './spark/index.js';
import type { Getter } from './spark/index.js';
import { lastRead, readCount } from './shelf.ts';
import type { Book, Status } from './shelf.ts';
import { library, shownDate, SORT_KEYS } from './library.ts';
import type { SortKey } from './library.ts';
import { historyEditor } from './historyView.ts';

/** What each order is called on its chip. */
const SORT_LABELS: Record<SortKey, string> = {
  title: 'Title',
  acquired: 'Acquired',
  lastRead: 'Last read',
};
/** Which way an order runs, usual then reversed, for its arrow's label. */
const DIRECTIONS: Record<SortKey, [string, string]> = {
  title: ['A to Z', 'Z to A'],
  acquired: ['newest first', 'oldest first'],
  lastRead: ['newest first', 'oldest first'],
};
/** What a book the reader has is called by status. */
const HAS: Record<Exclude<Status, 'want'>, string> = {
  owned: 'Owned',
  reading: 'Reading',
  read: 'Read',
};

// How the library is looked at, and the book open in it ('' for none).
const [search, setSearch] = signal('');
const [sort, setSort] = signal<SortKey>('title');
const [reverse, setReverse] = signal(false);
const [upNext, setUpNext] = signal(false);
const [open, setOpen] = signal('');

/** The text of the field an event came from. */
const valueOf = (e: Event) => (e.target as HTMLInputElement).value;

/** The library's search, its orders and its Up next filter, over books. */
export function libraryTools(books: Getter<Book[]>) {
  const pick = (key: SortKey) => {
    if (sort() === key) setReverse(r => !r);
    else {
      setSort(key);
      setReverse(false);
    }
  };
  const chip = (key: SortKey) =>
    html`<button
      class=${() => ({ chip: true, on: sort() === key })}
      aria-pressed=${() => String(sort() === key)}
      aria-label=${() =>
        SORT_LABELS[key] + (sort() === key ? ', ' + DIRECTIONS[key][reverse() ? 1 : 0] : '')}
      @click=${() => pick(key)}
    >
      ${SORT_LABELS[key]}
      <span class="dir" aria-hidden="true"
        >${() => (sort() !== key ? '' : (key === 'title') === reverse() ? '↓' : '↑')}</span
      >
    </button>`;
  const nextCount = () => books().filter(b => b.status !== 'want' && b.upNext).length;
  return html`<nav class="tools library-tools">
    <input
      type="search"
      placeholder="Search titles, authors or ISBN"
      aria-label="Search your library"
      .value=${search}
      @input=${(e: Event) => setSearch(valueOf(e))}
    />
    <div class="filters sorts" role="group" aria-label="Sort">
      <span class="label">Sort</span>
      ${SORT_KEYS.map(chip)}
      <button
        class=${() => ({ chip: true, on: upNext() })}
        aria-pressed=${() => String(upNext())}
        @click=${() => setUpNext(on => !on)}
      >
        Up next <span class="n">${nextCount}</span>
      </button>
    </div>
  </nav>`;
}

/** The library's books, each opening its history; change(isbn, edit)
 * applies an edit to a book on the shelf (the caller keeps it). */
export function libraryList(
  books: Getter<Book[]>,
  change: (isbn: string, edit: (b: Book) => Book) => void,
) {
  const listed = computed(() =>
    library(books(), { search: search(), sort: sort(), reverse: reverse(), upNext: upNext() }),
  );
  const volume = (book: Getter<Book>) => {
    const isOpen = () => open() === book().isbn;
    const fact = (label: string, value: () => string) =>
      html`<div>
        <dt>${label}</dt>
        <dd>${value}</dd>
      </div>`;
    return html`<li class=${() => ({ volume: true, open: isOpen() })}>
      <div class="volume-head">
        <button
          class="title"
          aria-expanded=${() => String(isOpen())}
          @click=${() => setOpen(isOpen() ? '' : book().isbn)}
        >
          <strong>${() => book().title}</strong>
          <span class="authors">${() => book().authors.join(', ')}</span>
        </button>
        <span class="has"
          >${() => HAS[book().status as keyof typeof HAS] ?? ''}${() =>
            book().upNext ? ' · Up next' : ''}</span
        >
      </div>
      <dl class="when">
        ${fact('Acquired', () => shownDate(book().acquired))}
        ${fact('Last read', () => shownDate(lastRead(book())))}
        ${fact('Times read', () => String(readCount(book())))}
      </dl>
      ${() =>
        isOpen()
          ? html`<div class="details">
              ${historyEditor(book, edit => change(book().isbn, edit))}
            </div>`
          : null}
    </li>`;
  };
  const empty = () => {
    if (listed().length) return null;
    return books().some(b => b.status !== 'want')
      ? html`<p class="empty">No book matches. Try fewer words, or the whole ISBN.</p>`
      : html`<div class="empty">
          <p><strong>Your library is empty.</strong></p>
          <p>A book you mark Owned, Reading or Read is kept here.</p>
        </div>`;
  };
  return html`${empty}
    <ul class="shelf library">
      ${each(listed, b => b.isbn, volume)}
    </ul>`;
}

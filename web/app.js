/* cuento's page: add a book by its ISBN, and the shelf, filtered and
 * searched, each book's status, dates, rating and notes. Built on spark
 * (spark/: signals, html`` templates, keyed each()).
 *
 *   books (signal) ──► shown (computed: filter + search) ──► each(row)
 *      │                                                      │
 *      └──► effect: save to localStorage   ◄── update(isbn) ──┘
 *
 * Depends on spark, isbn.js, lookup.js and shelf.js. Leaves out scanning
 * (the camera) and working offline, which come next. */
import { signal, computed, effect, batch, html, each, mount } from './spark/index.js';
import { toIsbn13, show } from './isbn.js';
import { lookup } from './lookup.js';
import {
  STATUSES,
  MAX_RATING,
  today,
  newBook,
  withStatus,
  load,
  save,
  exported,
  imported,
  merge,
} from './shelf.js';

/** @typedef {import('./shelf.js').Book} Book */
/** @typedef {import('./shelf.js').Status} Status */
/** @typedef {import('./spark/index.js').Getter<Book>} BookGetter a book on the shelf, live */
/**
 * Where adding a book is: looking it up, or why it can't be added.
 * @typedef {{state: 'looking' | 'invalid' | 'there' | 'missing' | 'offline', isbn?: string}} Adding
 */

/** The text of the field an input event came from.
 * @param {Event} e */
const valueOf = e => /** @type {HTMLInputElement} */ (e.target).value;

/** What each status is called on the page.
 * @type {Record<Status, string>} */
const LABELS = { want: 'Want to read', reading: 'Reading', read: 'Read' };
/** The filters above the shelf: every book, or one status.
 * @type {('all' | Status)[]} */
const FILTERS = ['all', ...STATUSES];

// The shelf, saved whenever it changes.
const [books, setBooks] = signal(load());
const [saveFailed, setSaveFailed] = signal(false);
effect(() => {
  setSaveFailed(!save(books()));
});

// What the shelf shows: a status (or all) and the words searched for.
const [filter, setFilter] = signal(/** @type {'all' | Status} */ ('all'));
const [query, setQuery] = signal('');
// The book whose details are open, by ISBN ('' for none).
const [open, setOpen] = signal('');
// Adding a book: the ISBN typed, and where its lookup is: null (idle), or
// {state: 'looking' | 'invalid' | 'there' | 'missing' | 'offline', isbn}.
const [typed, setTyped] = signal('');
const [adding, setAdding] = signal(/** @type {Adding | null} */ (null));

/** The books the filter and the search let through. */
const shown = computed(() => {
  const words = query().toLowerCase().split(/\s+/).filter(Boolean);
  return books().filter(
    b =>
      (filter() === 'all' || b.status === filter()) &&
      words.every(w => (b.title + ' ' + b.authors.join(' ')).toLowerCase().includes(w)),
  );
});
/** Books finished this calendar year: what cuento counts. */
const readThisYear = computed(
  () =>
    books().filter(b => b.status === 'read' && b.finished.startsWith(today().slice(0, 4))).length,
);

/** Changes the book with isbn by change(book) -> book.
 * @param {string} isbn
 * @param {(book: Book) => Book} change */
function update(isbn, change) {
  setBooks(bs => bs.map(b => (b.isbn === isbn ? change(b) : b)));
}
/** Puts book first on the shelf and shows it.
 * @param {Book} book */
function shelve(book) {
  batch(() => {
    setBooks(bs => [book, ...bs]);
    setTyped('');
    setAdding(null);
    setFilter('all');
    setQuery('');
  });
}

/** Looks up the typed ISBN and adds its book, or says why it can't. */
async function add() {
  const isbn = toIsbn13(typed());
  if (!isbn) return setAdding({ state: 'invalid' });
  if (books().some(b => b.isbn === isbn)) return setAdding({ state: 'there', isbn });
  setAdding({ state: 'looking', isbn });
  try {
    const found = await lookup(isbn);
    if (adding()?.isbn !== isbn) return; // the reader moved on meanwhile
    if (found) shelve(newBook(isbn, found));
    else setAdding({ state: 'missing', isbn });
  } catch {
    setAdding({ state: 'offline', isbn });
  }
}

/** The line under the ISBN field saying how adding is going. */
function addingNote() {
  const a = adding();
  if (!a) return null;
  const isbn = a.isbn || '';
  if (a.state === 'looking') return html`<p class="note">Looking up ${show(isbn)}…</p>`;
  if (a.state === 'invalid')
    return html`<p class="note bad">That isn't an ISBN: check the digits.</p>`;
  if (a.state === 'there') return html`<p class="note">That book is on your shelf already.</p>`;
  if (a.state === 'offline')
    return html`<p class="note bad">
      Couldn't reach the book services.
      <button type="button" @click=${add}>Try again</button>
    </p>`;
  return byHand(isbn);
}

/** For a book neither service knows: its title and author, by hand.
 * @param {string} isbn */
function byHand(isbn) {
  const [title, setTitle] = signal('');
  const [author, setAuthor] = signal('');
  const keep = (/** @type {Event} */ e) => {
    e.preventDefault();
    if (title().trim())
      shelve(
        newBook(isbn, { title: title().trim(), authors: author().trim() ? [author().trim()] : [] }),
      );
  };
  return html`<form class="by-hand" @submit=${keep}>
    <p class="note">No record of ${show(isbn)}. Add it by hand:</p>
    <input
      placeholder="Title"
      required
      .value=${title}
      @input=${(/** @type {Event} */ e) => setTitle(valueOf(e))}
    />
    <input
      placeholder="Author"
      .value=${author}
      @input=${(/** @type {Event} */ e) => setAuthor(valueOf(e))}
    />
    <button>Add</button>
  </form>`;
}

/** The ISBN field and its note. */
function addBar() {
  const submit = (/** @type {Event} */ e) => {
    e.preventDefault();
    add();
  };
  return html`<section class="add">
    <form @submit=${submit}>
      <input
        inputmode="numeric"
        autocomplete="off"
        placeholder="ISBN, e.g. 978-0-306-40615-7"
        aria-label="ISBN"
        .value=${typed}
        @input=${(/** @type {Event} */ e) => setTyped(valueOf(e))}
      />
      <button>Add</button>
    </form>
    ${addingNote}
  </section>`;
}

/** The filters by status and the search field. */
function toolbar() {
  const count = (/** @type {'all' | Status} */ f) => () =>
    (f === 'all' ? books() : books().filter(b => b.status === f)).length;
  return html`<nav class="tools">
    <div class="filters" role="group" aria-label="Show">
      ${FILTERS.map(
        f =>
          html`<button
            class=${() => ({ chip: true, on: filter() === f })}
            aria-pressed=${() => String(filter() === f)}
            @click=${() => setFilter(f)}
          >
            ${f === 'all' ? 'All' : LABELS[f]} <span class="n">${count(f)}</span>
          </button>`,
      )}
    </div>
    <input
      type="search"
      placeholder="Search titles and authors"
      aria-label="Search"
      .value=${query}
      @input=${(/** @type {Event} */ e) => setQuery(valueOf(e))}
    />
  </nav>`;
}

/** A book's cover, or a coloured spine with its title when it has none.
 * @param {BookGetter} book */
function cover(book) {
  return () =>
    book().cover
      ? html`<img class="cover" src=${book().cover} alt="" loading="lazy" />`
      : html`<div class="cover spine" style=${{ '--hue': hue(book().isbn) }}>
          ${book().title.slice(0, 40)}
        </div>`;
}
/** A colour for a spine, the same every time for the same book.
 * @param {string} isbn */
function hue(isbn) {
  return String(Number(isbn.slice(-4)) % 360);
}

/** Stars to rate a read book; the one given again clears the rating.
 * @param {BookGetter} book */
function stars(book) {
  const rate = (/** @type {number} */ n) =>
    update(book().isbn, b => ({ ...b, rating: b.rating === n ? 0 : n }));
  return html`<span class="stars" role="group" aria-label="Rating">
    ${Array.from(
      { length: MAX_RATING },
      (_, i) =>
        html`<button
          class=${() => ({ star: true, on: book().rating > i })}
          aria-label=${i + 1 + ' of ' + MAX_RATING}
          @click=${() => rate(i + 1)}
        >
          ★
        </button>`,
    )}
  </span>`;
}

/** A book's dates, notes and removal, shown when it is open.
 * @param {BookGetter} book */
function details(book) {
  const field = (
    /** @type {'added' | 'started' | 'finished'} */ key,
    /** @type {string} */ label,
  ) =>
    html`<label
      >${label}
      <input
        type="date"
        .value=${() => book()[key]}
        @change=${(/** @type {Event} */ e) =>
          update(book().isbn, b => ({ ...b, [key]: valueOf(e) }))}
    /></label>`;
  const remove = () => {
    if (confirm('Take “' + book().title + '” off your shelf?'))
      batch(() => {
        setOpen('');
        setBooks(bs => bs.filter(b => b.isbn !== book().isbn));
      });
  };
  return html`<div class="details">
    <div class="dates">
      ${field('added', 'Added')} ${field('started', 'Started')} ${field('finished', 'Finished')}
    </div>
    <textarea
      placeholder="Notes"
      rows="3"
      .value=${() => book().notes}
      @change=${(/** @type {Event} */ e) => update(book().isbn, b => ({ ...b, notes: valueOf(e) }))}
    ></textarea>
    <p class="meta">
      ISBN
      ${show(book().isbn)}${() => (book().pages ? ' · ' + book().pages + ' pages' : '')}${() =>
        book().published ? ' · ' + book().published : ''}
    </p>
    <button class="remove" @click=${remove}>Remove from shelf</button>
  </div>`;
}

/** One book on the shelf.
 * @param {BookGetter} book */
function row(book) {
  const isOpen = () => open() === book().isbn;
  const move = (/** @type {Event} */ e) =>
    update(book().isbn, b => withStatus(b, /** @type {Status} */ (valueOf(e))));
  return html`<li class=${() => ({ book: true, open: isOpen() })}>
    ${cover(book)}
    <div class="body">
      <button
        class="title"
        aria-expanded=${() => String(isOpen())}
        @click=${() => setOpen(isOpen() ? '' : book().isbn)}
      >
        <strong>${() => book().title}</strong>
        <span class="authors">${() => book().authors.join(', ')}</span>
      </button>
      <div class="status">
        <select aria-label="Status" .value=${() => book().status} @change=${move}>
          ${STATUSES.map(s => html`<option value=${s}>${LABELS[s]}</option>`)}
        </select>
        ${() => (book().status === 'read' ? stars(book) : null)}
      </div>
      ${() => (isOpen() ? details(book) : null)}
    </div>
  </li>`;
}

/** What the shelf says when it shows nothing. */
function empty() {
  if (shown().length) return null;
  return html`<p class="empty">
    ${books().length
      ? 'No book matches.'
      : 'Your shelf is empty. Add a book by its ISBN, on the back cover above the barcode.'}
  </p>`;
}

/** Saving the shelf to a file, and bringing one back. */
function backup() {
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([exported(books())], { type: 'application/json' }));
    a.download = 'cuento-' + today() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const restore = async (/** @type {Event} */ e) => {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const incoming = imported(await file.text());
      setBooks(bs => merge(bs, incoming));
      alert(incoming.length + ' books imported.');
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };
  return html`<footer>
    ${() =>
      saveFailed()
        ? html`<p class="note bad">This browser isn't keeping your shelf: export it.</p>`
        : null}
    <button @click=${download}>Export</button>
    <label class="button"
      >Import<input type="file" accept="application/json,.json" hidden @change=${restore}
    /></label>
    <p class="hint">
      Your shelf lives in this browser only. Export it now and then to keep a copy.
    </p>
  </footer>`;
}

mount(
  /** @type {HTMLElement} */ (document.getElementById('app')),
  html`<header>
      <h1>cuento</h1>
      <p class="count">${() => readThisYear()} read this year</p>
    </header>
    ${addBar()} ${toolbar()} ${empty}
    <ul class="shelf">
      ${each(shown, b => b.isbn, row)}
    </ul>
    ${backup()}`,
);

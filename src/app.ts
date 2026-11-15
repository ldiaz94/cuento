/* cuento's page: add a book by its ISBN, and the shelf, filtered and
 * searched (Up next among the filters), each book's status, Up next or
 * Read again, rating, notes and history (historyView.ts); or, switched
 * to, Your library (libraryView.ts). Built on spark (spark/: signals,
 * html`` templates, keyed each()).
 *
 *   books (signal) ──► shown (computed: filter + search) ──► each(row)
 *      │                                                      │
 *      └──► effect: save to localStorage   ◄── update(isbn) ──┘
 *
 * Depends on spark, isbn.ts, lookup.ts, scan.ts, shelf.ts, historyView.ts and
 * libraryView.ts. Working
 * offline is the service worker's (public/sw.js), not the page's. */
import {
  signal,
  computed,
  effect,
  batch,
  untrack,
  onCleanup,
  html,
  each,
  mount,
} from './spark/index.js';
import type { Getter } from './spark/index.js';
import { toIsbn13, show } from './isbn.ts';
import { lookup, search } from './lookup.ts';
import type { Hit } from './lookup.ts';
import { scan, canScan, ScanError } from './scan.ts';
import type { Reason } from './scan.ts';
import * as updates from './updates.ts';
import { startSync, code, enable } from './sync.ts';
import { syncSection } from './syncView.ts';
import { accountSection } from './accountView.ts';
import { follow } from './account.ts';
import { remindersSection } from './remindersView.ts';
import { shoppingSection, whereToBuySection } from './shoppingView.ts';
import { review } from './review.ts';
import { historyEditor } from './historyView.ts';
import { libraryTools, libraryList } from './libraryView.ts';
import { tilde, cloth } from './tilde.ts';
import type { Found, Version } from './updates.ts';
import {
  STATUSES,
  MAX_RATING,
  today,
  newBook,
  withStatus,
  readingsInYear,
  load,
  save,
  exported,
  imported,
  merge,
} from './shelf.ts';
import type { Book, Status } from './shelf.ts';

/** A book on the shelf, live: its row reads it through this. */
type BookGetter = Getter<Book>;
/** Where adding a book is: looking it up, or why it can't be added. */
interface Adding {
  state: 'looking' | 'invalid' | 'there' | 'missing' | 'offline' | 'searching' | 'found';
  isbn?: string;
  /** The words searched for, when what was typed is not an ISBN. */
  words?: string;
  /** The books the search found. */
  hits?: Hit[];
}

/** The text of the field an input event came from. */
const valueOf = (e: Event) => (e.target as HTMLInputElement).value;

/** What each status is called on the page. */
const LABELS: Record<Status, string> = {
  want: 'Want to read',
  owned: 'Owned',
  reading: 'Reading',
  read: 'Read',
};
/** What each status is called on a book's switch, where room is short. */
const SHORT: Record<Status, string> = {
  want: 'Want',
  owned: 'Owned',
  reading: 'Reading',
  read: 'Read',
};
/** What the shelf shows: every book, one status, the books marked Up
 * next, or the books finished in a year (History). */
type Filter = 'all' | Status | 'next' | number;
/** The filters above the shelf: by status, then Up next. */
const FILTERS: Filter[] = ['all', ...STATUSES, 'next'];
/** What each filter is called on its chip. */
const filterLabel = (f: Filter) =>
  f === 'all' ? 'All' : f === 'next' ? 'Up next' : LABELS[f as Status];

// The shelf, saved whenever it changes.
const [books, setBooks] = signal(load());
const [saveFailed, setSaveFailed] = signal(false);
effect(() => {
  setSaveFailed(!save(books()));
});
// What the shelf shows: a status (or all) and the words searched for.
const [filter, setFilter] = signal<Filter>('all');
const [query, setQuery] = signal('');
// Which the page shows: the shelf, or Your library.
const [view, setView] = signal<'shelf' | 'library'>('shelf');
// The book whose details are open, by ISBN ('' for none).
const [open, setOpen] = signal('');
// Adding a book: the ISBN typed, and where its lookup is: null (idle), or
// {state: 'looking' | 'invalid' | 'there' | 'missing' | 'offline', isbn}.
const [typed, setTyped] = signal('');
const [adding, setAdding] = signal<Adding | null>(null);

/** Whether book passes filter f. */
function passes(book: Book, f: Filter) {
  if (typeof f === 'number') return finishedIn(book, f);
  if (f === 'next') return book.upNext;
  return f === 'all' || book.status === f;
}
/** Whether book has a completed reading in year. */
const finishedIn = (book: Book, year: number) => readingsInYear(book, year).length > 0;
/** The latest completion in year, for sorting History. */
const finishedOn = (book: Book, year: number) => readingsInYear(book, year).at(-1)?.finished ?? '';

/** The books the filter and the search let through; a year's books in
 * the order they were finished, latest first. */
const shown = computed(() => {
  const words = query().toLowerCase().split(/\s+/).filter(Boolean);
  const found = books().filter(
    b =>
      passes(b, filter()) &&
      words.every(w => (b.title + ' ' + b.authors.join(' ')).toLowerCase().includes(w)),
  );
  const year = filter();
  return typeof year === 'number'
    ? found.sort((a, b) => finishedOn(b, year).localeCompare(finishedOn(a, year)))
    : found;
});
/** This year, as a number. */
const thisYear = () => Number(today().slice(0, 4));
/** Books finished this calendar year: what cuento counts. */
const readThisYear = computed(() =>
  books().reduce((n, b) => n + readingsInYear(b, thisYear()).length, 0),
);
/** The years books were finished in, latest first: the History. */
const years = computed(() =>
  [
    ...new Set(
      books().flatMap(b =>
        b.readings.filter(r => r.finished).map(r => Number(r.finished.slice(0, 4))),
      ),
    ),
  ].sort((a, b) => b - a),
);

/** Where reading goals are kept. */
const GOALS = 'cuento.goals';
/** Reading goals by year (books to finish), kept on this device and synced. */
const [goals, setGoals] = signal<Record<string, number>>(loadGoals());
effect(() => {
  try {
    localStorage.setItem(GOALS, JSON.stringify(goals()));
  } catch {
    // goals are a nicety: a browser that keeps nothing just forgets them
  }
});
/** The goals kept on this device ({} when none, or unreadable). */
function loadGoals(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(GOALS) || '{}');
  } catch {
    return {};
  }
}
// And, once sync is on, books and goals are shared with the reader's
// other devices.
startSync(books, setBooks, goals, setGoals);
follow(); // signed in: stay on the account's shelf
/** This year's goal (0: none). */
const goal = () => goals()[thisYear()] ?? 0;

/** Books being read now. */
const readingNow = computed(() => books().filter(b => b.status === 'reading').length);

/** Whether the reader asked their system for less motion. */
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Makes change, letting the books glide from where they were to where
 * they land (a view transition, where the browser has them). */
function glide(change: () => void) {
  if (!document.startViewTransition || still()) return change();
  document.startViewTransition(change);
}

/** Cheers a book just read: its cover jumps, and sparks fly from from. */
function cheer(cover: Element | null | undefined, from: Element) {
  if (still()) return;
  cover?.animate(
    [{ transform: 'none' }, { transform: 'rotate(-7deg) scale(1.1)' }, { transform: 'none' }],
    { duration: 550, easing: 'cubic-bezier(.3,1.6,.5,1)' },
  );
  const { left, top, width, height } = from.getBoundingClientRect();
  for (let i = 0; i < SPARKS; i++) {
    const spark = document.createElement('span');
    spark.className = 'spark';
    spark.style.left = left + width / 2 + 'px';
    spark.style.top = top + height / 2 + 'px';
    document.body.append(spark);
    const angle = (i / SPARKS) * 2 * Math.PI + Math.random() * 0.5;
    const far = 36 + Math.random() * 30;
    const to = `translate(${Math.cos(angle) * far}px, ${Math.sin(angle) * far}px) scale(0.3)`;
    spark
      .animate(
        [
          { transform: 'scale(1)', opacity: 1 },
          { transform: to, opacity: 0 },
        ],
        {
          duration: 600 + Math.random() * 250,
          easing: 'cubic-bezier(.15,.7,.3,1)',
        },
      )
      .finished.then(() => spark.remove());
  }
}
/** How many sparks a cheer throws. */
const SPARKS = 12;

/** Changes the book with isbn by change(book) -> book. */
function update(isbn: string, change: (book: Book) => Book) {
  setBooks(bs => bs.map(b => (b.isbn === isbn ? change(b) : b)));
}
/** Puts book first on the shelf and shows it. */
function shelve(book: Book) {
  // The field clears at once, ready for the next ISBN; the shelf glides a
  // frame later (a view transition runs its change then).
  batch(() => {
    setTyped('');
    setAdding(null);
  });
  glide(() =>
    batch(() => {
      setBooks(bs => [book, ...bs]);
      setFilter('all');
      setQuery('');
    }),
  );
}

/** Whether text is words to search for rather than an ISBN (right or
 * wrong): anything but digits, spaces, hyphens and a final X. */
const isWords = (text: string) => /[^\d\s-]/.test(text.trim().replace(/x$/i, ''));

/** Looks up the typed ISBN and adds its book, or says why it can't; words
 * that are no ISBN are searched for instead. */
async function add() {
  const isbn = toIsbn13(typed());
  if (!isbn && isWords(typed())) return find(typed().trim());
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

/** Searches titles and authors for words, and lists the books found. */
async function find(words: string) {
  setAdding({ state: 'searching', words });
  try {
    const hits = await search(words);
    if (adding()?.words !== words) return; // the reader moved on meanwhile
    setAdding({ state: 'found', words, hits });
  } catch {
    setAdding({ state: 'offline', words });
  }
}

/** The books a search found, to pick one from; one on the shelf already
 * says so. */
function hitList(words: string, hits: Hit[]) {
  if (!hits.length)
    return html`<p class="note">No books found for “${words}”. Try fewer words, or the ISBN.</p>`;
  const on = (h: Hit) => books().some(b => b.isbn === h.isbn);
  return html`<ul class="hits" aria-label="Books found">
    ${hits.map(
      h =>
        html`<li>
          <button class="hit" .disabled=${on(h)} @click=${() => shelve(newBook(h.isbn, h))}>
            ${h.cover
              ? html`<img src=${h.cover} alt="" loading="lazy" />`
              : html`<span class="nocover" style=${{ '--cloth': cloth(h.isbn) }}></span>`}
            <span class="what">
              <strong>${h.title}</strong>
              <span>${[h.authors?.join(', '), h.published].filter(Boolean).join(' · ')}</span>
            </span>
            <span class="plus" aria-hidden="true">${on(h) ? '✓' : '+'}</span>
          </button>
        </li>`,
    )}
  </ul>`;
}

/** The line under the ISBN field saying how adding is going. */
function addingNote() {
  const a = adding();
  if (!a) return null;
  const isbn = a.isbn || '';
  if (a.state === 'searching') return html`<p class="note looking">Searching for “${a.words}”</p>`;
  if (a.state === 'found') return hitList(a.words || '', a.hits || []);
  if (a.state === 'looking') return html`<p class="note looking">Looking up ${show(isbn)}</p>`;
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

/** For a book neither service knows: its title and author, by hand. */
function byHand(isbn: string) {
  const [title, setTitle] = signal('');
  const [author, setAuthor] = signal('');
  const keep = (e: Event) => {
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
      @input=${(e: Event) => setTitle(valueOf(e))}
    />
    <input placeholder="Author" .value=${author} @input=${(e: Event) => setAuthor(valueOf(e))} />
    <button>Add</button>
  </form>`;
}

/** The ISBN field and its note. */
function addBar() {
  const submit = (e: Event) => {
    e.preventDefault();
    add();
  };
  return html`<section class="add">
    <form @submit=${submit}>
      <input
        enterkeyhint="search"
        autocomplete="off"
        placeholder="ISBN, title or author"
        aria-label="ISBN, title or author"
        .value=${typed}
        @input=${(e: Event) => setTyped(valueOf(e))}
      />
      <button>${() => (isWords(typed()) ? 'Search' : 'Add book')}</button>
      ${canScan()
        ? html`<button
            type="button"
            class="scan"
            aria-label="Scan a barcode"
            @click=${() => setScanning(true)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M7 9v6M10 9v6M13 9v6M16 9v6" />
            </svg>
            <span class="label">Scan</span>
          </button>`
        : null}
    </form>
    ${addingNote}
  </section>`;
}

/** The filters by status and the search field. */
function toolbar() {
  const count = (f: Filter) => () => books().filter(b => passes(b, f)).length;
  const chip = (f: Filter, label: string) =>
    html`<button
      class=${() => ({ chip: true, on: filter() === f })}
      aria-pressed=${() => String(filter() === f)}
      @click=${() => glide(() => setFilter(f))}
    >
      ${label} <span class="n">${count(f)}</span>
    </button>`;
  return html`<nav class="tools">
    <div class="filters" role="group" aria-label="Show">
      ${FILTERS.map(f => chip(f, filterLabel(f)))}
    </div>
    ${() =>
      years().length
        ? html`<div class="filters years" role="group" aria-label="History">
            <span class="label">History</span>
            ${years().map(y => chip(y, String(y)))}
          </div>`
        : null}
    <input
      type="search"
      placeholder="Search titles and authors"
      aria-label="Search"
      .value=${query}
      @input=${(e: Event) => setQuery(valueOf(e))}
    />
  </nav>`;
}

/** The switch between the shelf and Your library. */
function viewSwitch() {
  const pick = (v: 'shelf' | 'library', label: string) =>
    html`<button aria-pressed=${() => String(view() === v)} @click=${() => glide(() => setView(v))}>
      ${label}
    </button>`;
  return html`<div class="views" role="group" aria-label="View" data-at=${view}>
    ${pick('shelf', 'Shelf')} ${pick('library', 'Library')}
  </div>`;
}

/** A book's cover, or a coloured spine with its title when it has none. */
function cover(book: BookGetter) {
  return () =>
    book().cover
      ? html`<img class="cover" src=${book().cover} alt="" loading="lazy" />`
      : html`<div class="cover spine" style=${{ '--cloth': cloth(book().isbn) }}>
          <span>${book().title.slice(0, 48)}</span>
        </div>`;
}
/** Stars to rate a read book; the one given again clears the rating. */
function stars(book: BookGetter) {
  const rate = (n: number) => update(book().isbn, b => ({ ...b, rating: b.rating === n ? 0 : n }));
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

/** A book's dates, history, notes and removal, shown when it is open. */
function details(book: BookGetter) {
  const remove = () => {
    if (confirm('Take “' + book().title + '” off your shelf?'))
      glide(() =>
        batch(() => {
          setOpen('');
          setBooks(bs => bs.filter(b => b.isbn !== book().isbn));
        }),
      );
  };
  return html`<div class="details">
    <div class="dates">
      <label
        >Added
        <input
          type="date"
          .value=${() => book().added}
          @change=${(e: Event) =>
            valueOf(e) && update(book().isbn, b => ({ ...b, added: valueOf(e) }))}
      /></label>
    </div>
    ${historyEditor(book, edit => update(book().isbn, edit))}
    <textarea
      placeholder="Notes"
      rows="3"
      .value=${() => book().notes}
      @change=${(e: Event) => update(book().isbn, b => ({ ...b, notes: valueOf(e) }))}
    ></textarea>
    ${whereToBuySection(book)}
    <p class="meta">
      ISBN
      ${show(book().isbn)}${() => (book().pages ? ' · ' + book().pages + ' pages' : '')}${() =>
        book().published ? ' · ' + book().published : ''}
    </p>
    <button class="remove" @click=${remove}>Remove from shelf</button>
  </div>`;
}

/** Marks a Want or Owned book Up next, or unmarks it. */
function upNextToggle(book: BookGetter) {
  const toggle = () => {
    const change = () => update(book().isbn, b => ({ ...b, upNext: !b.upNext }));
    if (filter() === 'next') glide(change);
    else change();
  };
  return html`<button class="next" aria-pressed=${() => String(book().upNext)} @click=${toggle}>
    <span aria-hidden="true">${() => (book().upNext ? '✓' : '+')}</span> Up next
  </button>`;
}

/** One book on the shelf. */
function row(book: BookGetter) {
  const isOpen = () => open() === book().isbn;
  const move = (s: Status, e: Event) => {
    if (s === book().status) return;
    const button = e.currentTarget as HTMLElement;
    // It glides only when it leaves the shelf shown: under All it stays put.
    const change = () => update(book().isbn, b => withStatus(b, s));
    if (filter() === 'all') change();
    else glide(change);
    if (s === 'read') cheer(button.closest('.book')?.querySelector('.cover'), button);
  };
  // Its own name in view transitions, so it glides as itself.
  return html`<li
    class=${() => ({ book: true, open: isOpen() })}
    style=${{ 'view-transition-name': 'book-' + book().isbn }}
  >
    ${cover(book)}
    <div class="body">
      <button
        class="title"
        aria-expanded=${() => String(isOpen())}
        @click=${() => glide(() => setOpen(isOpen() ? '' : book().isbn))}
      >
        <strong>${() => book().title}</strong>
        <span class="authors">${() => book().authors.join(', ')}</span>
      </button>
      <div class="status">
        <div class="seg" role="radiogroup" aria-label="Status" data-at=${() => book().status}>
          ${STATUSES.map(
            s =>
              html`<button
                role="radio"
                data-status=${s}
                aria-checked=${() => String(book().status === s)}
                @click=${(e: Event) => move(s, e)}
              >
                ${SHORT[s]}
              </button>`,
          )}
        </div>
        ${() => (book().status === 'read' ? stars(book) : null)}
        ${() =>
          book().status === 'read'
            ? html`<button class="again" @click=${(e: Event) => move('reading', e)}>
                Read again
              </button>`
            : book().status === 'want' || book().status === 'owned'
              ? upNextToggle(book)
              : null}
      </div>
      ${() => (isOpen() ? details(book) : null)}
    </div>
  </li>`;
}

/** At the top of a year's shelf (History): the year, what was read, and
 * its review. */
function yearCard() {
  const year = filter();
  if (typeof year !== 'number') return null;
  const read = books().filter(b => finishedIn(b, year));
  const pages = read.reduce((sum, b) => sum + (b.pages || 0), 0);
  const target = goals()[year];
  return html`<div class="year-card">
    <p class="year">${year}</p>
    <p class="what">
      ${read.length}
      ${read.length === 1 ? 'book' : 'books'}${pages
        ? ' · ' + pages.toLocaleString() + ' pages'
        : ''}${target ? ' · goal ' + target : ''}
    </p>
    <button class="review-button" @click=${() => setReviewing(year)}>
      Your ${year} in books <span aria-hidden="true">→</span>
    </button>
  </div>`;
}

/** The year whose review is showing (0: none). */
const [reviewing, setReviewing] = signal(0);

/** The year to offer a review of from the top: this one in December, the
 * last one in January (0: none, or nothing read). */
function reviewDue() {
  const month = Number(today().slice(5, 7));
  const year = month === 12 ? thisYear() : month === 1 ? thisYear() - 1 : 0;
  return year && books().some(b => finishedIn(b, year)) ? year : 0;
}

/** What the shelf says when it shows nothing. */
function empty() {
  if (shown().length) return null;
  return books().length
    ? html`<p class="empty">No book matches. Try fewer words, or another shelf.</p>`
    : html`<div class="empty">
        ${tilde()}
        <p><strong>Your shelf is empty.</strong></p>
        <p>Scan a book's barcode, or type its ISBN: the number above the barcode.</p>
      </div>`;
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
  const restore = async (e: Event) => {
    const input = e.target as HTMLInputElement;
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
  return html`<div class="backup">
    <button @click=${download}>Export</button>
    <label class="button"
      >Import<input type="file" accept="application/json,.json" hidden @change=${restore}
    /></label>
  </div>`;
}

/** A warning when this browser won't keep the shelf. */
function saveWarning() {
  return saveFailed()
    ? html`<p class="note bad">This browser isn't keeping your shelf: export it in Settings.</p>`
    : null;
}

// Settings: whether the sheet is open, and what looking for updates found.
const [settingsOpen, setSettingsOpen] = signal(false);
const [looked, setLooked] = signal<Found | 'looking' | ''>('');

/** Whether cuento runs installed, from the Home Screen or as an app. */
const installed = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true;

/** The settings sheet: the shelf's backup, the app's version and
 * updates, and where cuento comes from. */
function settings() {
  if (!settingsOpen()) return null;
  const close = () => setSettingsOpen(false);
  const escape = (e: KeyboardEvent) => e.key === 'Escape' && close();
  document.addEventListener('keydown', escape);
  onCleanup(() => document.removeEventListener('keydown', escape));
  const [version, setVersion] = signal<Version | null>(null);
  updates.current().then(setVersion);
  setLooked('');
  const look = async () => {
    setLooked('looking');
    setLooked(await updates.check());
  };
  const status = () => {
    if (updates.newer())
      return html`<p class="note">
        A new version is ready. <button type="button" @click=${updates.update}>Update</button>
      </p>`;
    const l = looked();
    if (l === 'looking') return html`<p class="note looking">Looking for a new version</p>`;
    if (l === 'latest') return html`<p class="note">You have the latest version.</p>`;
    if (l === 'unknown') return html`<p class="note bad">Couldn't look: are you online?</p>`;
    return null;
  };
  return html`<div class="sheet" @click=${(e: Event) => e.target === e.currentTarget && close()}>
    <div class="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header>
        <h2 id="settings-title">Settings</h2>
        <button class="done" @click=${close}>Done</button>
      </header>
      <section>
        <h3>Your shelf</h3>
        <p class="hint">
          ${() => books().length}
          ${() => (books().length === 1 ? 'book' : 'books')}${() =>
            code() ? ', kept in this browser and synced.' : ', kept in this browser only.'}
          Export now and then to keep a copy; import one to bring it back.
        </p>
        ${backup()}
      </section>
      ${accountSection()} ${syncSection()} ${remindersSection()} ${shoppingSection()}
      <section>
        <h3>Goal</h3>
        <label class="goal-field"
          >Books to read in ${thisYear()}
          <input
            type="number"
            inputmode="numeric"
            min="0"
            max="999"
            placeholder="No goal"
            .value=${() => (goal() ? String(goal()) : '')}
            @change=${(e: Event) => {
              const n = Math.max(0, Math.min(999, Math.round(Number(valueOf(e)) || 0)));
              setGoals(g => ({ ...g, [thisYear()]: n }));
            }}
        /></label>
      </section>
      <section>
        <h3>App</h3>
        <dl class="facts">
          <dt>Version</dt>
          <dd>${() => version()?.version ?? 'unknown'}</dd>
          <dt>Built</dt>
          <dd>${() => version()?.built ?? 'unknown'}</dd>
          <dt>Installed</dt>
          <dd>${installed() ? 'Yes' : 'No: Add to Home Screen to install it'}</dd>
        </dl>
        <button @click=${look} .disabled=${() => looked() === 'looking'}>Check for updates</button>
        ${status}
      </section>
      <section>
        <h3>About</h3>
        <p class="hint">
          cuento is free software (ISC), built on spark.
          <a href="https://github.com/ldiaz94/cuento" target="_blank" rel="noopener"
            >Source on GitHub</a
          >
        </p>
      </section>
    </div>
  </div>`;
}

/** Where cuento lives now. */
const HOME = 'cuento.page';

/** On cuento's old address, a bar offering to take the shelf to the new
 * one: sync carries it (turned on here first if it is off). */
function movedBar() {
  if (!location.hostname.endsWith('.workers.dev')) return null;
  const move = async () => {
    try {
      if (!code()) await enable();
      location.href = 'https://' + HOME + '/app/#sync=' + code();
    } catch {
      alert('Couldn’t reach cuento to move your shelf: are you online?');
    }
  };
  return html`<div class="toast moved" role="status">
    <span>cuento now lives at ${HOME}.</span>
    <button @click=${move}>Take my shelf there</button>
  </div>`;
}

/** The bar that says a new version is ready, with Update. */
function updateBar() {
  return updates.newer() && !settingsOpen()
    ? html`<div class="toast" role="status">
        <span>A new version of cuento is ready.</span>
        <button @click=${updates.update}>Update</button>
      </div>`
    : null;
}

/** The top: Tilde, the name, and what cuento counts. */
function hero() {
  const year = today().slice(0, 4);
  return html`<header class="hero">
    <div class="brand">
      <img src="icon.svg" alt="" width="44" height="44" />
      <h1>cuento</h1>
      <button class="gear" aria-label="Settings" @click=${() => setSettingsOpen(true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
          />
        </svg>
      </button>
    </div>
    <p class="count">
      ${() => html`<span class="big">${readThisYear()}</span>` /* new each time: it ticks in */}
      <span class="what"
        >${() => (goal() ? 'of ' + goal() + ' ' : '')}${() =>
          (goal() || readThisYear()) === 1 ? 'book' : 'books'}
        read in ${year}</span
      >
    </p>
    ${() =>
      goal()
        ? html`<div
            class="goal"
            role="progressbar"
            aria-label="Goal"
            aria-valuemin="0"
            aria-valuemax=${goal()}
            aria-valuenow=${readThisYear()}
          >
            <span style=${{ '--done': Math.min(1, readThisYear() / goal()) }}></span>
          </div>`
        : null}
    ${() => {
      const due = reviewDue();
      return due
        ? html`<button class="review-button" @click=${() => setReviewing(due)}>
            Your ${due} in books <span aria-hidden="true">→</span>
          </button>`
        : null;
    }}
    <p class="sub">${() => books().length} on the shelf · ${readingNow} reading now</p>
  </header>`;
}

// Scanning: whether the camera sheet is open, and what went wrong in it.
const [scanning, setScanning] = signal(false);
const [scanTrouble, setScanTrouble] = signal('');

/** What to tell the reader when the camera can't be had, by reason. */
const TROUBLE: Record<Reason, string> = {
  denied: 'cuento may not use the camera. Allow it in your browser’s settings, or type the ISBN.',
  none: 'No camera here. Type the ISBN instead.',
  insecure: 'The camera only works on the https site.',
  other: 'The camera wouldn’t start. Type the ISBN instead.',
};

/** The camera sheet: the camera, a frame to aim with, and Cancel. It
 * scans while open, and adds the book whose barcode it reads. */
function scanner() {
  if (!scanning()) return null;
  const stop = new AbortController();
  onCleanup(() => stop.abort()); // closed: the camera goes off
  const video = document.createElement('video');
  setScanTrouble('');
  scan(video, stop.signal).then(
    isbn => {
      navigator.vibrate?.(40);
      batch(() => {
        setScanning(false);
        setTyped(isbn);
      });
      add();
    },
    e => {
      if (e instanceof ScanError) setScanTrouble(TROUBLE[e.reason]);
      else if (!stop.signal.aborted) setScanTrouble(TROUBLE.other);
    },
  );
  const close = () => setScanning(false);
  const escape = (e: KeyboardEvent) => e.key === 'Escape' && close();
  document.addEventListener('keydown', escape);
  onCleanup(() => document.removeEventListener('keydown', escape));
  return html`<div class="scanner" role="dialog" aria-modal="true" aria-label="Scan a barcode">
    ${video}
    <div class="aim" aria-hidden="true"><span class="laser"></span></div>
    <p class="tell">${() => scanTrouble() || 'Point at the barcode on the back cover'}</p>
    <button class="close" @click=${close}>Cancel</button>
  </div>`;
}

// On a phone the parts stack (the shelf before the backup); on a wide
// screen the side column holds all but the shelf, and stays in view.
mount(
  document.getElementById('app') as HTMLElement,
  html`<div class="layout">
    <aside class="side">
      ${hero()} ${addBar()} ${viewSwitch()}
      ${() => (view() === 'library' ? libraryTools(books) : toolbar())} ${saveWarning}
    </aside>
    ${scanner} ${settings} ${updateBar} ${movedBar()}
    ${
      () =>
        reviewing()
          ? untrack(() => review(reviewing(), books(), () => setReviewing(0)))
          : null /* untracked: a change to the shelf doesn't restart the story */
    }
    ${() =>
      view() === 'library'
        ? html`<section class="main" aria-label="Your library">
            ${libraryList(books, update)}
          </section>`
        : html`<section class="main" aria-label="Your shelf">
            ${yearCard} ${empty}
            <ul class="shelf">
              ${each(shown, b => b.isbn, row)}
            </ul>
          </section>`}
  </div>`,
);
// Books rise in one after another as the page opens; after that, books
// that come and go glide instead.
setTimeout(() => document.documentElement.classList.add('settled'), 1500);
updates.start();
// Ask the browser to keep the shelf even when space runs short, and (on
// an iPhone) past seven days without a visit.
navigator.storage?.persist?.();

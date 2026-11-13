/* cuento's page: add a book by its ISBN, and the shelf, filtered and
 * searched, each book's status, dates, rating and notes. Built on spark
 * (spark/: signals, html`` templates, keyed each()).
 *
 *   books (signal) ──► shown (computed: filter + search) ──► each(row)
 *      │                                                      │
 *      └──► effect: save to localStorage   ◄── update(isbn) ──┘
 *
 * Depends on spark, isbn.ts, lookup.ts, scan.ts and shelf.ts. Working
 * offline is the service worker's (public/sw.js), not the page's. */
import { signal, computed, effect, batch, onCleanup, html, each, mount } from './spark/index.js';
import type { Getter } from './spark/index.js';
import { toIsbn13, show } from './isbn.ts';
import { lookup } from './lookup.ts';
import { scan, canScan, ScanError } from './scan.ts';
import type { Reason } from './scan.ts';
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
} from './shelf.ts';
import type { Book, Status } from './shelf.ts';

/** A book on the shelf, live: its row reads it through this. */
type BookGetter = Getter<Book>;
/** Where adding a book is: looking it up, or why it can't be added. */
interface Adding {
  state: 'looking' | 'invalid' | 'there' | 'missing' | 'offline';
  isbn?: string;
}

/** The text of the field an input event came from. */
const valueOf = (e: Event) => (e.target as HTMLInputElement).value;

/** What each status is called on the page. */
const LABELS: Record<Status, string> = { want: 'Want to read', reading: 'Reading', read: 'Read' };
/** What each status is called on a book's switch, where room is short. */
const SHORT: Record<Status, string> = { want: 'Want', reading: 'Reading', read: 'Read' };
/** The filters above the shelf: every book, or one status. */
const FILTERS: ('all' | Status)[] = ['all', ...STATUSES];

// The shelf, saved whenever it changes.
const [books, setBooks] = signal(load());
const [saveFailed, setSaveFailed] = signal(false);
effect(() => {
  setSaveFailed(!save(books()));
});

// What the shelf shows: a status (or all) and the words searched for.
const [filter, setFilter] = signal<'all' | Status>('all');
const [query, setQuery] = signal('');
// The book whose details are open, by ISBN ('' for none).
const [open, setOpen] = signal('');
// Adding a book: the ISBN typed, and where its lookup is: null (idle), or
// {state: 'looking' | 'invalid' | 'there' | 'missing' | 'offline', isbn}.
const [typed, setTyped] = signal('');
const [adding, setAdding] = signal<Adding | null>(null);

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
        inputmode="numeric"
        autocomplete="off"
        placeholder="ISBN: 10 or 13 digits"
        aria-label="ISBN"
        .value=${typed}
        @input=${(e: Event) => setTyped(valueOf(e))}
      />
      <button>Add book</button>
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
  const count = (f: 'all' | Status) => () =>
    (f === 'all' ? books() : books().filter(b => b.status === f)).length;
  return html`<nav class="tools">
    <div class="filters" role="group" aria-label="Show">
      ${FILTERS.map(
        f =>
          html`<button
            class=${() => ({ chip: true, on: filter() === f })}
            aria-pressed=${() => String(filter() === f)}
            @click=${() => glide(() => setFilter(f))}
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
      @input=${(e: Event) => setQuery(valueOf(e))}
    />
  </nav>`;
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
/** Bookcloth colours for spines: oxblood, navy, forest, ochre, teal,
 * plum, slate and rust. */
const CLOTHS = [
  '#7d2f2b',
  '#26476e',
  '#2f5e4a',
  '#a27b2c',
  '#1f6164',
  '#5d3b66',
  '#4b5762',
  '#9b4b25',
];

/** A cloth for a spine, the same every time for the same book: the ISBN
 * hashed (FNV-1a), so books with close ISBNs still differ. */
function cloth(isbn: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < isbn.length; i++) h = Math.imul(h ^ isbn.charCodeAt(i), 0x01000193);
  return CLOTHS[(h >>> 0) % CLOTHS.length] ?? CLOTHS[0];
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

/** A book's dates, notes and removal, shown when it is open. */
function details(book: BookGetter) {
  const field = (key: 'added' | 'started' | 'finished', label: string) =>
    html`<label
      >${label}
      <input
        type="date"
        .value=${() => book()[key]}
        @change=${(e: Event) => update(book().isbn, b => ({ ...b, [key]: valueOf(e) }))}
    /></label>`;
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
      ${field('added', 'Added')} ${field('started', 'Started')} ${field('finished', 'Finished')}
    </div>
    <textarea
      placeholder="Notes"
      rows="3"
      .value=${() => book().notes}
      @change=${(e: Event) => update(book().isbn, b => ({ ...b, notes: valueOf(e) }))}
    ></textarea>
    <p class="meta">
      ISBN
      ${show(book().isbn)}${() => (book().pages ? ' · ' + book().pages + ' pages' : '')}${() =>
        book().published ? ' · ' + book().published : ''}
    </p>
    <button class="remove" @click=${remove}>Remove from shelf</button>
  </div>`;
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
      </div>
      ${() => (isOpen() ? details(book) : null)}
    </div>
  </li>`;
}

/** Cuca, drawn in the page (icon.svg's drawing, in parts) so she can
 * move: her head sways on her neck and she blinks, while her book stays
 * still. */
function cuca() {
  return html`<svg class="cuca" viewBox="0 0 256 256" width="128" height="128" aria-hidden="true">
    <path
      d="M176 190 C176 140 96 156 100 112"
      fill="none"
      stroke="#2b2620"
      stroke-width="44"
      stroke-linecap="round"
    />
    <path
      d="M176 190 C176 140 96 156 100 112"
      fill="none"
      stroke="#7fb069"
      stroke-width="34"
      stroke-linecap="round"
    />
    <path
      d="M150 150 C150 138 128 140 126 134"
      fill="none"
      stroke="#5a8a4a"
      stroke-width="6"
      stroke-linecap="round"
    />
    <g class="head">
      <g transform="rotate(28 150 70)">
        <rect
          x="144"
          y="18"
          width="12"
          height="62"
          rx="2"
          fill="#d9a21b"
          stroke="#2b2620"
          stroke-width="4"
        />
        <path
          d="M144 18 L150 4 L156 18 Z"
          fill="#f6f1e7"
          stroke="#2b2620"
          stroke-width="4"
          stroke-linejoin="round"
        />
        <rect
          x="144"
          y="70"
          width="12"
          height="10"
          fill="#b5532c"
          stroke="#2b2620"
          stroke-width="4"
        />
      </g>
      <circle cx="104" cy="88" r="42" fill="#7fb069" stroke="#2b2620" stroke-width="6" />
      <circle cx="141" cy="88" r="9" fill="#5a8a4a" stroke="#2b2620" stroke-width="4" />
      <circle cx="88" cy="86" r="14" fill="#fffdf8" stroke="#2b2620" stroke-width="5" />
      <circle cx="120" cy="86" r="14" fill="#fffdf8" stroke="#2b2620" stroke-width="5" />
      <path d="M102 85 H106" stroke="#2b2620" stroke-width="5" />
      <g class="eyes">
        <circle cx="90" cy="88" r="4.5" fill="#2b2620" />
        <circle cx="122" cy="88" r="4.5" fill="#2b2620" />
      </g>
      <path
        d="M90 108 Q104 120 118 108"
        fill="none"
        stroke="#2b2620"
        stroke-width="5"
        stroke-linecap="round"
      />
    </g>
    <rect
      x="44"
      y="176"
      width="168"
      height="56"
      rx="8"
      fill="#b5532c"
      stroke="#2b2620"
      stroke-width="6"
    />
    <path d="M72 176 V232 M184 176 V232" stroke="#d9a21b" stroke-width="6" />
    <rect
      x="92"
      y="192"
      width="80"
      height="24"
      rx="3"
      fill="#fffdf8"
      stroke="#2b2620"
      stroke-width="4"
    />
    <path d="M102 204 H162" stroke="#7a7064" stroke-width="4" stroke-linecap="round" />
  </svg>`;
}

/** What the shelf says when it shows nothing. */
function empty() {
  if (shown().length) return null;
  return books().length
    ? html`<p class="empty">No book matches. Try fewer words, or another shelf.</p>`
    : html`<div class="empty">
        ${cuca()}
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

/** The top: Cuca, the name, and what cuento counts. */
function hero() {
  const year = today().slice(0, 4);
  return html`<header class="hero">
    <div class="brand">
      <img src="icon.svg" alt="" width="44" height="44" />
      <h1>cuento</h1>
    </div>
    <p class="count">
      ${() => html`<span class="big">${readThisYear()}</span>` /* new each time: it ticks in */}
      <span class="what">${() => (readThisYear() === 1 ? 'book' : 'books')} read in ${year}</span>
    </p>
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
    <aside class="side">${hero()} ${addBar()} ${toolbar()} ${backup()}</aside>
    ${scanner}
    <section class="main" aria-label="Your shelf">
      ${empty}
      <ul class="shelf">
        ${each(shown, b => b.isbn, row)}
      </ul>
    </section>
  </div>`,
);
// Books rise in one after another as the page opens; after that, books
// that come and go glide instead.
setTimeout(() => document.documentElement.classList.add('settled'), 1500);

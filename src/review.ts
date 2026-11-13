/* The year in review: a reader's year in books, told as a story of
 * cards over the page, like a music app's year in review but bound in
 * cloth and stamped in gold. Tap the right half (or swipe left, or press
 * the right arrow) to go on, the left half to go back; each card stays
 * about six seconds (review.css says how long) unless held down; Escape
 * or the cross closes it. The last card shares a picture of the year.
 *
 *   opening > count > months > favourites > records > pace > closing
 *             (a card with nothing to show is left out)
 *
 * yearStats() does the counting, as a pure function; the rest draws it.
 * Depends on spark, the shelf's Book, Tilde and the bookcloths, and
 * review.css. Leaves out comparing years, and books not marked read. */
import { signal, onCleanup, html } from './spark/index.js';
import { today } from './shelf.ts';
import type { Book } from './shelf.ts';
import { cloth, hash, tilde } from './tilde.ts';

/** What a year of reading comes to. */
export interface Stats {
  year: number;
  /** The books read and finished in the year, in the order finished. */
  read: Book[];
  /** Their pages, of those whose pages are known. */
  pages: number;
  /** The books finished in each month, January first. */
  months: Book[][];
  /** The month (0 to 11) with more books than any other; null on a tie. */
  best: number | null;
  /** Up to five rated 4 or 5, the best first (in the order read on a tie). */
  favourites: Book[];
  /** The book with the most pages (the first finished, on a tie). */
  longest: Book | null;
  /** The book read in the fewest days, counting the first and the last. */
  quickest: { book: Book; days: number } | null;
  /** The author of the most books, when that is two or more (all who tie). */
  author: { names: string[]; count: number } | null;
  /** The days of the year so far for each book read (two books or more). */
  every: number | null;
  /** The pages read a day over the year so far, when it is one or more. */
  perDay: number | null;
  /** The days a book took, start to finish, on average. */
  took: number | null;
}

/** The months' names. */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Days from one 'YYYY-MM-DD' to another. */
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);

/** The days book took, counting its first and last, or null when its
 * dates can't say: no start, a start after the end, or both on the day it
 * was added (shelving a book as read dates it that day). */
function took(book: Book): number | null {
  const { started, finished, added } = book;
  if (!started || started > finished || (started === finished && finished === added)) return null;
  return days(started, finished) + 1;
}

/** Everything the review shows of year, from books; now is today. */
export function yearStats(year: number, books: Book[], now = today()): Stats {
  const read = books
    .filter(b => b.status === 'read' && b.finished.startsWith(year + '-'))
    .sort((a, b) => a.finished.localeCompare(b.finished));
  const months = MONTHS.map((_, m) => read.filter(b => Number(b.finished.slice(5, 7)) === m + 1));
  const most = Math.max(...months.map(m => m.length));
  const busiest = months.flatMap((m, i) => (m.length === most ? [i] : []));
  const known = read.filter(b => b.pages);
  const pages = known.reduce((n, b) => n + (b.pages ?? 0), 0);
  const spans = read.flatMap(book => {
    const d = took(book);
    return d === null ? [] : [{ book, days: d }];
  });
  const byAuthor = new Map<string, number>();
  for (const b of read)
    for (const a of new Set(b.authors)) byAuthor.set(a, (byAuthor.get(a) ?? 0) + 1);
  const top = Math.max(0, ...byAuthor.values());
  const thisYear = Number(now.slice(0, 4));
  const soFar =
    year < thisYear
      ? days(year + '-01-01', year + 1 + '-01-01')
      : year === thisYear
        ? days(year + '-01-01', now) + 1
        : 0;
  return {
    year,
    read,
    pages,
    months,
    best: most && busiest.length === 1 ? (busiest[0] ?? null) : null,
    favourites: read
      .filter(b => b.rating >= 4)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 5),
    longest: known.reduce<Book | null>(
      (l, b) => (!l || (b.pages ?? 0) > (l.pages ?? 0) ? b : l),
      null,
    ),
    quickest: spans.reduce<Stats['quickest']>((q, s) => (!q || s.days < q.days ? s : q), null),
    author:
      top >= 2
        ? { names: [...byAuthor].filter(([, n]) => n === top).map(([a]) => a), count: top }
        : null,
    every: read.length >= 2 && soFar ? Math.max(1, Math.round(soFar / read.length)) : null,
    perDay: soFar && pages >= soFar ? Math.round(pages / soFar) : null,
    took: spans.length ? Math.round(spans.reduce((n, s) => n + s.days, 0) / spans.length) : null,
  };
}

/** n with its thousands marked. */
const fmt = (n: number) => n.toLocaleString('en');
/** n and a noun, plural unless n is 1. */
const many = (n: number, noun: string) => fmt(n) + ' ' + noun + (n === 1 ? '' : 's');
/** Words joined as a reader would: "a, b and c". */
const list = (words: string[]) =>
  words.length < 2 ? words.join('') : words.slice(0, -1).join(', ') + ' and ' + words.at(-1);

/** How thick a page is, with its share of the covers, in centimetres: a
 * 300-page paperback is about 2.4 cm. */
const PAGE_CM = 0.008;
/** Things a pile of books may stand taller than, tallest first, in cm. */
const TALLER: [number, string][] = [
  [500, 'a giraffe'],
  [200, 'a front door'],
  [75, 'a kitchen table'],
  [30, 'a cat sitting up'],
  [9, 'a teacup'],
];

/** What pages come to, piled up: "A pile 59 cm tall, taller than a cat
 * sitting up." */
export function pile(pages: number): string {
  const cm = pages * PAGE_CM;
  const height = cm < 100 ? Math.max(1, Math.round(cm)) + ' cm' : (cm / 100).toFixed(1) + ' m';
  const thing = TALLER.find(([h]) => cm > h)?.[1];
  return 'A pile ' + height + ' tall' + (thing ? ', taller than ' + thing + '.' : '.');
}

/** Whether the reader asked for less motion. */
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A card of the story: whether the year has anything for it, the
 * ground it is printed on, and how to draw it. */
interface Card {
  shows: (s: Stats) => boolean;
  tone: 'paper' | 'cloth';
  draw: (s: Stats) => Node;
}

/** The cards, in order. */
const CARDS: Card[] = [
  { shows: () => true, tone: 'cloth', draw: opening },
  { shows: () => true, tone: 'paper', draw: count },
  { shows: s => s.read.length >= 2, tone: 'paper', draw: months },
  { shows: s => s.favourites.length > 0, tone: 'cloth', draw: favourites },
  { shows: s => !!(s.longest || s.quickest || s.author), tone: 'paper', draw: records },
  { shows: s => s.every !== null, tone: 'cloth', draw: pace },
  { shows: () => true, tone: 'cloth', draw: closing },
];

/** The year in review of year, from books, over the page; close takes
 * it away (the cross and Escape call it). */
export function review(year: number, books: Book[], close: () => void): Node {
  const s = yearStats(year, books);
  const cards = CARDS.filter(c => c.shows(s));
  const [at, setAt] = signal(0);
  const [held, setHeld] = signal(false);
  /** Shows card i; past the last, the last stays. */
  const go = (i: number) => i < cards.length && setAt(Math.max(0, i));

  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') go(at() + 1);
    else if (e.key === 'ArrowLeft') go(at() - 1);
  };
  document.addEventListener('keydown', key);
  onCleanup(() => document.removeEventListener('keydown', key));

  // A press holds the card; let go quickly, it is a tap on a half; moved
  // sideways, a swipe.
  let down: PointerEvent | null = null;
  const press = (e: PointerEvent) => {
    if ((e.target as Element).closest('button')) return;
    down = e;
    setHeld(true);
  };
  const release = (e: PointerEvent) => {
    setHeld(false);
    if (!down) return;
    const dx = e.clientX - down.clientX;
    const dy = e.clientY - down.clientY;
    const quick = e.timeStamp - down.timeStamp < 400;
    down = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(at() + (dx < 0 ? 1 : -1));
    else if (quick && Math.hypot(dx, dy) < 10) {
      const r = (e.currentTarget as Element).getBoundingClientRect();
      go(at() + (e.clientX < r.left + r.width / 2 ? -1 : 1));
    }
  };
  const cancel = () => {
    down = null;
    setHeld(false);
  };
  /** The current card's bar has filled: on to the next. */
  const dwelt = (e: AnimationEvent) => e.animationName === 'rv-dwell' && go(at() + 1);

  return html`<div
    class=${() => (held() ? 'review held' : 'review')}
    role="dialog"
    aria-modal="true"
    aria-label=${'Your ' + year + ' in books'}
  >
    <div
      class=${() => 'phone ' + cards[at()]?.tone}
      @pointerdown=${press}
      @pointerup=${release}
      @pointercancel=${cancel}
    >
      ${() => cards[at()]?.draw(s)}
      <div class="bars" aria-hidden="true" @animationend=${dwelt}>
        ${cards.map(
          (_, i) =>
            html`<span class=${() => (i < at() ? 'seen' : i === at() ? 'on' : '')}><i></i></span>`,
        )}
      </div>
      <button class="shut" aria-label="Close" @click=${close}>×</button>
    </div>
  </div>`;
}

/** n, counted up from nought after delay ms (at once if motion is reduced). */
function counter(n: number, delay = 300) {
  const el = html`<span class="num">${fmt(n)}</span>` as HTMLElement;
  if (still()) return el;
  const start = performance.now() + delay;
  let frame = requestAnimationFrame(function tick(t) {
    const k = Math.min(1, Math.max(0, (t - start) / 1400));
    el.textContent = fmt(Math.round(n * (1 - (1 - k) ** 3)));
    if (k < 1) frame = requestAnimationFrame(tick);
  });
  onCleanup(() => cancelAnimationFrame(frame));
  return el;
}

/** A book's cover; its cloth and title while the picture loads, or when
 * there is none or it won't load. */
function cover(b: Book) {
  const hide = (e: Event) => ((e.target as HTMLElement).hidden = true);
  return html`<span class="jacket" style=${{ '--cloth': cloth(b.isbn) }}>
    <span>${b.title}</span>
    ${b.cover ? html`<img src=${b.cover} alt="" @error=${hide} />` : null}
  </span>`;
}

/** The first card: a cloth cover, stamped with the year, opening. */
function opening(s: Stats) {
  return html`<section class="card cloth opening" style="--cloth: #7d2f2b">
    <p class="rise" style="--i: 0">Your</p>
    <h1 class="foil rise" style="--i: 1">${s.year}</h1>
    <p class="rise" style="--i: 2">in books</p>
    ${tilde()}
    <p class="imprint">cuento</p>
    <div class="flyleaf"><strong>cuento</strong><span>a year in books</span></div>
  </section>`;
}

/** How many books and pages, over a pile of the year's books falling
 * into place. */
function count(s: Stats) {
  const n = s.read.length;
  /** A book lying on the pile: as thick as its pages, as long as its hash says. */
  const lying = (b: Book, i: number) => {
    const h = hash(b.isbn);
    return html`<span
      class="lying"
      style=${{
        '--cloth': cloth(b.isbn),
        '--i': i,
        '--w': 58 + (h % 28) + '%',
        '--h': Math.min(34, Math.max(16, (b.pages || 300) / 16)) + 'px',
        '--x': ((h >> 8) % 24) - 12 + 'px',
        '--r': ((h >> 16) % 7) - 3 + 'deg',
      }}
      >${b.title}</span
    >`;
  };
  return html`<section class="card paper tally">
    <p class="kicker rise">In ${s.year} you finished</p>
    <p class="huge rise" style="--i: 1">${counter(n)}</p>
    <p class="unit rise" style="--i: 2">${n === 1 ? 'book' : 'books'}</p>
    ${n ? null : html`<p class="aside rise" style="--i: 3">Not one yet. There’s still time.</p>`}
    ${s.pages
      ? html`<p class="line rise" style="--i: 3">
            ${s.read.some(b => !b.pages) ? 'At least ' : ''}<b>${counter(s.pages, 700)}</b> pages
          </p>
          <p class="aside rise" style="--i: 4">${pile(s.pages)}</p>`
      : null}
    <div class="heap">${s.read.slice(-9).map(lying)}</div>
  </section>`;
}

/** A bookcase with a shelf slot a month, the books finished in it
 * standing there, and the best month marked with a ribbon. */
function months(s: Stats) {
  const most = Math.max(...s.months.map(m => m.length));
  const busiest = MONTHS.filter((_, i) => s.months[i]?.length === most);
  /** A book standing on the shelf. */
  const upright = (b: Book, i: number) =>
    html`<span
      class="upright"
      style=${{ '--cloth': cloth(b.isbn), '--i': i, '--h': 62 + (hash(b.isbn) % 38) + '%' }}
    ></span>`;
  return html`<section class="card paper months">
    <p class="kicker rise">Month by month</p>
    <h2 class="rise" style="--i: 1">
      ${s.best === null ? 'A steady year' : html`<em>${MONTHS[s.best]}</em> was your month`}
    </h2>
    <p class="aside rise" style="--i: 2">
      ${s.best === null
        ? 'Your busiest: ' + list(busiest) + ', with ' + many(most, 'book') + ' each.'
        : many(most, 'book') + ', more than any other month.'}
    </p>
    <div class="case">
      ${s.months.map(
        (m, i) =>
          html`<div class=${i === s.best ? 'slot best' : 'slot'} style=${{ '--m': i }}>
            <div class="ledge">${m.map(upright)}</div>
            <span>${MONTHS[i]?.slice(0, 3)}</span>
          </div>`,
      )}
    </div>
  </section>`;
}

/** The books rated highest, their covers fanned out, their stars glinting. */
function favourites(s: Stats) {
  const f = s.favourites;
  return html`<section class="card cloth favourites" style="--cloth: #26476e">
    <p class="kicker rise">The ones you loved</p>
    <h2 class="foil rise" style="--i: 1">Favourites</h2>
    <div class="fan">
      ${f.map(
        (b, i) =>
          html`<div
            class="leaf"
            style=${{ '--a': (i - (f.length - 1) / 2) * 10 + 'deg', '--i': i }}
          >
            ${cover(b)}
          </div>`,
      )}
    </div>
    <ol class="picks">
      ${f.map(
        (b, i) =>
          html`<li class="rise" style=${{ '--i': i + 4 }}>
            <span class="glint" aria-label=${b.rating + ' stars'}>${'★'.repeat(b.rating)}</span>
            <span>${b.title}</span>
          </li>`,
      )}
    </ol>
  </section>`;
}

/** The year's records, each on a library catalogue card. */
function records(s: Stats) {
  const slips: [string, string, Book | undefined, string][] = [];
  const { longest, quickest, author } = s;
  if (longest) slips.push(['The longest', many(longest.pages!, 'page'), longest, longest.title]);
  if (quickest)
    slips.push([
      'The quickest',
      quickest.days === 1 ? 'One day' : quickest.days + ' days',
      quickest.book,
      quickest.book.title,
    ]);
  if (author)
    slips.push([
      author.names.length > 1 ? 'Most read, tied' : 'Most read',
      many(author.count, 'book') + (author.names.length > 1 ? ' each' : ''),
      s.read.filter(b => b.authors.includes(author.names[0] ?? '')).at(-1),
      list(author.names),
    ]);
  return html`<section class="card paper records">
    <p class="kicker rise">Records</p>
    <h2 class="rise" style="--i: 1">For the <em>books</em></h2>
    <ol class="slips">
      ${slips.map(
        ([label, value, book, about], i) =>
          html`<li class="slip" style=${{ '--i': i, '--r': (i % 2 ? 2 : -2) + 'deg' }}>
            ${book ? cover(book) : null}
            <div>
              <span class="kicker">${label}</span>
              <strong>${value}</strong>
              <span class="about">${about}</span>
            </div>
          </li>`,
      )}
    </ol>
  </section>`;
}

/** How often a book was finished, over the year as a thread with a gold
 * bead for each, lit as the thread runs past it. */
function pace(s: Stats) {
  const length = days(s.year + '-01-01', s.year + 1 + '-01-01');
  return html`<section class="card cloth pace" style="--cloth: #2f5e4a">
    <p class="kicker rise">Your pace</p>
    <p class="line rise" style="--i: 1">A book every</p>
    <p class="huge foil rise" style="--i: 2">${counter(s.every ?? 0, 500)}</p>
    <p class="unit rise" style="--i: 3">${s.every === 1 ? 'day' : 'days'}</p>
    <div class="thread">
      ${s.read.map(
        b => html`<i style=${{ '--x': days(s.year + '-01-01', b.finished) / length }}></i>`,
      )}
    </div>
    <p class="axis"><span>Jan</span><span>Dec</span></p>
    ${s.perDay
      ? html`<p class="aside rise" style="--i: 6">About <b>${s.perDay}</b> pages a day.</p>`
      : null}
    ${s.took
      ? html`<p class="aside rise" style="--i: 7">
          Start to finish, a book took you <b>${many(s.took, 'day')}</b>.
        </p>`
      : null}
  </section>`;
}

/** The last card: a gold seal for the year, a toast to the next, and Share. */
function closing(s: Stats) {
  const png = shareImage(s); // drawn now, so Share can share at once
  return html`<section class="card cloth closing" style="--cloth: #7d2f2b">
    <div class="medal">${seal(s.year)} ${tilde()}</div>
    <h2 class="foil rise" style="--i: 2">Here’s to ${s.year + 1}</h2>
    <p class="aside rise" style="--i: 3">
      ${many(s.read.length, 'book')} read in ${s.year}. Tilde has her pencil ready.
    </p>
    <button class="share rise" style="--i: 4" @click=${() => share(png, s.year)}>
      Share your year
    </button>
  </section>`;
}

/** The points of a seal's crimped edge, round a 200-unit square. */
const CRIMP = Array.from({ length: 72 }, (_, i) => {
  const r = i % 2 ? 93 : 100;
  const a = (i * Math.PI) / 36;
  return (100 + r * Math.sin(a)).toFixed(1) + ',' + (100 - r * Math.cos(a)).toFixed(1);
}).join(' ');

/** A gold seal, like an award's on a book's cover, stamped with year. */
function seal(year: number) {
  return html`<svg class="seal" viewBox="0 0 200 200" aria-hidden="true">
    <defs>
      <linearGradient id="rv-gold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#8a6420" />
        <stop offset=".3" stop-color="#f3d68a" />
        <stop offset=".5" stop-color="#b8892f" />
        <stop offset=".75" stop-color="#f8e8b0" />
        <stop offset="1" stop-color="#94701f" />
      </linearGradient>
      <path id="rv-ring" d="M100 100 m-67 0 a67 67 0 1 1 134 0 a67 67 0 1 1 -134 0" />
    </defs>
    <polygon points=${CRIMP} fill="url(#rv-gold)" />
    <circle cx="100" cy="100" r="82" fill="none" stroke="#6b4c14" stroke-opacity=".55" />
    <circle cx="100" cy="100" r="54" fill="none" stroke="#6b4c14" stroke-opacity=".55" />
    <text class="ring">
      <textPath href="#rv-ring" textLength="415">A YEAR IN BOOKS · KEPT WITH CUENTO ·</textPath>
    </text>
    <text class="stamp" x="100" y="113" text-anchor="middle">${year}</text>
  </svg>`;
}

/** Shares the picture of the year, or saves it where files can't be shared. */
async function share(png: Promise<Blob | null>, year: number) {
  const blob = await png;
  if (!blob) return;
  const file = new File([blob], 'cuento-' + year + '.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file] }).catch(() => {}); // dismissed: nothing to do
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** The share picture's size: a phone's story. */
const W = 1080;
const H = 1920;
/** The cloth it is bound in, its gold, and its cream. */
const OXBLOOD = '#7d2f2b';
const GOLD = '#e2c06e';
const CREAM = '#f6eedd';

/** An image loaded for a canvas without tainting it, or null if its
 * server won't allow that (CORS) or it takes over four seconds. */
function picture(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    setTimeout(() => resolve(null), 4000);
    img.src = src;
  });
}

/** The year as a 1080x1920 PNG: the cloth, the year in gold, the count,
 * the favourites (or the last books read) on a shelf, and Tilde. Covers
 * whose server forbids drawing them stand as cloth. Null if it can't be
 * drawn. */
async function shareImage(s: Stats): Promise<Blob | null> {
  try {
    await Promise.all([
      document.fonts.load('600 100px Fraunces'),
      document.fonts.load('600 40px "Instrument Sans"'),
    ]);
    const shelf = (s.favourites.length ? s.favourites : s.read.slice(-5)).slice(0, 5);
    const svg = new XMLSerializer().serializeToString(tilde());
    const [worm, ...covers] = await Promise.all([
      picture('data:image/svg+xml,' + encodeURIComponent(svg)),
      ...shelf.map(b => (b.cover ? picture(b.cover) : null)),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    if (!g) return null;
    const gold = g.createLinearGradient(0, 0, W, H / 3);
    for (const [at, c] of [
      [0, '#9a7425'],
      [0.35, '#f4dc94'],
      [0.55, '#b98e33'],
      [0.8, '#fbecb8'],
      [1, '#a07a2a'],
    ] as const)
      gold.addColorStop(at, c);
    /** Writes text centred at y, in font and fill. */
    const write = (text: string, y: number, font: string, fill: string | CanvasGradient) => {
      g.font = font;
      g.fillStyle = fill;
      g.textAlign = 'center';
      g.fillText(text, W / 2, y, W - 200);
    };

    // The cloth: its weave, darker at the edges, and a tooled double frame.
    g.fillStyle = OXBLOOD;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#00000014';
    for (let y = 0; y < H; y += 5) g.fillRect(0, y, W, 2);
    g.fillStyle = '#ffffff08';
    for (let x = 0; x < W; x += 5) g.fillRect(x, 0, 2, H);
    const shade = g.createRadialGradient(W / 2, H * 0.4, 200, W / 2, H / 2, H * 0.75);
    shade.addColorStop(0, '#0000');
    shade.addColorStop(1, '#0007');
    g.fillStyle = shade;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = GOLD;
    g.lineWidth = 4;
    g.strokeRect(56, 56, W - 112, H - 112);
    g.lineWidth = 1.5;
    g.strokeRect(74, 74, W - 148, H - 148);

    g.letterSpacing = '10px';
    write('A YEAR IN BOOKS', 230, '600 36px "Instrument Sans"', GOLD);
    g.letterSpacing = '0px';
    write(String(s.year), 480, '600 250px Fraunces', gold);
    write('⁂', 590, '400 50px Fraunces', GOLD);
    write(fmt(s.read.length), 830, '600 220px Fraunces', CREAM);
    write(
      s.read.length === 1 ? 'book read' : 'books read',
      910,
      '500 54px "Instrument Sans"',
      CREAM,
    );
    const facts = [
      s.pages ? many(s.pages, 'page') : '',
      s.best === null ? '' : 'best month ' + MONTHS[s.best],
    ];
    write(facts.filter(Boolean).join('  ·  '), 990, '500 40px "Instrument Sans"', '#f6eeddaa');

    // The shelf: covers standing on a plank, cloth where a cover can't be drawn.
    const bw = 150,
      bh = 225,
      gap = 18,
      plank = 1370;
    let x = (W - shelf.length * bw - (shelf.length - 1) * gap) / 2;
    shelf.forEach((b, i) => {
      const img = covers[i];
      g.save();
      g.shadowColor = '#0009';
      g.shadowBlur = 24;
      g.shadowOffsetY = 10;
      g.fillStyle = cloth(b.isbn);
      g.fillRect(x, plank - bh, bw, bh);
      g.restore();
      if (img) g.drawImage(img, x, plank - bh, bw, bh);
      else {
        g.strokeStyle = GOLD;
        g.lineWidth = 2;
        g.strokeRect(x + 12, plank - bh + 12, bw - 24, bh - 24);
        g.font = '600 24px Fraunces';
        g.fillStyle = CREAM;
        g.textAlign = 'center';
        wrap(g, b.title, bw - 48).forEach((line, j) =>
          g.fillText(line, x + bw / 2, plank - bh + 64 + j * 30, bw - 32),
        );
      }
      x += bw + gap;
    });
    g.fillStyle = '#5b3a20';
    g.fillRect(110, plank, W - 220, 22);
    g.fillStyle = '#0005';
    g.fillRect(110, plank + 22, W - 220, 8);
    if (s.favourites.length)
      write('My favourites of the year', 1470, '500 40px Fraunces', '#f6eeddcc');

    if (worm) g.drawImage(worm, W / 2 - 120, 1510, 240, 240);
    write('cuento', 1800, '600 40px Fraunces', GOLD);
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  } catch {
    return null; // a browser without what this needs: Share does nothing
  }
}

/** text broken into at most three lines no wider than width in g's font. */
function wrap(g: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? line + ' ' + word : word;
    if (line && g.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  return [...lines, line].slice(0, 3);
}

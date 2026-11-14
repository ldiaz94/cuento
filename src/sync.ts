/* Sync: one shelf on several devices, with no accounts. Turning sync on
 * makes a sync code, 26 random characters that are both the shelf's
 * address on the server (worker/) and its only key; another device joins
 * with a link holding the code (#sync=<code>), or the code typed in.
 *
 *   books() ──► diff against the last synced copy ──► POST changes
 *      ▲                                                  │
 *      └── setBooks ◄── what other devices changed ◄──────┘
 *
 * localStorage stays the device's copy, so cuento works offline as ever.
 * Beside it, cuento.synced keeps the shelf as last synced: each book's
 * JSON and when it changed. A book that differs from that copy is a
 * change, stamped now; one missing from the shelf is a deletion. The
 * server keeps the later of two changes to a book (last writer wins), and
 * answers with every book changed since this device last asked. The
 * reading goals travel the same way as one more record, the settings:
 * the snapshot keeps their JSON, and the later change wins whole.
 *
 * It syncs on opening, a moment after the books change, on coming back
 * online or to the screen, and when the server says another device
 * changed something (a WebSocket). Depends on spark and shelf.ts. Leaves
 * out merging within a book (the later book wins whole), and devices
 * whose clocks are far off (their changes lose or win unfairly). */
import { signal, effect } from './spark/index.js';
import type { Getter, Setter } from './spark/index.js';
import { readBook, merge } from './shelf.ts';
import type { Book } from './shelf.ts';

/** Where sync is: not on, talking to the server, done, or unable. */
export type SyncStatus = 'off' | 'syncing' | 'synced' | 'offline' | 'error';

/** One book's change: the book, or null when deleted; updated is when, in
 * ms, by the clock of the device that made it. v is the sync model version. */
export interface Change {
  v: 2;
  isbn: string;
  book: Book | null;
  updated: number;
}

/** The shelf's settings: reading goals by year, as of updated (ms, by the
 * clock of the device that wrote them). */
export interface Settings {
  data: { goals: Goals };
  updated: number;
}

/** Reading goals by year (books to finish). */
export type Goals = Record<string, number>;

/** The server's answer to a sync: its last seq, what changed since, and the
 * settings when they did. */
export interface Reply {
  seq: number;
  changes: Change[];
  settings?: Settings;
}

/** A book as last synced: its JSON (null once deleted), and when it changed. */
export interface Kept {
  json: string | null;
  updated: number;
}

/** The shelf as last synced: the server's seq then, every book by ISBN,
 * and the settings (none until there are goals to sync). */
export interface Snapshot {
  seq: number;
  books: Record<string, Kept>;
  settings?: { json: string; updated: number };
}

/** Crockford's base32: no I, L, O or U, so a code reads back unmistakably. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A code's length: 26 characters of 5 random bits, 130 bits in all. */
const LENGTH = 26;
/** The localStorage key of this device's sync code. */
const CODE_KEY = 'cuento.sync';
/** The localStorage key of the shelf as last synced. */
const SNAPSHOT_KEY = 'cuento.synced';
/** How long the books stay still before their changes are sent, in ms. */
const DEBOUNCE = 800;
/** The most changes sent at once (the server's limit, worker/store.ts). */
const BATCH = 500;
/** The longest wait before listening again after the socket drops, in ms. */
const MAX_RETRY = 60_000;

// ---- Codes and links ----------------------------------------------------

/** A new sync code, from 26 random bytes (each byte's low 5 bits). */
export function newCode(random = crypto.getRandomValues(new Uint8Array(LENGTH))): string {
  return Array.from(random, b => ALPHABET[b & 31]).join('');
}

/** The code in what a reader typed or pasted (a code with dashes or
 * spaces, in any case, or a whole link), or null when there is none.
 * Letters easily misread are read as Crockford says: I and L as 1, O as 0. */
export function readCode(text: string): string | null {
  const code = text
    .replace(/^.*#sync=/, '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return code.length === LENGTH && [...code].every(c => ALPHABET.includes(c)) ? code : null;
}

/** code in groups of four, to read aloud or copy by eye: 7KQ2-…-XY. */
export function grouped(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? '';
}

// ---- The diff and the merge (pure) ----------------------------------------

/** The changes between the shelf (books) and the snapshot, stamped now:
 * oldest book first, so the server's order follows the shelf's. */
export function diff(books: Book[], snapshot: Snapshot, now: number): Change[] {
  const changes: Change[] = [];
  const here = new Set<string>();
  for (const book of [...books].reverse()) {
    here.add(book.isbn);
    if (JSON.stringify(book) !== snapshot.books[book.isbn]?.json)
      changes.push({ v: 2, isbn: book.isbn, book, updated: now });
  }
  for (const [isbn, kept] of Object.entries(snapshot.books))
    if (kept.json !== null && !here.has(isbn))
      changes.push({ v: 2, isbn, book: null, updated: now });
  return changes;
}

/** The settings changed here since the snapshot, stamped now, or null.
 * No goals and none synced is nothing to send, so a new device never
 * wipes the shelf's goals. */
export function diffSettings(goals: Goals, snapshot: Snapshot, now: number): Settings | null {
  const json = settingsJson(goals);
  if (json === (snapshot.settings?.json ?? null)) return null;
  return { data: { goals }, updated: now };
}

/** goals as the snapshot keeps them (null when there are none). */
function settingsJson(goals: Goals): string | null {
  return Object.keys(goals).length ? JSON.stringify(goals) : null;
}

/** Whether value is settings as the server sends them. */
function isSettings(value: unknown): value is Settings {
  const s = value as Settings | null;
  return typeof s?.data?.goals === 'object' && s.data.goals !== null;
}

/** snapshot with changes and settings recorded, as kept by the server. */
export function recorded(
  snapshot: Snapshot,
  changes: Change[],
  seq = snapshot.seq,
  settings?: Settings | null,
): Snapshot {
  const books = { ...snapshot.books };
  for (const c of changes)
    books[c.isbn] = { json: c.book && JSON.stringify(c.book), updated: c.updated };
  const next: Snapshot = { seq, books };
  const kept = settings
    ? { json: JSON.stringify(settings.data.goals), updated: settings.updated }
    : snapshot.settings;
  if (kept) next.settings = kept;
  return next;
}

/** Incoming books in the current model, with invalid ones left out. Keeping
 * the migrated JSON in the snapshot stops a legacy book bouncing back. */
function readChanges(changes: Change[]): Change[] {
  return changes.flatMap(c => {
    if (c.book === null) return [{ ...c, v: 2 as const }];
    const book = readBook(c.book);
    return book ? [{ ...c, v: 2 as const, book }] : [];
  });
}

/** The shelf, goals and snapshot once the server's reply is in. The
 * snapshot takes every valid change; the shelf takes those to books it hasn't
 * changed since the snapshot, and the goals the settings if unchanged
 * here (own changes go next time, and win, being newer). books and
 * goals are null when they stay as they were. */
export function received(
  books: Book[],
  snapshot: Snapshot,
  reply: Reply,
  goals: Goals = {},
): { books: Book[] | null; goals: Goals | null; snapshot: Snapshot } {
  const shelf = new Map(books.map(b => [b.isbn, JSON.stringify(b)]));
  const taken: Book[] = [];
  const gone = new Set<string>();
  const changes = readChanges(reply.changes);
  for (const c of changes) {
    const was = snapshot.books[c.isbn]?.json ?? null;
    const json = c.book && JSON.stringify(c.book);
    if (json === was) continue; // nothing new: often this device's own change
    if ((shelf.get(c.isbn) ?? null) !== was) continue; // changed here meanwhile
    if (c.book === null) gone.add(c.isbn);
    else taken.push(c.book);
  }
  const theirs = isSettings(reply.settings) ? reply.settings : null;
  const next = recorded(snapshot, changes, reply.seq, theirs);
  const took =
    theirs &&
    next.settings?.json !== (snapshot.settings?.json ?? null) && // not an echo
    settingsJson(goals) === (snapshot.settings?.json ?? null) // not changed here meanwhile
      ? theirs.data.goals
      : null;
  if (!taken.length && !gone.size) return { books: null, goals: took, snapshot: next };
  return {
    books: merge(
      books.filter(b => !gone.has(b.isbn)),
      newestFirst(taken),
    ),
    goals: took,
    snapshot: next,
  };
}

/** books added most recently first: by the day added, then the latest
 * change first (the server's order is oldest first). */
export function newestFirst(books: Book[]): Book[] {
  return [...books].reverse().sort((a, b) => b.added.localeCompare(a.added));
}

// ---- Storage --------------------------------------------------------------

/** The snapshot kept on this device, or an empty one. */
function readSnapshot(): Snapshot {
  try {
    const s = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null') as Snapshot | null;
    if (s && typeof s.seq === 'number' && typeof s.books === 'object') return s;
  } catch {
    // damaged: start again, which resends the shelf (harmless)
  }
  return { seq: 0, books: {} };
}

/** Keeps the snapshot; throws when storage refuses it. */
function keepSnapshot(snapshot: Snapshot) {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

// ---- The server -----------------------------------------------------------

/** Sends changes (and settings, if changed) to code's shelf, with since;
 * the server's reply. Throws a TypeError when there is no network, an
 * Error when refused. */
async function post(
  code: string,
  since: number,
  changes: Change[],
  settings?: Settings | null,
): Promise<Reply> {
  const response = await fetch('/api/shelf/' + code + '/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 2, since, changes, settings: settings ?? undefined }),
  });
  if (!response.ok) throw Error(await response.text());
  return (await response.json()) as Reply;
}

// ---- Syncing --------------------------------------------------------------

const [status, setStatus] = signal<SyncStatus>('off');
const [code, setCode] = signal('');
/** Where sync is, live. */
export { status };
/** This device's sync code, or '' when sync is off. */
export { code };

/** The shelf and the goals, as startSync was given them. */
let books: Getter<Book[]> = () => [];
let setBooks: Setter<Book[]> = v => v as Book[];
let goals: Getter<Goals> = () => ({});
let setGoals: Setter<Goals> = v => v as Goals;
/** The sync under way, if any, and whether another is wanted after it. */
let running: Promise<void> | null = null;
let again = false;

/** Starts syncing, if this device syncs (call once, at startup): now,
 * when the books change, and when the server or the browser says so. A
 * #sync=<code> link joins that shelf. */
export function startSync(
  get: Getter<Book[]>,
  set: Setter<Book[]>,
  getGoals: Getter<Goals>,
  setGoalsTo: Setter<Goals>,
) {
  books = get;
  setBooks = set;
  goals = getGoals;
  setGoals = setGoalsTo;
  setCode(localStorage.getItem(CODE_KEY) || '');
  if (code()) wake();

  const link = /^#sync=(.+)$/.exec(location.hash);
  if (link)
    join(decodeURIComponent(link[1]!)).then(
      () => history.replaceState(null, '', location.pathname + location.search),
      () => {}, // the status says why; the link stays, to try again
    );

  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    get();
    getGoals();
    clearTimeout(timer);
    timer = setTimeout(() => {
      const snapshot = readSnapshot();
      if (code() && (diff(books(), snapshot, 0).length || diffSettings(goals(), snapshot, 0)))
        sync();
    }, DEBOUNCE);
  });
  addEventListener('online', wake);
  addEventListener('offline', () => (hush(), code() && setStatus('offline')));
  document.addEventListener('visibilitychange', () =>
    document.visibilityState === 'visible' ? wake() : hush(),
  );
}

/** Syncs now (or right after the sync under way, which may have missed
 * a change). */
function sync(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await once();
    } while (again);
  })().finally(() => (running = null));
  return running;
}

/** One sync: sends the shelf's changes in batches (the settings with
 * the first), and takes in the server's; the status says how it went. */
async function once() {
  const shelf = code();
  if (!shelf) return;
  if (!navigator.onLine) return setStatus('offline');
  setStatus('syncing');
  try {
    let snapshot = readSnapshot();
    const now = Date.now();
    const changes = diff(books(), snapshot, now);
    let settings = diffSettings(goals(), snapshot, now);
    let sent = 0;
    do {
      const batch = changes.slice(sent, (sent += BATCH));
      const reply = await post(shelf, snapshot.seq, batch, settings);
      if (code() !== shelf) return; // left, or joined another, meanwhile
      const kept = recorded(snapshot, batch, snapshot.seq, settings);
      settings = null;
      const next = received(books(), kept, reply, goals());
      snapshot = next.snapshot;
      keepSnapshot(snapshot); // first, so the books and goals it sets are not changes
      if (next.books) setBooks(next.books);
      if (next.goals) setGoals(next.goals);
    } while (sent < changes.length);
    setStatus('synced');
  } catch (error) {
    setStatus(error instanceof TypeError ? 'offline' : 'error');
  }
}

/** Turns sync on with a new code: the first sync sends the whole shelf. */
export async function enable() {
  start(newCode(), { seq: 0, books: {} });
  await sync();
}

/** Joins the shelf of code (as typed or pasted): its books join this
 * device's, its copy winning where both have a book; books only here are
 * then sent to it. Its goals replace this device's, unless it has none,
 * and then this device's go to it. Throws when the code is not one or the server can't
 * be reached. */
export async function join(text: string) {
  const shelf = readCode(text);
  if (!shelf) throw Error('That is not a sync code.');
  if (shelf === code()) return void (await sync());
  setStatus('syncing');
  let reply: Reply;
  try {
    reply = await post(shelf, 0, []);
  } catch (error) {
    const offline = error instanceof TypeError;
    setStatus(offline ? 'offline' : 'error');
    throw Error(offline ? "Couldn't reach the shelf: are you online?" : 'No shelf has that code.');
  }
  const changes = readChanges(reply.changes);
  const theirs = changes.flatMap(c => (c.book ? [c.book] : []));
  const settings = isSettings(reply.settings) ? reply.settings : null;
  start(shelf, recorded({ seq: 0, books: {} }, changes, reply.seq, settings));
  setBooks(merge(books(), newestFirst(theirs)));
  if (settings) setGoals(settings.data.goals);
  await sync();
}

/** Keeps code and snapshot as this device's, and listens for changes. */
function start(shelf: string, snapshot: Snapshot) {
  hush();
  keepSnapshot(snapshot);
  localStorage.setItem(CODE_KEY, shelf);
  setCode(shelf);
  listen();
}

/** Stops syncing on this device; its books stay. */
export function leave() {
  hush();
  localStorage.removeItem(CODE_KEY);
  localStorage.removeItem(SNAPSHOT_KEY);
  setCode('');
  setStatus('off');
}

/** The link that joins this shelf from another device. */
export function link(): string {
  return location.origin + location.pathname + '#sync=' + code();
}

// ---- Listening for other devices' changes ---------------------------------

/** The socket the server says "changed" on, while open or opening. */
let socket: WebSocket | null = null;
/** The wait before listening again, doubling up to MAX_RETRY. */
let retry = 1000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** Syncs and listens again (on opening, online, or back on the screen). */
function wake() {
  if (!code()) return;
  listen();
  sync();
}

/** Opens the socket, if sync is on, the device online and cuento shown.
 * Opened again after a drop, it syncs, for what changed meanwhile. */
function listen(again = false) {
  if (socket || !code() || !navigator.onLine || document.visibilityState === 'hidden') return;
  const url = new URL('/api/shelf/' + code() + '/live', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const s = new WebSocket(url);
  socket = s;
  s.onopen = () => {
    retry = 1000;
    if (again) sync();
  };
  s.onmessage = e => e.data === 'changed' && sync();
  s.onclose = () => {
    if (socket !== s) return; // closed on purpose
    socket = null;
    retryTimer = setTimeout(() => listen(true), retry);
    retry = Math.min(retry * 2, MAX_RETRY);
  };
}

/** Closes the socket, and forgets any retry. */
function hush() {
  const s = socket;
  socket = null;
  clearTimeout(retryTimer);
  s?.close();
}

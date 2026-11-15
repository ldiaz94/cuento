/* cuento in a real browser (headless Chromium through playwright-core),
 * with Open Library and Google Books faked: adding books, every note the
 * ISBN field gives, statuses and rating, filters and search, a reload, and
 * that a book's text never becomes HTML; then, on a shelf of their own,
 * Read again, editing the reading history, and Up next. CHROMIUM names the
 * browser (default /usr/sbin/chromium). Runs build/site/ (robbie build
 * first). Depends on test/serve.ts and shelf.ts. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Server } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { serve, origin } from './serve.ts';
import { newBook, withStatus } from '../src/shelf.ts';

/** What the fake Open Library knows, by ISBN-13. */
const LIBRARY: Record<string, object> = {
  '9780306406157': {
    title: 'Typesetting Mathematics',
    authors: [{ name: 'A. Writer' }],
    number_of_pages: 210,
  },
  '9780804429573': {
    title: '<img src=x onerror="window.hacked=1">',
    authors: [{ name: 'Mallory' }],
  },
};

/** What the fake Open Library search finds, whatever is asked. */
const SEARCH = [
  {
    title: 'The Hobbit',
    author_name: ['J. R. R. Tolkien'],
    isbn: ['0261103342'],
    first_publish_year: 1937,
  },
  { title: 'Typesetting Mathematics', author_name: ['A. Writer'], isbn: ['9780306406157'] },
];

let server: Server, browser: Browser, page: Page;
/** Errors the page threw. */
const errors: string[] = [];
/** Whether the fake services answer, or the network is down. */
let online = true;

before(async () => {
  server = await serve();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/sbin/chromium' });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/openlibrary\.org|googleapis\.com/, route => {
    if (!online) return route.abort();
    const url = route.request().url();
    if (url.includes('search.json')) return route.fulfill({ json: { docs: SEARCH } });
    const isbn = /isbn:(\d+)/i.exec(url)?.[1] || '';
    const known = LIBRARY[isbn];
    return route.fulfill({
      json: url.includes('openlibrary')
        ? known
          ? { ['ISBN:' + isbn]: known }
          : {}
        : { totalItems: 0 },
    });
  });
  await page.goto(origin(server) + 'app/');
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** Types text in the ISBN field and adds it. */
async function addIsbn(text: string) {
  await page.fill('.add form input', text);
  await page.click('.add form > button');
}
/** The text of the first element matching selector ('' when none). */
const text = async (selector: string) => (await page.textContent(selector)) ?? '';
/** The titles on the shelf, in order. */
const titles = () => page.$$eval('.book .title strong', els => els.map(e => e.textContent));

test('an empty shelf says how to add a book', async () => {
  assert.match(await text('.empty'), /shelf is empty/);
});

test('a typed ISBN-10 is looked up and shelved as its ISBN-13', async () => {
  await addIsbn('0-306-40615-2');
  await page.waitForSelector('.book');
  assert.deepEqual(await titles(), ['Typesetting Mathematics']);
  assert.equal(await page.inputValue('.add form input'), '');
  assert.equal(await page.$('.empty'), null);
});

test('the ISBN field says what is wrong', async () => {
  await addIsbn('12345');
  assert.match(await text('.add .note'), /isn't an ISBN/);
  await addIsbn('9780306406157');
  assert.match(await text('.add .note'), /on your shelf already/);
  online = false;
  try {
    await addIsbn('9780000000002');
    await page.waitForSelector('text=/Couldn.t reach/');
  } finally {
    online = true;
  }
});

test('a book no service knows is added by hand, and its text stays text', async () => {
  await addIsbn('9780000000002');
  await page.waitForSelector('.by-hand');
  await page.fill('.by-hand [placeholder=Title]', 'Family recipes');
  await page.click('.by-hand button');
  await addIsbn('080442957X');
  await page.waitForFunction(() => document.querySelectorAll('.book').length === 3);
  assert.equal((await titles())[0], '<img src=x onerror="window.hacked=1">');
  assert.equal(await page.evaluate(() => (window as { hacked?: number }).hacked), undefined);
});

test('owning and reading a book date it, and a read book can be rated', async () => {
  const row = page.locator('.book', { hasText: 'Typesetting' });
  await row.locator('[data-status=owned]').click();
  assert.equal(await row.locator('.seg').getAttribute('data-at'), 'owned');
  // The switch's four segments fit on one row of a phone.
  const tops = await row
    .locator('.seg button')
    .evaluateAll(els => els.map(e => e.getBoundingClientRect().top));
  assert.equal(new Set(tops).size, 1);
  await row.locator('[data-status=read]').click();
  await row.locator('.star').nth(3).click();
  assert.equal(await row.locator('.star.on').count(), 4);
  assert.equal(await row.locator('[data-status=read]').getAttribute('aria-checked'), 'true');
  assert.match((await text('.count')).replace(/\s+/g, ' ').trim(), /^1 book read in \d{4}$/);
  await row.locator('.title').click();
  const dates = row.locator('input[type=date]'); // Added, Acquired, Started, Finished
  assert.match(await dates.nth(1).inputValue(), /^\d{4}-\d\d-\d\d$/); // kept on reading
  assert.match(await dates.nth(2).inputValue(), /^\d{4}-\d\d-\d\d$/);
});

test('filters and search narrow the shelf, and the counts follow', async () => {
  // A filter's books glide in a frame later (a view transition): wait for them.
  await page.locator('.chip').nth(4).click(); // All, Want to read, Owned, Reading, Read
  await page.waitForFunction(() => document.querySelectorAll('.book').length === 1);
  assert.deepEqual(await titles(), ['Typesetting Mathematics']);
  await page.locator('.chip').nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll('.book').length === 3);
  await page.fill('[aria-label=Search]', 'family');
  assert.deepEqual(await titles(), ['Family recipes']);
  await page.fill('[aria-label=Search]', 'nothing like it');
  assert.match(await text('.empty'), /No book matches/);
  await page.fill('[aria-label=Search]', '');
  assert.match((await page.locator('.chip').nth(1).textContent()) ?? '', /2/);
});

test('Scan opens the camera sheet, which says when there is no camera, and Escape closes it', async () => {
  await page.click('.scan');
  await page.waitForSelector('text=/camera|Type the ISBN/i');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.scanner', { state: 'detached' });
});

test('History shows the books finished in a year, under the year', async () => {
  const year = String(new Date().getFullYear());
  await page.locator('.years .chip', { hasText: year }).click();
  await page.waitForFunction(() => document.querySelectorAll('.book').length === 1);
  assert.equal(await text('.year-card .year'), year);
  assert.deepEqual(await titles(), ['Typesetting Mathematics']);
  await page.locator('.chip').nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll('.book').length === 3);
});

test('the shelf is still there after a reload, with no page errors', async () => {
  await page.reload();
  await page.waitForSelector('.book');
  assert.equal((await titles()).length, 3);
  assert.equal(await page.locator('.star.on').count(), 4);
  // Each book's switch shows its own status, after a reload too.
  const statuses = await page.$$eval('.seg [aria-checked=true]', els =>
    els.map(e => (e as HTMLElement).dataset.status ?? ''),
  );

  test('the app opens offline once its service worker has it', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await page.reload(); // now the worker controls the page
    await page.waitForSelector('.book');
    const context = page.context();
    await context.setOffline(true);
    try {
      await page.reload();
      await page.waitForSelector('.book');
      assert.equal((await titles()).length, 3);
      assert.deepEqual(errors, []);
    } finally {
      await context.setOffline(false);
    }
  });
  assert.deepEqual(statuses.sort(), ['read', 'want', 'want']);
  assert.deepEqual(errors, []);
});

test('words are searched for, and a book found is added with a tap', async () => {
  await addIsbn('hobbit tolkien');
  await page.waitForSelector('.hit');
  assert.equal(await page.locator('.hit').count(), 2);
  assert.equal(await page.locator('.hit').nth(1).isDisabled(), true); // on the shelf already
  await page.locator('.hit').nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll('.book').length === 4);
  assert.equal((await titles())[0], 'The Hobbit');
  assert.equal(await page.$('.hits'), null);
});

test('Settings shows the version, and Escape closes it', async () => {
  await page.click('.gear');
  assert.match(await text('.facts dd'), /^[0-9a-f]{12}$/);
  await page.fill('.goal-field input', '12');
  await page.press('.goal-field input', 'Enter'); // a number field's change
  await page.locator('.goal-field input').blur();
  assert.match((await text('.count')).replace(/\s+/g, ' '), /1 of 12 books read/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.settings', { state: 'detached' });
});

test('a new version waits for Update, which reloads into it', async () => {
  const worker = new URL('../build/site/app/sw.js', import.meta.url);
  const before = await readFile(worker, 'utf8');
  await writeFile(worker, before + '\n// a new version\n');
  try {
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r?.update()));
    await page.waitForSelector('.toast');
    await Promise.all([page.waitForEvent('load'), page.click('.toast button')]);
    await page.waitForSelector('.book');
    assert.equal(await page.$('.toast'), null);
    assert.deepEqual(errors, []);
  } finally {
    await writeFile(worker, before);
  }
});

// Read again, the history editor and Up next, on a shelf of their own (a
// fresh browser context, so the shelf above is left as it was).
describe('history and Up next', () => {
  let p: Page;
  const DUNE = '9780306406157';
  const EMMA = '9780804429573';
  /** The book on p whose title has words. */
  const book = (words: string) => p.locator('.book', { hasText: words });
  /** The reading sessions listed in an open book's history. */
  const sessions = (words: string) => book(words).locator('.session');
  /** The titles on p's shelf, in order. */
  const shelved = () => p.$$eval('.book .title strong', els => els.map(e => e.textContent));
  /** Whether p is no wider than its viewport. */
  const fits = () => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

  before(async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    p = await context.newPage();
    p.on('pageerror', e => errors.push(e.message));
    const dune = newBook(DUNE, { title: 'Dune' }, 'owned', '2026-01-01');
    const shelf = [
      withStatus(withStatus(dune, 'reading', '2026-01-05'), 'read', '2026-01-20'),
      newBook(EMMA, { title: 'Emma' }, 'owned', '2026-01-01'),
    ];
    await p.goto(origin(server) + 'app/');
    await p.evaluate(books => localStorage.setItem('cuento.books', books), JSON.stringify(shelf));
    await p.reload();
    await p.waitForSelector('.book');
  });
  after(() => p.context().close());

  test('Read again starts a new read, and the earlier one stays', async () => {
    assert.equal(await book('Emma').locator('.again').count(), 0); // only Read books
    await book('Dune').locator('.again').click();
    assert.equal(await book('Dune').locator('.seg').getAttribute('data-at'), 'reading');
    await book('Dune').locator('.title').click();
    await sessions('Dune').nth(1).waitFor(); // it opens a frame later (a view transition)
    assert.deepEqual(await sessions('Dune').locator('.which').allTextContents(), [
      'Read 1',
      'Reading now',
    ]);
    const first = sessions('Dune').nth(0).locator('input');
    assert.equal(await first.nth(0).inputValue(), '2026-01-05');
    assert.equal(await first.nth(1).inputValue(), '2026-01-20');
    assert.equal(await sessions('Dune').nth(1).locator('input').nth(1).inputValue(), '');
  });

  test('the history is edited, backfilled and pruned, and History follows', async () => {
    const open = sessions('Dune').nth(1).locator('input');
    await open.nth(0).fill('2026-03-01');
    await open.nth(1).fill('2026-03-10'); // finished: the book is Read again
    assert.equal(await book('Dune').locator('.seg').getAttribute('data-at'), 'read');
    // A finish before its start is refused, and said so.
    await sessions('Dune').nth(0).locator('input').nth(1).fill('2025-12-01');
    assert.match(await book('Dune').locator('.history .note.bad').innerText(), /before it starts/);
    assert.equal(await sessions('Dune').nth(0).locator('input').nth(1).inputValue(), '2026-01-20');
    // A read from before cuento, added by hand, goes first.
    await book('Dune').locator('.add-past').click();
    await book('Dune').locator('.past input').nth(0).fill('2019-04-01');
    await book('Dune').locator('.past input').nth(1).fill('2019-05-01');
    await book('Dune').locator('.past button', { hasText: 'Add read' }).click();
    assert.deepEqual(await sessions('Dune').locator('.which').allTextContents(), [
      'Read 1',
      'Read 2',
      'Read 3',
    ]);
    assert.equal(await sessions('Dune').nth(0).locator('input').nth(1).inputValue(), '2019-05-01');
    assert.ok(await fits()); // the open book fits a phone
    await p.locator('.years .chip', { hasText: '2019' }).click();
    await p.waitForFunction(() => document.querySelectorAll('.book').length === 1);
    assert.match(await p.locator('.year-card .what').innerText(), /^1 book/);
    await p.locator('.chip').nth(0).click();
    await p.waitForFunction(() => document.querySelectorAll('.book').length === 2);
    // Removing it takes 2019 out of History.
    p.once('dialog', d => d.accept());
    await sessions('Dune').nth(0).locator('.forget').click();
    await p.waitForFunction(() => document.querySelectorAll('.session').length === 2);
    assert.equal(await p.locator('.years .chip', { hasText: '2019' }).count(), 0);
    // The acquisition date is edited here too, and may be blank.
    const acquired = book('Dune').locator('.history > .dates input');
    await acquired.fill('');
    assert.equal(await acquired.inputValue(), '');
  });

  test('Up next marks Want and Owned books, lists them, and clears on reading', async () => {
    assert.equal(await book('Dune').locator('.next').count(), 0); // a Read book
    const next = book('Emma').locator('.next');
    assert.equal(await next.getAttribute('aria-pressed'), 'false');
    await next.click();
    assert.equal(await next.getAttribute('aria-pressed'), 'true');
    const chip = p.locator('.chip', { hasText: 'Up next' });
    assert.match(await chip.innerText(), /1/);
    await chip.click();
    await p.waitForFunction(() => document.querySelectorAll('.book').length === 1);
    assert.deepEqual(await shelved(), ['Emma']);
    assert.ok(await fits());
    await p.reload(); // kept
    await p.waitForSelector('.book');
    assert.equal(await book('Emma').locator('.next').getAttribute('aria-pressed'), 'true');
    await p.locator('.chip', { hasText: 'Up next' }).click();
    await p.waitForFunction(() => document.querySelectorAll('.book').length === 1);
    await book('Emma').locator('[data-status=reading]').click();
    await p.waitForFunction(() => document.querySelectorAll('.book').length === 0);
    assert.match(await p.locator('.chip', { hasText: 'Up next' }).innerText(), /0/);
  });
});

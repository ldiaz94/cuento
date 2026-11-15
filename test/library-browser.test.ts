/* Your library in headless Chromium (playwright-core), on a shelf of four
 * put in storage: only the books owned are listed, an ISBN finds its book
 * in any form, the orders (unknown dates last), "—" for an unknown date,
 * Up next, and the history editor opened from a book, whose edits show on
 * the shelf. At 390px, light and dark, with a book open. CHROMIUM names
 * the browser. Runs build/site/ (robbie build first). Depends on
 * test/serve.ts and shelf.ts. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Server } from 'node:http';
import { serve, origin } from './serve.ts';
import { newBook, withStatus } from '../src/shelf.ts';

let server: Server, browser: Browser, page: Page;
const errors: string[] = [];

/** Dune (read once), Emma (owned, acquired unknown, Up next), Ulysses
 * (reading) and Zadie (only wanted). */
function shelf() {
  const dune = newBook(
    '9780306406157',
    { title: 'Dune', authors: ['Frank Herbert'] },
    'owned',
    '2024-05-01',
  );
  return [
    withStatus(withStatus(dune, 'reading', '2025-01-01'), 'read', '2025-01-10'),
    {
      ...newBook('9780804429573', { title: 'Emma' }, 'owned', '2025-03-03'),
      acquired: '',
      upNext: true,
    },
    withStatus(
      newBook('9791090636071', { title: 'Ulysses' }, 'owned', '2026-01-01'),
      'reading',
      '2026-01-02',
    ),
    newBook('9780261103344', { title: 'Zadie' }, 'want', '2026-01-01'),
  ];
}

before(async () => {
  server = await serve();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/sbin/chromium' });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-GB' });
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/openlibrary\.org|googleapis\.com/, route => route.abort());
  await page.goto(origin(server) + 'app/');
  await page.evaluate(
    books => localStorage.setItem('cuento.books', books),
    JSON.stringify(shelf()),
  );
  await page.reload();
  await page.waitForSelector('.book');
  await page.click('.views button:has-text("Library")');
  await page.waitForSelector('.volume');
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** The titles listed in the library, in order. */
const listed = () => page.$$eval('.volume .title strong', els => els.map(e => e.textContent));
/** Waits until the library lists titles, then says what it lists. */
async function waitFor(titles: string[]) {
  await page
    .waitForFunction(
      want =>
        JSON.stringify(
          [...document.querySelectorAll('.volume .title strong')].map(e => e.textContent),
        ) === JSON.stringify(want),
      titles,
      { timeout: 3000 },
    )
    .catch(() => {});
  return listed();
}
/** The book in the library whose title has words. */
const volume = (words: string) => page.locator('.volume', { hasText: words });
/** The facts under a book: Acquired, Last read and Times read. */
const facts = (words: string) => volume(words).locator('.when dd').allTextContents();
/** Whether the page is no wider than its viewport. */
const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('the library lists only the books owned, by title', async () => {
  assert.deepEqual(await listed(), ['Dune', 'Emma', 'Ulysses']);
  assert.equal(
    await page.getAttribute('.views button:has-text("Library")', 'aria-pressed'),
    'true',
  );
  assert.equal(await page.$('.book'), null); // the shelf is put away meanwhile
});

test('an ISBN finds its book with hyphens or without, 10 digits or 13', async () => {
  const search = page.locator('input[aria-label="Search your library"]');
  for (const isbn of ['0-306-40615-2', '9780306406157', '978-0-306-40615-7']) {
    await search.fill(isbn);
    assert.deepEqual(await waitFor(['Dune']), ['Dune'], isbn);
  }
  await search.fill('0804429573');
  assert.deepEqual(await waitFor(['Emma']), ['Emma']);
  await search.fill('herbert');
  assert.deepEqual(await waitFor(['Dune']), ['Dune']);
  await search.fill('');
  assert.deepEqual(await waitFor(['Dune', 'Emma', 'Ulysses']), ['Dune', 'Emma', 'Ulysses']);
});

test('the orders run both ways, with unknown dates last', async () => {
  const sort = (label: string) => page.click(`.sorts .chip:has-text("${label}")`);
  await sort('Acquired');
  assert.deepEqual(await waitFor(['Ulysses', 'Dune', 'Emma']), ['Ulysses', 'Dune', 'Emma']);
  await sort('Acquired'); // again: oldest first, Emma still last
  assert.deepEqual(await waitFor(['Dune', 'Ulysses', 'Emma']), ['Dune', 'Ulysses', 'Emma']);
  assert.match((await page.getAttribute('.sorts .chip.on', 'aria-label')) ?? '', /oldest first/);
  await sort('Last read');
  assert.deepEqual(await waitFor(['Dune', 'Emma', 'Ulysses']), ['Dune', 'Emma', 'Ulysses']);
  await sort('Title');
  await sort('Title'); // Z to A
  assert.deepEqual(await waitFor(['Ulysses', 'Emma', 'Dune']), ['Ulysses', 'Emma', 'Dune']);
  await sort('Title');
  assert.deepEqual(await waitFor(['Dune', 'Emma', 'Ulysses']), ['Dune', 'Emma', 'Ulysses']);
});

test('each book shows its dates and reads, "—" for what is unknown', async () => {
  assert.deepEqual(await facts('Dune'), ['1 May 2024', '10 Jan 2025', '1']);
  assert.deepEqual(await facts('Emma'), ['—', '—', '0']);
  assert.deepEqual(await facts('Ulysses'), ['1 Jan 2026', '—', '0']);
});

test('Up next narrows the library to the books marked', async () => {
  const chip = page.locator('.sorts .chip', { hasText: 'Up next' });
  assert.match(await chip.innerText(), /1/);
  await chip.click();
  assert.deepEqual(await waitFor(['Emma']), ['Emma']);
  assert.equal(await chip.getAttribute('aria-pressed'), 'true');
  await chip.click();
  assert.deepEqual(await waitFor(['Dune', 'Emma', 'Ulysses']), ['Dune', 'Emma', 'Ulysses']);
});

test('a book opens its history editor, and an edit there shows on the shelf', async () => {
  await volume('Emma').locator('.title').click();
  await volume('Emma').locator('.history').waitFor();
  assert.equal(await volume('Emma').locator('.title').getAttribute('aria-expanded'), 'true');
  await volume('Emma').locator('.history > .dates input').fill('2023-06-01');
  await volume('Emma').locator('.add-past').click();
  await volume('Emma').locator('.past input').nth(0).fill('2020-01-01');
  await volume('Emma').locator('.past input').nth(1).fill('2020-02-01');
  await volume('Emma').locator('.past button', { hasText: 'Add read' }).click();
  assert.deepEqual(await facts('Emma'), ['1 Jun 2023', '1 Feb 2020', '1']);
  assert.match(await volume('Emma').locator('.has').innerText(), /^Owned/); // a past read keeps it so
  await page.click('.views button:has-text("Shelf")');
  const emma = page.locator('.book', { hasText: 'Emma' });
  await emma.waitFor();
  assert.equal(await emma.locator('.seg').getAttribute('data-at'), 'owned');
  await emma.locator('.title').click();
  await emma.locator('.session').waitFor();
  assert.equal(await emma.locator('.history > .dates input').inputValue(), '2023-06-01');
  assert.deepEqual(await emma.locator('.session .which').allTextContents(), ['Read 1']);
  await page.click('.views button:has-text("Library")');
  await page.waitForSelector('.volume');
});

test('it fits a 390px phone with a book open, light and dark', async () => {
  if (!(await page.$('.volume .history'))) await volume('Dune').locator('.title').click();
  await page.waitForSelector('.volume .history');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    assert.ok(await fits(), scheme + ': the page scrolls sideways');
    const [bg, ink] = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('.volume')!);
      return [s.backgroundColor, s.color];
    });
    assert.notEqual(bg, ink, scheme + ': a book card is unreadable');
  }
  await page.setViewportSize({ width: 320, height: 640 });
  assert.ok(await fits(), 'the library scrolls sideways at 320px');
  await page.setViewportSize({ width: 390, height: 844 });
  const dark = await page.evaluate(
    () => getComputedStyle(document.querySelector('.volume')!).backgroundColor,
  );
  await page.emulateMedia({ colorScheme: 'light' });
  const light = await page.evaluate(
    () => getComputedStyle(document.querySelector('.volume')!).backgroundColor,
  );
  assert.notEqual(dark, light, 'the library follows the theme');
  assert.deepEqual(errors, []);
});

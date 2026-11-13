/* cuento in a real browser (headless Chromium through playwright-core),
 * with Open Library and Google Books faked: adding books, every note the
 * ISBN field gives, statuses and rating, filters and search, a reload, and
 * that a book's text never becomes HTML. CHROMIUM names the browser
 * (default /usr/sbin/chromium). Depends on test/serve.js. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { serve } from './serve.js';

/** What the fake Open Library knows, by ISBN-13. */
const LIBRARY = {
  9780306406157: {
    title: 'Typesetting Mathematics',
    authors: [{ name: 'A. Writer' }],
    number_of_pages: 210,
  },
  9780804429573: { title: '<img src=x onerror="window.hacked=1">', authors: [{ name: 'Mallory' }] },
};

let server, browser, page, origin;
/** Whether the fake services answer, or the network is down. */
let online = true;

before(async () => {
  server = await serve();
  origin = 'http://localhost:' + server.address().port + '/';
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/sbin/chromium' });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  await page.route(/openlibrary\.org|googleapis\.com/, route => {
    if (!online) return route.abort();
    const isbn = /ISBN:(\d+)|isbn:(\d+)/.exec(route.request().url()).slice(1).find(Boolean);
    const known = LIBRARY[isbn];
    return route.fulfill({
      json: route.request().url().includes('openlibrary')
        ? known
          ? { ['ISBN:' + isbn]: known }
          : {}
        : { totalItems: 0 },
    });
  });
  await page.goto(origin);
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** Types text in the ISBN field and adds it. */
async function addIsbn(text) {
  await page.fill('[aria-label=ISBN]', text);
  await page.click('.add form > button');
}
/** The titles on the shelf, in order. */
const titles = () => page.$$eval('.book .title strong', els => els.map(e => e.textContent));

test('an empty shelf says how to add a book', async () => {
  assert.match(await page.textContent('.empty'), /shelf is empty/);
});

test('a typed ISBN-10 is looked up and shelved as its ISBN-13', async () => {
  await addIsbn('0-306-40615-2');
  await page.waitForSelector('.book');
  assert.deepEqual(await titles(), ['Typesetting Mathematics']);
  assert.equal(await page.inputValue('[aria-label=ISBN]'), '');
  assert.equal(await page.$('.empty'), null);
});

test('the ISBN field says what is wrong', async () => {
  await addIsbn('12345');
  assert.match(await page.textContent('.add .note'), /isn't an ISBN/);
  await addIsbn('9780306406157');
  assert.match(await page.textContent('.add .note'), /on your shelf already/);
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
  assert.equal(await page.evaluate(() => window.hacked), undefined);
});

test('reading a book dates it, and a read book can be rated', async () => {
  const row = page.locator('.book', { hasText: 'Typesetting' });
  await row.locator('select').selectOption('read');
  await row.locator('.star').nth(3).click();
  assert.equal(await row.locator('.star.on').count(), 4);
  assert.equal(await row.locator('select').inputValue(), 'read');
  assert.match(await page.textContent('.count'), /^1 read this year/);
  await row.locator('.title').click();
  assert.match(await row.locator('input[type=date]').nth(2).inputValue(), /^\d{4}-\d\d-\d\d$/);
});

test('filters and search narrow the shelf, and the counts follow', async () => {
  await page.locator('.chip').nth(3).click(); // All, Want to read, Reading, Read
  assert.deepEqual(await titles(), ['Typesetting Mathematics']);
  await page.locator('.chip').nth(0).click();
  await page.fill('[aria-label=Search]', 'family');
  assert.deepEqual(await titles(), ['Family recipes']);
  await page.fill('[aria-label=Search]', 'nothing like it');
  assert.match(await page.textContent('.empty'), /No book matches/);
  await page.fill('[aria-label=Search]', '');
  assert.match(await page.locator('.chip').nth(1).textContent(), /2/);
});

test('the shelf is still there after a reload, with no page errors', async () => {
  await page.reload();
  await page.waitForSelector('.book');
  assert.equal((await titles()).length, 3);
  assert.equal(await page.locator('.star.on').count(), 4);
  // Each select shows its book's status (spark 0.1.0 showed the first option).
  const statuses = await page.$$eval('.book select', els => els.map(e => e.value));
  assert.deepEqual(statuses.sort(), ['read', 'want', 'want']);
  assert.deepEqual(page.errors, []);
});

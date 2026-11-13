/* The year in review in headless Chromium (playwright-core), on its own
 * page (test/fixtures/review.html) with fixed books whose covers' server
 * forbids drawing them: every card in turn by the arrow keys and by taps,
 * the shared picture (drawn without them, never tainted), and Escape.
 * Motion is reduced, so no card moves on by itself. CHROMIUM names the
 * browser. Runs build/site/ (robbie build first). Depends on test/serve.ts. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { serve, origin } from './serve.ts';
import { newBook } from '../src/shelf.ts';

/** Six books read in 2026: two by one author, rated, dated and paged. */
const BOOKS = [
  ['Middlemarch', 'George Eliot', 880, 5, '01-02', '02-20'],
  ['Piranesi', 'Susanna Clarke', 272, 5, '03-01', '03-04'],
  ['Foster', 'Claire Keegan', 88, 4, '03-10', '03-11'],
  ['Stoner', 'John Williams', 288, 3, '05-01', '05-20'],
  ['Small Things Like These', 'Claire Keegan', 116, 4, '07-01', '07-02'],
  ['Moby-Dick', 'Herman Melville', 720, 0, '08-01', '10-30'],
].map(([title, author, pages, rating, started, finished], i) => ({
  ...newBook(
    '978000000000' + i,
    { title: String(title), authors: [String(author)], pages: Number(pages) },
    'want',
  ),
  cover: 'https://covers.example/' + i + '.png',
  status: 'read',
  rating,
  started: '2026-' + started,
  finished: '2026-' + finished,
}));
/** The cards these books make, in order. */
const CARDS = ['opening', 'tally', 'months', 'favourites', 'records', 'pace', 'closing'];

let server: Server, browser: Browser, page: Page;
/** Errors the page threw. */
const errors: string[] = [];

before(async () => {
  server = await serve();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/sbin/chromium' });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  page.on('pageerror', e => errors.push(e.message));
  // Covers that show on the page but, with no CORS header, may not be drawn.
  const png = await readFile(new URL('../public/icon-192.png', import.meta.url));
  await page.route('https://covers.example/**', route =>
    route.fulfill({ contentType: 'image/png', body: png }),
  );
  await page.route('**/review.html', route =>
    route.fulfill({ path: new URL('fixtures/review.html', import.meta.url).pathname }),
  );
  await page.addInitScript(books => Object.assign(window, { YEAR: 2026, BOOKS: books }), BOOKS);
  await page.goto(origin(server) + 'review.html');
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** The class naming the card shown. */
const card = () => page.$eval('.card', el => el.classList[2]);

test('the arrow keys go through every card, and back', async () => {
  assert.equal(await page.locator('.bars span').count(), CARDS.length);
  for (const name of CARDS.slice(1)) {
    await page.keyboard.press('ArrowRight');
    assert.equal(await card(), name);
  }
  await page.keyboard.press('ArrowRight'); // past the last, it stays
  assert.equal(await card(), 'closing');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await card(), 'pace');
});

test('a tap on the left half goes back, on the right half goes on', async () => {
  await page.mouse.click(60, 600);
  assert.equal(await card(), 'records');
  await page.mouse.click(330, 600);
  assert.equal(await card(), 'pace');
  assert.match((await page.textContent('.pace')) ?? '', /A book every\s*\d+\s*days/);
});

test('Share saves a 1080x1920 picture, drawn without the covers it may not use', async () => {
  await page.keyboard.press('ArrowRight');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.share')]);
  assert.equal(download.suggestedFilename(), 'cuento-2026.png');
  const file = await readFile((await download.path()) ?? '');
  assert.equal(file.toString('latin1', 1, 4), 'PNG');
  assert.deepEqual([file.readUInt32BE(16), file.readUInt32BE(20)], [1080, 1920]);
});

test('Escape closes it, with no page errors', async () => {
  await page.keyboard.press('Escape');
  await page.waitForSelector('.review', { state: 'detached' });
  assert.equal(await page.getAttribute('body', 'data-closed'), '');
  assert.deepEqual(errors, []);
});

/* The README's pictures, from fixed books, so they are the same every run:
 * node test/shots.js (robbie shots) writes doc/img/shelf-light.png and
 * shelf-dark.png at phone size. Depends on test/serve.js and
 * playwright-core (CHROMIUM names the browser). */
import { chromium } from 'playwright-core';
import { serve } from './serve.js';

/** The shelf pictured: one book of each status, without covers. */
const BOOKS = [
  ['9780306406157', 'The Left Hand of Darkness', 'Ursula K. Le Guin', 'reading', 0, ''],
  ['9780804429573', 'Pedro Páramo', 'Juan Rulfo', 'read', 5, 'Comala.'],
  ['9780140449136', 'Crime and Punishment', 'Fyodor Dostoevsky', 'want', 0, ''],
  ['9780141439518', 'Pride and Prejudice', 'Jane Austen', 'read', 4, ''],
].map(([isbn, title, author, status, rating, notes]) => ({
  isbn,
  title,
  authors: [author],
  cover: '',
  pages: null,
  published: '',
  status,
  added: '2026-10-01',
  started: status === 'want' ? '' : '2026-10-02',
  finished: status === 'read' ? '2026-10-20' : '',
  rating,
  notes,
}));

const server = await serve();
const url = 'http://localhost:' + server.address().port + '/';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/usr/sbin/chromium',
});
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 720 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  // A fixed "today", so "read this year" counts the same books every run.
  await page.clock.setFixedTime(new Date('2026-11-13T12:00:00'));
  await page.goto(url);
  await page.evaluate(books => localStorage.setItem('cuento.books', JSON.stringify(books)), BOOKS);
  await page.reload();
  await page.locator('.book').nth(1).locator('.title').click();
  await page.screenshot({ path: 'doc/img/shelf-' + scheme + '.png' });
}
await browser.close();
server.close();

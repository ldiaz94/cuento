/* Shopping in headless Chromium (playwright-core): the Settings section
 * (format, favourite stores, location) kept on this device and across a
 * reload, and Where to buy on a Want book: links ordered by a favourite,
 * nearby ones only with a location, none on any other status, and the
 * disclaimer. At 390px, light and dark. The book is added by ISBN through
 * a faked Open Library. CHROMIUM names the browser. Runs build/site/
 * (robbie build first). Depends on test/serve.ts. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Server } from 'node:http';
import { serve, origin } from './serve.ts';

let server: Server, browser: Browser, page: Page;
const errors: string[] = [];

before(async () => {
  server = await serve();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/sbin/chromium' });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-GB' });
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/openlibrary\.org|googleapis\.com/, route => {
    const url = route.request().url();
    if (url.includes('googleapis')) return route.fulfill({ json: { totalItems: 0 } });
    const isbn = /isbn:(\d+)/i.exec(url)?.[1] || '';
    return route.fulfill({
      json: {
        ['ISBN:' + isbn]: { title: 'Typesetting Mathematics', authors: [{ name: 'A. Writer' }] },
      },
    });
  });
  await page.goto(origin(server) + 'app/');
  await page.fill('.add form input', '9780306406157');
  await page.click('.add form > button');
  await page.waitForSelector('.book');
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** Opens Settings and runs what, then closes it. */
async function inSettings(what: () => Promise<void>) {
  await page.click('.gear');
  await page.waitForSelector('.shopping');
  await what();
  await page.click('.settings .done');
}
/** The labels of the links under the open book. */
const links = () => page.$$eval('.buy-links a', as => as.map(a => a.textContent ?? ''));
/** Opens the first book's details and reveals Where to buy, whatever was open before. */
async function reveal() {
  if (!(await page.$('.details'))) await page.click('.book .title');
  if (!(await page.$('.buy-links'))) await page.click('.buy-toggle');
  await page.waitForSelector('.buy-links');
}

test('preferences persist across a reload', async () => {
  await inSettings(async () => {
    await page.click('.shop-format [role=radio]:has-text("Ebook")');
    await page.click('.shop-suggest button:has-text("Waterstones")');
    await page.fill('input[aria-label="Another store"]', 'My Local Shop');
    await page.click('.shop-custom button');
    await page.click('[aria-label="Move My Local Shop up"]');
  });
  await page.reload();
  await page.click('.gear');
  await page.waitForSelector('.shopping');
  assert.deepEqual(await page.$$eval('.shop-stores li span', e => e.map(x => x.textContent)), [
    'My Local Shop',
    'Waterstones',
  ]);
  assert.equal(
    await page.getAttribute('.shop-format [role=radio]:has-text("Ebook")', 'aria-checked'),
    'true',
  );
  const kept = await page.evaluate(() => localStorage.getItem('cuento.shopping'));
  assert.equal(JSON.parse(kept!).stores[0], 'My Local Shop');
  await page.click('.settings .done');
});

test('a Want book lists searches, favourites first, with the disclaimer and safe links', async () => {
  await reveal();
  const labels = await links();
  assert.equal(labels[0], 'Search the web for My Local Shop');
  assert.ok(labels[1]!.startsWith('Search Waterstones'));
  assert.ok(!labels.some(l => l.includes('near')), 'no nearby links without a location');
  assert.match((await page.textContent('.buy .hint')) ?? '', /Searches, not prices/);
  const a = page.locator('.buy-links a').first();
  assert.equal(await a.getAttribute('target'), '_blank');
  assert.equal(await a.getAttribute('rel'), 'noopener noreferrer');
});

test('a location adds nearby links after the online ones', async () => {
  await inSettings(async () => {
    await page.fill('.shop-location input', 'Leeds');
    await page.press('.shop-location input', 'Tab');
  });
  await reveal();
  const labels = await links();
  const nearby = (l: string) => l.includes('near') || l.includes('WorldCat');
  const first = labels.findIndex(nearby);
  assert.ok(first > 0);
  assert.ok(labels.slice(first).every(nearby));
  assert.ok(labels.some(l => l.includes('Leeds')));
});

test('it fits at 390px in light and dark, and only Want books have it', async () => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await reveal();
    assert.equal(
      await page.evaluate(() =>
        [...document.querySelectorAll('.buy-toggle, .buy-links, .buy-links *')].some(
          e => e.getBoundingClientRect().right > innerWidth,
        ),
      ),
      false,
      scheme + ': Where to buy runs off the screen',
    );
    await page.click('.gear');
    await page.waitForSelector('.shopping');
    assert.equal(
      await page.evaluate(() => {
        const s = document.querySelector('.settings') as HTMLElement;
        return s.scrollWidth > s.clientWidth;
      }),
      false,
    );
    await page.click('.settings .done');
  }
  for (const status of ['owned', 'reading', 'read']) {
    await page.click(`.book [data-status=${status}]`);
    assert.equal(await page.$('.buy-toggle'), null, status + ' shows Where to buy');
    assert.equal(await page.$('.buy-links'), null);
  }
  await page.click('.book [data-status=want]');
  assert.ok(await page.$('.buy-toggle'));
  assert.deepEqual(errors, []);
});

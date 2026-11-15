/* Shopping in headless Chromium (playwright-core): the Settings section
 * (format, favourite stores, location) kept on this device and across a
 * reload, and synced with the shelf through a faked /api/shelf backed by
 * worker/store.ts (a change from another device redraws Settings and
 * Where to buy), and Where to buy on a Want book: only the favourites, a priced
 * store's card with its price from a faked /api/prices (asked with the
 * ISBN, store ids and region, never the location), searches for the rest,
 * nearby ones only with a location, none on any other status, and the
 * note. At 390px and 320px, light and dark. The book is added by ISBN
 * through a faked Open Library. CHROMIUM names the browser. Runs
 * build/site/ (robbie build first). Depends on test/serve.ts. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { serve, origin } from './serve.ts';
import { setUp, parse, apply, applySettings, applyPrefs, changedSince } from '../worker/store.ts';
import type { Sql } from '../worker/store.ts';

let server: Server, browser: Browser, page: Page;
const errors: string[] = [];
/** Every /api/prices URL the page asked for. */
const asked: string[] = [];
/** The shelf's store, as the Worker keeps it, behind a faked /api/shelf/<code>/sync. */
const db = new DatabaseSync(':memory:');
const shelf: Sql = (query, ...params) => db.prepare(query).all(...params);
setUp(shelf);
/** A sync code (26 characters of Crockford's base32). */
const CODE = '0123456789ABCDEFGHJKMNPQRS';

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
  await page.route('**/api/prices?*', route => {
    asked.push(route.request().url());
    return route.fulfill({
      json: {
        isbn: '9780306406157',
        region: 'GB',
        results: {
          'apple-books': {
            status: 'found',
            checked: 1,
            offer: {
              price: 4.99,
              currency: 'GBP',
              url: 'https://books.apple.com/gb/book/x/id1',
              image: '',
              format: 'ebook',
            },
          },
        },
      },
    });
  });
  await page.route('**/api/shelf/*/sync', route => {
    const sync = parse(JSON.parse(route.request().postData() || 'null'));
    if (!sync) return route.fulfill({ status: 400, body: 'Not a sync.' });
    apply(shelf, sync.changes);
    if (sync.settings) applySettings(shelf, sync.settings);
    if (sync.prefs) applyPrefs(shelf, sync.prefs);
    return route.fulfill({ json: changedSince(shelf, sync.since, sync.version) });
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
/** The stores under the open book: cards, then searches. */
const stores = () =>
  page.$$eval('.wtb-store, .wtb-tile-name', es =>
    es.map(e => e.firstChild?.textContent?.trim() ?? ''),
  );
/** Opens the first book's details and reveals Where to buy, whatever was open before. */
async function reveal() {
  if (!(await page.$('.details'))) await page.click('.book .title');
  if (!(await page.$('.wtb'))) await page.click('.buy-toggle');
  await page.waitForSelector('.wtb');
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

test('a Want book shows only the favourites, as searches, with More stores and the note', async () => {
  await reveal();
  assert.deepEqual(await stores(), ['My Local Shop', 'Waterstones']);
  assert.equal(await page.$('.wtb-near'), null, 'no nearby links without a location');
  assert.equal(asked.length, 0, 'no priced store: no prices asked');
  assert.match((await page.textContent('.wtb-note')) ?? '', /Prices come from each store/);
  const a = page.locator('.wtb-tile').first();
  assert.equal(await a.getAttribute('target'), '_blank');
  assert.equal(await a.getAttribute('rel'), 'noopener noreferrer');
  assert.match((await a.getAttribute('href')) ?? '', /^https:\/\/duckduckgo\.com\//);
  await page.click('.wtb-more summary');
  assert.ok(
    (await page.$$eval('.wtb-more a', as => as.map(a => a.textContent ?? ''))).some(t =>
      t.includes('Kobo'),
    ),
  );
});

test('a priced favourite shows the book, its price and the store, asked without the location', async () => {
  await inSettings(async () => {
    await page.click('.shop-suggest button:has-text("Apple Books")');
    await page.fill('.shop-location input', 'Leeds');
    await page.press('.shop-location input', 'Tab');
  });
  await reveal();
  await page.waitForSelector('.wtb-card:not(.is-loading)');
  assert.equal(await page.textContent('.wtb-card .wtb-store'), 'Apple Books');
  assert.equal(await page.textContent('.wtb-card .wtb-price'), '£4.99');
  assert.equal(await page.textContent('.wtb-card .wtb-title'), 'Typesetting Mathematics');
  assert.equal(
    await page.getAttribute('.wtb-card', 'href'),
    'https://books.apple.com/gb/book/x/id1',
  );
  assert.deepEqual(await stores(), ['Apple Books', 'My Local Shop', 'Waterstones']);
  assert.ok(asked.length >= 1);
  for (const url of asked) {
    const q = new URL(url).searchParams;
    assert.deepEqual([...q.keys()], ['isbn', 'region', 'stores']);
    assert.deepEqual(
      [q.get('isbn'), q.get('region'), q.get('stores')],
      ['9780306406157', 'GB', 'apple-books'],
    );
    assert.ok(!url.includes('Leeds'));
  }
});

test('a location adds nearby searches', async () => {
  await reveal();
  const near = await page.$$eval('.wtb-near a', as => as.map(a => a.textContent ?? ''));
  assert.ok(near.some(l => l.includes('Leeds')));
  assert.ok(near.some(l => l.includes('WorldCat')));
});

test('preferences, the location too, sync with the shelf; another device’s redraw them', async () => {
  await page.evaluate(code => localStorage.setItem('cuento.sync', code), CODE);
  await page.reload();
  await page.waitForSelector('.book');
  const prefsRow = () =>
    shelf('SELECT data, updated FROM prefs WHERE id = 1')[0] as
      | { data: string; updated: number }
      | undefined;
  for (let i = 0; i < 50 && !prefsRow(); i++) await page.waitForTimeout(100);
  assert.deepEqual(JSON.parse(prefsRow()!.data), {
    format: 'ebook',
    stores: ['My Local Shop', 'waterstones', 'apple-books'],
    location: 'Leeds',
  });

  // Another device, later, picks print, Kobo and York.
  applyPrefs(shelf, {
    data: { format: 'print', stores: ['kobo'], location: 'York' },
    updated: prefsRow()!.updated + 1000,
  });
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await reveal();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.wtb-near a')].some(a => a.textContent?.includes('York')),
  );
  assert.deepEqual(await stores(), ['Kobo']);
  await page.click('.gear');
  await page.waitForSelector('.shopping');
  assert.equal(await page.inputValue('.shop-location input'), 'York');
  assert.deepEqual(await page.$$eval('.shop-stores li span', e => e.map(x => x.textContent)), [
    'Kobo',
  ]);
  assert.equal(
    await page.getAttribute('.shop-format [role=radio]:has-text("Print")', 'aria-checked'),
    'true',
  );
  const kept = JSON.parse((await page.evaluate(() => localStorage.getItem('cuento.shopping')))!);
  assert.equal(kept.location, 'York');

  // A change here goes back to the shelf.
  await page.fill('.shop-location input', 'Bath');
  await page.press('.shop-location input', 'Tab');
  await page.click('.settings .done');
  for (let i = 0; i < 50 && JSON.parse(prefsRow()!.data).location !== 'Bath'; i++)
    await page.waitForTimeout(100);
  assert.equal(JSON.parse(prefsRow()!.data).location, 'Bath');
  for (const url of asked) assert.ok(!/Leeds|York|Bath/.test(url), 'a location sent for prices');
  await page.evaluate(() => localStorage.removeItem('cuento.sync'));
});

test('it fits at 390px and 320px in light and dark, and only Want books have it', async () => {
  for (const [scheme, width] of [
    ['light', 390],
    ['dark', 390],
    ['light', 320],
    ['dark', 320],
  ] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: scheme });
    await reveal();
    assert.equal(
      await page.evaluate(() =>
        [...document.querySelectorAll('.buy-toggle, .wtb, .wtb *')].some(
          e => e.getBoundingClientRect().right > innerWidth,
        ),
      ),
      false,
      `${scheme} ${width}: Where to buy runs off the screen`,
    );
    await page.click('.gear');
    await page.waitForSelector('.shopping');
    assert.equal(
      await page.evaluate(() => {
        const s = document.querySelector('.settings') as HTMLElement;
        return s.scrollWidth > s.clientWidth;
      }),
      false,
      `${scheme} ${width}: Settings scrolls sideways`,
    );
    await page.click('.settings .done');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const status of ['owned', 'reading', 'read']) {
    await page.click(`.book [data-status=${status}]`);
    assert.equal(await page.$('.buy-toggle'), null, status + ' shows Where to buy');
    assert.equal(await page.$('.wtb'), null);
  }
  await page.click('.book [data-status=want]');
  assert.ok(await page.$('.buy-toggle'));
  assert.deepEqual(errors, []);
});

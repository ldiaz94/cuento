/* Reminders' Settings section in headless Chromium (playwright-core),
 * mounted on its own in the app's page: off at first, asking for
 * permission only when a switch is tapped, subscribing with the server's
 * VAPID key, and telling the server each change. The push service and
 * cuento's server are faked (pushManager's subscribe, page routes for
 * /api/push/), and so is the permission prompt, which headless Chromium
 * can't show. And an iPhone's Safari, where reminders need the Home
 * Screen. CHROMIUM names the browser. Runs build/site/ (robbie build
 * first). Depends on test/serve.ts. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Server } from 'node:http';
import { serve, origin } from './serve.ts';

/** The VAPID public key the fake server gives (a P-256 point, base64url). */
const KEY =
  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';

let server: Server, browser: Browser, page: Page;
/** What the page posted to /api/push/, in order: path and body. */
const posted: [string, Record<string, unknown>][] = [];

/** Fakes, before the page's scripts: a permission that turns to granted
 * when asked (counting the asks), and a pushManager that keeps the key it
 * was given and makes up a subscription. */
function fakes() {
  const w = window as unknown as { asked: number; key: number[] };
  let permission: NotificationPermission = 'default';
  w.asked = 0;
  Object.defineProperty(Notification, 'permission', { get: () => permission });
  Notification.requestPermission = async () => {
    w.asked++;
    return (permission = 'granted');
  };
  let made: PushSubscription | null = null;
  PushManager.prototype.getSubscription = async () => made;
  PushManager.prototype.subscribe = async options => {
    w.key = [...new Uint8Array(options!.applicationServerKey as ArrayBuffer)];
    const endpoint = 'https://push.example/send/abc';
    const keys = { p256dh: 'p', auth: 'a' };
    made = {
      endpoint,
      toJSON: () => ({ endpoint, keys }),
      unsubscribe: async () => !(made = null),
    } as unknown as PushSubscription;
    return made;
  };
}

/** The section, mounted in a Settings-like sheet in the page. */
async function mountSection(p: Page) {
  await p.evaluate(async () => {
    const { mount } = await import('./spark/index.js' as string);
    const { remindersSection } = await import('./remindersView.js' as string);
    const sheet = document.createElement('div');
    sheet.className = 'settings';
    document.body.append(sheet);
    mount(sheet, remindersSection);
  });
}

before(async () => {
  server = await serve();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/sbin/chromium' });
  const context = await browser.newContext();
  await context.grantPermissions(['notifications'], { origin: origin(server) });
  page = await context.newPage();
  await page.addInitScript(fakes);
  await page.route('**/api/push/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/push/key') return route.fulfill({ json: { key: KEY } });
    posted.push([path, route.request().postDataJSON()]);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(origin(server) + 'app/');
  await mountSection(page);
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** What the page holds in its global name. */
const global = (name: string) => page.evaluate(n => (window as never)[n], name);
/** The switch labelled name. */
const toggle = (name: string) => page.getByRole('switch', { name });

test('reminders start off, and nothing is asked until a tap', async () => {
  await page.waitForSelector('.reminders h3');
  assert.equal(await toggle('Remind me to read').isChecked(), false);
  assert.equal(await toggle('Tell me when my Year in review is ready').isChecked(), false);
  assert.equal(await page.$('.reminders input[type=time]'), null);
  assert.equal(await global('asked'), 0);
  assert.deepEqual(posted, []);
});

test('a tap asks, subscribes with the VAPID key, and tells the server', async () => {
  await toggle('Remind me to read').click();
  await page.waitForSelector('text=Send a test');
  assert.equal(await global('asked'), 1);
  assert.deepEqual(await global('key'), [...Buffer.from(KEY, 'base64url')]);
  const [path, body] = posted.at(-1)!;
  assert.equal(path, '/api/push/subscribe');
  assert.deepEqual(body.prefs, {
    enabled: true,
    time: '21:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    review: false,
  });
  assert.equal(typeof body.tz, 'string');
  assert.deepEqual(body.subscription, {
    endpoint: 'https://push.example/send/abc',
    keys: { p256dh: 'p', auth: 'a' },
  });
  assert.equal(await page.inputValue('.reminders input[type=time]'), '21:00');
});

test('days and time go to the server, and are kept on the device', async () => {
  await page.click('.reminder-days >> text=Mon');
  await page.waitForFunction(() => document.querySelector('[aria-pressed=false]'));
  await page.fill('.reminders input[type=time]', '07:30');
  await page.waitForFunction(() => localStorage.getItem('cuento.reminders')?.includes('07:30'));
  const [path, body] = posted.at(-1)!;
  assert.equal(path, '/api/push/prefs');
  assert.equal(body.endpoint, 'https://push.example/send/abc');
  assert.deepEqual(body.prefs, {
    enabled: true,
    time: '07:30',
    days: [0, 2, 3, 4, 5, 6],
    review: false,
  });
  assert.equal(await global('asked'), 1); // allowed once, never asked again
});

test('a test is sent; turning both off unsubscribes', async () => {
  await page.click('text=Send a test');
  await page.waitForSelector('text=Sent:');
  assert.equal(posted.at(-1)![0], '/api/push/test');
  await toggle('Remind me to read').click();
  await page.waitForFunction(() => !document.querySelector('.reminders input[type=time]'));
  assert.deepEqual(posted.at(-1), [
    '/api/push/unsubscribe',
    { endpoint: 'https://push.example/send/abc' },
  ]);
  assert.equal(await page.$('text=Send a test'), null);
});

test('on an iPhone, in Safari, it says to add cuento to the Home Screen', async () => {
  const iphone = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  await iphone.addInitScript(() => delete (window as { PushManager?: unknown }).PushManager);
  await iphone.goto(origin(server) + 'app/');
  await mountSection(iphone);
  await iphone.waitForSelector('text=Add to Home Screen');
  assert.equal(await iphone.$('.reminders [role=switch]'), null);
  await iphone.close();
});

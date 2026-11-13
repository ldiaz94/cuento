/* The landing page's sharing picture (Open Graph and Twitter cards):
 * node landing/og.ts draws a page in headless Chromium and writes it to
 * landing/img/og.png, 1200 by 630. Tilde and the name on paper, beside a
 * shelf of cloth spines on red bookcloth. Depends on playwright-core
 * (CHROMIUM names the browser), the app's fonts in public/fonts/ and
 * Tilde in doc/img/logo.svg. Leaves out the cloth's weave and the
 * paper's light, which would treble the file. */
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

/** A file of the repository, by its path from the root. */
const here = (path: string) => new URL('../' + path, import.meta.url);

/** A font from public/fonts/, as a data URL the page can load. */
async function font(name: string): Promise<string> {
  const bytes = await readFile(here('public/fonts/' + name));
  return 'data:font/woff2;base64,' + bytes.toString('base64');
}

const tilde = (await readFile(here('doc/img/logo.svg'), 'utf8')).replace(/<title>.*?<\/title>/, '');
const fraunces = await font('fraunces-latin-full-normal.woff2');
const sans = await font('instrument-sans-latin-wght-normal.woff2');

/** The spines on the shelf: their cloth and height in pixels. */
const SPINES: [string, number][] = [
  ['#7d2f2b', 250],
  ['#26476e', 296],
  ['#a27b2c', 228],
  ['#2f5e4a', 276],
  ['#5d3b66', 310],
  ['#1f6164', 240],
  ['#9b4b25', 286],
  ['#4b5762', 262],
];

const html = `<!doctype html>
<style>
  @font-face { font-family: Fraunces; font-weight: 100 900; src: url(${fraunces}); }
  @font-face { font-family: Sans; font-weight: 400 700; src: url(${sans}); }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; display: flex; overflow: hidden;
    background: #f7f2e8;
    color: #2a241d; font-family: Sans;
  }
  .paper { flex: 1; padding: 64px 0 0 72px; }
  .kicker { color: #b5532c; font: 600 20px Sans; letter-spacing: .18em; text-transform: uppercase; }
  .name { display: flex; align-items: flex-end; gap: 6px; margin-top: 26px; }
  .name svg { width: 190px; height: 190px; }
  h1 {
    font: 750 190px/0.78 Fraunces; letter-spacing: -.045em;
    font-variation-settings: 'SOFT' 100, 'WONK' 1, 'opsz' 144;
    margin-bottom: 14px;
  }
  .lede {
    margin-top: 44px; font: 560 54px/1.05 Fraunces; letter-spacing: -.015em;
    font-variation-settings: 'SOFT' 100, 'WONK' 1;
  }
  .lede span { color: #b5532c; }
  .url { margin-top: 30px; color: #6b6054; font: 600 24px Sans; letter-spacing: .04em; }
  .cloth {
    position: relative; width: 360px; display: flex; align-items: flex-end;
    justify-content: center; gap: 5px; padding-bottom: 92px;
    background:
      radial-gradient(ellipse at 50% 20%, #ffffff1c, #0000 55%, #00000059 100%), #7d2f2b;
  }
  .cloth::before {
    content: ''; position: absolute; inset: 18px; border: 2px solid #e2c06e; border-radius: 10px;
    box-shadow: inset 0 0 0 8px transparent, inset 0 0 0 9.5px #e2c06e80;
  }
  .cloth::after {
    content: ''; position: absolute; left: 34px; right: 34px; bottom: 78px; height: 16px;
    background: linear-gradient(#b07a47, #6b4426); box-shadow: 0 6px 10px #0005;
  }
  .cloth i {
    width: 30px; border-radius: 4px 4px 0 0;
    background:
      linear-gradient(transparent 9%, #e2c06ecc 9% 11.5%, transparent 11.5% 82%, #e2c06ecc 82% 84.5%, transparent 84.5%),
      linear-gradient(90deg, #ffffff30, transparent 45%, #00000050), var(--c);
    box-shadow: 0 0 0 1.5px #00000040;
  }
</style>
<div class="paper">
  <p class="kicker">un cuento, a story · cuento, I count</p>
  <div class="name">${tilde}<h1>cuento</h1></div>
  <p class="lede">Count the books you read.<br><span>Keep the story.</span></p>
  <p class="url">cuento.page</p>
</div>
<div class="cloth">${SPINES.map(([c, h]) => `<i style="--c: ${c}; height: ${h}px"></i>`).join('')}</div>`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/usr/sbin/chromium',
});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: new URL('img/og.png', import.meta.url).pathname });
await browser.close();

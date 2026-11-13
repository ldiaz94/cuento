/* The scanner reading a real barcode in headless Chromium: an EAN-13 of
 * 9780306406157 is drawn, screenshot and made into a video with ffmpeg,
 * which Chromium offers as its fake camera; with BarcodeDetector deleted
 * scan() must take the zxing-wasm path and find the ISBN. Also that a
 * camera that can't be had gives a ScanError, and a stop aborts. Runs
 * build/site/ (robbie build first); needs ffmpeg. CHROMIUM names the
 * browser (default /usr/sbin/chromium). Depends on test/serve.ts. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import type { Server } from 'node:http';
import { serve, origin } from './serve.ts';

/** The ISBN drawn. */
const ISBN = '9780306406157';
/** Bar patterns of the digits 0-9: left-hand odd (L), left-hand even (G)
 * and right-hand (R), as 7 modules each, 1 for a bar. */
const L = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
];
const G = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
];
const R = L.map(p => [...p].map(b => (b === '1' ? '0' : '1')).join(''));
/** Which of the six left digits are G-coded, by the first digit. */
const PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
];

/** The modules of an EAN-13 (guards, six left, middle, six right). */
function modules(digits: string): string {
  const parity = PARITY[Number(digits[0])] as string;
  let m = '101';
  for (let i = 0; i < 6; i++) m += (parity[i] === 'L' ? L : G)[Number(digits[i + 1])];
  m += '01010';
  for (let i = 7; i < 13; i++) m += R[Number(digits[i])];
  return m + '101';
}

/** An SVG page of the barcode, black on white with a quiet zone. */
function barcodeSvg(digits: string): string {
  const bars = [...modules(digits)]
    .map((b, i) => (b === '1' ? `<rect x="${60 + i * 4}" y="100" width="4" height="280"/>` : ''))
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#fff"/>${bars}</svg>`;
}

/** The built scanner's address on the page (passed in, so tsc leaves it be). */
const SCANNER = '/scan.js';
/** The scanner's module, as the page imports it. */
type Scanner = typeof import('../src/scan.ts');

let server: Server, browser: Browser, dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cuento-scan-'));
  const chromiumPath = process.env.CHROMIUM || '/usr/sbin/chromium';
  const shooter = await chromium.launch({ executablePath: chromiumPath });
  const page = await shooter.newPage({ viewport: { width: 640, height: 480 } });
  await page.setContent(`<body style="margin:0">${barcodeSvg(ISBN)}</body>`);
  await page.screenshot({ path: join(dir, 'code.png') });
  await shooter.close();
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-loop',
    '1',
    '-i',
    join(dir, 'code.png'),
    '-t',
    '2',
    '-r',
    '10',
    '-pix_fmt',
    'yuvj420p',
    join(dir, 'code.mjpeg'),
  ]);
  server = await serve();
  browser = await chromium.launch({
    executablePath: chromiumPath,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${join(dir, 'code.mjpeg')}`,
    ],
  });
});

after(async () => {
  await browser?.close();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The built scanner, on a page of our origin with a video and no BarcodeDetector. */
async function scanPage() {
  const page = await browser.newPage();
  await page.route('**/blank.html', route =>
    route.fulfill({ contentType: 'text/html', body: '<video id="v"></video>' }),
  );
  await page.goto(origin(server) + 'blank.html');
  await page.evaluate(() => delete (window as { BarcodeDetector?: unknown }).BarcodeDetector);
  return page;
}

test('zxing-wasm reads the ISBN from the camera and the camera is stopped', async () => {
  const page = await scanPage();
  const result = await page.evaluate(async scanner => {
    const { scan } = (await import(scanner)) as Scanner;
    const video = document.getElementById('v') as HTMLVideoElement;
    const isbn = await scan(video, new AbortController().signal);
    return { isbn, released: video.srcObject === null };
  }, SCANNER);
  assert.deepEqual(result, { isbn: ISBN, released: true });
  await page.close();
});

test('a stop aborts the scan with an AbortError and ends the camera', async () => {
  const page = await scanPage();
  const result = await page.evaluate(async scanner => {
    const { scan } = (await import(scanner)) as Scanner;
    // a blank camera never shows a code, so only the stop can end the scan
    const stream = document.createElement('canvas').captureStream();
    navigator.mediaDevices.getUserMedia = () => Promise.resolve(stream);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 700);
    const name = await scan(document.getElementById('v') as HTMLVideoElement, stop.signal).then(
      () => 'resolved',
      e => e.name,
    );
    return { name, ended: stream.getTracks().every(t => t.readyState === 'ended') };
  }, SCANNER);
  assert.deepEqual(result, { name: 'AbortError', ended: true });
  await page.close();
});

test('no camera gives a ScanError', async () => {
  const page = await scanPage();
  const reason = await page.evaluate(async scanner => {
    const { scan } = (await import(scanner)) as Scanner;
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('no', 'NotFoundError'));
    return scan(
      document.getElementById('v') as HTMLVideoElement,
      new AbortController().signal,
    ).catch(e => `${e.name}:${e.reason}`);
  }, SCANNER);
  assert.equal(reason, 'ScanError:none');
  await page.close();
});

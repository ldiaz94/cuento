/* The landing page's pictures of the app, from fixed books, so they are
 * the same every run: node landing/shots.ts writes landing/img/shelf-light.webp,
 * shelf-dark.webp and review-<card>.webp from the built app (robbie build
 * first). The app is at build/site/app/, or at build/site/ before the
 * landing page moved it. Depends on test/serve.ts and playwright-core
 * (CHROMIUM names the browser). Leaves out the cards' motion: they are
 * taken with motion reduced, so each stands as it ends. */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright-core';
import { serve, origin } from '../test/serve.ts';

/** A book on the fixed shelf. */
type Row = [string, string, string, string, number, number, string, string];

/** The year's books: ISBN, title, author, status, rating, pages, started, finished. */
const ROWS: Row[] = [
  [
    '9780306406157',
    'The Left Hand of Darkness',
    'Ursula K. Le Guin',
    'reading',
    0,
    304,
    '2026-12-01',
    '',
  ],
  ['9780140449136', 'Crime and Punishment', 'Fyodor Dostoevsky', 'want', 0, 671, '', ''],
  ['9780804429573', 'Pedro Páramo', 'Juan Rulfo', 'read', 5, 124, '2026-01-03', '2026-01-06'],
  [
    '9780141439518',
    'Pride and Prejudice',
    'Jane Austen',
    'read',
    4,
    432,
    '2026-01-10',
    '2026-01-28',
  ],
  [
    '9780060883287',
    'One Hundred Years of Solitude',
    'Gabriel García Márquez',
    'read',
    5,
    417,
    '2026-02-02',
    '2026-02-25',
  ],
  ['9780141182803', 'Mrs Dalloway', 'Virginia Woolf', 'read', 3, 194, '2026-03-01', '2026-03-12'],
  [
    '9780441478125',
    'The Dispossessed',
    'Ursula K. Le Guin',
    'read',
    5,
    387,
    '2026-03-14',
    '2026-04-02',
  ],
  [
    '9780679732242',
    'The Sound and the Fury',
    'William Faulkner',
    'read',
    3,
    326,
    '2026-04-05',
    '2026-04-30',
  ],
  [
    '9780142437230',
    'Don Quixote',
    'Miguel de Cervantes',
    'read',
    4,
    1023,
    '2026-05-01',
    '2026-06-20',
  ],
  [
    '9780307389732',
    'Love in the Time of Cholera',
    'Gabriel García Márquez',
    'read',
    4,
    348,
    '2026-06-22',
    '2026-07-08',
  ],
  ['9780811216005', 'Ficciones', 'Jorge Luis Borges', 'read', 5, 174, '2026-07-10', '2026-07-16'],
  ['9780374529260', 'The Plague', 'Albert Camus', 'read', 3, 308, '2026-07-18', '2026-07-31'],
  ['9780553418026', 'The Martian', 'Andy Weir', 'read', 4, 387, '2026-08-02', '2026-08-05'],
  [
    '9780099448822',
    'Never Let Me Go',
    'Kazuo Ishiguro',
    'read',
    4,
    288,
    '2026-08-09',
    '2026-08-21',
  ],
  ['9780441013593', 'Dune', 'Frank Herbert', 'read', 4, 617, '2026-09-01', '2026-09-26'],
  [
    '9780141187761',
    'Nineteen Eighty-Four',
    'George Orwell',
    'read',
    3,
    328,
    '2026-10-02',
    '2026-10-14',
  ],
  ['9780452284234', 'Wide Sargasso Sea', 'Jean Rhys', 'read', 4, 176, '2026-10-16', '2026-10-22'],
  ['9780307277671', 'The Road', 'Cormac McCarthy', 'read', 4, 287, '2026-11-01', '2026-11-04'],
  [
    '9780571334650',
    'Klara and the Sun',
    'Kazuo Ishiguro',
    'read',
    4,
    303,
    '2026-11-08',
    '2026-11-19',
  ],
];

/** The rows as the shelf keeps them (localStorage 'cuento.books'). */
const BOOKS = ROWS.map(([isbn, title, author, status, rating, pages, started, finished]) => ({
  isbn,
  title,
  authors: [author],
  cover: '',
  pages,
  published: '',
  status,
  added: started || '2026-11-30',
  started,
  finished,
  rating,
  notes: title === 'Pedro Páramo' ? 'Comala. Read it in one sitting, then again.' : '',
}));

/** The cards of the review kept, by their place in the story. */
const CARDS = ['opening', 'count', 'months', 'favourites', 'records', 'pace', 'closing'];

const server = await serve();
const app = origin(server) + (existsSync('build/site/app/index.html') ? 'app/' : '');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/usr/sbin/chromium',
});

/** A phone-sized page of the app holding the fixed books, in a scheme. */
async function phone(scheme: 'light' | 'dark'): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: 'reduce',
  });
  // A fixed "today" in December, so the top offers the year's review.
  await page.clock.setFixedTime(new Date('2026-12-04T12:00:00'));
  await page.goto(app);
  await page.evaluate(books => {
    localStorage.setItem('cuento.books', JSON.stringify(books));
    localStorage.setItem('cuento.goals', JSON.stringify({ 2026: 24 }));
  }, BOOKS);
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** Saves what the page shows as WebP (Chromium's own encoder), scaled by
 * scale, at quality q. */
async function webp(page: Page, path: string, scale = 1, q = 0.82) {
  const png = (await page.screenshot()).toString('base64');
  const data = await page.evaluate(
    async ([png, scale, q]) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + png;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/webp', q).split(',')[1]!;
    },
    [png, scale, q] as const,
  );
  await writeFile(path, Buffer.from(data, 'base64'));
}

for (const scheme of ['light', 'dark'] as const) {
  const page = await phone(scheme);
  await webp(page, 'landing/img/shelf-' + scheme + '.webp');
  await page.close();
}

const page = await phone('light');
await page.locator('.review-button').first().click();
await page.addStyleTag({ content: '.review .shut { visibility: hidden }' });
for (const card of CARDS) {
  await page.waitForTimeout(300);
  await webp(page, 'landing/img/review-' + card + '.webp', 0.6);
  await page.keyboard.press('ArrowRight');
}
await browser.close();
server.close();

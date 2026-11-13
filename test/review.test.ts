/* The year in review's counting (yearStats and pile), on its own: which
 * books count, the months, favourites, records and pace, and the edge
 * cases (no pages known, other years, missing dates, ties). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yearStats, pile } from '../src/review.ts';
import type { Book } from '../src/shelf.ts';

/** A read book finished on finished, with whatever else is given. */
function book(finished: string, more: Partial<Book> = {}): Book {
  return {
    isbn: '978' + finished.replace(/-/g, '') + '00',
    title: 'Book of ' + finished,
    authors: ['Anon'],
    cover: '',
    pages: null,
    published: '',
    status: 'read',
    added: '2020-01-01',
    started: '',
    finished,
    rating: 0,
    notes: '',
    ...more,
  };
}

test('only books read and finished in the year count, in the order finished', () => {
  const s = yearStats(2025, [
    book('2025-03-01'),
    book('2024-12-31'),
    book('2026-01-01'),
    book('2025-01-15'),
    book('2025-02-01', { status: 'reading' }),
  ]);
  assert.deepEqual(
    s.read.map(b => b.finished),
    ['2025-01-15', '2025-03-01'],
  );
  assert.deepEqual(
    s.months.map(m => m.length),
    [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
});

test('with no pages known there are no pages, no longest book and no pages a day', () => {
  const s = yearStats(2025, [book('2025-01-01'), book('2025-02-01')], '2026-01-10');
  assert.equal(s.pages, 0);
  assert.equal(s.longest, null);
  assert.equal(s.perDay, null);
});

test('pages add up over the books that know theirs; the longest is the first of a tie', () => {
  const a = book('2025-01-01', { pages: 500 });
  const b = book('2025-02-01', { pages: 500 });
  const s = yearStats(2025, [b, book('2025-03-01'), a, book('2025-04-01', { pages: 100 })]);
  assert.equal(s.pages, 1100);
  assert.equal(s.longest, a);
});

test('the best month is the one with most books; a tie has none', () => {
  const march = [book('2025-03-01'), book('2025-03-02')];
  assert.equal(yearStats(2025, [...march, book('2025-05-01')]).best, 2);
  assert.equal(yearStats(2025, [...march, book('2025-05-01'), book('2025-05-02')]).best, null);
  assert.equal(yearStats(2025, []).best, null);
});

test('favourites are rated 4 or 5, the best first, at most five', () => {
  const books = [3, 4, 5, 4, 5, 5, 4, 0].map((rating, i) =>
    book('2025-01-1' + i, { rating, title: String(i) }),
  );
  assert.deepEqual(
    yearStats(2025, books).favourites.map(b => b.title),
    ['2', '4', '5', '1', '3'],
  );
});

test('the quickest read counts both days, and skips dates that cannot say', () => {
  const s = yearStats(2025, [
    book('2025-01-10'), // never started
    book('2025-02-10', { started: '2025-02-12' }), // started after it ended
    book('2025-03-10', { started: '2025-03-10', added: '2025-03-10' }), // shelved as read
    book('2025-04-10', { started: '2025-04-01' }),
    book('2025-05-10', { started: '2025-05-06' }),
  ]);
  assert.equal(s.quickest?.book.finished, '2025-05-10');
  assert.equal(s.quickest?.days, 5);
  assert.equal(s.took, 8); // (10 + 5) / 2, rounded
  const day = yearStats(2025, [book('2025-06-01', { started: '2025-06-01' })]);
  assert.equal(day.quickest?.days, 1);
});

test('the most read author needs two books; a tie names them all', () => {
  const by = (author: string, d: string) => book(d, { authors: [author] });
  assert.equal(yearStats(2025, [by('A', '2025-01-01'), by('B', '2025-01-02')]).author, null);
  const tie = yearStats(2025, [
    by('A', '2025-01-01'),
    by('B', '2025-01-02'),
    by('A', '2025-01-03'),
    by('B', '2025-01-04'),
    by('C', '2025-01-05'),
  ]);
  assert.deepEqual(tie.author, { names: ['A', 'B'], count: 2 });
});

test('pace: over a whole past year, or the year so far', () => {
  const books = [book('2024-01-10', { pages: 400 }), book('2024-02-10', { pages: 330 })];
  const past = yearStats(2024, books, '2026-05-01');
  assert.equal(past.every, 183); // 366 days, a leap year
  assert.equal(past.perDay, 2);
  const now = yearStats(2024, books, '2024-03-01');
  assert.equal(now.every, 31); // 61 days so far
  assert.equal(yearStats(2024, books.slice(1), '2024-03-01').every, null); // one book: no pace
  assert.equal(yearStats(2027, [], '2026-05-01').every, null);
});

test('a pile of pages is measured, and compared when it is tall enough', () => {
  assert.equal(pile(300), 'A pile 2 cm tall.');
  assert.equal(pile(5349), 'A pile 43 cm tall, taller than a cat sitting up.');
  assert.equal(pile(30000), 'A pile 2.4 m tall, taller than a front door.');
});

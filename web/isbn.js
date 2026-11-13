/* ISBNs: reading one as typed or scanned, checking it, and writing it as
 * the 13 digits cuento keys every book by.
 *
 *   "0-306-40615-2" --clean--> "0306406152"   (an ISBN-10, check digit 2)
 *                   --toIsbn13--> "978" + "030640615" + "7"
 *                              = "9780306406157"
 *
 * An ISBN-10 is nine digits and a check digit (0-9 or X, for 10) chosen
 * so the digits weighted 10, 9, ... 1 add up to a multiple of 11. An
 * ISBN-13 is a book's EAN barcode: 978 or 979, then nine digits and a
 * check digit, weighted 1, 3, 1, 3, ... to a multiple of 10. Depends on
 * nothing. Leaves out ISSNs, ISMNs and other barcodes on a book. */

/** text without spaces and hyphens, a final x as X.
 * @param {string} text */
export function clean(text) {
  return String(text).replace(/[\s-]/g, '').toUpperCase();
}

/** Whether s (clean) is an ISBN-10 whose check digit is right.
 * @param {string} s */
function valid10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (10 - i) * (s[i] === 'X' ? 10 : Number(s[i]));
  return sum % 11 === 0;
}

/** The check digit of the first 12 digits of an ISBN-13.
 * @param {string} twelve */
function check13(twelve) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (i % 2 ? 3 : 1) * Number(twelve[i]);
  return String((10 - (sum % 10)) % 10);
}

/** Whether s (clean) is a book's ISBN-13 whose check digit is right.
 * @param {string} s */
function valid13(s) {
  return /^97[89]\d{10}$/.test(s) && check13(s) === s[12];
}

/** The ISBN-13 of text (typed or scanned, either length), or null when
 * it is not a valid ISBN.
 * @param {string} text
 * @returns {string | null} */
export function toIsbn13(text) {
  const s = clean(text);
  if (valid13(s)) return s;
  if (!valid10(s)) return null;
  const twelve = '978' + s.slice(0, 9);
  return twelve + check13(twelve);
}

/** isbn13 with hyphens after the prefix and before the check digit, for
 * reading (the groups between vary by country and publisher).
 * @param {string} isbn13 */
export function show(isbn13) {
  return isbn13.slice(0, 3) + '-' + isbn13.slice(3, 12) + '-' + isbn13[12];
}

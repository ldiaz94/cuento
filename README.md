<p align="center">
  <img src="doc/img/banner.svg" alt="cuento: count the books you read. Tilde the bookworm on a red book, beside a shelf of spines" width="800">
</p>

cuento keeps the books you read. Scan a book's barcode, type its ISBN,
or search by title or author, and cuento fills in the title, author and
cover, and puts it on
your shelf: want to read, reading, or read, with the dates, a rating and
notes. It counts what you finished this year. It runs in the browser,
keeps your shelf on your device, works offline, and needs no account;
sync it between your devices with a code, or a passkey. At the end of
the year it tells you your year in books.

The name is Spanish: _un cuento_ is a story, and _cuento_ is also "I
count". The mascot is **Tilde**, a bookworm named after the curl over
Spanish ñ, which her body makes too, with round glasses and a
pencil behind her ear, for keeping count.

cuento is also the first real app on [spark](https://github.com/ldiaz94/spark),
a ~400-line reactive UI library: it is here to find spark's bugs (it
found one on its first day, fixed in spark 0.1.1).

## See it

<p align="center">
  <img src="doc/img/shelf-light.png" alt="The shelf on a phone: four books, one open with its dates, rating and notes" width="260">
  <img src="doc/img/shelf-dark.png" alt="The same shelf in the dark theme" width="260">
</p>

The pictures come from fixed books (`robbie shots`), so they show the app
as the tests see it.

The site is two parts: a landing page at [cuento.page](https://cuento.page)
(`landing/`: static HTML and CSS; `node landing/shots.ts` redraws its
pictures from the built app, `node landing/og.ts` its link preview) and
the app at `/app/`.

## Get it

Open the deployed page, or run your own:

```sh
npm install           # TypeScript, Prettier, playwright-core, Wrangler: tools only
robbie build          # compiles src/ into build/site/
robbie serve          # http://localhost:8080/
robbie check          # types, unit tests, the page in headless Chromium
robbie deploy         # to Cloudflare, as static files
```

The browser tests drive Chromium at `/usr/sbin/chromium`; set `CHROMIUM`
for another.

## Learn it

| To                       | Do                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Add a book               | Type its ISBN (10 or 13 digits, hyphens or not) and **Add**                                                  |
| Scan a book              | Tap the barcode button, aim at the back cover's barcode                                                      |
| Find a book to add       | Type words from its title or author and **Search**; tap one                                                  |
| Add one no service knows | Add its ISBN, then its title and author by hand                                                              |
| Start or finish a book   | Change its status: starting dates it, finishing dates it                                                     |
| Rate a read book         | Tap a star; tap the same star again to clear it                                                              |
| See its dates and notes  | Tap its title                                                                                                |
| Find a book              | Pick a status or a year (History), or search titles and authors                                              |
| Own a book               | Tap **Owned**; it is dated the day you got it                                                                |
| Read it again            | On a Read book, tap **Read again**                                                                           |
| Edit reading history     | Tap its title: change the dates, remove a read, or **+ Add a past read**                                     |
| Up next                  | Tap **Up next** on a Want or Owned book; the **Up next** chip lists them                                     |
| Your library             | Tap **Library**: the books you own, to search (ISBN too) and sort; tap one for its history                   |
| Where to buy             | Tap a Want book's title, then **Where to buy**: searches at the stores, not prices                           |
| Shopping preferences     | **Settings → Shopping**: format, favourite stores first, and a city or postcode for nearby shops             |
| Set a goal               | In **Settings**: books to read this year; the count shows the way                                            |
| Keep a copy              | In **Settings** (the gear): **Export** saves the shelf as JSON; **Import** brings one back                   |
| See past years           | **History** under the shelves: a year's books, and **Your year in books**                                    |
| Sync your devices        | **Settings → Sync**: turn it on, then open its link or QR on the other device                                |
| Sign in                  | **Settings → Account**: create a passkey; sign in with it anywhere                                           |
| Be reminded to read      | **Settings → Reminders**: a time and days; on an iPhone, add cuento to the Home Screen first                 |
| Update cuento            | When a new version is ready a bar says so: tap **Update**. **Settings** shows the version and checks for one |

Your shelf lives in this browser only. cuento opens with no network once
it has been loaded; only looking up a new book needs one. To install it,
use **Add to Home Screen** in Safari on an iPhone (Share menu), or
**Install** in Chrome on Android or the desktop. On an iPhone, Safari may
clear a site's data after a few weeks unused: an installed app is spared,
but export now and then.

## How it works

Five ideas, a module each, read in this order:

1. **An ISBN is a check digit away from wrong** ([src/isbn.ts](src/isbn.ts)).
   Both lengths are checked, and every book is kept by its ISBN-13.
2. **A barcode is read twice before it is believed**
   ([src/scan.ts](src/scan.ts)). The browser's own BarcodeDetector where
   it has one; elsewhere (iPhone Safari) zxing-wasm, self-hosted in
   `public/vendor/zxing/` (`robbie zxing`) and fetched only then. Only an
   EAN-13 that is an ISBN counts, and only when two reads in a row agree.
3. **Two services, and offline is not "no such book"**
   ([src/lookup.ts](src/lookup.ts)). Open Library first, Google Books
   when it has no record; a lookup that reached neither throws. Only
   `https:` cover URLs are kept, since spark does not sanitise attributes.
   A search by title or author asks the same two, and keeps only the
   books found with an ISBN, since a book is kept by its ISBN.
4. **The shelf is plain data** ([src/shelf.ts](src/shelf.ts)). A book is
   a record; a status brings its dates; the shelf is kept in
   `localStorage` and travels as an export file.
5. **The page is signals and templates** ([src/app.ts](src/app.ts)). The
   books are a signal; a computed filters and searches them; spark's keyed
   `each()` keeps one row per book, updated in place.

Where to buy ([src/buy.ts](src/buy.ts)) builds links to searches at the
stores, not prices or stock: nothing fetches either.

Beyond the page, four more, each a module or two:

- **A year, told as a story** ([src/review.ts](src/review.ts)): pure
  statistics (`yearStats`), then cards drawn in HTML and CSS, and a
  share picture drawn on a canvas.
- **Sync: a code is a shelf** ([src/sync.ts](src/sync.ts),
  [worker/store.ts](worker/store.ts)). A small Worker
  ([worker/index.ts](worker/index.ts)) keeps each shelf in a Durable
  Object with SQLite, found by a hash of its code. Devices send what
  changed since the last sync (a diff against a snapshot, so the page
  never says what it changed); the latest change to a book wins, and
  the reading goals travel with the shelf as one more record, and the
  shopping preferences (format, stores and location) as another, the
  latest write winning each; the location goes to no store or price
  lookup. A WebSocket tells the others to sync.
- **Accounts are passkeys** ([worker/auth.ts](worker/auth.ts),
  [src/account.ts](src/account.ts)): an account owns one shelf, so
  signing in on a new device joins it. Sessions are signed cookies
  (`SESSION_KEY`, a Worker secret).
- **Reminders are Web Push** ([worker/notify.ts](worker/notify.ts),
  [worker/reminders.ts](worker/reminders.ts), [src/reminders.ts](src/reminders.ts)):
  a browser's push subscription, its time, days and time zone, kept in a
  Durable Object; a cron every quarter hour sends what is due there,
  once a local day. The server never learns a book. Messages are
  encrypted and signed with WebCrypto in [worker/push.ts](worker/push.ts)
  (RFC 8291 and 8292), as the `web-push` package needs Node. The VAPID
  key is made once by `robbie vapid`: its private half goes straight into
  the `VAPID_PRIVATE_KEY` secret, its public half into `wrangler.jsonc`.

To work offline, a small service worker ([public/sw.js](public/sw.js))
keeps every file of the site, and the covers you have seen, on the
device. `robbie build` fills in its file list and a version (a hash of
the site, also written to `version.json`) with
[tools/precache.ts](tools/precache.ts). A deploy that changes anything
is fetched in the background and waits: the page offers **Update**
([src/updates.ts](src/updates.ts)), so nothing changes under the reader.
Lookups always go to the network. The PNG icons in `public/` are kept, redrawn by `robbie icons`
(needs `rsvg-convert`).

cuento is TypeScript, strict. `robbie build` compiles `src/` into
`build/site/`, beside `public/` (the page, its style and icon) and spark,
which `src/spark/` vendors at a tag (`robbie spark`) as JavaScript with
its own type declarations. The tests are TypeScript too, and Node runs
them as they are.

## Tests

`robbie check`: strict TypeScript over the app and the tests; the pure modules in Node
(check digits, the lookup's fallback and offline case, unsafe cover URLs,
status dates, imports, a full or broken storage); and the page in
headless Chromium with the services faked (adding, the scanner sheet, every note the ISBN
field gives, adding by hand, statuses and ratings, filters and search, a
reload, the page opening with the network cut, and that a book's title never becomes HTML).
And the scanner in Chromium with a fake camera filming a drawn barcode
(`test/scan.test.ts`, needs ffmpeg): zxing reads it, and the camera goes
off after a read, a stop or a missing camera.
Reminders (`test/reminders.test.ts`): the encryption against RFC 8291's
own example, a VAPID token that verifies, and who is due when, across
time zones and summer time; and their Settings section in Chromium
(`test/reminders-browser.test.ts`), which asks for permission only on a
tap and subscribes with the server's key.

## Left out

- **The torch, zoom and other barcodes** when scanning.
- **Limiting the covers kept offline**: they are kept as seen.
- **A recovery email**: an account is its passkeys; keep two, and export.
- **Merging edits to one book**: the latest change to a book wins whole.
- **Editions and series**: a book is one ISBN.
- **More than one reminder a day**, and retrying a push that failed.

## Licence

ISC: see [LICENSE](LICENSE). spark, in `src/spark/`, is ISC too.

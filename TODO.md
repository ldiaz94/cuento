# Next steps

## Where to buy

- [ ] **Apple Books prices fail in production.** The Worker logs
      `prices: itunes.apple.com failed for <isbn> (<region>): Error: HTTP 403`
      (seen 2026-11-15 with `npx wrangler tail`). The same URL answers 200 from
      a home connection, and it worked under local `wrangler dev`. Likely Apple
      blocking Cloudflare egress or the `cuento.page` User-Agent. Try a browser
      User-Agent or no Accept header with `wrangler dev --remote`. If Apple keeps
      refusing, drop `priced` from Apple Books (it falls back to a search tile).
- [ ] **Google Books ebook prices**: `saleInfo` needs an API key (the
      anonymous quota returned 429). Add a key as a Worker secret and a reader in
      worker/prices.ts.
- [ ] **Currency symbol**: Gandhi prices are MXN but `Intl.NumberFormat`
      shows a bare "$" in some locales. Consider `currencyDisplay: 'narrowSymbol'`
      off, or always showing the code for foreign currencies.
- [ ] Casa del Libro MX: its VTEX API and search URL both 404 (2026-11).
      Recheck, or fix its search URL.
- [ ] Apple Books now appears in every region's suggestions. Decide whether
      that's wanted.

## Tests

- [ ] Three browser tests fail locally, also on the code before 2026-11-15's
      changes: "Settings shows the version", "a new version waits for Update"
      (test/browser.test.ts), "Share saves a 1080x1920 picture"
      (test/review-browser.test.ts). The two files then hang instead of exiting.
- [ ] scan.test.ts defaults to `/usr/sbin/chromium`; on macOS set
      `CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.

## Mobile

- [ ] The signed-in account (passkey list) and sync-code/QR screens weren't
      audited at 320–390px: they need a server.
- [ ] The status switch now sits on its own row on desktop too. Check it reads
      well there.

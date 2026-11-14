# TODO: ownership, library and shopping

## 1. Extend the book model and migration

- [ ] Add the `owned` status, optional `acquired` date, reading sessions and an `upNext` marker.
- [ ] Preserve existing dates when migrating stored books.
- [ ] Version exports and handle mixed-version sync so older app versions cannot silently discard new data.

## 2. Add the Owned status

- [ ] Use the progression **Want → Owned → Reading → Read**.
- [ ] Set `acquired` to the current date when moving a book from Want to Owned.
- [ ] Make the acquisition date editable and allow it to be blank.
- [ ] Preserve an existing acquisition date during later status changes.
- [ ] Treat Reading and Read books as owned for Library purposes.

## 3. Add reading history

- [ ] Replace the single reading period with sessions containing a start date and optional finish date.
- [ ] Support **Read again** without losing earlier reads.
- [ ] Derive the last-read date and completed-read count from sessions.
- [ ] Allow reading history to be backfilled and edited manually.
- [ ] Update yearly statistics to count each completed read.

## 4. Add Up next

- [ ] Add a simple Up next marker to Want and Owned books, without manual queue ordering initially.
- [ ] Add an **Up next** view containing marked books.
- [ ] Clear the marker automatically when reading starts.
- [ ] Keep the marker local, exportable and synced with the book.

## 5. Build Your library

- [ ] Show Owned, Reading and Read books.
- [ ] Search by title, author or ISBN.
- [ ] Sort by title, acquisition date or last-read date.
- [ ] Show acquisition date, last read and times read, using “—” for unknown dates.
- [ ] Open the full ownership and reading-history editor from each book.
- [ ] Optionally filter Library to Up next.

## 6. Add shopping preferences

- [ ] Add an optional format preference: print or ebook.
- [ ] Add optional favourite stores, with regional suggestions and custom entries.
- [ ] Add an optional manually entered location, without requiring GPS.
- [ ] Keep location device-only initially.

## 7. Add Where to buy for Want books

- [ ] Generate retailer search links using ISBN, with title and author as a fallback.
- [ ] Include nearby-store searches when location is supplied.
- [ ] Order results using format and favourite-store preferences.
- [ ] Label results as searches, not confirmed prices or availability.

## 8. Test and release

- [ ] Cover migration, old exports, acquisition-date transitions, rereading, Up next, sync between versions, offline behaviour and phone layouts.
- [ ] Leave live prices and stock integrations for a later, separate phase.

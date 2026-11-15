# TODO: ownership, library and shopping

## 1. Extend the book model and migration

- [x] Add the `owned` status, optional `acquired` date, reading sessions and an `upNext` marker.
- [x] Preserve existing dates when migrating stored books.
- [x] Version exports and handle mixed-version sync so older app versions cannot silently discard new data.

## 2. Add the Owned status

- [x] Use the progression **Want → Owned → Reading → Read**.
- [x] Set `acquired` to the current date when moving a book from Want to Owned.
- [x] Make the acquisition date editable and allow it to be blank.
- [x] Preserve an existing acquisition date during later status changes.
- [x] Treat Reading and Read books as owned for Library purposes.

## 3. Add reading history

- [x] Replace the single reading period with sessions containing a start date and optional finish date.
- [x] Support **Read again** without losing earlier reads.
- [x] Derive the last-read date and completed-read count from sessions.
- [x] Allow reading history to be backfilled and edited manually.
- [x] Update yearly statistics to count each completed read.

## 4. Add Up next

- [x] Add a simple Up next marker to Want and Owned books, without manual queue ordering initially.
- [x] Add an **Up next** view containing marked books.
- [x] Clear the marker automatically when reading starts.
- [x] Keep the marker local, exportable and synced with the book.

## 5. Build Your library

- [x] Show Owned, Reading and Read books.
- [x] Search by title, author or ISBN.
- [x] Sort by title, acquisition date or last-read date.
- [x] Show acquisition date, last read and times read, using “—” for unknown dates.
- [x] Open the full ownership and reading-history editor from each book.
- [x] Optionally filter Library to Up next.

## 6. Add shopping preferences

- [x] Add an optional format preference: print or ebook.
- [x] Add optional favourite stores, with regional suggestions and custom entries.
- [x] Add an optional manually entered location, without requiring GPS.
- [x] Keep location device-only initially.

## 7. Add Where to buy for Want books

- [x] Generate retailer search links using ISBN, with title and author as a fallback.
- [x] Include nearby-store searches when location is supplied.
- [x] Order results using format and favourite-store preferences.
- [x] Label results as searches, not confirmed prices or availability.

## 8. Test and release

- [x] Cover migration, old exports, acquisition-date transitions, rereading, Up next, sync between versions, offline behaviour and phone layouts.
- [x] Leave live prices and stock integrations for a later, separate phase.

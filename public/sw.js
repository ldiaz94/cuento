/* cuento's service worker: keeps the app on the device so it opens with no
 * network, which is also what lets a phone install it as an app. Plain
 * JavaScript, written by hand; robbie build (tools/precache.ts) copies it
 * to build/site/sw.js with the BUILD line filled in, so the file list and
 * the version are never kept by hand. Depends on the browser's service
 * worker, Cache and fetch APIs. Leaves out the book lookups (always the
 * network: offline, the page says so), background sync, and any limit on
 * the covers kept (a shelf's worth is small). */

/** Filled in by the build: the version (a hash of the site) and its files. */
const BUILD = { version: 'dev', files: ['index.html'] };
/** The cache for the app's files; a new version gets a new name. */
const SHELL = 'shell-' + BUILD.version;
/** The cache for book covers, kept across versions. */
const COVERS = 'covers';

// Install: keep every file of this version. A new version then waits
// until the reader says Update (src/updates.ts), so a page never changes
// under them.
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(['./', ...BUILD.files])));
});

// The page's Update button: stop waiting and take over.
self.addEventListener('message', event => {
  if (event.data === 'update') self.skipWaiting();
});

// Activate: delete the caches of older versions, and take over open pages.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(names =>
        Promise.all(names.filter(n => n !== SHELL && n !== COVERS).map(n => caches.delete(n))),
      )
      .then(() => self.clients.claim()),
  );
});

// Fetch: the app's files and the covers come from a cache first; anything
// else (the lookups) is left alone, so it goes to the network as usual.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const sameOrigin = new URL(request.url).origin === location.origin;
  if (sameOrigin) {
    event.respondWith(cacheFirst(request, SHELL, request.mode === 'navigate'));
  } else if (request.destination === 'image') {
    event.respondWith(cacheFirst(request, COVERS, false));
  }
});

/* The cached answer to request, else the network's (kept for next time in
 * the cache called name). When both fail, a page navigation gets the cached
 * index.html, and anything else fails. */
async function cacheFirst(request, name, isPage) {
  const cache = await caches.open(name);
  const kept = await cache.match(request, { ignoreSearch: isPage });
  if (kept) return kept;
  try {
    const response = await fetch(request);
    // Keep good answers, and a cover's opaque one (status 0).
    if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
    return response;
  } catch (error) {
    const page = isPage && (await caches.open(SHELL).then(c => c.match('index.html')));
    if (page) return page;
    throw error;
  }
}

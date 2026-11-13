/* The service worker cuento had at its root, retired. cuento's app moved
 * from / to /app/ (with its own worker there), so a browser that still
 * runs the old root worker gets this one in its place: it empties the old
 * caches, unregisters itself, and takes open pages to /app/. robbie build
 * copies it to build/site/sw.js. Depends on nothing. Leaves out the
 * shelf itself, which lives in localStorage and is untouched. */

// Take over at once: there is nothing to wait for.
self.addEventListener('install', () => self.skipWaiting());
// The old page's Update button asks the same.
self.addEventListener('message', event => {
  if (event.data === 'update') self.skipWaiting();
});

// Empty the old caches, leave, and send open pages to the app.
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      await self.clients.claim(); // so open pages can be sent on
      for (const name of await caches.keys()) await caches.delete(name);
      await self.registration.unregister();
      for (const page of await self.clients.matchAll({ type: 'window' })) page.navigate('/app/');
    })(),
  );
});

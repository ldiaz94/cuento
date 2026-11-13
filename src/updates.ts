/* Updates: cuento's service worker (public/sw.js) keeps a version of the
 * app on the device. When a deploy changes it, the browser fetches the
 * new version in the background and holds it, waiting, until the reader
 * says Update; then the new worker takes over and the page reloads.
 *
 *   register ─► a new worker installs ─► waiting (newer: true)
 *                                           │ update()
 *                                           ▼
 *              page reloads ◄─ controllerchange ◄─ it takes over
 *
 * The version shown is the build's (version.json, written by
 * tools/precache.ts, kept with the rest). Depends on spark. Leaves out
 * updating without asking, and release notes. */
import { signal } from './spark/index.js';

/** The version of the app this page runs: a hash of its files and the
 * day it was built. */
export interface Version {
  version: string;
  built: string;
}

/** How often to look for a new version while cuento stays open, in ms. */
const EVERY = 60 * 60 * 1000;

/** Whether a newer version is downloaded and waiting for Update. */
const [newer, setNewer] = signal(false);
export { newer };

/** The worker's registration, once registered (null without one). */
let registration: ServiceWorkerRegistration | null = null;

/** Registers the service worker, and watches for new versions: on
 * opening, when cuento comes back to the screen, and every hour. */
export async function start() {
  if (!('serviceWorker' in navigator)) return;
  registration = await navigator.serviceWorker.register('sw.js');
  const reg = registration;
  // A worker waiting with a controller in place is a new version (the
  // very first worker has no controller before it, and never waits).
  const seen = () => setNewer(!!reg.waiting && !!navigator.serviceWorker.controller);
  seen();
  reg.addEventListener('updatefound', () => reg.installing?.addEventListener('statechange', seen));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
  setInterval(check, EVERY);
}

/** What looking for a new version found: one waiting, none, or no
 * answer (offline, or no service worker). */
export type Found = 'new' | 'latest' | 'unknown';

/** Asks the server for a new version, and says what it found. */
export async function check(): Promise<Found> {
  if (!registration) return 'unknown';
  try {
    await registration.update();
  } catch {
    return newer() ? 'new' : 'unknown'; // offline
  }
  // A new worker may still be installing: wait for it to settle.
  const installing = registration.installing;
  if (installing)
    await new Promise(done =>
      installing.addEventListener(
        'statechange',
        () => installing.state !== 'installing' && done(0),
      ),
    );
  setNewer(!!registration.waiting);
  return newer() ? 'new' : 'latest';
}

/** Lets the waiting version take over, and reloads into it. */
export function update() {
  const waiting = registration?.waiting;
  if (!waiting) return location.reload();
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
    once: true,
  });
  waiting.postMessage('update');
}

/** The version this page runs, or null when it can't be read. */
export async function current(): Promise<Version | null> {
  try {
    return (await (await fetch('version.json')).json()) as Version;
  } catch {
    return null;
  }
}

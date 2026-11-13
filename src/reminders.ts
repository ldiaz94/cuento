/* Reading reminders, the browser's side: the prefs (kept in localStorage,
 * and told to the server), the browser's push subscription, and whether
 * this device can have reminders at all.
 *
 *   tap a switch ─► ask permission ─► subscribe (cuento's VAPID key) ─► POST /api/push/subscribe
 *   change prefs ─► POST /api/push/prefs (or subscribe again, if the server forgot)
 *   both off     ─► POST /api/push/unsubscribe, and unsubscribe here
 *
 * The server (worker/notify.ts) learns only when to nudge and in which
 * time zone, never a book. Permission is asked only from a tap, first
 * thing, as iPhones insist. On an iPhone or iPad, Web Push works only in
 * cuento installed on the Home Screen (iOS 16.4 and later). Depends on
 * spark and the service worker that updates.ts registers (public/sw.js
 * shows the notifications). Leaves out choosing what a reminder says. */
import { signal } from './spark/index.js';

/** When to remind; the server checks the same shape (worker/reminders.ts). */
export interface Prefs {
  /** Whether to remind at all. */
  enabled: boolean;
  /** The local time, "HH:MM", 24-hour. */
  time: string;
  /** The weekdays, 0 (Sunday) to 6. */
  days: number[];
  /** Whether to say, on 15 December, that the year in review is ready. */
  review: boolean;
}

/** Where reminders stand on this device: impossible here, possible once
 * installed on the Home Screen (iOS), blocked, not yet asked, or allowed. */
export type Standing = 'unsupported' | 'install' | 'denied' | 'ask' | 'granted';

/** The localStorage key the prefs are kept under. */
const KEY = 'cuento.reminders';
/** The prefs before any are chosen: off, 21:00, every day. */
const DEFAULT: Prefs = {
  enabled: false,
  time: '21:00',
  days: [0, 1, 2, 3, 4, 5, 6],
  review: false,
};

/** The prefs kept on this device, or DEFAULT. */
function load(): Prefs {
  try {
    return { ...DEFAULT, ...(JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Prefs>) };
  } catch {
    return DEFAULT;
  }
}

const [prefs, setPrefs] = signal<Prefs>(load());
/** This device's reminder prefs. */
export { prefs };

/** Whether this is an iPhone or iPad (an iPad says it is a Mac, with touch). */
const ios = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
/** Whether cuento runs installed, from the Home Screen. */
const installed = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true;

/** Where reminders stand now. */
function look(): Standing {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return ios() && !installed() ? 'install' : 'unsupported';
  const p = Notification.permission;
  return p === 'denied' ? 'denied' : p === 'granted' ? 'granted' : 'ask';
}

const [standing, setStanding] = signal<Standing>(look());
/** Where reminders stand on this device. */
export { standing };

/** Whether prefs ask for any notification at all. */
export const wanted = (p: Prefs) => p.enabled || p.review;

/** This device's time zone, as the server reads it ("Europe/Madrid"). */
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Asks cuento's server; the reply's JSON. Throws an Error in words when
 * it can't be reached or refuses (with the HTTP status). */
async function api(path: string, body?: object): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body && JSON.stringify(body),
    });
  } catch {
    throw Error("Couldn't reach cuento's server: are you online? Your choice is kept here.");
  }
  const reply = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok)
    throw Object.assign(
      Error(
        response.status >= 500
          ? 'Reminders are not available just now.'
          : reply.error || 'The server said no.',
      ),
      { status: response.status },
    );
  return reply;
}

/** base64url text as bytes. */
const bytes = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/** The browser's push subscription for cuento, or null. */
async function current(): Promise<PushSubscription | null> {
  return (await navigator.serviceWorker.ready).pushManager.getSubscription();
}

/** Makes the server match the prefs: subscribed with them while any is
 * on, else not subscribed at all. Needs permission given already. */
async function sync() {
  const p = prefs();
  let s = await current();
  if (!wanted(p)) {
    if (s) await api('/api/push/unsubscribe', { endpoint: s.endpoint });
    await s?.unsubscribe();
    return;
  }
  const subscribe = (s: PushSubscription) =>
    api('/api/push/subscribe', { subscription: s.toJSON(), prefs: p, tz: zone() });
  if (!s) {
    const { key } = (await api('/api/push/key')) as { key: string };
    const pushManager = (await navigator.serviceWorker.ready).pushManager;
    s = await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
    return subscribe(s);
  }
  try {
    await api('/api/push/prefs', { endpoint: s.endpoint, prefs: p, tz: zone() });
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    await subscribe(s); // the server forgot this browser: tell it again
  }
}

/** Changes the prefs, from a tap: asks for permission first when a
 * notification is wanted and not yet allowed, and keeps nothing if it is
 * refused. Kept here even when the server can't be reached; refresh tells
 * it later. */
export async function change(next: Prefs) {
  if (wanted(next) && Notification.permission !== 'granted') {
    await Notification.requestPermission();
    setStanding(look());
    if (standing() !== 'granted') return;
  }
  setPrefs(next);
  localStorage.setItem(KEY, JSON.stringify(next));
  await sync();
}

/** Looks again where reminders stand and, when allowed, tells the server
 * the prefs (a new time zone, or a subscription the browser renewed). */
export async function refresh() {
  setStanding(look());
  if (standing() === 'granted' && wanted(prefs())) await sync();
}

/** Asks the server to send a test notification now. */
export async function test() {
  const s = await current();
  if (!s) throw Error('Reminders are not on in this browser.');
  await api('/api/push/test', { endpoint: s.endpoint });
}

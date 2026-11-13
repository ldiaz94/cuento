/* Reading reminders on the server: the browsers that asked for them, and
 * which are due when the clock strikes a quarter hour. Pure: it runs over
 * store.ts's tiny SQL interface, so the Durable Object (worker/notify.ts)
 * gives it SQLite and the tests give it node:sqlite.
 *
 *   subscriptions: endpoint │ keys (JSON) │ prefs (JSON) │ tz │ created │ lastSent (local day)
 *
 * A browser's push endpoint is its key: whoever knows it is that browser,
 * so no account is needed. Prefs say when, in the browser's own time zone:
 * a reminder at time on the chosen days, and, opted into apart, the Year
 * in review nudge on 15 December (at the reminder's time, else 19:00).
 * A browser hears at most one message a local day. Nothing about the
 * shelf is ever sent here, so the messages are about reading, not books.
 * Depends on store.ts's Sql type and Intl's time zones. Leaves out rate
 * limits and a cap on subscriptions. */
import type { Sql } from './store.ts';
import type { Subscription } from './push.ts';

/** When a browser wants to hear from cuento. */
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

/** A notification, as the service worker (public/sw.js) shows it. */
export interface Notice {
  title: string;
  body: string;
  tag: string;
  url: string;
}

/** A browser that is due a notice now, and the local day it is for. */
export interface Due {
  subscription: Subscription;
  day: string;
  notice: Notice;
}

/** The longest endpoint taken (real ones are a few hundred characters). */
const MAX_ENDPOINT = 1024;
/** The length of a reminder's window, in minutes: the cron's period. */
export const WINDOW = 15;
/** When the review nudge comes with no reminder time, in local minutes. */
const REVIEW_TIME = 19 * 60;
/** The review nudge's day: 15 December (month 12). */
const REVIEW_DAY = '-12-15';
/** What a reminder says, one a day in turn: warm, and about no book. */
const MESSAGES = [
  'A few pages before bed?',
  'Tilde saved your place.',
  'Your book is right where you left it.',
  'Ten quiet minutes, one good chapter?',
  'A fine time for a story.',
  'Tilde is curled up with a book. Join her?',
  'Where were we? Your book remembers.',
];

/** Makes the table, when the store is new. */
export function setUp(sql: Sql) {
  sql(`CREATE TABLE IF NOT EXISTS subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys TEXT NOT NULL,
    prefs TEXT NOT NULL,
    tz TEXT NOT NULL,
    created INTEGER NOT NULL,
    lastSent TEXT
  )`);
}

// ---- What the routes take, checked -------------------------------------------

/** value as a push endpoint (an https URL), or null. */
export function parseEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_ENDPOINT) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** Whether text is base64url for exactly n bytes. */
function base64url(text: unknown, n: number): text is string {
  return (
    typeof text === 'string' && /^[\w-]+$/.test(text) && Math.floor((text.length * 3) / 4) === n
  );
}

/** value as a browser's subscription (PushSubscription.toJSON()), or null:
 * an https endpoint, a P-256 key (65 bytes) and a 16-byte secret. */
export function parseSubscription(value: unknown): Subscription | null {
  const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = parseEndpoint(v?.endpoint);
  const p256dh = v?.keys?.p256dh;
  const auth = v?.keys?.auth;
  if (!endpoint || !base64url(p256dh, 65) || !base64url(auth, 16)) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** value as prefs, or null: a time "HH:MM", distinct weekdays 0 to 6. */
export function parsePrefs(value: unknown): Prefs | null {
  const v = value as Partial<Record<keyof Prefs, unknown>> | null;
  if (typeof v?.enabled !== 'boolean' || typeof v.review !== 'boolean') return null;
  if (typeof v.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) return null;
  const days = v.days;
  if (!Array.isArray(days) || days.length > 7) return null;
  if (!days.every(d => Number.isInteger(d) && d >= 0 && d <= 6) || new Set(days).size < days.length)
    return null;
  return { enabled: v.enabled, time: v.time, days: days as number[], review: v.review };
}

/** value as an IANA time zone Intl knows ("Europe/Madrid"), or null. */
export function parseTz(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

// ---- Keeping subscriptions ---------------------------------------------------

/** Keeps a browser's subscription and prefs (new, or replacing its own). */
export function subscribe(sql: Sql, s: Subscription, prefs: Prefs, tz: string, now: number) {
  sql(
    `INSERT INTO subscriptions (endpoint, keys, prefs, tz, created) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET keys = excluded.keys, prefs = excluded.prefs, tz = excluded.tz`,
    s.endpoint,
    JSON.stringify(s.keys),
    JSON.stringify(prefs),
    tz,
    now,
  );
}

/** Changes a browser's prefs; false when it has no subscription here. */
export function setPrefs(sql: Sql, endpoint: string, prefs: Prefs, tz: string): boolean {
  const rows = sql(
    'UPDATE subscriptions SET prefs = ?, tz = ? WHERE endpoint = ? RETURNING endpoint',
    JSON.stringify(prefs),
    tz,
    endpoint,
  );
  return rows.length > 0;
}

/** Forgets a browser's subscription. */
export function unsubscribe(sql: Sql, endpoint: string) {
  sql('DELETE FROM subscriptions WHERE endpoint = ?', endpoint);
}

/** A browser's subscription, or null when it has none here. */
export function subscription(sql: Sql, endpoint: string): Subscription | null {
  const row = sql('SELECT keys FROM subscriptions WHERE endpoint = ?', endpoint)[0];
  return row ? { endpoint, keys: JSON.parse(row.keys as string) } : null;
}

/** Notes that a browser was sent its notice for day. */
export function sent(sql: Sql, endpoint: string, day: string) {
  sql('UPDATE subscriptions SET lastSent = ? WHERE endpoint = ?', day, endpoint);
}

// ---- Who is due --------------------------------------------------------------

/** A moment in one time zone: its day "YYYY-MM-DD", weekday (0: Sunday)
 * and minutes since local midnight. */
export interface Local {
  day: string;
  weekday: number;
  minutes: number;
}

/** Intl's formatters by time zone, made once each. */
const formats = new Map<string, Intl.DateTimeFormat>();
/** Intl's short weekdays, in the order of Date's getDay. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The moment now (ms since 1970) as the clocks in tz show it. */
export function local(tz: string, now: number): Local {
  let format = formats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    formats.set(tz, format);
  }
  const part: Record<string, string> = {};
  for (const p of format.formatToParts(now)) part[p.type] = p.value;
  return {
    day: `${part.year}-${part.month}-${part.day}`,
    weekday: WEEKDAYS.indexOf(part.weekday ?? ''),
    minutes: Number(part.hour) * 60 + Number(part.minute),
  };
}

/** "HH:MM" as minutes since midnight. */
const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

/** The notice prefs call for at the moment at, or null: the review nudge
 * on its day, else a reminder on a chosen day; either only in the
 * quarter hour that holds its time. */
export function noticeFor(prefs: Prefs, at: Local): Notice | null {
  const window = at.minutes - (at.minutes % WINDOW);
  const now = (minutes: number) => minutes >= window && minutes < window + WINDOW;
  const time = minutesOf(prefs.time);
  if (prefs.review && at.day.endsWith(REVIEW_DAY)) {
    if (!now(prefs.enabled ? time : REVIEW_TIME)) return null;
    const year = at.day.slice(0, 4);
    return {
      title: `Your ${year} in books is ready`,
      body: 'Tilde counted every page. Come and see your year.',
      tag: 'review',
      url: '/app/',
    };
  }
  if (!prefs.enabled || !prefs.days.includes(at.weekday) || !now(time)) return null;
  // One message a day, in turn: the day's number picks it.
  const turn = Math.floor(Date.parse(at.day) / 86_400_000) % MESSAGES.length;
  return { title: 'cuento', body: MESSAGES[turn] ?? MESSAGES[0]!, tag: 'reminder', url: '/app/' };
}

/** Every browser due a notice at now and not yet sent one today, its
 * own local today. */
export function due(sql: Sql, now: number): Due[] {
  const out: Due[] = [];
  for (const row of sql('SELECT endpoint, keys, prefs, tz, lastSent FROM subscriptions')) {
    const at = local(row.tz as string, now);
    if (row.lastSent === at.day) continue;
    const notice = noticeFor(JSON.parse(row.prefs as string) as Prefs, at);
    if (!notice) continue;
    const endpoint = row.endpoint as string;
    out.push({
      subscription: { endpoint, keys: JSON.parse(row.keys as string) },
      day: at.day,
      notice,
    });
  }
  return out;
}

/** The notice a test sends: right away, whatever the prefs. */
export const TEST: Notice = {
  title: 'Notifications are on',
  body: 'cuento will remind you to read, as you asked.',
  tag: 'test',
  url: '/app/',
};

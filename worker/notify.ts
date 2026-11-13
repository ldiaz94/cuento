/* Reminders: the routes a browser uses to ask for them, and the Durable
 * Object (Reminders, one for all) that keeps the subscriptions and sends
 * what is due.
 *
 *   GET  /api/push/key                             ─► {key} (VAPID public key)
 *   POST /api/push/subscribe   {subscription, prefs, tz} ─► {ok}
 *   POST /api/push/prefs       {endpoint, prefs, tz}     ─► {ok}, or 404
 *   POST /api/push/unsubscribe {endpoint}                ─► {ok}
 *   POST /api/push/test        {endpoint}                ─► {ok}, or 404
 *
 * A Cron Trigger every quarter hour (wrangler.jsonc) calls sendDue. A
 * cron, not the object's alarm: it needs no alarm set and set again, and
 * runs whether or not anyone has subscribed. A push service answering
 * 404 or 410 means the browser dropped the subscription: it is forgotten.
 * The guard against other sites is session.ts's. Depends on
 * reminders.ts, push.ts, session.ts and Cloudflare's Durable Objects with
 * SQLite; the VAPID private key is the secret VAPID_PRIVATE_KEY. Leaves
 * out retrying a push that failed (it waits for the next day). */
import { DurableObject } from 'cloudflare:workers';
import * as store from './reminders.ts';
import type { Prefs, Notice } from './reminders.ts';
import type { Sql } from './store.ts';
import { send } from './push.ts';
import type { Subscription, Vapid } from './push.ts';
import { refused } from './session.ts';

/** The largest body a push route takes, in bytes. */
const MAX_BODY = 4096;

/** The VAPID keys, or null when the server has none. */
function vapid(env: Env): Vapid | null {
  const privateKey = (env as Env & { VAPID_PRIVATE_KEY?: string }).VAPID_PRIVATE_KEY;
  if (!env.VAPID_PUBLIC_KEY || !privateKey) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey, subject: env.VAPID_SUBJECT };
}

/** Every reminder: one object, its own SQLite, its methods the store's. */
export class Reminders extends DurableObject<Env> {
  /** The store's SQL, on this object's own database. */
  private sql: Sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray();
    store.setUp(this.sql);
  }

  subscribe(s: Subscription, prefs: Prefs, tz: string) {
    store.subscribe(this.sql, s, prefs, tz, Date.now());
  }
  setPrefs(endpoint: string, prefs: Prefs, tz: string) {
    return store.setPrefs(this.sql, endpoint, prefs, tz);
  }
  unsubscribe(endpoint: string) {
    store.unsubscribe(this.sql, endpoint);
  }

  /** Sends the test notice to endpoint: whether the push service took
   * it, or null when endpoint has no subscription. */
  async test(endpoint: string): Promise<boolean | null> {
    const s = store.subscription(this.sql, endpoint);
    return s && this.push(s, store.TEST);
  }

  /** Sends every notice due at now (ms); gives how many were sent. Each
   * is marked sent first, so a slow or failed push is never sent twice. */
  async sendDue(now: number): Promise<number> {
    const due = store.due(this.sql, now);
    for (const d of due) store.sent(this.sql, d.subscription.endpoint, d.day);
    const results = await Promise.allSettled(due.map(d => this.push(d.subscription, d.notice)));
    return results.filter(r => r.status === 'fulfilled' && r.value).length;
  }

  /** Pushes notice to s; forgets s when the push service has; says
   * whether the push was taken. */
  private async push(s: Subscription, notice: Notice): Promise<boolean> {
    const keys = vapid(this.env);
    if (!keys) return false;
    const status = await send(s, notice, keys);
    if (status === 404 || status === 410) store.unsubscribe(this.sql, s.endpoint);
    return status >= 200 && status < 300;
  }
}

/** The single Reminders object. */
const reminders = (env: Env) => env.REMINDERS.get(env.REMINDERS.idFromName('reminders'));

/** Sends what is due at now: the Cron Trigger's work. */
export async function sendDue(env: Env, now: number) {
  await reminders(env).sendDue(now);
}

/** An answer in JSON (a sentence, for an error), never cached. */
function answer(status: number, body: unknown): Response {
  const headers = { 'Cache-Control': 'no-store' };
  return Response.json(status < 400 ? body : { error: body }, { status, headers });
}

/** The request's body as a JSON object, or null when it is not one or is
 * too big. */
async function body(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Answers a push route (path starts /api/push/). */
export async function push(request: Request, env: Env, path: string): Promise<Response> {
  const keys = vapid(env);
  if (!keys) return answer(503, 'Reminders are not set up on this server: it has no VAPID key.');
  const route = request.method + ' ' + path;
  if (route === 'GET /api/push/key') return answer(200, { key: keys.publicKey });
  const why = refused(request);
  if (why) return answer(403, why);
  if (request.method !== 'POST') return answer(405, 'POST only.');
  const given = await body(request);
  if (!given) return answer(400, 'Not a push request.');

  const prefs = store.parsePrefs(given.prefs);
  const tz = store.parseTz(given.tz);
  const endpoint = store.parseEndpoint(given.endpoint);
  if (route === 'POST /api/push/subscribe') {
    const s = store.parseSubscription(given.subscription);
    if (!s || !prefs || !tz) return answer(400, 'Not a subscription.');
    await reminders(env).subscribe(s, prefs, tz);
    return answer(200, { ok: true });
  }
  if (route === 'POST /api/push/prefs') {
    if (!endpoint || !prefs || !tz) return answer(400, 'Not reminder settings.');
    const kept = await reminders(env).setPrefs(endpoint, prefs, tz);
    return kept ? answer(200, { ok: true }) : answer(404, 'No such subscription.');
  }
  if (route === 'POST /api/push/unsubscribe') {
    if (!endpoint) return answer(400, 'Not a subscription.');
    await reminders(env).unsubscribe(endpoint);
    return answer(200, { ok: true });
  }
  if (route === 'POST /api/push/test') {
    if (!endpoint) return answer(400, 'Not a subscription.');
    const taken = await reminders(env).test(endpoint);
    if (taken === null) return answer(404, 'No such subscription.');
    return taken ? answer(200, { ok: true }) : answer(502, 'The push service did not take it.');
  }
  return answer(404, 'No such route.');
}

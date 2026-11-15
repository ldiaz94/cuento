/* cuento's Worker: the API for shelves that sync between devices. Every
 * path but /api/* is a static file (wrangler.jsonc sends only those here).
 *
 *   POST /api/shelf/<code>/sync   {since, changes, settings?, prefs?}
 *                                 ─► {seq, changes, settings?, prefs?}
 *   GET  /api/shelf/<code>/live   a WebSocket that hears "changed"
 *
 * The sync code is the shelf's address and its only secret: each code has
 * its own Durable Object (Shelf), named by the code's SHA-256 so the code
 * itself is never stored. Depends on store.ts and Cloudflare's Workers,
 * Durable Objects (with SQLite) and WebSocket hibernation.
 *
 * Accounts (passkeys that own a shelf, /api/auth/* and /api/me) are
 * auth.ts's; reminders (Web Push, /api/push/* and the quarter-hour cron)
 * are notify.ts's; Where to buy's prices (/api/prices) are shop.ts's.
 * Leaves out rate limits and deleting a shelf. */
import { DurableObject } from 'cloudflare:workers';
import { setUp, parse, apply, applySettings, applyPrefs, changedSince } from './store.ts';
import type { Sql, SyncRequest, SyncReply } from './store.ts';
import { auth } from './auth.ts';
export { Accounts } from './auth.ts';
import { push, sendDue } from './notify.ts';
export { Reminders } from './notify.ts';
import { shop } from './shop.ts';
export { Prices } from './shop.ts';

/** A sync code: 26 characters of Crockford's base32, upper case. */
const ROUTE = /^\/api\/shelf\/([0-9A-HJKMNP-TV-Z]{26})\/(sync|live)$/;
/** The largest sync body taken, in bytes. */
const MAX_BODY = 1 << 20;

/** One shelf: its books in SQLite, and the devices listening for changes. */
export class Shelf extends DurableObject<Env> {
  /** The store's SQL, on this object's own database. */
  private sql: Sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray();
    setUp(this.sql);
  }

  /** Keeps a device's changes and answers with what it hasn't seen; when
   * anything changed, tells every listening device. */
  sync(request: SyncRequest): SyncReply {
    const kept = this.ctx.storage.transactionSync(
      () =>
        apply(this.sql, request.changes) +
        (request.settings && applySettings(this.sql, request.settings) ? 1 : 0) +
        (request.prefs && applyPrefs(this.sql, request.prefs) ? 1 : 0),
    );
    if (kept > 0)
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send('changed');
        } catch {
          // a socket closing as we speak: it syncs when it comes back
        }
      }
    return changedSince(this.sql, request.since, request.version);
  }

  /** A device listening: a WebSocket the object may sleep through. */
  async fetch(): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!);
    return new Response(null, { status: 101, webSocket: client });
  }
}

/** A plain-text answer with no caching. */
function answer(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** text's SHA-256, in hex. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // www.cuento.page is cuento.page: one address, so passkeys and the
    // shelf in the browser are always found in the same place.
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.href, 301);
    }
    const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (path.startsWith('/api/auth/') || path === '/api/me' || path.startsWith('/api/me/'))
      return auth(request, env, path);
    if (path.startsWith('/api/push/')) return push(request, env, path);
    if (path === '/api/prices') return shop(request, env);
    const route = ROUTE.exec(path);
    if (!route) return answer(404, 'No such shelf.');
    const [, code, what] = route as unknown as [string, string, string];
    const shelf = env.SHELF.get(env.SHELF.idFromName(await sha256(code)));

    if (what === 'live') {
      if (request.headers.get('Upgrade') !== 'websocket') return answer(426, 'A WebSocket only.');
      return shelf.fetch(request);
    }
    if (request.method !== 'POST') return answer(405, 'POST only.');
    if (Number(request.headers.get('Content-Length')) > MAX_BODY) return answer(413, 'Too big.');
    const body = await request.text();
    if (body.length > MAX_BODY) return answer(413, 'Too big.');
    let sync: SyncRequest | null = null;
    try {
      sync = parse(JSON.parse(body));
    } catch {
      // not JSON: refused below
    }
    if (!sync) return answer(400, 'Not a sync.');
    return Response.json(await shelf.sync(sync), { headers: { 'Cache-Control': 'no-store' } });
  },

  /** The Cron Trigger, every quarter hour: send the reminders due. */
  async scheduled(controller, env) {
    await sendDue(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;

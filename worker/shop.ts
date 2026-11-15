/* Where to buy's prices: the route, and the Durable Object (Prices, one
 * per ISBN) that asks the stores' APIs and keeps their answers a day.
 *
 *   GET /api/prices?isbn=<ISBN-13>&region=<XX>&stores=<id>,<id>
 *     ─► {isbn, region, results: {<id>: StoreResult}}   (src/offers.ts)
 *     ─► 400 with a reason, when the query isn't one
 *
 * One object per ISBN keeps each its own small SQLite, and the readers
 * looking at one book at once share its answers; two asking the same
 * store at once share one fetch. An alarm forgets the answers as they
 * expire, and the object's storage once none is left. Depends on
 * prices.ts and Cloudflare's Durable Objects with SQLite. Leaves out
 * rate limits (each store is asked at most once a day per book). */
import { DurableObject } from 'cloudflare:workers';
import * as cache from './prices.ts';
import type { PriceQuery } from './prices.ts';
import type { Sql } from './store.ts';
import type { PriceReply, StoreResult } from '../src/offers.ts';

/** One book's prices: its own SQLite, the stores asked through it. */
export class Prices extends DurableObject<Env> {
  private sql: Sql;
  /** Answers being fetched, by store and region, so a second reader waits on the first. */
  private asking = new Map<string, Promise<Record<string, StoreResult>>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray();
    cache.setUp(this.sql);
  }

  /** Every store's answer for q, kept or fetched. */
  async prices(q: PriceQuery): Promise<Record<string, StoreResult>> {
    const get = cache.fetchJson(fetch);
    const parts = await Promise.all(
      q.stores.map(id => {
        const key = id + ' ' + q.region;
        let p = this.asking.get(key);
        if (!p) {
          p = cache.prices(this.sql, get, { ...q, stores: [id] }, Date.now());
          this.asking.set(key, p);
          void p.finally(() => this.asking.delete(key)).catch(() => {});
        }
        return p;
      }),
    );
    if ((await this.ctx.storage.getAlarm()) === null) {
      const next = cache.prune(this.sql, Date.now());
      if (next !== null) await this.ctx.storage.setAlarm(next);
    }
    return Object.assign({}, ...parts) as Record<string, StoreResult>;
  }

  /** Forgets what has expired; when nothing is left, the whole store. */
  async alarm() {
    const next = cache.prune(this.sql, Date.now());
    if (next === null) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.setAlarm(next);
  }
}

/** The /api/prices route. */
export async function shop(request: Request, env: Env): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (request.method !== 'GET') return new Response('GET only.', { status: 405, headers });
  const q = cache.parseQuery(new URL(request.url));
  if (typeof q === 'string') return new Response(q, { status: 400, headers });
  const results = await env.PRICES.get(env.PRICES.idFromName(q.isbn)).prices(q);
  const reply: PriceReply = { isbn: q.isbn, region: q.region, results };
  // Kept by the browser an hour, or ten minutes when a store didn't answer.
  const failed = Object.values(results).some(r => r.status === 'error');
  return Response.json(reply, {
    headers: { 'Cache-Control': `private, max-age=${failed ? 600 : 3600}` },
  });
}

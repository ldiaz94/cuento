/* Makes a VAPID key pair for Web Push (robbie vapid): a P-256 key, its
 * public half for wrangler.jsonc's VAPID_PUBLIC_KEY, its private half (d,
 * base64url) for the Worker's secret VAPID_PRIVATE_KEY. The private half
 * goes to standard output only, and only into a pipe, never the screen:
 *
 *   node tools/vapid.ts | npx wrangler secret put VAPID_PRIVATE_KEY
 *
 * The public half and what to do with it go to standard error. Depends on
 * Node alone. Leaves out editing wrangler.jsonc. */
import { webcrypto } from 'node:crypto';

if (process.stdout.isTTY) {
  console.error(
    'Pipe me into the secret: node tools/vapid.ts | npx wrangler secret put VAPID_PRIVATE_KEY',
  );
  process.exit(1);
}
const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
]);
const point = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey));
const { d } = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
console.error(
  `Set this in wrangler.jsonc, then deploy; keep the pair (browsers subscribed with an old key hear nothing):\n` +
    `  "VAPID_PUBLIC_KEY": "${point.toString('base64url')}",`,
);
process.stdout.write(d!);

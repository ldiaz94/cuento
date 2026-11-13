/* A static file server for web/, for the browser tests and for trying
 * cuento on a phone on the same network: node test/serve.js [port].
 * Depends on Node alone. Leaves out caching, ranges and HTTPS (a phone's
 * camera needs HTTPS: use the deployed site, or a tunnel). */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

/** The directory served. */
const ROOT = new URL('../web/', import.meta.url).pathname;
/** Media types by extension. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

/** Starts serving web/ on port (0: any free one); resolves to the server. */
export function serve(port = 0) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = join(ROOT, path.endsWith('/') ? path + 'index.html' : path);
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const server = await serve(Number(process.argv[2] || 8080));
  console.log('cuento on http://localhost:' + server.address().port + '/');
}

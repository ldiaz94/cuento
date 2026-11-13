/* A static file server for build/site/ (robbie build), for the browser
 * tests and for trying cuento on a phone on the same network:
 * node test/serve.ts [port]. Depends on Node alone. Leaves out caching,
 * ranges and HTTPS (a phone's camera needs HTTPS: use the deployed site,
 * or a tunnel). */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

/** The directory served. */
const ROOT = new URL('../build/site/', import.meta.url).pathname;
/** Media types by extension. */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

/** Starts serving build/site/ on port (0: any free one). */
export function serve(port = 0): Promise<Server> {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url || '/', 'http://x').pathname));
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

/** The URL server answers on. */
export function origin(server: Server): string {
  return 'http://localhost:' + (server.address() as AddressInfo).port + '/';
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const server = await serve(Number(process.argv[2] || 8080));
  console.log('cuento on ' + origin(server));
}

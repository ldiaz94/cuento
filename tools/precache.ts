/* Writes build/site/app/sw.js from public/sw.js (robbie build): fills in the
 * list of files the service worker keeps for offline use, and a version
 * that is a hash of those files, so a deploy that changes anything gets a
 * new cache; and version.json, that version and the day, for the page to
 * show. Run after build/site/app/ is complete: node tools/precache.ts.
 * Depends on Node alone. Leaves out the page's own URL ("./"): the worker
 * adds it. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The built site. */
const SITE = new URL('../build/site/app/', import.meta.url).pathname;
/** The line in public/sw.js this script fills in. */
const MARKER = /^const BUILD = .*$/m;

// Every file but sw.js itself, as a path from the site's root, sorted.
const files = readdirSync(SITE, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile())
  .map(e => relative(SITE, join(e.parentPath, e.name)))
  .filter(f => f !== 'sw.js' && f !== 'version.json')
  .sort();

// The version: a hash of every file's name and bytes.
const hash = createHash('sha256');
for (const f of files) hash.update(f).update(readFileSync(SITE + f));
const version = hash.digest('hex').slice(0, 12);

// The version the page shows (Settings), kept offline with the rest.
const built = new Date().toISOString().slice(0, 10);
writeFileSync(SITE + 'version.json', JSON.stringify({ version, built }) + '\n');
files.push('version.json');

const worker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
if (!MARKER.test(worker)) throw new Error('public/sw.js has no "const BUILD" line');
const line = `const BUILD = ${JSON.stringify({ version, files })};`;
writeFileSync(
  SITE + 'sw.js',
  worker.replace(MARKER, () => line),
);

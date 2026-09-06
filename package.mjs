#!/usr/bin/env node
/**
 * Assemble `dist/` — everything needed to serve the player, nothing else.
 *
 * The player is plain static files, so `dist/` drops onto any static host
 * (here.now, Netlify, S3, GitHub Pages, an intranet nginx) with no build step
 * and no server. Courses are read in the visitor's browser, so nothing is
 * uploaded and the host never sees course content.
 *
 * The sample course is deliberately excluded: it is real course data used for
 * local smoke-testing, not something to publish.
 */
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');

const INCLUDE = ['index.html', 'player.js', 'audio-check.html', 'vendor'];

async function size(path) {
  const s = await stat(path);
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    total += await size(join(path, entry.name));
  }
  return total;
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

let total = 0;
for (const item of INCLUDE) {
  const from = resolve(here, item);
  await cp(from, join(dist, item), { recursive: true });
  const bytes = await size(from);
  total += bytes;
  console.log(`  ${item.padEnd(14)} ${(bytes / 1e6).toFixed(2)} MB`);
}
console.log(`dist/ ready — ${(total / 1e6).toFixed(1)} MB total`);

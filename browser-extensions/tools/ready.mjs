#!/usr/bin/env node
// Writes the committed, load-as-is builds: ../ready-to-load/edge-chrome/<extension> and ../ready-to-load/firefox/<extension>.
// These let people install straight from a download of the repo without Node or a build step.
// Chrome and Edge builds are identical, so they share one folder.
//
//   node tools/ready.mjs                    (npm run ready)
//   node tools/ready.mjs --brand brand/examples/summit-logistics.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, '..', 'ready-to-load');
const brandIdx = process.argv.indexOf('--brand');
const brand = brandIdx > 0 ? process.argv[brandIdx + 1] : 'brand/brand.json';

export async function writeReady(outDir = OUT, { quiet = false } = {}) {
  const tmp = `${outDir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  await build({ brand, browsers: ['chrome', 'firefox'], out: path.relative(ROOT, tmp), zip: false, quiet: true });
  fs.renameSync(path.join(tmp, 'chrome'), path.join(tmp, 'edge-chrome'));
  for (const name of ['edge-chrome', 'firefox']) {
    fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.renameSync(path.join(tmp, name), path.join(outDir, name));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!quiet) console.log(`✓ ready-to-load/ updated (${fs.readdirSync(path.join(outDir, 'edge-chrome')).join(', ')})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeReady().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

#!/usr/bin/env node
// Syntax-checks every script, builds every extension for every browser and verifies that
// every file referenced by manifests, HTML pages and JS imports exists in the build.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';
import { walk } from './lib.mjs';
import { writeReady } from './ready.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > 0 ? process.argv[onlyIdx + 1].split(',') : null;
const CHECK_OUT = `dist/.check-${process.pid}`;
const errors = [];
const err = (m) => errors.push(m);

// 1. Syntax
const sources = walk(ROOT).filter((f) => !f.includes(`${path.sep}dist`) && !f.includes('node_modules') && /\.(m?js)$/.test(f));
for (const f of sources) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) err(`syntax: ${path.relative(ROOT, f)}\n${r.stderr.trim()}`);
}
const jsons = walk(ROOT).filter((f) => !f.includes(`${path.sep}dist`) && !f.includes('node_modules') && f.endsWith('.json'));
for (const f of jsons) {
  try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { err(`json: ${path.relative(ROOT, f)}: ${e.message}`); }
}
console.log(`Checked ${sources.length} scripts and ${jsons.length} JSON files.`);

// 2. Build into a scratch folder
const results = await build({ out: CHECK_OUT, zip: false, quiet: true, only });

// 3. Reference validation
for (const { ext, browser, dir, manifest: m } of results) {
  const where = `${browser}/${ext}`;
  const must = (rel, from = `manifest`) => {
    if (!rel || /^(https?:|data:|#|mailto:)/.test(rel)) return;
    const clean = rel.split(/[?#]/)[0];
    if (clean.includes('*')) return;
    const p = path.join(dir, clean.replace(/^\//, ''));
    if (!fs.existsSync(p)) err(`${where}: ${from} references missing file "${rel}"`);
  };
  if (browser === 'firefox') {
    (m.background?.scripts || []).forEach((s) => must(s, 'background.scripts'));
    if (m.background?.service_worker) err(`${where}: firefox manifest still has service_worker`);
    if (!m.browser_specific_settings?.gecko?.id) err(`${where}: missing gecko id`);
  } else {
    must(m.background?.service_worker, 'background.service_worker');
    must(m.storage?.managed_schema, 'storage.managed_schema');
  }
  Object.values(m.icons || {}).forEach((s) => must(s, 'icons'));
  Object.values(m.action?.default_icon || {}).forEach((s) => must(s, 'action.default_icon'));
  must(m.action?.default_popup, 'action.default_popup');
  must(m.options_ui?.page, 'options_ui.page');
  must(m.options_page, 'options_page');
  for (const cs of m.content_scripts || []) {
    (cs.js || []).forEach((s) => must(s, 'content_scripts.js'));
    (cs.css || []).forEach((s) => must(s, 'content_scripts.css'));
  }
  for (const r of m.declarative_net_request?.rule_resources || []) must(r.path, 'declarative_net_request');
  for (const w of m.web_accessible_resources || []) (w.resources || []).forEach((s) => must(s, 'web_accessible_resources'));
  if (m.manifest_version !== 3) err(`${where}: manifest_version must be 3`);

  for (const file of walk(dir)) {
    const rel = path.relative(dir, file);
    if (file.endsWith('.html')) {
      const html = fs.readFileSync(file, 'utf8');
      for (const [, ref] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
        if (/^(https?:|data:|#|mailto:|javascript:)/.test(ref)) {
          if (/^https?:/.test(ref) && /<script[^>]+src=["']https?:/.test(html)) err(`${where}: ${rel} loads remote script (not allowed in MV3)`);
          continue;
        }
        const target = ref.startsWith('/') ? path.join(dir, ref) : path.join(path.dirname(file), ref);
        if (!fs.existsSync(target.split(/[?#]/)[0])) err(`${where}: ${rel} references missing "${ref}"`);
      }
      if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html)) err(`${where}: ${rel} has an inline <script> (blocked by MV3 CSP)`);
      if (/\son[a-z]+=["']/.test(html)) err(`${where}: ${rel} has an inline event handler (blocked by MV3 CSP)`);
    }
    if (/\.m?js$/.test(file)) {
      const js = fs.readFileSync(file, 'utf8');
      const specs = [
        ...js.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm),
        ...js.matchAll(/^\s*export\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/gm),
      ].map((x) => x[1]);
      for (const s of specs) {
        if (!s.startsWith('.') && !s.startsWith('/')) {
          err(`${where}: ${rel} imports bare module "${s}" (no bundler, use a relative path)`);
          continue;
        }
        const target = s.startsWith('/') ? path.join(dir, s) : path.join(path.dirname(file), s);
        if (!fs.existsSync(target)) err(`${where}: ${rel} imports missing "${s}"`);
      }
    }
  }
}

fs.rmSync(path.join(ROOT, CHECK_OUT), { recursive: true, force: true });

// 4. The committed ready-to-load/ folders must match the source (people install from them directly).
if (!only) {
  const committed = path.resolve(ROOT, '..', 'ready-to-load');
  const fresh = path.join(ROOT, `dist/.ready-${process.pid}`);
  await writeReady(fresh, { quiet: true });
  const list = (dir) => (fs.existsSync(dir) ? walk(dir).map((f) => path.relative(dir, f)).filter((f) => !f.endsWith('README.md')).sort() : []);
  const a = list(committed);
  const b = list(fresh);
  const stale = b.filter((f) => !a.includes(f) || !fs.readFileSync(path.join(committed, f)).equals(fs.readFileSync(path.join(fresh, f))));
  const extra = a.filter((f) => !b.includes(f));
  if (stale.length || extra.length) {
    err(`ready-to-load/ is out of date (${stale.length + extra.length} file(s), e.g. ${[...stale, ...extra][0]}). Run: npm run ready`);
  }
  fs.rmSync(fresh, { recursive: true, force: true });
}

if (errors.length) {
  console.error(`\n✗ ${errors.length} problem(s):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`✓ ${results.length} builds valid (${[...new Set(results.map((r) => r.ext))].join(', ')}).`);

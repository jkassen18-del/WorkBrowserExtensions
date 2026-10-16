#!/usr/bin/env node
// Headless Chromium screenshots of extension pages (uses the pre-installed Playwright, if any).
//
//   node tools/screenshot.mjs go-links options/options.html#links popup/popup.html
//   node tools/screenshot.mjs env-labeler --url http://localhost:8000/   (screenshot a web page with the extension active)
//
// Output: screenshots/<extension>-<page>.png. Console errors from extension pages are printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [ext, ...rest] = process.argv.slice(2);
if (!ext) {
  console.log('Usage: node tools/screenshot.mjs <extension> [page.html#hash ...] [--url https://site] [--width 1280] [--height 800]');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    const req = createRequire(path.join(process.execPath, '..', '..', 'lib', 'node_modules', 'x.js'));
    ({ chromium } = req('playwright'));
  } catch {
    console.error('Playwright is not installed. Run "npm i -D playwright" (optional; only needed for screenshots).');
    process.exit(1);
  }
}

const pages = [];
const urls = [];
let width = 1280;
let height = 800;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--url') urls.push(rest[++i]);
  else if (rest[i] === '--width') width = Number(rest[++i]);
  else if (rest[i] === '--height') height = Number(rest[++i]);
  else pages.push(rest[i]);
}
if (!pages.length && !urls.length) pages.push('options/options.html');

const extDir = path.join(ROOT, 'dist', 'chrome', ext);
if (!fs.existsSync(extDir)) {
  console.error(`Build first: npm run build (missing ${extDir})`);
  process.exit(1);
}
const outDir = path.join(ROOT, 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-shot-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: 'chromium',
  viewport: { width, height },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
const id = new URL(worker.url()).host;
await new Promise((r) => setTimeout(r, 800));
for (const p of context.pages()) if (p.url().includes(id)) await p.close().catch(() => {});

let failures = 0;
const shoot = async (target, name) => {
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') { failures++; console.log(`  console.error [${name}]: ${m.text()}`); } });
  page.on('pageerror', (e) => { failures++; console.log(`  pageerror [${name}]: ${e.message}`); });
  await page.goto(target);
  // The first storage.managed read in a fresh profile can take a couple of seconds.
  await page.waitForFunction(() => {
    const b = document.body;
    if (!b || !b.children.length) return false;
    const main = b.querySelector('.wx-main');
    return !main || (main.children.length > 0 && main.textContent.trim() !== 'Loading…');
  }, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
  const file = path.join(outDir, `${ext}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`✓ ${path.relative(ROOT, file)}`);
  await page.close();
};

for (const p of pages) await shoot(`chrome-extension://${id}/${p}`, p.replace(/[^a-z0-9]+/gi, '_').replace(/_html_?/, '_').replace(/_$/, ''));
for (const u of urls) await shoot(u, `web_${new URL(u).hostname.replace(/[^a-z0-9]+/gi, '_')}`);

await context.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
if (failures) {
  console.log(`${failures} error(s) logged by the pages above.`);
  process.exitCode = 2;
}

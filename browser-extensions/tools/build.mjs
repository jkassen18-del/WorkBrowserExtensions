#!/usr/bin/env node
// Builds every extension for Chrome, Edge and Firefox. No dependencies.
//
//   node tools/build.mjs                          all extensions, all browsers, with zips
//   node tools/build.mjs --brand brand/examples/summit-logistics.json
//   node tools/build.mjs --browser chrome --only go-links --no-zip
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePNG, zipDir, copyDir, deepMerge, schemaFromDefaults } from './lib.mjs';
import { renderIcon } from '../shared/icon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BROWSERS = ['chrome', 'edge', 'firefox'];
const ICON_SIZES = [16, 32, 48, 128];
const FIREFOX_MIN = '128.0';
const FIREFOX_DROP_KEYS = ['minimum_chrome_version', 'offline_enabled', 'side_panel', 'key', 'update_url', 'storage', 'externally_connectable'];
const FIREFOX_DROP_PERMS = ['offscreen', 'sidePanel', 'favicon', 'tabGroups'];
const SKIP = new Set(['README.md', 'node_modules', '.DS_Store']);

function parseArgs(argv) {
  const args = { brand: 'brand/brand.json', browsers: BROWSERS, only: null, zip: true, out: 'dist', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--brand') args.brand = argv[++i];
    else if (a === '--browser') args.browsers = argv[++i].split(',');
    else if (a === '--only') args.only = argv[++i].split(',');
    else if (a === '--no-zip') args.zip = false;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node tools/build.mjs [--brand file.json] [--browser chrome,edge,firefox] [--only ext1,ext2] [--no-zip] [--out dist]');
      process.exit(0);
    }
  }
  return args;
}

export function listExtensions() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort();
}

function loadBrand(brandPath) {
  const abs = path.resolve(ROOT, brandPath);
  const brand = JSON.parse(fs.readFileSync(abs, 'utf8'));
  let logoFile = null;
  if (brand.logo && !/^(data:|https?:)/.test(brand.logo)) {
    const p = path.resolve(path.dirname(abs), brand.logo);
    if (fs.existsSync(p)) logoFile = p;
    else {
      console.warn(`! brand logo not found: ${p} (continuing without a logo)`);
      brand.logo = '';
    }
  }
  return { brand, logoFile };
}

async function loadDefaults(ext) {
  const file = path.join(ROOT, ext, 'defaults.js');
  if (!fs.existsSync(file)) return { defaults: {}, descriptions: {}, overrides: {} };
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return { defaults: mod.default || {}, descriptions: mod.DESCRIPTIONS || {}, overrides: mod.SCHEMA || {} };
}

function transformManifest(src, browser, ext, brand) {
  let m = JSON.parse(JSON.stringify(src));
  const overrides = m.browser_overrides?.[browser];
  delete m.browser_overrides;
  const glyph = m.wx?.glyph || 'link';
  delete m.wx;
  if (overrides) m = deepMerge(m, overrides);

  const baseName = m.name;
  m.name = brand.productPrefix ? `${brand.productPrefix} ${baseName}` : baseName;
  m.short_name = m.short_name || baseName.slice(0, 12);
  if (brand.companyName && m.description) m.description = m.description.replace(/\{company\}(\.?)/g, (_, dot) => brand.companyName.replace(/\.$/, '') + (dot || (brand.companyName.endsWith('.') ? '.' : '')));
  if (brand.companyName) m.author = m.author || brand.companyName;
  m.icons = Object.fromEntries(ICON_SIZES.map((s) => [String(s), `icons/icon-${s}.png`]));
  m.action = { ...(m.action || {}), default_icon: Object.fromEntries([16, 32, 48].map((s) => [String(s), `icons/icon-${s}.png`])) };
  if (m.action.default_title) m.action.default_title = m.action.default_title.replace(/\{name\}/g, m.name);
  else m.action.default_title = m.name;

  if (browser === 'firefox') {
    if (m.background?.service_worker) {
      const { service_worker, ...rest } = m.background;
      m.background = { ...rest, scripts: [service_worker] };
    }
    for (const k of FIREFOX_DROP_KEYS) delete m[k];
    if (m.permissions) m.permissions = m.permissions.filter((p) => !FIREFOX_DROP_PERMS.includes(p));
    if (m.web_accessible_resources) {
      m.web_accessible_resources = m.web_accessible_resources.map(({ use_dynamic_url, ...r }) => r);
    }
    const domain = brand.extensionIdDomain || 'example.com';
    m.browser_specific_settings = deepMerge({
      gecko: { id: `${ext}@${domain}`, strict_min_version: FIREFOX_MIN },
    }, m.browser_specific_settings || {});
  } else {
    m.storage = { ...(m.storage || {}), managed_schema: 'schema.json' };
    delete m.browser_specific_settings;
  }
  return { manifest: m, glyph };
}

export async function build(opts = {}) {
  const args = { ...parseArgs([]), ...opts };
  const log = (...a) => !args.quiet && console.log(...a);
  const { brand, logoFile } = loadBrand(args.brand);
  const outRoot = path.resolve(ROOT, args.out);
  const exts = listExtensions().filter((e) => !args.only || args.only.includes(e));
  if (!exts.length) throw new Error('No extensions found to build.');
  const results = [];

  for (const ext of exts) {
    const srcDir = path.join(ROOT, ext);
    const srcManifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
    const { defaults, descriptions, overrides } = await loadDefaults(ext);
    const schema = schemaFromDefaults(defaults, descriptions, overrides);
    // Keep the documented schema in the source tree in sync with defaults.js.
    fs.writeFileSync(path.join(srcDir, 'schema.json'), `${JSON.stringify(schema, null, 2)}\n`);

    for (const browser of args.browsers) {
      const dest = path.join(outRoot, browser, ext);
      fs.rmSync(dest, { recursive: true, force: true });
      copyDir(srcDir, dest, (p, e) => SKIP.has(e.name) || (e.name === 'manifest.json' && path.dirname(p) === srcDir));
      copyDir(path.join(ROOT, 'shared'), path.join(dest, 'shared'), (p, e) => SKIP.has(e.name));

      const runtimeBrand = { ...brand };
      if (logoFile) {
        const name = `logo${path.extname(logoFile)}`;
        fs.copyFileSync(logoFile, path.join(dest, 'shared', name));
        runtimeBrand.logo = name;
      }
      fs.writeFileSync(path.join(dest, 'shared', 'brand.json'), JSON.stringify(runtimeBrand, null, 2));

      const { manifest, glyph } = transformManifest(srcManifest, browser, ext, brand);
      fs.mkdirSync(path.join(dest, 'icons'), { recursive: true });
      for (const s of ICON_SIZES) {
        const { width, height, data } = renderIcon(glyph, s, brand.primary, brand.accent);
        fs.writeFileSync(path.join(dest, 'icons', `icon-${s}.png`), encodePNG(width, height, data));
      }
      fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));

      let zip = null;
      if (args.zip) {
        zip = path.join(outRoot, browser, `${ext}-${manifest.version}.zip`);
        zipDir(dest, zip);
      }
      results.push({ ext, browser, dir: dest, zip, manifest });
      log(`✓ ${browser.padEnd(8)} ${ext.padEnd(14)} → ${path.relative(ROOT, dest)}${zip ? `  (+ ${path.basename(zip)})` : ''}`);
    }
  }
  log(`\nBuilt ${exts.length} extension(s) × ${args.browsers.length} browser(s) with brand "${brand.companyName}".`);
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build(parseArgs(process.argv.slice(2))).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

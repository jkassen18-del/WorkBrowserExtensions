// Page shells: the Settings app (left nav + panels, with the shared Branding, Connections,
// Backup & policy and About panels) and the popup header/footer.
import { api, send } from './api.js';
import { h, add, clear, toast, modal, confirmDialog, download, pickFile, readAsDataURL, formatDate, toggle, lockedBadge } from './ui.js';
import { loadBrandState, applyBrand, productName, logoSrc, saveBrandOverride, onBrandChange, BRAND_FIELDS } from './brand.js';
import {
  CONNECTION_TYPES, getConnectionState, saveConnection, requestHostAccess, testConnection, SUPABASE_SQL,
} from './connections.js';

const PRESETS = [
  ['#4F46E5', '#0EA5E9'], ['#0F766E', '#F59E0B'], ['#BE185D', '#7C3AED'], ['#1D4ED8', '#22C55E'],
  ['#B91C1C', '#F97316'], ['#111827', '#6B7280'], ['#7C3AED', '#EC4899'], ['#0369A1', '#14B8A6'],
];

function logoEl(brand, cls = 'wx-logo') {
  const src = logoSrc(brand);
  if (src) return h('img', { class: cls, src, alt: '' });
  return h('div.wx-logo-fallback', (brand.companyName || '?').trim().charAt(0).toUpperCase());
}

/** Applies the brand to the current page and keeps it updated. Returns the brand. */
export async function brandPage(baseName, { titleSuffix = '' } = {}) {
  const { brand } = await loadBrandState();
  applyBrand(brand);
  document.title = productName(brand, baseName) + (titleSuffix ? ` · ${titleSuffix}` : '');
  onBrandChange((b) => applyBrand(b));
  return brand;
}

/**
 * Renders a popup frame. Returns { body, brand } where body is the element to fill.
 */
export async function mountPopup(baseName, { optionsHash = '' } = {}) {
  const brand = await brandPage(baseName);
  document.body.classList.add('popup');
  const body = h('div.popup-body');
  const support = brand.supportUrl
    ? h('a', { href: brand.supportUrl, target: '_blank', rel: 'noopener' }, 'Get help')
    : brand.supportEmail ? h('a', { href: `mailto:${brand.supportEmail}` }, 'Get help') : h('span', brand.footerText || '');
  document.body.append(
    h('div.popup-header', logoEl(brand, ''), h('div.grow', h('div.wx-title', productName(brand, baseName))),
      h('button.icon-btn', {
        title: 'Settings', 'aria-label': 'Settings', style: { color: 'inherit' },
        onclick: () => openOptions(optionsHash),
      }, '⚙')),
    body,
    h('div.popup-footer', support, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openOptions(optionsHash); } }, 'Settings')),
  );
  return { body, brand };
}

export function openOptions(hash = '') {
  const u = api.runtime.getURL(`options/options.html${hash ? `#${hash}` : ''}`);
  api.tabs.create({ url: u });
  if (document.body.classList.contains('popup')) window.close();
}

/**
 * Settings app.
 * @param {object} o
 * @param {string} o.baseName          e.g. "Go-Links"
 * @param {string} o.tagline           one line under the title
 * @param {object} o.settings          createSettings() instance
 * @param {Array}  o.panels            [{ id, label, icon, render(el, ctx) }] extension panels (first one is the default)
 * @param {Array}  [o.syncCollections] collection names this extension shares when a backend is linked
 * @param {string} [o.welcome]         HTML/text shown on the welcome screen (first install)
 * @param {Array}  [o.welcomeSteps]    short getting-started steps
 */
export async function mountApp(o) {
  const settings = o.settings;
  let brandState = await loadBrandState();
  applyBrand(brandState.brand);
  let state = await settings.load();

  const header = h('header.wx-header');
  const nav = h('nav.wx-nav', { 'aria-label': 'Sections' });
  const main = h('main.wx-main');
  const footer = h('footer.wx-footer');
  document.body.append(header, h('div.wx-layout', nav, main), footer);

  const common = [
    { id: 'branding', label: 'Branding', icon: '🎨', render: renderBranding },
    { id: 'connections', label: 'Shared data', icon: '🔗', render: renderConnections },
    { id: 'backup', label: 'Backup & policy', icon: '💾', render: renderBackup },
    { id: 'about', label: 'About', icon: 'ℹ️', render: renderAbout },
  ];
  const all = [...o.panels, ...common];
  let current = null;

  const ctx = {
    settings,
    get values() { return state.values; },
    get state() { return state; },
    get brand() { return brandState.brand; },
    isLocked: (k) => state.locked.has(k),
    async save(patch, { quiet = false } = {}) {
      const before = state.locked;
      const blocked = Object.keys(patch).filter((k) => before.has(k));
      state = await settings.set(patch);
      if (blocked.length) toast('Some settings are managed by your IT department and were not changed.', { error: true });
      else if (!quiet) toast('Saved');
      return state.values;
    },
    field: (spec) => field(spec, ctx),
    navigate: (id) => show(id),
    rerender: () => show(current, true),
    lockedBadge,
  };

  function paintChrome() {
    const b = brandState.brand;
    applyBrand(b);
    document.title = `${productName(b, o.baseName)} · Settings`;
    clear(header, logoEl(b), h('div.grow',
      h('div.wx-title', productName(b, o.baseName)),
      h('div.wx-sub', o.tagline || '')),
    h('span.badge', { title: 'Your data is stored in this browser only' }, '🔒 Stored on this device'));
    clear(footer, b.footerText || '', b.supportUrl ? [' · ', h('a', { href: b.supportUrl, target: '_blank', rel: 'noopener' }, 'Help')] : '',
      b.supportEmail ? [' · ', h('a', { href: `mailto:${b.supportEmail}` }, b.supportEmail)] : '');
    clear(nav);
    o.panels.forEach((p) => nav.append(navBtn(p)));
    nav.append(h('div.wx-nav-sep'));
    common.forEach((p) => nav.append(navBtn(p)));
  }

  function navBtn(p) {
    return h('button', {
      'aria-current': current === p.id ? 'page' : null,
      dataset: { id: p.id },
      onclick: () => show(p.id),
    }, p.icon ? h('span', { 'aria-hidden': 'true' }, p.icon) : null, p.label);
  }

  async function show(id, force = false) {
    id = String(id || '').split('?')[0]; // "#panel?x=y" deep links: the page reads the query itself
    if (id === 'welcome') return showWelcome();
    const panel = all.find((p) => p.id === id) || all[0];
    if (current === panel.id && !force) return;
    current = panel.id;
    if (location.hash.slice(1) !== panel.id) history.replaceState(null, '', `#${panel.id}`);
    nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', b.dataset.id === panel.id ? 'page' : 'false'));
    clear(main, h('div.muted', 'Loading…'));
    const el = h('div');
    try {
      await panel.render(el, ctx);
    } catch (e) {
      console.error(e);
      el.append(h('div.notice.danger', `Something went wrong: ${e.message}`));
    }
    clear(main, el);
    main.focus?.();
  }

  function showWelcome() {
    current = 'welcome';
    const b = brandState.brand;
    clear(main, h('div.card',
      h('h1', `Welcome to ${productName(b, o.baseName)}`),
      h('p.muted', o.tagline || ''),
      o.welcome ? h('p', o.welcome) : null,
      o.welcomeSteps?.length ? h('ol', o.welcomeSteps.map((s) => h('li', { style: { marginBottom: '6px' } }, s))) : null,
      h('div.notice', 'Everything you add is stored in this browser only. No account or server is needed. ',
        'If your team wants to share data later, link a database under ', h('b', 'Shared data'), '.'),
      h('div.row', h('button.btn.primary', { onclick: () => show(all[0].id) }, 'Get started'),
        h('button.btn', { onclick: () => show('branding') }, 'Customize branding'))));
  }

  // ---- Common panels ------------------------------------------------------------

  async function renderBranding(el) {
    brandState = await loadBrandState();
    const { locked, bundled } = brandState;
    let draft = { ...brandState.brand };
    const preview = h('div');

    const paintPreview = () => {
      const p = h('div.brand-preview');
      applyVars(p, draft);
      clear(preview, p);
      p.append(
        h('div.popup-header', logoEl(draft, ''), h('div.wx-title', productName(draft, o.baseName))),
        h('div', { style: { padding: '14px', background: 'var(--wx-surface)' } },
          h('p', { style: { margin: '0 0 10px' } }, `${draft.companyName || 'Your company'}`),
          h('div.row', h('button.btn.primary', 'Primary action'), h('button.btn', 'Secondary'), h('span.badge.primary', 'Badge')),
          h('p.small.muted', { style: { margin: '10px 0 0' } }, draft.footerText || '')),
      );
    };

    const input = (key, label, type = 'text', extra = {}) => {
      const dis = locked.has(key);
      const inp = h('input', { type, value: draft[key] ?? '', disabled: dis, ...extra });
      inp.addEventListener('input', () => {
        draft[key] = type === 'number' || type === 'range' ? Number(inp.value) : inp.value;
        paintPreview();
      });
      return h('div.field', h('label', label, ' ', dis ? lockedBadge() : null), inp);
    };

    const colorRow = (key, label) => {
      const dis = locked.has(key);
      const c = h('input', { type: 'color', value: draft[key], disabled: dis });
      const t = h('input', { type: 'text', value: draft[key], disabled: dis, style: { width: '110px' } });
      const sync = (v) => {
        draft[key] = v;
        c.value = v;
        t.value = v;
        paintPreview();
      };
      c.addEventListener('input', () => sync(c.value));
      t.addEventListener('change', () => /^#[0-9a-f]{6}$/i.test(t.value) && sync(t.value));
      return h('div.field', h('label', label, ' ', dis ? lockedBadge() : null), h('div.row', c, t));
    };

    const logoField = () => {
      const dis = locked.has('logo');
      return h('div.field', h('label', 'Logo ', dis ? lockedBadge() : null),
        h('div.row',
          h('button.btn', {
            disabled: dis,
            onclick: async () => {
              const f = await pickFile('image/png,image/svg+xml,image/jpeg,image/webp');
              if (!f) return;
              if (f.size > 512 * 1024) return toast('Please use an image under 512 KB.', { error: true });
              draft.logo = await readAsDataURL(f);
              paintPreview();
            },
          }, 'Upload…'),
          h('button.btn.ghost', { disabled: dis, onclick: () => { draft.logo = ''; paintPreview(); } }, 'Remove'),
          h('span.small.muted', 'PNG or SVG, square works best')));
    };

    const presets = h('div.row', PRESETS.map(([p, a]) => h('button.swatch', {
      title: `${p} / ${a}`,
      style: { background: `linear-gradient(135deg, ${p} 50%, ${a} 50%)` },
      disabled: locked.has('primary'),
      onclick: () => {
        draft.primary = p;
        draft.accent = a;
        el.querySelectorAll('input[type=color]').forEach((c, i) => { c.value = i ? a : p; c.nextSibling.value = c.value; });
        paintPreview();
      },
    })));

    const themeSel = h('select', { disabled: locked.has('theme') },
      ['auto', 'light', 'dark'].map((t) => h('option', { value: t, selected: draft.theme === t }, t[0].toUpperCase() + t.slice(1))));
    themeSel.addEventListener('change', () => { draft.theme = themeSel.value; paintPreview(); });

    paintPreview();
    add(el,
      h('h1', 'Branding'),
      h('p.muted', 'Name, logo and colours used by every page, popup, in-page dialog and the toolbar icon.'),
      h('div.grid-2',
        h('div.card',
          input('companyName', 'Company name'),
          input('productPrefix', 'Product prefix', 'text', { placeholder: 'e.g. Acme -> "Acme Go-Links"' }),
          logoField(),
          h('div.field', h('label', 'Colour presets'), presets),
          h('div.grid-2', colorRow('primary', 'Primary colour'), colorRow('accent', 'Accent colour')),
          h('div.grid-2',
            h('div.field', h('label', 'Theme ', locked.has('theme') ? lockedBadge() : null), themeSel),
            input('radius', 'Corner roundness (px)', 'number', { min: 0, max: 24 })),
          input('supportUrl', 'Support URL', 'url', { placeholder: 'https://' }),
          input('supportEmail', 'Support email', 'email'),
          input('footerText', 'Footer text')),
        h('div',
          h('div.card', h('h3', 'Preview'), preview),
          h('div.card',
            h('div.stack',
              h('button.btn.primary', {
                onclick: async () => {
                  const override = {};
                  for (const k of BRAND_FIELDS) if (!locked.has(k) && draft[k] !== bundled[k]) override[k] = draft[k];
                  await saveBrandOverride(override);
                  brandState = await loadBrandState();
                  paintChrome();
                  toast('Branding saved');
                },
              }, 'Save branding'),
              h('button.btn', {
                onclick: () => {
                  const kit = {};
                  for (const k of BRAND_FIELDS) kit[k] = draft[k];
                  kit.extensionIdDomain = bundled.extensionIdDomain || '';
                  download('brand.json', kit);
                },
              }, 'Export brand kit (brand.json)'),
              h('button.btn.ghost', {
                onclick: async () => {
                  if (!(await confirmDialog('Reset branding', 'Go back to the built-in brand kit?'))) return;
                  await saveBrandOverride({});
                  brandState = await loadBrandState();
                  paintChrome();
                  show('branding', true);
                },
              }, 'Reset to built-in brand')),
            h('p.small.muted', { style: { marginTop: '10px' } },
              'To ship this look to everyone, drop the exported file into brand/brand.json and rebuild, or push it as the "brand" policy.')))),
    );
  }

  async function renderConnections(el) {
    const { connection, locked } = await getConnectionState();
    const draft = { ...connection };
    const { syncStatus } = await api.storage.local.get('syncStatus');
    const body = h('div');
    const collections = o.syncCollections || [];

    const paint = () => {
      const t = CONNECTION_TYPES[draft.type] || CONNECTION_TYPES.none;
      const typeSel = h('select', { disabled: locked.has('type') },
        Object.entries(CONNECTION_TYPES).map(([k, v]) => h('option', { value: k, selected: draft.type === k }, v.label)));
      typeSel.addEventListener('change', () => { draft.type = typeSel.value; paint(); });
      const inp = (key, label, attrs = {}, hint = '') => {
        const i = h('input', { value: draft[key] || '', disabled: locked.has(key), ...attrs });
        i.addEventListener('input', () => { draft[key] = i.value; });
        return h('div.field', h('label', label, ' ', locked.has(key) ? lockedBadge() : null), i, hint ? h('div.hint', hint) : null);
      };
      const urlHint = {
        webhook: 'Every new record is POSTed here as JSON: { source, collection, sentAt, records: [...] }',
        rest: 'GET {url}/{collection} should return a JSON array; POST {url}/{collection} receives an array of records.',
        supabase: 'Your project URL, e.g. https://abcd1234.supabase.co',
      }[draft.type] || '';
      clear(body,
        h('div.field', h('label', 'Where should shared data go? ', locked.has('type') ? lockedBadge() : null), typeSel),
        t.fields.includes('url') ? inp('url', draft.type === 'supabase' ? 'Project URL' : 'URL', { type: 'url', placeholder: 'https://' }, urlHint) : null,
        t.fields.includes('token') ? inp('token', draft.type === 'supabase' ? 'API key (anon or service key)' : 'Auth token (optional)', { type: 'password', autocomplete: 'off' },
          draft.type === 'supabase' ? 'Use row-level security if the key is shared with other people.' : 'Sent as "Authorization: Bearer <token>".') : null,
        t.fields.includes('tablePrefix') ? inp('tablePrefix', 'Table prefix') : null,
        draft.type !== 'none' && draft.type !== 'webhook' ? h('div.field', h('div.row', toggle(draft.autoSync, (v) => { draft.autoSync = v; }, { disabled: locked.has('autoSync') }), h('span', 'Sync automatically every hour'))) : null,
        draft.type === 'supabase' && collections.length ? h('details', { style: { marginBottom: '14px' } },
          h('summary', 'SQL to create the tables'),
          h('pre.mono', { style: { whiteSpace: 'pre-wrap', background: 'var(--wx-surface-2)', padding: '10px', borderRadius: '8px' } }, SUPABASE_SQL(draft.tablePrefix || '', collections))) : null,
        h('div.row',
          h('button.btn.primary', {
            onclick: async () => {
              if (draft.type !== 'none') {
                if (!draft.url) return toast('Enter a URL first.', { error: true });
                if (!(await requestHostAccess(draft.url))) return toast('Permission to reach that address was not granted.', { error: true });
              }
              await saveConnection(draft);
              toast(draft.type === 'none' ? 'Local only. Nothing leaves this browser.' : 'Connection saved');
            },
          }, 'Save'),
          draft.type !== 'none' ? h('button.btn', {
            onclick: async () => {
              if (!(await requestHostAccess(draft.url))) return toast('Permission was not granted.', { error: true });
              const r = await testConnection(draft);
              toast(r.message, { error: !r.ok });
            },
          }, 'Test') : null,
          draft.type !== 'none' && collections.length ? h('button.btn', {
            onclick: async () => {
              await saveConnection(draft);
              const r = await send({ type: 'wx:sync' });
              toast(r?.message || 'Done', { error: r && r.ok === false });
              show('connections', true);
            },
          }, 'Sync now') : null),
      );
    };
    paint();

    add(el,
      h('h1', 'Shared data'),
      h('p.muted', 'By default everything stays in this browser. This works for one person and needs no setup.'),
      h('div.card',
        h('p', 'When a team wants shared data, link a backend here, for example ',
          collections.length ? h('span', collections.map((c) => h('code', c)).reduce((a, b) => [a, ', ', b])) : 'records',
          '. Only data from this extension is sent, and only after you save a connection.'),
        body),
      syncStatus ? h('p.small', { class: syncStatus.ok ? 'muted' : '' }, `Last sync ${formatDate(syncStatus.at)}: ${syncStatus.message}`) : null,
    );
  }

  async function renderBackup(el) {
    const genPolicy = (enforce) => {
      const values = {};
      for (const [k, v] of Object.entries(state.values)) {
        if (JSON.stringify(v) !== JSON.stringify(settings.DEFAULTS[k])) values[k] = v;
      }
      const policy = enforce ? { ...values } : { defaults: values };
      const brandOverride = brandState.override || {};
      if (Object.keys(brandOverride).length) policy.brand = brandOverride;
      return policy;
    };
    const out = h('pre.mono', { style: { whiteSpace: 'pre-wrap', background: 'var(--wx-surface-2)', padding: '12px', borderRadius: '8px', maxHeight: '320px', overflow: 'auto' } });
    let enforce = false;
    const paintPolicy = () => { out.textContent = JSON.stringify(genPolicy(enforce), null, 2); };
    paintPolicy();

    add(el,
      h('h1', 'Backup & policy'),
      h('div.card',
        h('h2', 'Backup'),
        h('p.muted', 'Download everything this extension has stored (settings, branding and your data) as one file, or restore it on another browser.'),
        h('div.row',
          h('button.btn.primary', {
            onclick: async () => {
              const all = await api.storage.local.get(null);
              const manifest = api.runtime.getManifest();
              download(`${manifest.short_name || 'extension'}-backup-${new Date().toISOString().slice(0, 10)}.json`,
                { app: manifest.name, version: manifest.version, exportedAt: new Date().toISOString(), data: all });
            },
          }, 'Export backup'),
          h('button.btn', {
            onclick: async () => {
              const f = await pickFile('application/json,.json');
              if (!f) return;
              try {
                const json = JSON.parse(await f.text());
                const data = json.data && typeof json.data === 'object' ? json.data : json;
                if (!(await confirmDialog('Restore backup', 'This replaces everything this extension has stored in this browser.', { okLabel: 'Restore', danger: true }))) return;
                await api.storage.local.clear();
                await api.storage.local.set(data);
                toast('Backup restored');
                setTimeout(() => location.reload(), 600);
              } catch (e) {
                toast(`Could not read that file: ${e.message}`, { error: true });
              }
            },
          }, 'Restore from file…'))),
      h('div.card',
        h('h2', 'Generate policy'),
        h('p.muted', 'Turns the settings you changed in this browser into JSON for Chrome/Edge policy (3rdparty → extensions → <id> → policy), a macOS profile or Firefox policies.json. Policy is optional.'),
        h('div.row', { style: { marginBottom: '10px' } },
          toggle(enforce, (v) => { enforce = v; paintPolicy(); }), h('span', 'Enforce (lock) these settings instead of suggesting them')),
        out,
        h('div.row', { style: { marginTop: '10px' } },
          h('button.btn', { onclick: () => download('policy.json', genPolicy(enforce)) }, 'Download policy.json'),
          h('button.btn.ghost', { onclick: () => navigator.clipboard.writeText(out.textContent).then(() => toast('Copied')) }, 'Copy'))),
      h('div.card',
        h('h2', 'Reset'),
        h('p.muted', 'Removes your settings and all data stored by this extension in this browser.'),
        h('button.btn.danger', {
          onclick: async () => {
            if (!(await confirmDialog('Erase everything?', 'All settings and data for this extension will be deleted from this browser. This cannot be undone.', { okLabel: 'Erase', danger: true }))) return;
            await api.storage.local.clear();
            location.reload();
          },
        }, 'Erase all data')),
    );
  }

  async function renderAbout(el) {
    const m = api.runtime.getManifest();
    const b = brandState.brand;
    let bytes = null;
    try { bytes = await api.storage.local.getBytesInUse?.(null); } catch { /* not supported */ }
    const managedKeys = Object.keys(state.managed || {});
    add(el,
      h('h1', productName(b, o.baseName)),
      h('div.card',
        h('p', o.tagline || ''),
        h('table.table', h('tbody',
          h('tr', h('th', 'Version'), h('td', m.version)),
          h('tr', h('th', 'Data storage'), h('td', 'This browser only', bytes != null ? ` (${(bytes / 1024).toFixed(1)} KB used)` : '')),
          h('tr', h('th', 'Managed by policy'), h('td', managedKeys.length ? managedKeys.join(', ') : 'No')),
          b.supportUrl ? h('tr', h('th', 'Help'), h('td', h('a', { href: b.supportUrl, target: '_blank', rel: 'noopener' }, b.supportUrl))) : null,
          b.supportEmail ? h('tr', h('th', 'Contact'), h('td', h('a', { href: `mailto:${b.supportEmail}` }, b.supportEmail))) : null))),
      o.about ? h('div.card', o.about) : null,
    );
    if (o.renderAboutExtra) await o.renderAboutExtra(el, ctx);
  }

  paintChrome();
  onBrandChange(async () => {
    brandState = await loadBrandState();
    paintChrome();
  });
  settings.onChange(async () => { state = await settings.load(); });
  window.addEventListener('hashchange', () => show(location.hash.slice(1) || all[0].id));
  await show(location.hash.slice(1) || all[0].id);
  return ctx;
}

function applyVars(el, b) {
  const tmp = document.createElement('div');
  applyBrand(b, { documentElement: tmp });
  el.style.cssText = tmp.style.cssText;
  el.style.borderRadius = `${b.radius}px`;
}

/**
 * Builds a labelled form control bound to a setting.
 * spec: { key, label, type: text|url|email|number|password|textarea|select|toggle|list|color, options:[[value,label]], hint, placeholder, onSaved }
 *   list = array of strings edited one per line.
 */
export function field(spec, ctx) {
  const { key, label, type = 'text', hint, placeholder, options = [] } = spec;
  const locked = ctx.isLocked(key);
  const value = ctx.values[key];
  const save = async (v) => {
    await ctx.save({ [key]: v }, { quiet: spec.quiet });
    spec.onSaved?.(v);
  };
  let control;
  if (type === 'toggle') {
    return h('div.field', h('div.row',
      toggle(value, save, { disabled: locked, label }),
      h('span', { style: { fontWeight: 550 } }, label), locked ? lockedBadge() : null),
    hint ? h('div.hint', { style: { marginLeft: '46px' } }, hint) : null);
  }
  if (type === 'select') {
    control = h('select', { disabled: locked },
      options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
    control.addEventListener('change', () => save(control.value));
  } else if (type === 'textarea' || type === 'list') {
    control = h('textarea', { disabled: locked, placeholder: placeholder || '', rows: spec.rows || 5 },
      type === 'list' ? (value || []).join('\n') : value ?? '');
    control.addEventListener('change', () => save(type === 'list'
      ? control.value.split('\n').map((s) => s.trim()).filter(Boolean)
      : control.value));
  } else {
    control = h('input', { type, value: value ?? '', disabled: locked, placeholder: placeholder || '', min: spec.min, max: spec.max });
    control.addEventListener('change', () => save(type === 'number' ? Number(control.value) : control.value));
  }
  return h('div.field', h('label', label, ' ', locked ? lockedBadge() : null), control, hint ? h('div.hint', hint) : null);
}

export { modal };

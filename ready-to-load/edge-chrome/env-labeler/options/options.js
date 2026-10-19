import { api, send } from '/shared/api.js';
import { mountApp } from '/shared/app-shell.js';
import { h, add, clear, toast, modal, confirmDialog, download, pickFile, toggle, timeAgo, formatDate, debounce, lockedBadge, copyText } from '/shared/ui.js';
import { requestHostAccess } from '/shared/connections.js';
import { settings } from '../settings.js';
import { BUILTIN_RULES } from '../defaults.js';
import {
  mergeSources, matchUrl, normalizeRule, normalizeEnv, envTextColor, compilePattern, PATTERN_KINDS, validatePattern,
  parseRulesFile, formatPrefix, NO_LABEL, slug, uid,
} from '../rules.js';

const EI = globalThis.EnvIndicator;
const BASE = 'Environment Labeler';
let selfSaveAt = 0; // lets the live-refresh below ignore changes this page made itself

// ---- helpers -------------------------------------------------------------------------------

function envChip(env, cls = '') {
  if (!env) return h('span.env-chip.none', { class: cls }, 'No label');
  return h('span.env-chip', { class: cls, style: { background: env.color, color: envTextColor(env) } }, env.name);
}

async function loadSources() {
  const { remoteRules = {}, sharedRules = null } = await api.storage.local.get(['remoteRules', 'sharedRules']);
  return { remoteRules, sharedRules };
}

function activeRemote(remoteRules, values) {
  const sources = new Set(values.ruleSources || []);
  return Object.fromEntries(Object.entries(remoteRules || {}).filter(([u, v]) => sources.has(u) && Array.isArray(v?.rules)));
}

function mergedFor(values, src, rules = values.rules) {
  return mergeSources({ rules, environments: values.environments, remote: activeRemote(src.remoteRules, values), shared: src.sharedRules });
}

function toHref(v) {
  const s = v.trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
}

const shortUrl = (u) => (u.length > 60 ? `${u.slice(0, 58)}…` : u);
const sourceName = (r) => (r.source === 'remote' ? `Remote: ${shortUrl(r.sourceUrl)}` : r.source === 'shared' ? 'Shared by your team' : 'Your rules');

/**
 * Mock browser window showing exactly what a labelled tab looks like (uses the real content-script renderer).
 */
function mockBrowser(env, s, { small = false, label = '', host = 'admin.example.com', onMove } = {}) {
  const showTitle = s.showTitlePrefix && env.titlePrefix;
  const showFav = s.showFavicon && env.favicon;
  const showBadge = s.showBadge && env.badge;
  const fav = h('img', { alt: '', src: '/icons/icon-32.png' });
  if (showFav) EI.favicon(env, '/icons/icon-32.png').then((d) => { fav.src = d; });
  const title = `${showTitle ? formatPrefix(s.titleFormat, env, { label }) : ''}Customer admin`;
  const page = h('div.mock-page',
    h('div.line', { style: { width: '42%', height: '14px', background: 'var(--wx-border)' } }),
    h('div.line', { style: { width: '88%' } }), h('div.line', { style: { width: '76%' } }), h('div.line', { style: { width: '64%' } }),
    h('span.btnish', 'Save changes'));
  const holder = h('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none' } });
  page.append(holder);
  if (s.enabled !== false && s.showRibbon && env.ribbon) {
    const root = holder.attachShadow({ mode: 'open' });
    EI.render(root, {
      env: { ...env, textColor: envTextColor(env) },
      label,
      style: s.style,
      position: s.position,
      size: s.size,
      opacity: s.opacity,
      contained: true,
      title: 'Preview. On a real page, click hides the label for a moment. Drag it to another corner to move it.',
      onHide: () => toast(Number(s.hideSeconds) > 0 ? `On a real page this hides the label for ${s.hideSeconds} seconds.` : 'On a real page this hides the label until reload.'),
      onMove,
    });
  }
  return h('div.mock', { class: small ? 'small' : '' },
    h('div.mock-tabs', h('div.mock-tab', fav, h('span', title)), h('div.mock-tab', { style: { opacity: 0.55, background: 'transparent' } }, 'New tab')),
    h('div.mock-url', h('div.bar', `https://${host}/settings`),
      h('span.mock-badge', {
        style: showBadge ? { background: env.color, color: envTextColor(env) } : { background: 'var(--wx-surface-2)', color: 'var(--wx-muted)' },
        title: 'Toolbar badge',
      }, showBadge ? env.short.slice(0, 4) : '⚑')),
    page);
}

function patternHelp() {
  const ex = [
    ['app.example.com', 'Exact host (any port)'],
    ['*.example.com', 'Any subdomain of example.com'],
    ['api.example.com:8443', 'Host with a specific port (*:* = any host with a port)'],
    ['https://example.com/admin*', 'URL prefix, * matches anything'],
    ['example.com/admin*', 'Host and path, any scheme'],
    ['/^https:\\/\\/.+\\.corp\\.net\\//i', 'Regular expression on the full URL'],
  ];
  return h('details', { style: { marginBottom: '14px' } }, h('summary.small', 'Pattern examples'),
    h('table.table', { style: { marginTop: '6px' } }, h('tbody', ex.map(([p, d]) => h('tr', h('td.mono-cell', p), h('td.small.muted', d))))));
}

// ---- Rules -------------------------------------------------------------------------------------

async function renderRules(el, ctx) {
  const locked = ctx.isLocked('rules');
  const src = await loadSources();
  let rules = (ctx.values.rules || []).map((r) => normalizeRule(r));
  const envs = () => (ctx.values.environments || []).map(normalizeEnv);
  const envById = (id) => envs().find((e) => e.id === id);
  const tableHost = h('div');
  const otherHost = h('div');
  const testInput = h('input', { type: 'text', placeholder: 'Paste a URL, e.g. https://app.example.com/orders', 'aria-label': 'URL to test' });
  const testOut = h('div.test-result');
  let hitId = null;

  async function save(next, message) {
    rules = next;
    selfSaveAt = Date.now();
    await ctx.save({ rules: next }, { quiet: true });
    if (message) toast(message);
    paint();
  }

  function paintTest() {
    const href = toHref(testInput.value);
    hitId = null;
    if (!href) {
      clear(testOut, h('span.small.muted', 'Type or paste an address to see which rule labels it and how it will look.'));
    } else {
      const all = mergedFor(ctx.values, src, rules);
      const m = matchUrl(href, all.rules, all.environments);
      if (!m) {
        clear(testOut, envChip(null), h('span.muted', 'No rule matches. Nothing is shown on this site.'));
      } else {
        hitId = m.rule.id;
        clear(testOut,
          m.none ? envChip(null) : envChip(m.env),
          h('span', `Rule #${m.index + 1}`), h('code', m.rule.pattern),
          h('span.badge', sourceName(m.rule)),
          m.none ? h('span.small.muted', 'This exception rule turns labels off here.') : null);
      }
    }
    tableHost.querySelectorAll('tr[data-id]').forEach((tr) => tr.classList.toggle('hit', tr.dataset.id === hitId));
    otherHost.querySelectorAll('tr[data-id]').forEach((tr) => tr.classList.toggle('hit', tr.dataset.id === hitId));
  }
  testInput.addEventListener('input', debounce(paintTest, 120));

  let dragFrom = -1;
  function row(rule, i) {
    const env = rule.env === NO_LABEL ? null : envById(rule.env);
    const c = compilePattern(rule.pattern);
    const tr = h('tr', { dataset: { id: rule.id }, class: rule.enabled ? '' : 'off', draggable: locked ? 'false' : 'true' },
      h('td', { style: { width: '54px' } }, h('div.row', { style: { gap: '2px', flexWrap: 'nowrap' } },
        locked ? null : h('span.handle', { title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'),
        h('span.num', String(i + 1)))),
      h('td', h('div.mono-cell', rule.pattern),
        h('div', { style: { marginTop: '2px' } }, h('span.badge', { class: c.kind === 'invalid' ? 'danger' : '' }, PATTERN_KINDS[c.kind]),
          String(rule.id).startsWith('builtin-') ? [' ', h('span.badge', 'Built in')] : null)),
      h('td', rule.env === NO_LABEL ? h('span.env-chip.none', 'No label') : env ? envChip(env) : h('span.badge.warn', `Unknown "${rule.env}"`)),
      h('td.small', rule.label || h('span.muted', '—')),
      h('td', toggle(rule.enabled, (v) => {
        const next = rules.slice();
        next[i] = { ...rule, enabled: v };
        save(next, v ? 'Rule enabled' : 'Rule disabled');
      }, { disabled: locked, label: 'Enabled' })),
      h('td', { style: { whiteSpace: 'nowrap', textAlign: 'right' } },
        h('span.order-btns',
          h('button.icon-btn', { title: 'Move up', 'aria-label': 'Move up', disabled: locked || i === 0, onclick: () => move(i, i - 1) }, '▲'),
          h('button.icon-btn', { title: 'Move down', 'aria-label': 'Move down', disabled: locked || i === rules.length - 1, onclick: () => move(i, i + 1) }, '▼')),
        h('button.btn.sm.ghost', { disabled: locked, onclick: () => editRule(rule, i) }, 'Edit'),
        h('button.btn.sm.ghost.danger', {
          disabled: locked,
          title: 'Delete rule',
          'aria-label': 'Delete rule',
          onclick: async () => {
            if (!(await confirmDialog('Delete rule?', `"${rule.pattern}" will no longer label sites.`, { okLabel: 'Delete', danger: true }))) return;
            save(rules.filter((r) => r.id !== rule.id), 'Rule deleted');
          },
        }, '✕')));
    if (!locked) {
      tr.addEventListener('dragstart', (e) => {
        dragFrom = i;
        tr.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
      });
      tr.addEventListener('dragend', () => {
        dragFrom = -1;
        tableHost.querySelectorAll('tr').forEach((r) => r.classList.remove('dragging', 'drop-before', 'drop-after'));
      });
      tr.addEventListener('dragover', (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        const r = tr.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        tr.classList.toggle('drop-after', after);
        tr.classList.toggle('drop-before', !after);
      });
      tr.addEventListener('dragleave', () => tr.classList.remove('drop-before', 'drop-after'));
      tr.addEventListener('drop', (e) => {
        e.preventDefault();
        const after = tr.classList.contains('drop-after');
        tr.classList.remove('drop-before', 'drop-after');
        if (dragFrom < 0) return;
        let to = i + (after ? 1 : 0);
        if (dragFrom < to) to -= 1;
        move(dragFrom, to);
      });
    }
    return tr;
  }

  function move(from, to) {
    if (to < 0 || to >= rules.length || from === to) return;
    const next = rules.slice();
    const [r] = next.splice(from, 1);
    next.splice(to, 0, r);
    save(next);
  }

  function editRule(rule, index) {
    const isNew = !rule;
    const draft = rule ? { ...rule } : { id: uid('r-'), pattern: '', env: 'prod', label: '', enabled: true };
    const pattern = h('input', { type: 'text', value: draft.pattern, placeholder: 'app.example.com', spellcheck: 'false', class: 'mono' });
    const kind = h('div.hint');
    const checkPattern = () => {
      const v = pattern.value.trim();
      if (!v) { kind.textContent = 'Host, *.wildcard, host:port, URL prefix or /regex/'; kind.style.color = ''; return; }
      const err = validatePattern(v);
      kind.textContent = err || PATTERN_KINDS[compilePattern(v).kind];
      kind.style.color = err ? 'var(--wx-danger)' : '';
    };
    pattern.addEventListener('input', checkPattern);
    checkPattern();
    const envSel = h('select',
      envs().map((e) => h('option', { value: e.id, selected: draft.env === e.id }, e.name)),
      h('option', { value: NO_LABEL, selected: draft.env === NO_LABEL }, 'No label (exception)'));
    const labelIn = h('input', { type: 'text', value: draft.label, placeholder: 'e.g. Customer admin (EU)' });
    let enabled = draft.enabled;
    const where = isNew ? h('select', h('option', { value: 'top' }, 'At the top (wins over other rules)'), h('option', { value: 'bottom' }, 'At the bottom')) : null;
    return modal(isNew ? 'Add rule' : 'Edit rule', (close) => h('form', {
      onsubmit: (e) => { e.preventDefault(); close('save'); },
    },
    h('div.field', h('label', 'Pattern'), pattern, kind),
    patternHelp(),
    h('div.grid-2',
      h('div.field', h('label', 'Environment'), envSel),
      h('div.field', h('label', 'Label (optional)'), labelIn)),
    where ? h('div.field', h('label', 'Position'), where, h('div.hint', 'First match wins.')) : null,
    h('div.field', h('div.row', toggle(enabled, (v) => { enabled = v; }, { label: 'Enabled' }), h('span', 'Enabled'))),
    h('button', { type: 'submit', hidden: true })), {
      actions: (close) => [
        h('button.btn', { onclick: () => close(undefined) }, 'Cancel'),
        h('button.btn.primary', { onclick: () => close('save') }, isNew ? 'Add rule' : 'Save'),
      ],
    }).then((r) => {
      if (r !== 'save') return;
      const v = pattern.value.trim();
      const err = validatePattern(v);
      if (err) {
        toast(err, { error: true });
        return editRule({ ...draft, pattern: v, env: envSel.value, label: labelIn.value.trim(), enabled }, index);
      }
      const saved = { ...draft, pattern: v, env: envSel.value, label: labelIn.value.trim(), enabled };
      const next = rules.slice();
      if (isNew) {
        if (where.value === 'bottom') next.push(saved);
        else next.unshift(saved);
      } else if (index != null && index >= 0 && next[index]?.id === saved.id) {
        next[index] = saved;
      } else {
        const j = next.findIndex((x) => x.id === saved.id);
        if (j >= 0) next[j] = saved;
        else next.unshift(saved);
      }
      save(next, isNew ? 'Rule added' : 'Rule saved');
    });
  }

  function paintOther() {
    const all = mergedFor(ctx.values, src, rules);
    const other = all.rules.map((r, i) => ({ r, i })).filter(({ r }) => r.source !== 'local');
    if (!other.length) return clear(otherHost);
    clear(otherHost, h('div.card',
      h('h2', 'Rules from other sources'),
      h('p.muted.small', 'Read-only. They apply after your own rules. Manage them under Remote rules.'),
      h('div.table-wrap', h('table.table.rules-table', h('thead', h('tr', h('th', '#'), h('th', 'Pattern'), h('th', 'Environment'), h('th', 'Label'), h('th', 'Source'))),
        h('tbody', other.map(({ r, i }) => {
          const env = r.env === NO_LABEL ? null : all.environments.find((e) => e.id === r.env);
          return h('tr', { dataset: { id: r.id }, class: r.enabled ? '' : 'off' },
            h('td.num', String(i + 1)), h('td.mono-cell', r.pattern), h('td', envChip(env)), h('td.small', r.label || '—'), h('td.small.muted', sourceName(r)));
        }))))));
  }

  function paint() {
    if (!rules.length) {
      clear(tableHost, h('div.empty',
        h('div.empty-title', 'No rules yet'),
        h('p', 'Add your production hosts so they get a red label, or restore the built-in rules for localhost and staging-like hosts.'),
        h('div.row', { style: { justifyContent: 'center' } },
          h('button.btn.primary', { disabled: locked, onclick: () => editRule(null) }, 'Add a rule'),
          h('button.btn', { disabled: locked, onclick: restoreBuiltins }, 'Restore built-in rules'))));
    } else {
      clear(tableHost, h('div.table-wrap', h('table.table.rules-table',
        h('thead', h('tr', h('th', ''), h('th', 'Pattern'), h('th', 'Environment'), h('th', 'Label'), h('th', 'On'), h('th', ''))),
        h('tbody', rules.map(row)))));
    }
    paintOther();
    paintTest();
  }

  function restoreBuiltins() {
    const have = new Set(rules.map((r) => r.id));
    const missing = BUILTIN_RULES.filter((r) => !have.has(r.id));
    if (!missing.length) return toast('All built-in rules are already in the list.');
    save([...rules, ...missing.map((r) => ({ ...r }))], `Restored ${missing.length} built-in rule(s) at the bottom`);
  }

  const userCount = rules.filter((r) => !String(r.id).startsWith('builtin-')).length;
  add(el,
    h('div.row.between', { style: { alignItems: 'flex-start' } },
      h('div', h('h1', 'Rules'), h('p.muted', 'Which sites get which label. Rules are checked from the top and the first match wins.')),
      h('div.row',
        locked ? lockedBadge() : null,
        h('button.btn', { disabled: locked, onclick: restoreBuiltins }, 'Restore built-ins'),
        h('button.btn.primary', { disabled: locked, onclick: () => editRule(null) }, '+ Add rule'))),
    !userCount ? h('div.notice',
      h('b', 'Tip: '), 'Localhost, *.local, *.test, hosts with a port and staging-like names are labelled automatically. ',
      'Add your production sites here, or open one and use the toolbar button: ', h('i', 'Label this site as → Production'), '.') : null,
    h('div.card', h('h3', 'Test a URL'), testInput, testOut),
    h('div.card', tableHost),
    otherHost);
  paint();
}

// ---- Environments -----------------------------------------------------------------------------

async function renderEnvironments(el, ctx) {
  const locked = ctx.isLocked('environments');
  let envs = (ctx.values.environments || []).map(normalizeEnv);
  const list = h('div');
  const persist = debounce(async () => {
    await ctx.save({ environments: envs }, { quiet: true });
  }, 350);

  const usage = (id) => (ctx.values.rules || []).filter((r) => r.env === id).length;

  function card(env, i) {
    const previewHost = h('div');
    const paintPreview = () => clear(previewHost, mockBrowser(env, ctx.values, { small: true, label: '' }));
    const titleEl = h('span', env.name || env.id);
    const update = (patch, { repaint = false } = {}) => {
      env = { ...env, ...patch };
      envs[i] = env;
      c.style.setProperty('--env', env.color);
      titleEl.textContent = env.name || env.id;
      paintPreview();
      persist();
      if (repaint) paintAll();
    };
    const txt = (key, label, attrs = {}) => {
      const inp = h('input', { type: 'text', value: env[key] ?? '', disabled: locked, ...attrs });
      inp.addEventListener('input', () => update({ [key]: key === 'short' ? inp.value.toUpperCase().slice(0, 6) : inp.value }));
      return h('div.field', h('label', label), inp);
    };
    const colorIn = h('input', { type: 'color', value: env.color, disabled: locked, 'aria-label': 'Colour' });
    const colorTxt = h('input', { type: 'text', value: env.color, disabled: locked, style: { width: '96px' }, 'aria-label': 'Colour hex' });
    colorIn.addEventListener('input', () => { colorTxt.value = colorIn.value; update({ color: colorIn.value }); });
    colorTxt.addEventListener('change', () => {
      if (/^#[0-9a-f]{6}$/i.test(colorTxt.value)) { colorIn.value = colorTxt.value; update({ color: colorTxt.value }); }
    });
    const autoText = !env.textColor;
    const textIn = h('input', { type: 'color', value: env.textColor || envTextColor(env), disabled: locked || autoText, 'aria-label': 'Text colour' });
    textIn.addEventListener('input', () => update({ textColor: textIn.value }));
    const textMode = h('select', { disabled: locked, style: { width: 'auto' } },
      h('option', { value: 'auto', selected: autoText }, 'Automatic (best contrast)'),
      h('option', { value: 'custom', selected: !autoText }, 'Custom'));
    textMode.addEventListener('change', () => {
      textIn.disabled = locked || textMode.value === 'auto';
      update({ textColor: textMode.value === 'auto' ? '' : textIn.value });
    });
    const flag = (key, label, hint) => h('div.row', { title: hint || '' },
      toggle(env[key], (v) => update({ [key]: v }), { disabled: locked, label }), h('span', label));

    const c = h('div.card.env-card', { style: `--env: ${env.color}` },
      h('div.row.between',
        h('h2', { style: { margin: 0 } }, titleEl, ' ', h('span.badge', { title: 'Identifier used by rules' }, env.id)),
        h('div.row',
          h('span.small.muted', `${usage(env.id)} rule(s)`),
          h('button.btn.sm.ghost.danger', {
            disabled: locked,
            onclick: async () => {
              const n = usage(env.id);
              if (n) return toast(`${n} rule(s) use ${env.name}. Point them at another environment first.`, { error: true });
              if (!(await confirmDialog(`Delete ${env.name}?`, 'This environment will be removed.', { okLabel: 'Delete', danger: true }))) return;
              envs = envs.filter((e) => e.id !== env.id);
              await ctx.save({ environments: envs }, { quiet: true });
              toast('Environment deleted');
              paintAll();
            },
          }, 'Delete'))),
      h('div.grid-2', { style: { marginTop: '12px' } },
        h('div',
          h('div.grid-2', txt('name', 'Name'), txt('short', 'Short tag', { maxlength: 6, placeholder: 'PROD' })),
          h('div.grid-2',
            h('div.field', h('label', 'Colour'), h('div.row', colorIn, colorTxt)),
            h('div.field', h('label', 'Text colour'), h('div.row', { style: { flexWrap: 'nowrap' } }, textMode, textIn))),
          h('label', 'Indicators'),
          h('div.toggles',
            flag('confirmSubmit', 'Ask before submitting forms', 'Shows "Are you sure?" before a form is submitted'),
            flag('ribbon', 'Ribbon / bar / frame'),
            flag('titlePrefix', 'Tab title prefix'),
            flag('favicon', 'Favicon tint'),
            flag('badge', 'Toolbar badge'))),
        previewHost));
    paintPreview();
    return c;
  }

  function paintAll() {
    clear(list, envs.length ? envs.map(card) : h('div.card', h('div.empty', h('div.empty-title', 'No environments'), 'Add one to start labelling sites.')));
  }

  async function addEnv() {
    const name = h('input', { type: 'text', placeholder: 'e.g. Demo, Training, Sandbox' });
    const color = h('input', { type: 'color', value: '#7C3AED' });
    const r = await modal('Add environment', (close) => h('form', { onsubmit: (e) => { e.preventDefault(); close(true); } },
      h('div.field', h('label', 'Name'), name),
      h('div.field', h('label', 'Colour'), color),
      h('button', { type: 'submit', hidden: true })), {
      actions: (close) => [h('button.btn', { onclick: () => close(false) }, 'Cancel'), h('button.btn.primary', { onclick: () => close(true) }, 'Add')],
    });
    if (!r) return;
    const n = name.value.trim();
    if (!n) return toast('Give the environment a name.', { error: true });
    let id = slug(n) || 'env';
    while (envs.some((e) => e.id === id) || id === NO_LABEL) id = `${slug(n) || 'env'}-${uid().slice(0, 4)}`;
    envs.push(normalizeEnv({ id, name: n, color: color.value, short: n.slice(0, 4) }));
    await ctx.save({ environments: envs }, { quiet: true });
    toast(`${n} added. Use it from the popup or in a rule.`);
    paintAll();
  }

  add(el,
    h('div.row.between', { style: { alignItems: 'flex-start' } },
      h('div', h('h1', 'Environments'), h('p.muted', 'Names, colours and which indicators each environment shows. Changes apply to open tabs right away.')),
      h('div.row', locked ? lockedBadge() : null, h('button.btn.primary', { disabled: locked, onclick: addEnv }, '+ Add environment'))),
    list);
  paintAll();
}

// ---- Appearance ---------------------------------------------------------------------------------

async function renderAppearance(el, ctx) {
  const preview = h('div');
  const envSel = h('select', { style: { width: 'auto' }, 'aria-label': 'Environment to preview' });
  const envs = () => (ctx.values.environments || []).map(normalizeEnv);
  envs().forEach((e) => envSel.append(h('option', { value: e.id }, e.name)));
  const paintPreview = () => {
    const env = envs().find((e) => e.id === envSel.value) || envs()[0];
    if (!env) return clear(preview, h('div.empty', 'Add an environment to see a preview.'));
    clear(preview, mockBrowser(env, ctx.values, {
      label: 'Customer admin',
      onMove: async (position) => {
        await ctx.save({ position }, { quiet: true });
        paintCorners();
        paintPreview();
      },
    }));
  };
  envSel.addEventListener('change', paintPreview);

  const quiet = (spec) => ctx.field({ quiet: true, onSaved: () => { paintPreview(); paintStyles(); paintCorners(); }, ...spec });

  const styles = [
    ['ribbon', 'Corner ribbon', 'Diagonal band in a corner'],
    ['bar', 'Top or bottom bar', 'Full-width strip'],
    ['frame', 'Frame', 'Coloured border around the page'],
  ];
  const styleHost = h('div.choice-grid');
  const thumb = (id) => {
    if (id === 'ribbon') return h('div.thumb', h('i', { style: { width: '70px', height: '12px', right: '-18px', top: '12px', transform: 'rotate(45deg)' } }));
    if (id === 'bar') return h('div.thumb', h('i', { style: { left: 0, right: 0, top: 0, height: '10px' } }));
    return h('div.thumb', { style: { boxShadow: 'inset 0 0 0 4px #dc2626' } }, h('i', { style: { right: 0, top: 0, width: '26px', height: '10px', borderBottomLeftRadius: '4px' } }));
  };
  const paintStyles = () => clear(styleHost, styles.map(([id, name, desc]) => h('button.choice', {
    'aria-pressed': String(ctx.values.style === id),
    disabled: ctx.isLocked('style'),
    onclick: async () => { await ctx.save({ style: id }, { quiet: true }); paintStyles(); paintPreview(); },
  }, thumb(id), h('b', name), h('span', desc))));

  const cornerHost = h('div.corner-grid');
  const paintCorners = () => clear(cornerHost, [['top-left', '↖ Top left'], ['top-right', 'Top right ↗'], ['bottom-left', '↙ Bottom left'], ['bottom-right', 'Bottom right ↘']]
    .map(([id, label]) => h('button.btn.sm', {
      'aria-pressed': String(ctx.values.position === id),
      disabled: ctx.isLocked('position'),
      onclick: async () => { await ctx.save({ position: id }, { quiet: true }); paintCorners(); paintPreview(); },
    }, label)));

  const opacityVal = h('span.badge', `${ctx.values.opacity}%`);
  const opacity = h('input', { type: 'range', min: 30, max: 100, step: 1, value: ctx.values.opacity, disabled: ctx.isLocked('opacity'), style: { width: '100%' } });
  opacity.addEventListener('input', () => { opacityVal.textContent = `${opacity.value}%`; });
  opacity.addEventListener('change', async () => { await ctx.save({ opacity: Number(opacity.value) }, { quiet: true }); paintPreview(); });

  paintStyles();
  paintCorners();
  add(el,
    h('h1', 'Appearance'),
    h('p.muted', 'How labelled tabs look. Each environment can switch indicators off under Environments.'),
    h('div.grid-2',
      h('div',
        h('div.card',
          quiet({ key: 'enabled', label: 'Show environment labels', type: 'toggle', hint: 'Master switch for every indicator and confirmation.' }),
          h('div.field', h('label', 'Style ', ctx.isLocked('style') ? lockedBadge() : null), styleHost),
          h('div.field', h('label', 'Corner ', ctx.isLocked('position') ? lockedBadge() : null), cornerHost,
            h('div.hint', 'The bar uses the top or bottom edge. You can also drag the label on any page.')),
          h('div.grid-2',
            quiet({ key: 'size', label: 'Size', type: 'select', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] }),
            h('div.field', h('label', 'Opacity ', opacityVal, ' ', ctx.isLocked('opacity') ? lockedBadge() : null), opacity)),
          quiet({ key: 'hideSeconds', label: 'Click to hide for (seconds)', type: 'number', min: 0, max: 3600, hint: '0 hides the label until the page is reloaded.' })),
        h('div.card',
          h('h3', 'Indicators'),
          quiet({ key: 'showRibbon', label: 'Ribbon, bar or frame on the page', type: 'toggle' }),
          quiet({ key: 'showTitlePrefix', label: 'Prefix in the tab title', type: 'toggle' }),
          quiet({ key: 'titleFormat', label: 'Title prefix format', placeholder: '[{short}] ', hint: 'Placeholders: {short} (PROD), {name} (Production), {label} (the rule label).' }),
          quiet({ key: 'showFavicon', label: 'Tint the site favicon', type: 'toggle' }),
          quiet({ key: 'showBadge', label: 'Badge on the toolbar icon', type: 'toggle' }),
          quiet({ key: 'confirmSubmit', label: 'Ask "Are you sure?" before submitting forms', type: 'toggle', hint: 'Only on environments with confirmation turned on (Production by default).' }))),
      h('div',
        h('div.card', { style: { position: 'sticky', top: '76px' } },
          h('div.row.between', { style: { marginBottom: '10px' } }, h('h3', { style: { margin: 0 } }, 'Preview'), envSel),
          preview,
          h('p.small.muted', { style: { marginTop: '10px' } }, 'Try it: drag the label to another corner.')))));
  paintPreview();
}

// ---- Remote rules & shared rules ------------------------------------------------------------------

const EXAMPLE_FILE = {
  environments: [{ id: 'prod', name: 'Production', short: 'PROD', color: '#DC2626', confirmSubmit: true }],
  rules: [
    { id: 'crm-prod', pattern: 'crm.example.com', env: 'prod', label: 'CRM' },
    { id: 'billing-admin', pattern: 'https://billing.example.com/admin*', env: 'prod', label: 'Billing admin' },
    { id: 'staging-all', pattern: '*.staging.example.com', env: 'staging' },
  ],
};

async function renderRemote(el, ctx) {
  const lockedSources = ctx.isLocked('ruleSources');
  const { remoteRules, sharedRules } = await loadSources();
  const { syncStatus } = await api.storage.local.get('syncStatus');
  const { connection } = await api.storage.local.get('connection');
  const sources = ctx.values.ruleSources || [];
  const urlIn = h('input', { type: 'url', placeholder: 'https://intranet.example.com/env-rules.json', disabled: lockedSources });

  async function addSource() {
    const raw = urlIn.value.trim();
    let u;
    try {
      u = new URL(raw);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      return toast('Enter a full http(s) address of a JSON file.', { error: true });
    }
    if (sources.includes(u.href)) return toast('That file is already in the list.');
    const allowed = await requestHostAccess(u.href);
    if (!allowed) toast('Permission to read that address was not granted. Fetching may fail unless the server allows it.', { error: true });
    await ctx.save({ ruleSources: [...sources, u.href] }, { quiet: true });
    toast('Fetching…');
    const res = await send({ type: 'env:fetchRemote', url: u.href });
    const st = res?.[u.href];
    toast(st?.ok ? `Loaded ${st.message}` : `Could not load the file: ${st?.message || res?.error || 'unknown error'}`, { error: !st?.ok });
    ctx.rerender();
  }

  async function refresh(url) {
    const res = await send({ type: 'env:fetchRemote', url });
    const bad = Object.entries(res || {}).filter(([u, v]) => (!url || u === url) && !v.ok);
    toast(bad.length ? `${bad.length} file(s) could not be loaded` : 'Rules refreshed', { error: !!bad.length });
    ctx.rerender();
  }

  const sourceList = sources.length
    ? sources.map((url) => {
      const st = remoteRules[url];
      return h('div.source',
        h('div.grow',
          h('div.mono-cell', url),
          h('div.small', { style: { marginTop: '4px' } },
            st ? h('span.badge', { class: st.ok ? 'ok' : 'danger' }, st.ok ? 'OK' : 'Error') : h('span.badge.warn', 'Not fetched yet'), ' ',
            st ? h('span.muted', `${st.message} · ${timeAgo(st.at)}`) : null,
            st && !st.ok && st.rules?.length ? h('span.muted', ` · using the last good copy (${st.rules.length} rules)`) : null)),
        h('div.row', { style: { flexWrap: 'nowrap' } },
          h('button.btn.sm', { onclick: () => refresh(url) }, 'Refresh'),
          h('button.btn.sm.ghost.danger', {
            disabled: lockedSources,
            onclick: async () => {
              if (!(await confirmDialog('Remove rule file?', 'Its rules stop applying right away.', { okLabel: 'Remove', danger: true }))) return;
              await ctx.save({ ruleSources: sources.filter((s) => s !== url) }, { quiet: true });
              await send({ type: 'env:fetchRemote', url: '__prune__' });
              ctx.rerender();
            },
          }, 'Remove')));
    })
    : h('div.empty', h('div.empty-title', 'No rule files'), 'Optional. Paste the address of a JSON rule file your team publishes, for example on an intranet or a Git host.');

  const connected = connection && connection.type && connection.type !== 'none' && connection.url;
  const shared = sharedRules?.rules || [];

  add(el,
    h('h1', 'Remote rules'),
    h('p.muted', 'Optional. Load rules from a URL or from your team\'s shared backend. They apply after your own rules and are read-only here.'),
    h('div.card',
      h('div.row.between', h('h2', { style: { margin: 0 } }, 'Rule files'), lockedSources ? lockedBadge() : null),
      h('p.small.muted', 'Format: { "environments": [...], "rules": [...] }. The Import / Export page produces the same format.'),
      h('div.row', { style: { flexWrap: 'nowrap', margin: '10px 0' } }, urlIn, h('button.btn.primary', { disabled: lockedSources, onclick: addSource }, 'Add')),
      h('div', sourceList),
      sources.length ? h('div.row', { style: { marginTop: '10px' } }, h('button.btn', { onclick: () => refresh() }, 'Refresh all')) : null,
      h('div', { style: { marginTop: '14px', maxWidth: '320px' } },
        ctx.field({ key: 'remoteRefreshHours', label: 'Refresh every (hours)', type: 'number', min: 0, max: 168, hint: '0 = only when you click Refresh.' })),
      h('details', h('summary.small', 'Example rule file'),
        h('pre.mono', { style: { whiteSpace: 'pre-wrap', background: 'var(--wx-surface-2)', padding: '10px', borderRadius: '8px' } }, JSON.stringify(EXAMPLE_FILE, null, 2)),
        h('button.btn.sm', { onclick: () => download('env-rules.json', EXAMPLE_FILE) }, 'Download example'))),
    h('div.card',
      h('h2', 'Shared with your team'),
      connected
        ? h('p.small.muted', `Linked to a ${connection.type} backend. Shared rules are pulled on every sync (collection "env-rules").`)
        : h('div.notice', 'No shared backend is linked, so nothing is sent or received. To share rules with your team, link one under ',
          h('a', { href: '#connections', onclick: (e) => { e.preventDefault(); ctx.navigate('connections'); } }, 'Shared data'), '.'),
      ctx.field({ key: 'shareRules', label: 'Share my rules', type: 'toggle', hint: 'When syncing, push your own rules (not the built-in ones) so teammates receive them. Off by default.' }),
      connected ? h('div.row',
        h('button.btn', {
          onclick: async () => {
            const r = await send({ type: 'wx:sync' });
            toast(r?.message || 'Done', { error: r && r.ok === false });
            ctx.rerender();
          },
        }, 'Sync now'),
        syncStatus ? h('span.small.muted', `Last sync ${formatDate(syncStatus.at)}: ${syncStatus.message}`) : null) : null,
      shared.length ? h('div', { style: { marginTop: '14px' } },
        h('h3', `${shared.length} shared rule(s)`, h('span.small.muted', { style: { fontWeight: 400 } }, ` · received ${timeAgo(sharedRules.at)}`)),
        h('div.table-wrap', h('table.table', h('thead', h('tr', h('th', 'Pattern'), h('th', 'Environment'), h('th', 'Label'))),
          h('tbody', shared.map((r) => h('tr', h('td.mono-cell', r.pattern),
            h('td', r.env === NO_LABEL ? envChip(null) : envChip(normalizeEnv({ id: r.env, name: r.envName || r.env, color: r.envColor || '#6B7280' }))),
            h('td.small', r.label || '—')))))),
        h('button.btn.sm.ghost', {
          style: { marginTop: '8px' },
          onclick: async () => {
            await api.storage.local.remove('sharedRules');
            toast('Shared rules cleared from this browser');
            ctx.rerender();
          },
        }, 'Clear shared rules')) : null));
}

// ---- Import / Export ------------------------------------------------------------------------------

async function renderTransfer(el, ctx) {
  const locked = ctx.isLocked('rules');
  let includeBuiltins = false;
  const payload = () => {
    const rules = (ctx.values.rules || []).map((r) => normalizeRule(r)).filter((r) => includeBuiltins || !r.id.startsWith('builtin-'));
    return { environments: (ctx.values.environments || []).map(normalizeEnv), rules };
  };
  const pre = h('pre.mono', { style: { whiteSpace: 'pre-wrap', background: 'var(--wx-surface-2)', padding: '12px', borderRadius: '8px', maxHeight: '260px', overflow: 'auto' } });
  const paint = () => { pre.textContent = JSON.stringify(payload(), null, 2); };
  paint();
  const paste = h('textarea', { rows: 6, placeholder: '{ "environments": [...], "rules": [...] }', disabled: locked, class: 'mono' });

  async function importData(text) {
    let data;
    try {
      data = parseRulesFile(text);
    } catch (e) {
      return toast(`That is not a rules file: ${e.message}`, { error: true });
    }
    const invalid = data.rules.filter((r) => validatePattern(r.pattern));
    const mode = await modal('Import rules', h('div',
      h('p', `Found ${data.rules.length} rule(s) and ${data.environments.length} environment(s).`),
      invalid.length ? h('div.notice.warn', `${invalid.length} rule(s) have invalid patterns and will be skipped.`) : null,
      h('p.small.muted', 'Merge adds new rules to the top and updates rules with the same id. Replace swaps all your rules for these.')), {
      actions: (close) => [
        h('button.btn', { onclick: () => close(null) }, 'Cancel'),
        h('button.btn', { onclick: () => close('replace') }, 'Replace all'),
        h('button.btn.primary', { onclick: () => close('merge') }, 'Merge'),
      ],
    });
    if (!mode) return;
    const incoming = data.rules.filter((r) => !validatePattern(r.pattern));
    let rules;
    if (mode === 'replace') {
      rules = incoming;
    } else {
      const current = (ctx.values.rules || []).map((r) => normalizeRule(r));
      const byId = new Map(incoming.map((r) => [r.id, r]));
      const updated = current.map((r) => (byId.has(r.id) ? byId.get(r.id) : r));
      const existingIds = new Set(current.map((r) => r.id));
      rules = [...incoming.filter((r) => !existingIds.has(r.id)), ...updated];
    }
    const envs = (ctx.values.environments || []).map(normalizeEnv);
    for (const e of data.environments) {
      const i = envs.findIndex((x) => x.id === e.id);
      if (i >= 0) envs[i] = e;
      else envs.push(e);
    }
    const patch = { rules };
    if (data.environments.length && !ctx.isLocked('environments')) patch.environments = envs;
    await ctx.save(patch, { quiet: true });
    toast(`Imported ${incoming.length} rule(s)`);
    ctx.rerender();
  }

  add(el,
    h('h1', 'Import / Export'),
    h('p.muted', 'Move rules between browsers or hand them to teammates. Host the exported file on an intranet and teammates can add it under Remote rules.'),
    h('div.grid-2',
      h('div.card',
        h('h2', 'Export'),
        h('div.field', h('div.row', toggle(false, (v) => { includeBuiltins = v; paint(); }, { label: 'Include built-in rules' }), h('span', 'Include built-in rules'))),
        h('div.row', { style: { marginBottom: '10px' } },
          h('button.btn.primary', { onclick: () => download(`env-rules-${new Date().toISOString().slice(0, 10)}.json`, payload()) }, 'Download env-rules.json'),
          h('button.btn', { onclick: async () => toast((await copyText(pre.textContent)) ? 'Copied' : 'Copy failed', { error: false }) }, 'Copy')),
        pre),
      h('div.card',
        h('h2', 'Import ', locked ? lockedBadge() : null),
        h('p.small.muted', 'Accepts the export format above, a remote rule file, or a plain array of rules.'),
        h('button.btn.primary', {
          disabled: locked,
          onclick: async () => {
            const f = await pickFile('application/json,.json');
            if (f) importData(await f.text());
          },
        }, 'Choose file…'),
        h('div.field', { style: { marginTop: '14px' } }, h('label', 'Or paste JSON'), paste),
        h('button.btn', { disabled: locked, onclick: () => (paste.value.trim() ? importData(paste.value) : toast('Paste some JSON first.', { error: true })) }, 'Import pasted JSON'))));
}

// ---- App --------------------------------------------------------------------------------------------

const app = await mountApp({
  baseName: BASE,
  tagline: 'Know at a glance whether a tab is production, staging or development.',
  settings,
  syncCollections: ['env-rules'],
  panels: [
    { id: 'rules', label: 'Rules', icon: '🧭', render: renderRules },
    { id: 'environments', label: 'Environments', icon: '🏷️', render: renderEnvironments },
    { id: 'appearance', label: 'Appearance', icon: '🚩', render: renderAppearance },
    { id: 'remote', label: 'Remote rules', icon: '☁️', render: renderRemote },
    { id: 'transfer', label: 'Import / Export', icon: '⇅', render: renderTransfer },
  ],
  welcomeSteps: [
    'It already works: localhost, 127.0.0.1, *.local, *.test and any host with a port show DEV; hosts with "staging", "uat", "qa" or "preprod" in the name show STAGING.',
    'Open one of your production sites, click the toolbar icon and choose "Label this site as → Production". It gets a red ribbon, [PROD] in the tab title, a tinted favicon and a check before forms are submitted.',
    'Fine-tune it here: reorder or add rules (wildcards, URL prefixes and regex work), change colours, or switch the ribbon to a bar or frame.',
    'Optional: load your team\'s rules from a URL under Remote rules, or share them through a linked backend.',
  ],
});

// Keep the Rules and Remote rules pages current when something else changes them
// (the popup's "Label this site as…", a scheduled remote refresh, a sync, another Settings tab).
let refreshTimer = 0;
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const panel = location.hash.slice(1);
  if (panel !== 'rules' && panel !== 'remote') return;
  const rulesChanged = 'settings' in changes
    && JSON.stringify(changes.settings.oldValue?.rules) !== JSON.stringify(changes.settings.newValue?.rules)
    && Date.now() - selfSaveAt > 1500;
  if (!rulesChanged && !('remoteRules' in changes) && !('sharedRules' in changes)) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { if (!document.querySelector('.wx-modal')) app.rerender(); }, 250);
});

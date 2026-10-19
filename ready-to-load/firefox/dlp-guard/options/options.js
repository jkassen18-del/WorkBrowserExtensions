import { api, send, uid } from '/shared/api.js';
import { mountApp } from '/shared/app-shell.js';
import { h, add, clear, toast, modal, confirmDialog, download, pickFile, formatDate, timeAgo, debounce, toggle, lockedBadge } from '/shared/ui.js';
import { getConnectionState, isConnected, CONNECTION_TYPES } from '/shared/connections.js';
import { settings } from '../settings.js';
import { normalize, Sites, BASE_NAME, ACTIONS, CHANNELS, categoryLabel, reportRecord } from '../lib/config.js';

const D = globalThis.WxDetectors;
const DAY = 24 * 60 * 60 * 1000;
const DETECTOR_MODES = [['site', 'Use the site setting'], ['warn', 'Always warn (at least)'], ['block', 'Always block']];
const SITE_MODES = Sites.MODES.map((m) => [m, Sites.MODE_LABELS[m]]);
const MODE_BADGE = { off: '', monitor: 'primary', warn: 'warn', block: 'danger', site: '' };

const values = (ctx) => normalize(ctx.values);

function selectEl(options, value, onchange, { disabled = false, label } = {}) {
  const sel = h('select', { disabled, 'aria-label': label || '' },
    options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
  sel.addEventListener('change', () => onchange(sel.value));
  return sel;
}

function statCard(label, n, cls = '') {
  return h('div.card.stat', h('div.stat-value', { class: n ? cls : '' }, String(n)), h('div.stat-label', label));
}

function detectorBadges(i) {
  return h('div.dlp-det', (i.detectors || []).map((d) => h('span.badge', { title: (d.kinds || []).join(', ') },
    `${d.label}${d.count > 1 ? ` ×${d.count}` : ''}`)));
}

// ============================================================ Activity
const filters = { range: '30', category: '', action: '', detector: '', q: '' };
let shown = 100;

async function renderActivity(el, ctx) {
  const { incidents = [] } = await api.storage.local.get('incidents');
  const all = [...incidents].sort((a, b) => b.time - a.time);
  const weekAgo = Date.now() - 7 * DAY;
  const week = all.filter((i) => i.time >= weekAgo);
  const n = (a) => week.filter((i) => i.action === a).length;

  add(el,
    h('h1', 'Activity'),
    h('p.muted', 'Every time sensitive data was found on a website. Only metadata is stored: the type of data, how many, the site and what happened. Never the text itself.'),
    h('div.dlp-stats',
      statCard('Warned this week', n('warned'), 'warn'),
      statCard('Blocked this week', n('blocked'), 'danger'),
      statCard('Overridden this week', n('overridden'), 'primary'),
      statCard('Logged this week', n('logged'))));

  if (!all.length) {
    add(el, h('div.card', h('div.empty',
      h('div', { style: { fontSize: '34px' } }, '🛡️'),
      h('div.empty-title', 'No incidents yet'),
      h('p', 'Protection is on. Try it: paste ', h('code', '4111 1111 1111 1111'), ' into a text box on chatgpt.com, or check some text on the Test tab.'),
      h('div.row', { style: { justifyContent: 'center' } },
        h('button.btn.primary', { onclick: () => ctx.navigate('test') }, 'Open the Test tab'),
        h('button.btn', { onclick: () => ctx.navigate('sites') }, 'Review sites')))));
    return;
  }

  const detOptions = new Map();
  for (const i of all) for (const d of i.detectors || []) if (!detOptions.has(d.id)) detOptions.set(d.id, d.label);
  const cats = [...new Set(all.map((i) => i.category))];

  const tableHost = h('div');
  const countEl = h('span.small.muted');
  const paint = () => {
    const since = filters.range === 'all' ? 0 : filters.range === 'today' ? new Date().setHours(0, 0, 0, 0) : Date.now() - Number(filters.range) * DAY;
    const q = filters.q.trim().toLowerCase();
    const rows = all.filter((i) => i.time >= since
      && (!filters.category || i.category === filters.category)
      && (!filters.action || i.action === filters.action)
      && (!filters.detector || (i.detectors || []).some((d) => d.id === filters.detector))
      && (!q || i.domain.includes(q) || (i.justification || '').toLowerCase().includes(q)));
    countEl.textContent = `${rows.length} of ${all.length} incident${all.length === 1 ? '' : 's'}`;
    if (!rows.length) {
      clear(tableHost, h('div.empty', h('div.empty-title', 'Nothing matches these filters'), h('p', 'Try a longer date range or clear a filter.')));
      return;
    }
    clear(tableHost, h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', 'When'), h('th', 'Site'), h('th', 'How'), h('th', 'What was found'), h('th', 'Result'))),
      h('tbody', rows.slice(0, shown).map((i) => h('tr',
        h('td.dlp-nowrap', { title: formatDate(i.time) }, timeAgo(i.time)),
        h('td', h('div', { style: { fontWeight: 550 } }, i.domain || '—'), h('div.small.muted', categoryLabel(i.category))),
        h('td.dlp-nowrap', CHANNELS[i.channel] || i.channel, i.files ? h('div.small.muted', `${i.files} file${i.files > 1 ? 's' : ''}`) : null),
        h('td', detectorBadges(i)),
        h('td', h(`span.badge${ACTIONS[i.action]?.badge ? `.${ACTIONS[i.action].badge}` : ''}`, ACTIONS[i.action]?.label || i.action),
          i.justification ? h('div.small.muted', { style: { marginTop: '4px', maxWidth: '220px' } }, `“${i.justification}”`) : null)))))),
    rows.length > shown ? h('div.row', { style: { justifyContent: 'center', marginTop: '12px' } },
      h('button.btn', { onclick: () => { shown += 200; paint(); } }, `Show more (${rows.length - shown} left)`)) : null);
  };

  const filter = (key, label, options) => h('div.field', h('label.small', label),
    selectEl(options, filters[key], (v) => { filters[key] = v; shown = 100; paint(); }, { label }));
  const search = h('input', { type: 'search', placeholder: 'Site or reason', value: filters.q, 'aria-label': 'Search' });
  search.addEventListener('input', debounce(() => { filters.q = search.value; paint(); }, 200));

  const toCsv = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['time', 'domain', 'category', 'channel', 'action', 'detectors', 'files', 'justification'];
    const lines = all.map((i) => [new Date(i.time).toISOString(), i.domain, i.category, i.channel, i.action,
      (i.detectors || []).map((d) => `${d.label} x${d.count}`).join('; '), i.files || 0, i.justification || ''].map(esc).join(','));
    return [head.join(','), ...lines].join('\r\n');
  };
  const stamp = new Date().toISOString().slice(0, 10);

  add(el, h('div.card',
    h('div.dlp-filters',
      filter('range', 'Date', [['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'All time']]),
      filter('category', 'Site category', [['', 'All categories'], ...cats.map((c) => [c, categoryLabel(c)])]),
      filter('action', 'Result', [['', 'All results'], ...Object.entries(ACTIONS).map(([k, v]) => [k, v.label])]),
      filter('detector', 'Data type', [['', 'All data types'], ...detOptions])),
    h('div.row.between', { style: { margin: '14px 0 6px' } },
      h('div.row', search, countEl),
      h('div.row',
        h('button.btn.sm', { onclick: () => download(`data-leak-guard-incidents-${stamp}.csv`, toCsv(), 'text/csv') }, 'Export CSV'),
        h('button.btn.sm', { onclick: () => download(`data-leak-guard-incidents-${stamp}.json`, all.map(reportRecord)) }, 'Export JSON'),
        h('button.btn.sm.danger', {
          onclick: async () => {
            if (!(await confirmDialog('Clear activity?', `Delete all ${all.length} incidents from this browser? Reported incidents stay in your shared backend.`, { okLabel: 'Clear', danger: true }))) return;
            await api.storage.local.remove('incidents');
            toast('Activity cleared');
            ctx.rerender();
          },
        }, 'Clear'))),
    tableHost));
  search.style.width = '220px';
  paint();
}

// ============================================================ Sites
async function renderSites(el, ctx) {
  const v = values(ctx);
  const modesLocked = ctx.isLocked('categoryModes');
  const saveMode = (id, mode) => ctx.save({ categoryModes: { ...values(ctx).categoryModes, [id]: mode } });

  const modeField = (id, label) => {
    const hint = h('div.hint', modeHint(v.categoryModes[id]));
    return h('div.field',
      h('label', 'Mode ', modesLocked ? lockedBadge() : null),
      selectEl(SITE_MODES, v.categoryModes[id], (m) => { hint.textContent = modeHint(m); saveMode(id, m); }, { disabled: modesLocked, label }),
      hint);
  };
  const checkOut = h('div.small', { style: { marginTop: '8px', minHeight: '20px' } });
  const checkIn = h('input', { type: 'text', placeholder: 'e.g. chatgpt.com or https://mail.google.com/', 'aria-label': 'Site to check' });
  const runCheck = () => {
    const raw = checkIn.value.trim();
    if (!raw) return clear(checkOut);
    const c = Sites.classify(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`, values(ctx));
    if (c.reason === 'unsupported') return clear(checkOut, h('span.muted', 'Enter a web address.'));
    clear(checkOut, h('b', c.host), ': ',
      c.reason === 'approved' ? h('span.badge.ok', 'Approved, never checked')
        : c.reason === 'disabled' ? h('span.badge', 'Protection is off')
          : [h('span', `${c.label} → `), h(`span.badge${MODE_BADGE[c.mode] ? `.${MODE_BADGE[c.mode]}` : ''}`, Sites.MODE_LABELS[c.mode])],
      c.entry ? h('span.muted', ` (matches “${c.entry}”)`) : null);
  };
  checkIn.addEventListener('input', debounce(runCheck, 150));

  add(el,
    h('h1', 'Sites'),
    h('p.muted', 'What happens depends on where data goes. Each list entry matches the site and its subdomains; add a path (e.g. ', h('code', 'linkedin.com/messaging'), ') to match only part of a site.'),
    h('div.card',
      ctx.field({ key: 'enabled', label: 'Protection is on', type: 'toggle', hint: 'Turn off to stop all checks in this browser.' }),
      h('div.field', { style: { marginBottom: 0 } }, h('label', 'Check a site'), checkIn, checkOut)),
    h('div.card',
      h('div.dlp-cat',
        h('div',
          h('h2', '✓ Approved sites'),
          h('p.muted', 'Your company’s own tools and domains. Nothing is ever checked on these sites.'),
          ctx.field({ key: 'approvedSites', label: 'One per line', type: 'list', rows: 5, placeholder: 'acme.com\nacme.sharepoint.com\nacme.atlassian.net', hint: 'Tip: approve a site in one click from the toolbar popup.' })),
        h('div', h('span.badge.ok', 'Never checked')))),
    Sites.CATEGORIES.map((c) => h('div.card',
      h('div.dlp-cat',
        h('div',
          h('h2', c.plural),
          h('p.muted', c.description),
          ctx.field({ key: c.key, label: `Sites (${v[c.key].length})`, type: 'list', rows: 6 })),
        modeField(c.id, `${c.plural} mode`)))),
    h('div.card',
      h('div.dlp-cat',
        h('div', h('h2', 'Other sites'), h('p.muted', Sites.OTHER.description, ' Detectors set to “Always block” (secrets by default) still block here.')),
        modeField('other', 'Other sites mode')),
      h('div.notice.small', { style: { margin: '6px 0 0' } },
        'The stricter of the site mode and the detector mode wins. Example: secrets are set to “Always block”, so an API key pasted into any unapproved site is blocked.')),
  );
}

function modeHint(m) {
  return {
    off: 'Not checked.',
    monitor: 'Logged in Activity, the user is not interrupted.',
    warn: 'A dialog asks the user to cancel or continue (with an optional reason).',
    block: 'Stopped. The user cannot continue.',
  }[m] || '';
}

// ============================================================ Detectors
async function renderDetectors(el, ctx) {
  const v = values(ctx);
  const detLocked = ctx.isLocked('detectors');
  const saveDet = (id, patch) => ctx.save({ detectors: { ...values(ctx).detectors, [id]: { ...values(ctx).detectors[id], ...patch } } }, { quiet: true })
    .then(() => toast('Saved'));

  const builtins = D.BUILTIN.map((d) => {
    const conf = v.detectors[d.id] || { enabled: true, mode: 'site' };
    return h('div.dlp-detector',
      toggle(conf.enabled, (on) => saveDet(d.id, { enabled: on }), { disabled: detLocked, label: d.label }),
      h('div', h('div', { style: { fontWeight: 600 } }, d.label), h('div.small.muted', d.description)),
      selectEl(DETECTOR_MODES, conf.mode, (m) => saveDet(d.id, { mode: m }), { disabled: detLocked, label: `${d.label} mode` }));
  });

  const patternsHost = h('div');
  const paintPatterns = () => {
    const list = values(ctx).customPatterns;
    const locked = ctx.isLocked('customPatterns');
    const saveList = async (next) => {
      await ctx.save({ customPatterns: next }, { quiet: true });
      paintPatterns();
    };
    clear(patternsHost,
      list.length ? h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'On'), h('th', 'Name'), h('th', 'Pattern'), h('th', 'Mode'), h('th', ''))),
        h('tbody', list.map((p, idx) => h('tr',
          h('td', toggle(p.enabled, (on) => saveList(list.map((x, i) => (i === idx ? { ...x, enabled: on } : x))), { disabled: locked, label: `Enable ${p.name}` })),
          h('td', { style: { fontWeight: 550 } }, p.name),
          h('td.dlp-mono', `/${p.pattern}/${p.flags || ''}`),
          h('td', h('span.badge', DETECTOR_MODES.find(([m]) => m === p.mode)?.[1] || p.mode)),
          h('td.dlp-nowrap', { style: { textAlign: 'right' } },
            h('button.btn.sm.ghost', { disabled: locked, onclick: () => editPattern(p, (np) => saveList(list.map((x, i) => (i === idx ? np : x)))) }, 'Edit'),
            h('button.btn.sm.ghost.danger', {
              disabled: locked,
              onclick: async () => {
                if (!(await confirmDialog('Delete pattern?', `Delete “${p.name}”?`, { okLabel: 'Delete', danger: true }))) return;
                saveList(list.filter((_, i) => i !== idx));
              },
            }, 'Delete')))))))
        : h('div.empty', h('div.empty-title', 'No custom patterns'), h('p', 'Add one for project code names, customer IDs or internal ticket numbers.')),
      h('div.row', { style: { marginTop: '12px' } },
        h('button.btn.primary', { disabled: locked, onclick: () => editPattern(null, (np) => saveList([...values(ctx).customPatterns, np])) }, '+ Add pattern'),
        locked ? lockedBadge() : null));
  };
  paintPatterns();

  add(el,
    h('h1', 'Detectors'),
    h('p.muted', 'What counts as sensitive. Everything is checked inside this browser. Turn detectors off or make them stricter than the site setting.'),
    h('div.card', h('h2', 'Built-in detectors', ' ', detLocked ? lockedBadge() : null), builtins),
    h('div.card',
      h('h2', 'Confidentiality markers'),
      h('p.muted', 'Text or file names containing these phrases are flagged (not case-sensitive).'),
      h('div.grid-2',
        ctx.field({ key: 'markers', label: 'Phrases, one per line', type: 'list', rows: 6 }),
        h('div',
          ctx.field({ key: 'emailThreshold', label: 'Bulk email threshold', type: 'number', min: 2, max: 10000, hint: 'Flag text with at least this many different email addresses.' })))),
    h('div.card', h('h2', 'Custom patterns'), h('p.muted', 'Regular expressions for data only your company knows about. Matches are masked in the warning dialog.'), patternsHost),
    h('div.card',
      h('h2', 'What is checked'),
      h('div.grid-2',
        h('div',
          ctx.field({ key: 'checkPaste', label: 'Pasted text and files', type: 'toggle' }),
          ctx.field({ key: 'checkDrop', label: 'Dragged and dropped text and files', type: 'toggle' }),
          ctx.field({ key: 'checkUploads', label: 'File uploads', type: 'toggle', hint: 'File names, and the content of text files.' })),
        h('div',
          ctx.field({ key: 'checkSubmit', label: 'Form submissions', type: 'toggle', hint: 'Password and hidden fields are ignored.' }),
          ctx.field({ key: 'checkTyped', label: 'Typed chat messages', type: 'toggle', hint: 'Checked when the message is sent (Enter or the send button).' }),
          ctx.field({ key: 'scanFileContents', label: 'Read text files before upload', type: 'toggle', hint: 'txt, csv, json, md, log, env, pem, key, yaml, sql and similar.' }))),
      ctx.field({ key: 'maxFileSizeMB', label: 'Largest file to read (MB)', type: 'number', min: 0.1, max: 50 })),
  );
}

function editPattern(existing, onSave) {
  const draft = existing ? { ...existing } : { id: uid('p_'), name: '', pattern: '', flags: 'i', mode: 'warn', enabled: true };
  const name = h('input', { type: 'text', value: draft.name, placeholder: 'e.g. Customer ID' });
  const pattern = h('input', { type: 'text', value: draft.pattern, placeholder: 'e.g. \\bCUST-\\d{6}\\b', class: 'dlp-mono', spellcheck: false });
  const flags = h('input', { type: 'text', value: draft.flags, placeholder: 'i', style: { width: '80px' } });
  const mode = selectEl(DETECTOR_MODES, draft.mode, (m) => { draft.mode = m; }, { label: 'Mode' });
  const sample = h('textarea', { rows: 4, placeholder: 'Paste sample text to test the pattern' }, existing ? '' : 'Order for CUST-123456 is ready.');
  const result = h('div.small', { style: { marginTop: '6px' } });
  const test = () => {
    if (!pattern.value) return clear(result, h('span.muted', 'Enter a pattern.'));
    const r = D.testPattern(pattern.value, flags.value, sample.value);
    if (r.error) return clear(result, h('span', { style: { color: 'var(--wx-danger)' } }, `Invalid pattern: ${r.error}`));
    clear(result, r.matches.length
      ? [h('b', `${r.matches.length} match${r.matches.length === 1 ? '' : 'es'}: `), r.matches.slice(0, 10).map((m) => h('code', { style: { marginRight: '6px' } }, m.text))]
      : h('span.muted', 'No matches in the sample.'));
  };
  [pattern, flags, sample].forEach((i) => i.addEventListener('input', test));
  test();
  return modal(existing ? 'Edit pattern' : 'Add pattern', h('div',
    h('div.field', h('label', 'Name'), name),
    h('div.field', h('label', 'Regular expression'), pattern, h('div.hint', 'JavaScript syntax. Use \\b for word boundaries and \\d for digits.')),
    h('div.grid-2',
      h('div.field', h('label', 'Flags'), flags, h('div.hint', 'i = ignore case, m, s, u')),
      h('div.field', h('label', 'Mode'), mode)),
    h('div.field', h('label', 'Test'), sample, result)), {
    actions: (close) => [
      h('button.btn', { onclick: () => close() }, 'Cancel'),
      h('button.btn.primary', {
        onclick: () => {
          const r = D.compilePattern(pattern.value, flags.value);
          if (!name.value.trim()) return toast('Give the pattern a name.', { error: true });
          if (!pattern.value || r.error) return toast(`Invalid pattern${r.error ? `: ${r.error}` : ''}`, { error: true });
          if (new RegExp(pattern.value, flags.value.replace(/[^imsu]/g, '')).test('')) return toast('That pattern matches empty text. Make it more specific.', { error: true });
          onSave({ ...draft, name: name.value.trim(), pattern: pattern.value, flags: flags.value.replace(/[^imsu]/g, '') });
          close(true);
          toast('Pattern saved');
        },
      }, 'Save'),
    ],
  });
}

// ============================================================ Test
const SAMPLES = [
  ['Card number', 'Customer card: 4111 1111 1111 1111, exp 12/29'],
  ['US SSN', 'Employee SSN: 536-22-8726'],
  ['UK NINO', 'NI number AB 12 34 56 C'],
  ['Canadian SIN', 'SIN 130 692 544'],
  ['IBAN', 'Pay to DE89 3704 0044 0532 0130 00'],
  ['API key', 'export GITHUB_TOKEN=ghp_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R\naws_access_key_id = AKIAIOSFODNN7EXAMPLE'],
  ['Private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'],
  ['Confidential', 'CONFIDENTIAL - Q3 board pack. Do not distribute.'],
  ['Email list', Array.from({ length: 12 }, (_, i) => `customer${i + 1}@example.com`).join(', ')],
];

async function renderTest(el, ctx) {
  const area = h('textarea.dlp-test-area', { placeholder: 'Paste or type text here. Nothing is logged or sent anywhere.', spellcheck: false });
  const siteIn = h('input', { type: 'text', value: 'chatgpt.com', 'aria-label': 'Website to simulate' });
  const out = h('div');
  const run = () => {
    const v = values(ctx);
    const raw = siteIn.value.trim() || 'example.com';
    const c = Sites.classify(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`, v);
    const findings = D.scanText(area.value, v);
    paintResults(out, findings, c, area.value);
  };
  const runSoon = debounce(run, 150);
  area.addEventListener('input', runSoon);
  siteIn.addEventListener('input', runSoon);

  add(el,
    h('h1', 'Test'),
    h('p.muted', 'See what Data Leak Guard detects and what would happen on a given site. Uses your current settings. Nothing is logged.'),
    h('div.card',
      h('div.field', h('label', 'Try a sample'), h('div.dlp-chips', SAMPLES.map(([label, text]) => h('button.btn.sm', {
        onclick: () => { area.value = area.value ? `${area.value}\n${text}` : text; run(); },
      }, label)))),
      h('div.field', h('label', 'Text'), area),
      h('div.row', { style: { alignItems: 'flex-end' } },
        h('div.field.grow', { style: { margin: 0, maxWidth: '360px' } }, h('label', 'Pretend it is going to'), siteIn),
        h('button.btn', {
          onclick: async () => {
            const f = await pickFile('');
            if (!f) return;
            const v = values(ctx);
            const lists = [D.scanFileName(f.name, v)];
            let note = 'Only the file name was checked (not a text file or too large).';
            if (v.scanFileContents !== false && D.isTextFile(f.name, f.type) && f.size <= (Number(v.maxFileSizeMB) || 2) * 1048576) {
              lists.push(D.scanText(await f.text(), v));
              note = 'File name and content were checked.';
            }
            const raw = siteIn.value.trim() || 'example.com';
            const c = Sites.classify(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`, v);
            paintResults(out, D.merge(...lists), c, '', `${f.name}: ${note}`);
          },
        }, 'Test a file…'),
        h('button.btn.ghost', { onclick: () => { area.value = ''; run(); } }, 'Clear'))),
    out);
  run();
}

function paintResults(out, findings, c, text, note) {
  const siteLine = c.reason === 'approved' ? h('span', h('b', c.host), ' is approved: nothing would be checked.')
    : c.reason === 'disabled' ? h('span', 'Protection is turned off.')
      : c.reason === 'unsupported' ? h('span', 'Enter a web address.')
        : h('span', h('b', c.host), ` is in ${categoryLabel(c.category)} (${Sites.MODE_LABELS[c.mode]}).`);
  if (!findings.length) {
    clear(out, h('div.card',
      note ? h('p.small.muted', note) : null,
      h('div.empty', { style: { padding: '18px' } }, h('div.empty-title', text || note ? 'Nothing sensitive found' : 'Results appear here'),
        h('p', text || note ? 'This could be shared without a warning.' : 'Type, paste or pick a sample above.')),
      h('p.small.muted', { style: { margin: 0 } }, siteLine)));
    return;
  }
  const checked = c.checked;
  let overall = null;
  const rows = findings.map((f) => {
    const act = checked ? Sites.effective(c.mode, f.mode) : 'off';
    overall = overall ? Sites.stricter(overall, act) : act;
    return h('div.dlp-finding',
      h('div.row.between',
        h('div', h('b', f.label), f.kinds.length ? h('span.small.muted', ` · ${f.kinds.join(', ')}`) : null),
        h('div.row', h('span.badge', `×${f.count}`), h(`span.badge${MODE_BADGE[act] ? `.${MODE_BADGE[act]}` : ''}`, resultLabel(act)))),
      h('div.small', { style: { marginTop: '6px' } }, f.samples.map((s) => h('code', s))));
  });
  const verdict = !checked ? 'Not checked on this site' : {
    monitor: 'Would be logged (user not interrupted)', warn: 'Would show a warning', block: 'Would be blocked', off: 'Not checked',
  }[overall];
  // Highlight matches (this is the user's own text on this page; nothing is stored).
  let highlight = null;
  if (text) {
    const vals = findings.flatMap((f) => f.values).filter((x) => x && !x.startsWith('file:'));
    if (vals.length) {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const loose = (s) => esc(s).replace(/(\d)(?=\d)/g, '$1[ -]?');
      let re = null;
      try { re = new RegExp([...new Set(vals)].sort((a, b) => b.length - a.length).slice(0, 200).map(loose).join('|'), 'gi'); } catch { re = null; }
      if (re) {
        const parts = [];
        let last = 0;
        const t = text.slice(0, 20000);
        for (const m of t.matchAll(re)) {
          if (!m[0]) continue;
          parts.push(t.slice(last, m.index), h('mark', m[0]));
          last = m.index + m[0].length;
        }
        parts.push(t.slice(last));
        highlight = h('div', h('label', { style: { marginTop: '12px' } }, 'Where'), h('div.dlp-highlight', parts));
      }
    }
  }
  clear(out, h('div.card',
    h('div.row.between', { style: { marginBottom: '10px' } },
      h('h2', { style: { margin: 0 } }, verdict),
      h('span.small.muted', `${findings.length} type${findings.length === 1 ? '' : 's'} of sensitive data`)),
    h('p.small.muted', siteLine),
    note ? h('p.small.muted', note) : null,
    rows,
    highlight));
}

function resultLabel(act) {
  return { off: 'Not checked', monitor: 'Logged', warn: 'Warn', block: 'Block' }[act] || act;
}

// ============================================================ Reporting
async function renderReporting(el, ctx) {
  const { connection } = await getConnectionState();
  const linked = isConnected(connection);
  const { incidents = [] } = await api.storage.local.get('incidents');
  const pending = incidents.filter((i) => !i.synced).length;
  const sample = reportRecord({
    id: 'inc_3f9a12c0b7d4e581', time: Date.now(), domain: 'chatgpt.com', category: 'ai', channel: 'paste', action: 'overridden',
    detectors: [{ id: 'card', label: 'Payment card number', count: 1, kinds: ['Visa'] }], files: 0, justification: 'Test card from the docs', browser: 'chrome',
  });
  const policy = {
    approvedSites: ['acme.com', 'acme.sharepoint.com', 'acme.atlassian.net'],
    categoryModes: { ai: 'block', email: 'warn', files: 'warn', social: 'warn', other: 'monitor' },
    requireJustification: true,
    allowPause: false,
    reportIncidents: true,
    connection: { type: 'webhook', url: 'https://hooks.example.com/dlp' },
  };

  add(el,
    h('h1', 'Reporting'),
    h('p.muted', 'By default incidents stay in this browser. Your team can optionally collect them centrally.'),
    h('div.card',
      h('h2', 'Send incidents to your team'),
      ctx.field({
        key: 'reportIncidents', label: 'Report incidents to the shared backend', type: 'toggle',
        hint: 'Sends metadata only: site, category, how, result, data types and counts, and the reason given. Never the text, file names or file content.',
        onSaved: () => ctx.rerender(),
      }),
      linked
        ? h('div.notice.small', `Linked to ${CONNECTION_TYPES[connection.type]?.label || connection.type}: `, h('code', connection.url),
          h('div', { style: { marginTop: '6px' } }, values(ctx).reportIncidents ? `${pending} incident${pending === 1 ? '' : 's'} waiting to be sent.` : 'Reporting is off, nothing is sent.'))
        : h('div.notice.warn.small', 'No shared backend is linked, so nothing can be sent. ',
          h('a', { href: '#connections', onclick: (e) => { e.preventDefault(); ctx.navigate('connections'); } }, 'Link one under Shared data'), '.'),
      linked && values(ctx).reportIncidents ? h('button.btn', {
        onclick: async () => {
          const r = await send({ type: 'dlp:report' });
          toast(r?.message || 'Done', { error: r && r.ok === false });
          ctx.rerender();
        },
      }, 'Send now') : null,
      h('details', { style: { marginTop: '12px' } },
        h('summary', 'Example of what is sent'),
        h('pre.mono', { style: { whiteSpace: 'pre-wrap', background: 'var(--wx-surface-2)', padding: '10px', borderRadius: '8px' } },
          JSON.stringify({ source: 'dlp-guard', collection: 'incidents', records: [sample] }, null, 2)))),
    h('div.card',
      h('h2', 'Warning dialog'),
      ctx.field({ key: 'requireJustification', label: 'Require a reason to continue past a warning', type: 'toggle' }),
      ctx.field({ key: 'dialogMessage', label: 'Extra message in the dialog', type: 'textarea', rows: 2, placeholder: 'e.g. See the data handling policy at intranet/data-policy or ask #it-help.' }),
      ctx.field({ key: 'allowPause', label: 'Let people pause protection for 15 minutes', type: 'toggle', hint: 'From the toolbar popup. Turn off (or lock by policy) to prevent pausing.' }),
      ctx.field({ key: 'maxIncidents', label: 'Incidents kept in this browser', type: 'number', min: 10, max: 100000 })),
    h('div.card',
      h('h2', 'Roll out with policy (optional)'),
      h('p.muted', 'IT can lock any setting through browser policy (Chrome/Edge 3rdparty extension policy or Firefox policies.json). Example:'),
      h('pre.mono', { style: { whiteSpace: 'pre-wrap', background: 'var(--wx-surface-2)', padding: '10px', borderRadius: '8px' } }, JSON.stringify(policy, null, 2)),
      h('p.small.muted', { style: { margin: 0 } }, 'Generate one from your own settings under ', h('a', { href: '#backup', onclick: (e) => { e.preventDefault(); ctx.navigate('backup'); } }, 'Backup & policy'), '.')),
  );
}

// ============================================================ mount
const app = await mountApp({
  baseName: BASE_NAME,
  tagline: 'Stops card numbers, ID numbers, secrets and confidential text from leaking into AI chatbots, personal email and file-sharing sites.',
  settings,
  syncCollections: ['incidents'],
  panels: [
    { id: 'activity', label: 'Activity', icon: '📋', render: renderActivity },
    { id: 'sites', label: 'Sites', icon: '🌐', render: renderSites },
    { id: 'detectors', label: 'Detectors', icon: '🔎', render: renderDetectors },
    { id: 'test', label: 'Test', icon: '🧪', render: renderTest },
    { id: 'reporting', label: 'Reporting', icon: '📤', render: renderReporting },
  ],
  welcome: 'Protection is already on. There is nothing to set up.',
  welcomeSteps: [
    'AI chatbots, personal email, file-sharing and social sites are checked right away. Pasting a card number, ID number or API key there shows a warning (secrets are blocked).',
    'Try it now: open the Test tab, or paste 4111 1111 1111 1111 into a text box on chatgpt.com.',
    'Add your company’s own domains under Sites → Approved sites so they are never checked.',
    'See what was caught under Activity. Only metadata is stored, never the text itself.',
  ],
  about: h('div',
    h('h3', 'Privacy'),
    h('p.muted', 'All checks run inside this browser. Data Leak Guard never sends the text you paste, type or upload anywhere. Incidents record only the data type, count, site, channel, result and time.'),
    h('p.muted', { style: { margin: 0 } }, `Built-in detectors: ${D.BUILTIN.map((d) => d.label).join(', ')}.`)),
});

// Live-refresh the Activity panel when new incidents arrive.
const refreshActivity = debounce(() => {
  if ((location.hash.slice(1) || 'activity') === 'activity' && !document.querySelector('.wx-modal-backdrop')) app.rerender();
}, 400);
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'incidents' in changes) refreshActivity();
});

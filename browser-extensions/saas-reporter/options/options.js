import { api, send, uid } from '/shared/api.js';
import { mountApp } from '/shared/app-shell.js';
import { h, add, clear, toast, modal, confirmDialog, download, debounce, formatDate, copyText } from '/shared/ui.js';
import { getConnection, isConnected } from '/shared/connections.js';
import { settings } from '../settings.js';
import {
  KEYS, CATEGORIES, DEMO_SEED, buildIndex, loadUsage, summarize, unusedLicences, statusOf, statusPatch,
  normalizeDomain, generateDemo, buildReport, getInstallId, formatDuration, formatMoney, formatDay, lastUsedLabel,
  lastUsedMap, toCSV, STATUS_LABEL,
} from '../lib.js';
import { statCards, appsTable, statusSelect, appDot } from '../dashboard/view.js';

const BASE = 'SaaS Usage Reporter';
const openDashboard = () => api.tabs.create({ url: api.runtime.getURL('dashboard/dashboard.html') });

// ---- Overview ------------------------------------------------------------------------------

async function renderOverview(el, ctx) {
  await send({ type: 'saas:flush' });
  const values = ctx.values;
  const index = buildIndex(values);
  const { usage, hasDemo } = await loadUsage();
  const { [KEYS.since]: since } = await api.storage.local.get(KEYS.since);
  const sum = summarize(usage, index, values, { days: 30 });
  const unused = unusedLicences(usage, index, values);
  const locked = ctx.isLocked('approvedApps') || ctx.isLocked('unapprovedApps');

  const loadDemo = async () => {
    const v = ctx.values;
    const seed = {};
    // Only fill lists that are empty, and remember exactly what was added so it can be removed again.
    for (const key of ['approvedApps', 'unapprovedApps', 'licences']) {
      if (!ctx.isLocked(key) && !(v[key] || []).length) seed[key] = DEMO_SEED[key];
    }
    await api.storage.local.set({ [KEYS.demo]: generateDemo(30), [KEYS.demoSeed]: seed });
    if (Object.keys(seed).length) await ctx.save(seed, { quiet: true });
    toast('Demo data loaded: 30 days of sample usage');
    ctx.rerender();
  };
  const removeDemo = async () => {
    const { [KEYS.demoSeed]: seed = {} } = await api.storage.local.get(KEYS.demoSeed);
    const v = ctx.values;
    const patch = {};
    if (seed.approvedApps) patch.approvedApps = (v.approvedApps || []).filter((x) => !seed.approvedApps.includes(x));
    if (seed.unapprovedApps) patch.unapprovedApps = (v.unapprovedApps || []).filter((x) => !seed.unapprovedApps.includes(x));
    if (seed.licences) patch.licences = (v.licences || []).filter((l) => !String(l.id).startsWith('demo-'));
    if (Object.keys(patch).length) await ctx.save(patch, { quiet: true });
    await api.storage.local.remove([KEYS.demo, KEYS.demoSeed]);
    toast('Demo data removed');
    ctx.rerender();
  };
  const clearAll = async () => {
    if (!(await confirmDialog('Clear all usage?', 'This deletes every recorded day of usage (and any demo data) from this browser. Settings, approvals and licences are kept.', { okLabel: 'Clear usage', danger: true }))) return;
    await api.storage.local.remove([KEYS.usage]);
    if (hasDemo) await removeDemo();
    await api.storage.local.set({ [KEYS.since]: new Date().toISOString().slice(0, 10) });
    toast('Usage cleared');
    ctx.rerender();
  };

  add(el,
    h('div.row.between', { style: { marginBottom: '12px' } },
      h('div', h('h1', { style: { margin: 0 } }, 'Overview'), h('p.muted', { style: { margin: 0 } }, 'Last 30 days of SaaS usage in this browser.')),
      h('button.btn.primary', { onclick: openDashboard }, 'Open dashboard')),
    !values.enabled ? h('div.notice.warn', 'Tracking is paused. Turn it back on from the toolbar popup or under Tracking.') : null,
    hasDemo ? h('div.notice.warn', 'Demo data is loaded. It is shown on the dashboard but never included in reports.') : null,
    statCards(sum, unused, values),
    h('div.card',
      h('div.row.between', h('h2', { style: { margin: 0 } }, 'Most used apps'), h('button.btn.sm', { onclick: openDashboard }, 'See all')),
      sum.apps.length
        ? appsTable(sum.apps, { limit: 5, compact: true, locked, onStatus: async (id, s) => { await ctx.save(statusPatch(id, s, ctx.values), { quiet: true }); toast(`${index.get(id).name}: ${STATUS_LABEL[s]}`); } })
        : h('div.empty', h('div.empty-title', 'Nothing recorded yet'),
          'Use Slack, Google Docs, Figma or any other known app for a minute and it appears here. Want to see how it looks first? Load the demo data below.')),
    h('div.grid-2',
      h('div.card',
        h('h2', 'Try it with sample data'),
        h('p.muted', '30 days of realistic usage for a typical knowledge worker, plus sample approvals and licences (only where your lists are empty). Remove it any time; your own data is untouched.'),
        h('div.row',
          hasDemo ? h('button.btn', { onclick: removeDemo }, 'Remove demo data') : h('button.btn.primary', { onclick: loadDemo }, 'Load demo data'))),
      h('div.card',
        h('h2', 'Your data'),
        h('p.muted', 'Only the app, the day, active minutes and the number of visits are stored. Never page addresses, paths or titles.'),
        h('table.table', h('tbody',
          h('tr', h('th', 'Recording since'), h('td', since ? formatDay(since, { dateStyle: 'medium' }) : 'Today')),
          h('tr', h('th', 'Days stored'), h('td', String(Object.keys((await api.storage.local.get(KEYS.usage))[KEYS.usage] || {}).length), ` (kept for ${values.retentionDays} days)`)))),
        h('div.row', { style: { marginTop: '12px' } }, h('button.btn.danger', { onclick: clearAll }, 'Clear all usage')))),
  );
}

// ---- Apps (catalog browser) ----------------------------------------------------------------

async function renderApps(el, ctx) {
  const { usage } = await loadUsage();
  const lastUsed = lastUsedMap(usage);
  const prefill = normalizeDomain(new URLSearchParams(location.search).get('add') || '');
  const state = { q: '', category: '', status: '', limit: 60 };
  const statusLocked = ctx.isLocked('approvedApps') || ctx.isLocked('unapprovedApps');
  const customLocked = ctx.isLocked('customApps');
  const listHost = h('div');
  const customHost = h('div');

  const setStatus = async (id, s) => {
    await ctx.save(statusPatch(id, s, ctx.values), { quiet: true });
    toast(`${buildIndex(ctx.values).get(id).name}: ${STATUS_LABEL[s]}`);
  };

  const paintList = () => {
    const index = buildIndex(ctx.values);
    const needle = state.q.trim().toLowerCase();
    const rows = index.list.filter((a) => {
      if (state.category && a.category !== state.category) return false;
      const st = statusOf(a.id, ctx.values);
      if (state.status === 'used' ? !lastUsed[a.id] : state.status && st !== state.status) return false;
      return !needle || a.name.toLowerCase().includes(needle) || a.domains.some((d) => d.includes(needle));
    }).sort((a, b) => a.name.localeCompare(b.name));
    clear(listHost,
      h('p.small.muted', `${rows.length} app${rows.length === 1 ? '' : 's'}`),
      rows.length ? h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'App'), h('th', 'Domains'), h('th', 'Last used'), h('th', 'Status'))),
        h('tbody', rows.slice(0, state.limit).map((a) => h('tr',
          h('td', h('div.app-cell', appDot(a.name), h('div', h('div.app-name', a.name, a.custom ? [' ', h('span.badge.primary', 'Custom')] : null), h('div.sub', a.category)))),
          h('td.small.muted', a.domains.join(', ')),
          h('td.small', lastUsed[a.id] ? lastUsedLabel(lastUsed[a.id]) : h('span.muted', '–')),
          h('td', statusSelect(a.id, statusOf(a.id, ctx.values), setStatus, statusLocked))))))) : h('div.empty', h('div.empty-title', 'No apps match'), 'Not in the catalog? Add it as a custom app below.'),
      rows.length > state.limit ? h('div.more-row', h('button.btn.sm', { onclick: () => { state.limit += 120; paintList(); } }, `Show more (${rows.length - state.limit} left)`)) : null);
  };

  const q = h('input', { type: 'search', placeholder: 'Search by name or domain…', 'aria-label': 'Search apps' });
  q.addEventListener('input', debounce(() => { state.q = q.value; state.limit = 60; paintList(); }, 150));
  const cat = h('select', { 'aria-label': 'Category' }, h('option', { value: '' }, 'All categories'), CATEGORIES.map((c) => h('option', { value: c }, c)));
  cat.addEventListener('change', () => { state.category = cat.value; state.limit = 60; paintList(); });
  const st = h('select', { 'aria-label': 'Status' }, h('option', { value: '' }, 'Any status'),
    Object.entries(STATUS_LABEL).map(([k, l]) => h('option', { value: k }, l)), h('option', { value: 'used' }, 'Used by me'));
  st.addEventListener('change', () => { state.status = st.value; state.limit = 60; paintList(); });

  // Custom apps
  const paintCustom = () => {
    const list = ctx.values.customApps || [];
    clear(customHost, list.length ? h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', 'Name'), h('th', 'Domains'), h('th', 'Category'), h('th', ''))),
      h('tbody', list.map((a) => h('tr',
        h('td.app-name', a.name), h('td.small', (a.domains || []).join(', ')), h('td', a.category),
        h('td.num', customLocked ? null : [
          h('button.btn.sm.ghost', { onclick: () => editCustom(a) }, 'Edit'),
          h('button.btn.sm.ghost.danger', {
            onclick: async () => {
              if (!(await confirmDialog('Remove custom app', `Stop recognising ${a.name}? Its recorded usage is kept.`, { okLabel: 'Remove', danger: true }))) return;
              await ctx.save({ customApps: (ctx.values.customApps || []).filter((x) => x.id !== a.id) });
              paintCustom();
              paintList();
            },
          }, 'Remove')])))))) : h('p.muted', 'No custom apps yet. Internal tools, regional apps or anything missing from the catalog can be added here.'));
  };

  const editCustom = async (existing) => {
    const name = h('input', { value: existing?.name || '', placeholder: 'e.g. Acme Intranet', required: true });
    const domains = h('input', { value: (existing?.domains || (prefill && !existing ? [prefill] : [])).join(', '), placeholder: 'e.g. intranet.acme.com, acme.sharepoint.com' });
    const category = h('select', CATEGORIES.map((c) => h('option', { value: c, selected: c === (existing?.category || 'Other') }, c)));
    const err = h('div.small', { style: { color: 'var(--wx-danger)', minHeight: '18px' } });
    const result = await modal(existing ? 'Edit custom app' : 'Add a custom app', (close) => h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const doms = [...new Set(domains.value.split(/[\s,;]+/).map(normalizeDomain).filter(Boolean))];
        if (!name.value.trim()) return void (err.textContent = 'Enter a name.');
        if (!doms.length) return void (err.textContent = 'Enter at least one domain, e.g. example.com');
        close({ id: existing?.id || `custom-${uid()}`, name: name.value.trim(), domains: doms, category: category.value });
      },
    },
    h('div.field', h('label', 'Name'), name),
    h('div.field', h('label', 'Domains'), domains, h('div.hint', 'Separate with commas. Subdomains match automatically: "acme.com" also covers "app.acme.com".')),
    h('div.field', h('label', 'Category'), category),
    err,
    h('div.row.end', h('button.btn', { type: 'button', onclick: () => close(null) }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, existing ? 'Save' : 'Add app'))));
    if (!result) return;
    const list = (ctx.values.customApps || []).filter((x) => x.id !== result.id);
    await ctx.save({ customApps: [...list, result] });
    paintCustom();
    paintList();
  };

  paintList();
  paintCustom();
  add(el,
    h('h1', 'Apps'),
    h('p.muted', 'The built-in catalog of SaaS apps that are recognised by domain. Mark each app as Approved, Neutral or Not approved; the dashboard flags unapproved apps that are used.'),
    statusLocked ? h('div.notice', 'Approval lists are managed by your IT department.') : null,
    h('div.card',
      h('div.filters', q, cat, st),
      listHost),
    h('div.card',
      h('div.row.between', h('h2', { style: { margin: 0 } }, 'Custom apps'),
        h('button.btn.primary', { disabled: customLocked, onclick: () => editCustom(null) }, '+ Add custom app')),
      h('div', { style: { marginTop: '12px' } }, customHost)),
  );
  if (prefill && !customLocked) {
    history.replaceState(null, '', `${location.pathname}#apps`);
    editCustom(null);
  }
}

// ---- Licences ------------------------------------------------------------------------------

async function renderLicences(el, ctx) {
  const locked = ctx.isLocked('licences');
  const host = h('div');

  const paint = async () => {
    const values = ctx.values;
    const index = buildIndex(values);
    const { usage } = await loadUsage();
    const last = lastUsedMap(usage);
    const unusedIds = new Set(unusedLicences(usage, index, values).map((u) => u.licence.id));
    const list = values.licences || [];
    const total = list.reduce((s, l) => s + (Number(l.costPerMonth) || 0), 0);
    const idle = list.filter((l) => unusedIds.has(l.id)).reduce((s, l) => s + (Number(l.costPerMonth) || 0), 0);
    clear(host,
      list.length ? h('div.stats', { style: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' } },
        h('div.card.stat', h('div.stat-label', 'Licences'), h('div.stat-value', String(list.length))),
        h('div.card.stat', h('div.stat-label', 'Monthly cost'), h('div.stat-value', total ? formatMoney(total, values.currency) : '–')),
        h('div.card.stat', h('div.stat-label', `Unused (${values.unusedAfterDays}+ days)`), h('div.stat-value', { class: unusedIds.size ? 'warn' : '' }, String(unusedIds.size)),
          idle ? h('div.stat-note', `${formatMoney(idle, values.currency)} / month`) : null)) : null,
      h('div.card',
        h('div.row.between', h('h2', { style: { margin: 0 } }, 'Paid licences'),
          h('div.row',
            list.length ? h('button.btn', { onclick: () => exportLicences(list, index, last, unusedIds, values) }, 'Export CSV') : null,
            h('button.btn.primary', { disabled: locked, onclick: () => edit(null) }, '+ Add licence'))),
        list.length ? h('div.table-wrap', { style: { marginTop: '12px' } }, h('table.table',
          h('thead', h('tr', h('th', 'App'), h('th.num', 'Seats'), h('th.num', 'Cost / month'), h('th', 'Owner'), h('th', 'Last used'), h('th', 'Usage'), h('th', ''))),
          h('tbody', list.map((l) => {
            const app = index.get(l.appId);
            return h('tr',
              h('td', h('div.app-cell', appDot(app.name), h('div', h('div.app-name', app.name), h('div.sub', app.category)))),
              h('td.num', l.seats ? String(l.seats) : '–'),
              h('td.num', l.costPerMonth ? formatMoney(l.costPerMonth, values.currency) : '–'),
              h('td', l.owner || h('span.muted', '–')),
              h('td', lastUsedLabel(last[l.appId])),
              h('td', unusedIds.has(l.id) ? h('span.badge.warn', 'Unused') : h('span.badge.ok', 'In use')),
              h('td.num', locked ? null : [
                h('button.btn.sm.ghost', { onclick: () => edit(l) }, 'Edit'),
                h('button.btn.sm.ghost.danger', {
                  onclick: async () => {
                    if (!(await confirmDialog('Delete licence', `Delete the ${app.name} licence?`, { okLabel: 'Delete', danger: true }))) return;
                    await ctx.save({ licences: (ctx.values.licences || []).filter((x) => x.id !== l.id) });
                    paint();
                  },
                }, 'Delete')]));
          })))) : h('div.empty', h('div.empty-title', 'No licences yet'),
          'Add the apps your company pays for. Seats, cost and owner are optional. A licence is flagged as unused when nobody on this browser opened the app for ',
          String(values.unusedAfterDays), ' days.')),
    );
  };

  const edit = async (existing) => {
    const index = buildIndex(ctx.values);
    const byName = new Map(index.list.map((a) => [a.name.toLowerCase(), a.id]));
    const listId = `apps-${uid()}`;
    const appInput = h('input', { list: listId, value: existing ? index.get(existing.appId).name : '', placeholder: 'Start typing, e.g. Slack', autocomplete: 'off' });
    const datalist = h('datalist', { id: listId }, index.list.slice().sort((a, b) => a.name.localeCompare(b.name)).map((a) => h('option', { value: a.name })));
    const seats = h('input', { type: 'number', min: 0, value: existing?.seats ?? '', placeholder: 'Optional' });
    const cost = h('input', { type: 'number', min: 0, step: '0.01', value: existing?.costPerMonth ?? '', placeholder: 'Optional' });
    const owner = h('input', { value: existing?.owner || '', placeholder: 'Optional, e.g. IT or a person' });
    const err = h('div.small', { style: { color: 'var(--wx-danger)', minHeight: '18px' } });
    const result = await modal(existing ? 'Edit licence' : 'Add licence', (close) => h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const appId = byName.get(appInput.value.trim().toLowerCase());
        if (!appId) return void (err.textContent = 'Pick an app from the list (add it under Apps → Custom apps if it is missing).');
        close({
          id: existing?.id || `lic-${uid()}`,
          appId,
          seats: seats.value === '' ? null : Math.max(0, Math.round(Number(seats.value))),
          costPerMonth: cost.value === '' ? null : Math.max(0, Number(cost.value)),
          owner: owner.value.trim(),
        });
      },
    },
    h('div.field', h('label', 'App'), appInput, datalist),
    h('div.grid-2', h('div.field', h('label', 'Seats'), seats), h('div.field', h('label', `Total cost per month (${ctx.values.currency})`), cost)),
    h('div.field', h('label', 'Owner'), owner),
    err,
    h('div.row.end', h('button.btn', { type: 'button', onclick: () => close(null) }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, existing ? 'Save' : 'Add licence'))));
    if (!result) return;
    const list = (ctx.values.licences || []).slice();
    const i = list.findIndex((x) => x.id === result.id);
    if (i >= 0) list[i] = result;
    else list.push(result);
    await ctx.save({ licences: list });
    paint();
  };

  add(el,
    h('h1', 'Licences'),
    h('p.muted', 'Track paid SaaS subscriptions and find seats that are not being used.'),
    locked ? h('div.notice', 'The licence list is managed by your IT department.') : null,
    host);
  await paint();
}

function exportLicences(list, index, last, unusedIds, values) {
  const rows = [['App', 'App ID', 'Seats', `Cost per month (${values.currency})`, 'Owner', 'Last used', 'Usage'],
    ...list.map((l) => [index.get(l.appId).name, l.appId, l.seats ?? '', l.costPerMonth ?? '', l.owner || '', last[l.appId] || '', unusedIds.has(l.id) ? 'Unused' : 'In use'])];
  download('saas-licences.csv', `﻿${toCSV(rows)}`, 'text/csv');
}

// ---- Tracking ------------------------------------------------------------------------------

async function renderTracking(el, ctx) {
  add(el,
    h('h1', 'Tracking'),
    h('p.muted', 'How usage is measured in this browser.'),
    h('div.card',
      ctx.field({ key: 'enabled', label: 'Record SaaS usage', type: 'toggle', hint: 'Counts time while a known app is the active tab of the focused window and you are not idle.' }),
      h('div.grid-2',
        ctx.field({ key: 'idleSeconds', label: 'Idle after (seconds)', type: 'number', min: 15, max: 3600, hint: 'Counting stops after this long without keyboard or mouse input.' }),
        ctx.field({ key: 'retentionDays', label: 'Keep daily totals for (days)', type: 'number', min: 7, max: 730, hint: 'Older days are deleted automatically.' })),
      h('div.grid-2',
        ctx.field({ key: 'unusedAfterDays', label: 'Licence unused after (days)', type: 'number', min: 1, max: 365, hint: 'Licensed apps not opened for this long are flagged.' }),
        ctx.field({ key: 'currency', label: 'Currency', type: 'select', options: ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'INR', 'SEK', 'NOK', 'DKK', 'NZD', 'SGD', 'ZAR', 'BRL', 'MXN'].map((c) => [c, c]) })),
      ctx.values.retentionDays < ctx.values.unusedAfterDays
        ? h('div.notice.warn', 'Keep usage at least as long as the "licence unused" window, otherwise licences may be flagged as unused too early.') : null),
    h('div.card',
      h('h2', 'Never record these domains'),
      ctx.field({ key: 'excludedDomains', label: 'Excluded domains', type: 'list', placeholder: 'linkedin.com\nyoutube.com', hint: 'One per line. Subdomains are excluded too.' })),
    h('div.card',
      h('h2', 'What is recorded'),
      h('ul', { style: { margin: 0, paddingLeft: '18px' } },
        h('li', 'Only apps in the catalog or your custom apps. Other websites are ignored completely.'),
        h('li', 'Per app and day: active seconds and number of visits. A visit is opening the app, or coming back to it after 30 minutes.'),
        h('li', 'Never full addresses, paths, page titles or content.'),
        h('li', 'Everything stays in this browser unless you turn on Reporting and link a backend.'))),
  );
}

// ---- Reporting -----------------------------------------------------------------------------

async function renderReporting(el, ctx) {
  const conn = await getConnection();
  const linked = isConnected(conn);
  const { [KEYS.reportLog]: log = [], [KEYS.lastReportAt]: lastAt } = await api.storage.local.get([KEYS.reportLog, KEYS.lastReportAt]);
  const { usage, hasDemo } = await loadUsage({ includeDemo: false });
  const report = buildReport(usage, buildIndex(ctx.values), ctx.values, await getInstallId());
  const preview = h('pre.mono.preview', JSON.stringify(report, null, 2));

  add(el,
    h('h1', 'Reporting'),
    h('p.muted', 'Optionally share anonymous usage totals with IT. Off by default; nothing is sent until you turn it on and link a backend.'),
    !linked ? h('div.notice', 'No shared-data backend is linked, so nothing can be sent. ',
      h('a', { href: '#connections' }, 'Link one under Shared data'), ' (webhook, REST API or Supabase).') : null,
    h('div.card',
      ctx.field({ key: 'reportingEnabled', label: 'Send anonymous usage reports', type: 'toggle', hint: 'When on and a backend is linked, a report is sent automatically once per period.', onSaved: () => ctx.rerender() }),
      ctx.field({ key: 'reportPeriodDays', label: 'Each report covers', type: 'select', options: [[1, 'The last day'], [7, 'The last 7 days'], [14, 'The last 14 days'], [30, 'The last 30 days']], onSaved: () => ctx.rerender() }),
      h('div.row',
        h('button.btn.primary', {
          disabled: !ctx.values.reportingEnabled || !linked,
          title: !linked ? 'Link a backend under Shared data first' : !ctx.values.reportingEnabled ? 'Turn reporting on first' : '',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            const r = await send({ type: 'saas:sendReport' });
            toast(r?.message || r?.error || 'Done', { error: !r || r.ok === false });
            ctx.rerender();
          },
        }, 'Send report now'),
        lastAt ? h('span.small.muted', `Last sent ${formatDate(lastAt)}`) : null)),
    h('div.card',
      h('div.row.between', h('h2', { style: { margin: 0 } }, 'Exactly what would be sent'),
        h('button.btn.sm', { onclick: async () => toast((await copyText(preview.textContent)) ? 'Copied' : 'Copy failed') }, 'Copy')),
      h('p.small.muted', { style: { margin: '6px 0 10px' } },
        'Collection ', h('code', 'reports'), ' via the Shared data connection. The install id is random and not linked to you, your account or this device. ',
        hasDemo ? 'Demo data is excluded.' : ''),
      report.apps.length ? null : h('div.notice', 'No real usage in this period yet, so the report would have an empty app list.'),
      preview),
    h('div.card',
      h('h2', 'Recent reports'),
      log.length ? h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'Sent'), h('th', 'Period'), h('th.num', 'Apps'), h('th', 'Result'))),
        h('tbody', log.map((r) => h('tr',
          h('td', formatDate(r.at)), h('td', `${r.periodStart} → ${r.periodEnd}`), h('td.num', String(r.apps)),
          h('td', r.ok ? h('span.badge.ok', 'Sent') : h('span.badge.danger', { title: r.error }, 'Failed'))))))) : h('p.muted', 'No reports sent yet.')),
  );
}

// ---- Mount ---------------------------------------------------------------------------------

await mountApp({
  baseName: BASE,
  tagline: 'See which SaaS apps you use, spot unused licences and unapproved tools.',
  settings,
  syncCollections: ['reports'],
  panels: [
    { id: 'overview', label: 'Overview', icon: '📊', render: renderOverview },
    { id: 'apps', label: 'Apps', icon: '🧩', render: renderApps },
    { id: 'licences', label: 'Licences', icon: '🎫', render: renderLicences },
    { id: 'tracking', label: 'Tracking', icon: '⏱️', render: renderTracking },
    { id: 'reporting', label: 'Reporting', icon: '📤', render: renderReporting },
  ],
  welcomeSteps: [
    'Nothing to set up: just keep working. Time in known apps (Slack, Google Docs, Figma, Salesforce and 600+ more) is recorded by domain only.',
    'Click the toolbar icon to see today\'s apps, or open the dashboard for trends, categories and CSV export.',
    'Optional: mark apps as Approved or Not approved under Apps, and add the licences you pay for to spot unused seats.',
    'Want to look around first? Load 30 days of demo data from the Overview panel and remove it later with one click.',
  ],
  about: h('div', h('p', 'Usage is matched against a catalog of SaaS domains. Only app id, day, active seconds and visit counts are stored.'),
    h('p.muted.small', 'Reports (optional) contain anonymous totals: { periodStart, periodEnd, apps: [{ appId, name, seconds, visits, days }] }.')),
});


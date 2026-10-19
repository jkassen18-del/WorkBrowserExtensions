import { api, send } from '/shared/api.js';
import { h, clear, toast, download, debounce } from '/shared/ui.js';
import { brandPage } from '/shared/app-shell.js';
import { logoSrc, productName, onBrandChange, loadBrand } from '/shared/brand.js';
import { settings } from '../settings.js';
import {
  KEYS, CATEGORIES, buildIndex, loadUsage, summarize, unusedLicences, statusPatch, toCSV, formatDay,
  lastUsedLabel, STATUS_LABEL,
} from '../lib.js';
import {
  statCards, dailyChart, categoryBars, appsTable, unusedList, unapprovedList,
} from './view.js';

const BASE = 'SaaS Usage Reporter';
// Opens Settings in a new tab (keeps the dashboard open, unlike the popup helper).
const openOptions = (hash = '') => api.tabs.create({ url: api.runtime.getURL(`options/options.html${hash ? `#${hash}` : ''}`) });
const RANGES = [7, 30, 90];
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

let days = Number(store.get('saas-range', 30)) || 30;
if (!RANGES.includes(days)) days = 30;
const filters = { q: '', category: '', status: '' };
let showAll = false;

const header = h('header.wx-header.dash-header');
const main = h('main.dash-main');
const footer = h('footer.wx-footer');

function logo(brand) {
  const src = logoSrc(brand);
  return src ? h('img.wx-logo', { src, alt: '' }) : h('div.wx-logo-fallback', (brand.companyName || '?').charAt(0).toUpperCase());
}

function paintHeader(brand) {
  const range = h('div.range', { role: 'group', 'aria-label': 'Date range' }, RANGES.map((n) => h('button', {
    'aria-pressed': String(n === days),
    onclick: () => {
      days = n;
      store.set('saas-range', String(n));
      paintHeader(brand);
      render();
    },
  }, `${n} days`)));
  clear(header,
    logo(brand),
    h('div.grow', h('div.wx-title', productName(brand, BASE)), h('div.wx-sub', 'Dashboard · stored on this device')),
    range,
    h('button.btn', { onclick: exportCSV, title: 'Download the apps table as CSV' }, 'Export CSV'),
    h('button.btn.ghost', { onclick: () => openOptions(''), title: 'Settings' }, '⚙ Settings'));
  clear(footer, brand.footerText || '');
}

let latest = null;

async function render() {
  const values = await settings.get();
  const index = buildIndex(values);
  const { usage, hasDemo } = await loadUsage();
  const { [KEYS.since]: since } = await api.storage.local.get(KEYS.since);
  const sum = summarize(usage, index, values, { days });
  const unused = unusedLicences(usage, index, values);
  const locked = settings.isLocked('approvedApps') || settings.isLocked('unapprovedApps');
  latest = { sum, values };

  const onStatus = async (appId, status) => {
    const v = await settings.get();
    await settings.set(statusPatch(appId, status, v));
    toast(`${index.get(appId).name}: ${STATUS_LABEL[status]}`);
    render();
  };

  const anyUsage = Object.keys(usage).length > 0;
  if (!anyUsage) {
    clear(main,
      h('div.card', h('div.empty',
        h('div.empty-title', { style: { fontSize: '17px' } }, 'No SaaS usage recorded yet'),
        h('p', 'Keep working as usual. Time spent in known apps such as Slack, Google Docs or Figma shows up here within a minute.'),
        h('p.small', values.enabled ? 'Only the app name and time are recorded, never page addresses or titles.' : 'Tracking is paused. Turn it on from the toolbar popup or Settings → Tracking.'),
        h('div.row', { style: { justifyContent: 'center', marginTop: '12px' } },
          h('button.btn.primary', { onclick: () => openOptions('overview') }, 'Load demo data in Settings'),
          h('button.btn', { onclick: () => openOptions('apps') }, 'Browse the app catalog')))));
    return;
  }

  // Filters
  const q = h('input', { type: 'search', placeholder: 'Search apps…', value: filters.q, 'aria-label': 'Search apps' });
  const cat = h('select', { 'aria-label': 'Category' }, h('option', { value: '' }, 'All categories'),
    CATEGORIES.map((c) => h('option', { value: c, selected: c === filters.category }, c)));
  const st = h('select', { 'aria-label': 'Status' }, h('option', { value: '' }, 'Any status'),
    Object.entries(STATUS_LABEL).map(([k, l]) => h('option', { value: k, selected: k === filters.status }, l)));
  const tableHost = h('div');
  const paintTable = () => {
    const needle = filters.q.trim().toLowerCase();
    const rows = sum.apps.filter((a) => (!needle || a.name.toLowerCase().includes(needle) || a.category.toLowerCase().includes(needle))
      && (!filters.category || a.category === filters.category)
      && (!filters.status || a.status === filters.status));
    const limit = showAll ? 0 : 25;
    clear(tableHost,
      rows.length ? appsTable(rows, { onStatus, locked, limit }) : h('div.empty', 'No apps match these filters.'),
      !showAll && rows.length > 25 ? h('div.more-row', h('button.btn.sm', { onclick: () => { showAll = true; paintTable(); } }, `Show all ${rows.length} apps`)) : null);
  };
  q.addEventListener('input', debounce(() => { filters.q = q.value; paintTable(); }, 150));
  cat.addEventListener('change', () => { filters.category = cat.value; paintTable(); });
  st.addEventListener('change', () => { filters.status = st.value; paintTable(); });
  paintTable();

  clear(main,
    hasDemo ? h('div.notice.warn.row.between',
      h('span', 'Showing sample data mixed with your own. Demo data is never included in reports.'),
      h('button.btn.sm', { onclick: () => openOptions('overview') }, 'Remove demo data')) : null,
    !values.enabled ? h('div.notice.warn', 'Tracking is paused. New activity is not being recorded.') : null,
    h('div.dash-title-row',
      h('h1', { style: { margin: 0 } }, 'SaaS usage'),
      h('span.muted', `${formatDay(sum.range.start, { dateStyle: 'medium' })} – ${formatDay(sum.range.end, { dateStyle: 'medium' })}`)),
    statCards(sum, unused, values),
    h('div.grid-2',
      h('div.card.chart-card', h('h2', 'Daily activity', h('span.small.muted', 'active time per day')), dailyChart(sum.daily)),
      h('div.card.chart-card', h('h2', 'By category', h('span.small.muted', `${sum.byCategory.length} categories`)), categoryBars(sum.byCategory))),
    h('div.card',
      h('h2', 'Top apps'),
      h('div.filters', q, cat, st),
      tableHost,
      locked ? h('p.small.muted', 'Approval status is managed by your IT department.') : null),
    h('div.grid-2',
      h('div.card', h('h2', 'Unused licences'), unusedList(unused, values, { trackingSince: since })),
      h('div.card', h('h2', 'Unapproved apps used'), unapprovedList(sum.apps))),
  );
}

function exportCSV() {
  if (!latest || !latest.sum.apps.length) return toast('Nothing to export yet.', { error: true });
  const { sum } = latest;
  const rows = [['App', 'App ID', 'Category', 'Status', 'Active minutes', 'Visits', 'Days used', 'Last used', 'Period start', 'Period end'],
    ...sum.apps.map((a) => [a.name, a.appId, a.category, STATUS_LABEL[a.status], Math.round(a.seconds / 60), a.visits, a.days,
      a.lastUsed ? `${a.lastUsed} (${lastUsedLabel(a.lastUsed)})` : '', sum.range.start, sum.range.end])];
  download(`saas-usage-${sum.range.start}-to-${sum.range.end}.csv`, `﻿${toCSV(rows)}`, 'text/csv');
}

const brand = await brandPage(BASE, { titleSuffix: 'Dashboard' });
document.body.append(header, main, footer);
paintHeader(brand);
onBrandChange(async () => paintHeader(await loadBrand()));
await send({ type: 'saas:flush' });
await render();

const rerender = debounce(render, 400);
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (KEYS.usage in changes || KEYS.demo in changes || 'settings' in changes)) rerender();
});
// Keep the current session's time fresh while the page is open.
setInterval(() => { if (document.visibilityState === 'visible') send({ type: 'saas:flush' }); }, 60000);

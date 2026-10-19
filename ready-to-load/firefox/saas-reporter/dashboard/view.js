// Dashboard building blocks, shared by the dashboard page and the Overview settings panel.
import { h } from '/shared/ui.js';
import {
  STATUS_LABEL, STATUS_BADGE, formatDuration, formatMoney, formatDay, lastUsedLabel, parseDay,
} from '../lib.js';

// ---- Tooltip -------------------------------------------------------------------------------
let tip = null;
function showTip(e, lines) {
  if (!tip) document.body.append((tip = h('div.saas-tip', { role: 'tooltip' })));
  tip.replaceChildren(...lines.map((l, i) => h('div', i === 0 ? { style: { fontWeight: 650 } } : {}, l)));
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 12;
  let y = e.clientY - r.height - 10;
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 12;
  if (y < 8) y = e.clientY + 16;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
function hideTip() {
  if (tip) tip.style.display = 'none';
}
const withTip = (el, lines) => {
  el.addEventListener('mousemove', (e) => showTip(e, lines));
  el.addEventListener('mouseleave', hideTip);
  el.setAttribute('aria-label', lines.join(', '));
  return el;
};

// ---- Small pieces --------------------------------------------------------------------------

export function statusBadge(status) {
  return h('span.badge', { class: STATUS_BADGE[status] || '' }, STATUS_LABEL[status] || status);
}

export function appDot(name) {
  return h('span.app-dot', { 'aria-hidden': 'true' }, (name || '?').replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || '?');
}

export function statusSelect(appId, status, onStatus, disabled) {
  const sel = h('select.status-select', { disabled, 'aria-label': 'Approval status', title: disabled ? 'Managed by your IT department' : 'Change approval status' },
    ['approved', 'neutral', 'unapproved'].map((s) => h('option', { value: s, selected: s === status }, STATUS_LABEL[s])));
  sel.addEventListener('change', () => onStatus(appId, sel.value));
  return sel;
}

function stat(label, value, note, cls = '') {
  return h('div.card.stat', h('div.stat-label', label), h('div.stat-value', { class: cls }, value), note ? h('div.stat-note', note) : null);
}

// ---- Stat cards ----------------------------------------------------------------------------

export function statCards(sum, unused, values) {
  const unapproved = sum.apps.filter((a) => a.status === 'unapproved');
  const wasted = unused.reduce((s, u) => s + (Number(u.licence.costPerMonth) || 0), 0);
  return h('div.stats',
    stat('Apps used', String(sum.apps.length), `in the last ${sum.range.days} days`),
    stat('Active time', formatDuration(sum.totalSeconds), `${sum.totalVisits} visits`),
    stat('Unapproved apps used', String(unapproved.length),
      unapproved.length ? formatDuration(unapproved.reduce((s, a) => s + a.seconds, 0)) + ' spent in them' : 'Nothing flagged',
      unapproved.length ? 'danger' : ''),
    stat('Unused licences', String(unused.length),
      wasted ? `${formatMoney(wasted, values.currency)} / month` : (values.licences || []).length ? `of ${(values.licences || []).length} licences` : 'No licences added yet',
      unused.length ? 'warn' : ''));
}

// ---- Daily column chart --------------------------------------------------------------------

function niceMax(v) {
  if (v <= 0) return 3600;
  const hours = v / 3600;
  const steps = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24];
  const step = steps.find((s) => s >= hours) || Math.ceil(hours);
  return step * 3600;
}

export function dailyChart(daily) {
  const max = niceMax(Math.max(...daily.map((d) => d.seconds), 0));
  const grid = [1, 0.5, 0].map((f) => h('div.gridline', { style: { bottom: `${f * 100}%` } },
    h('span', f ? formatDuration(max * f, { short: max * f >= 3600 }) : '0')));
  const cols = daily.map((d) => {
    const dow = parseDay(d.day).getDay();
    const pct = d.seconds ? Math.max(1.5, (d.seconds / max) * 100) : 0;
    const col = h('div.col', { class: [d.seconds ? '' : 'zero', dow === 0 || dow === 6 ? 'weekend' : ''].filter(Boolean).join(' ') },
      h('div.bar', { style: { height: `${pct}%` } }));
    return withTip(col, [formatDay(d.day, { weekday: 'short', month: 'short', day: 'numeric' }),
      d.seconds ? `${formatDuration(d.seconds)} active` : 'No activity', d.apps ? `${d.apps} app${d.apps === 1 ? '' : 's'}` : '']
      .filter(Boolean));
  });
  const mid = daily[Math.floor(daily.length / 2)];
  return h('div',
    h('div.cols', { role: 'img', 'aria-label': 'Active time per day' }, grid, cols),
    h('div.cols-axis', h('span', formatDay(daily[0]?.day)), h('span', formatDay(mid?.day)), h('span', formatDay(daily[daily.length - 1]?.day))));
}

// ---- Category bars -------------------------------------------------------------------------

export function categoryBars(byCategory, limit = 8) {
  if (!byCategory.length) return h('div.empty', 'No categories yet.');
  let rows = byCategory;
  if (rows.length > limit) {
    const rest = rows.slice(limit - 1);
    rows = [...rows.slice(0, limit - 1), {
      category: `${rest.length} more categories`, seconds: rest.reduce((s, c) => s + c.seconds, 0), apps: rest.reduce((s, c) => s + c.apps, 0),
    }];
  }
  const max = Math.max(...rows.map((c) => c.seconds), 1);
  const total = byCategory.reduce((s, c) => s + c.seconds, 0) || 1;
  return h('div.hbars', rows.map((c) => withTip(h('div.hbar',
    h('div.hbar-label', c.category),
    h('div.hbar-track', h('div.hbar-fill', { style: { width: `${Math.max(1, (c.seconds / max) * 100)}%` } })),
    h('div.hbar-value', formatDuration(c.seconds))),
  [c.category, `${formatDuration(c.seconds)} (${Math.round((c.seconds / total) * 100)}%)`, `${c.apps} app${c.apps === 1 ? '' : 's'}`])));
}

// ---- Apps table ----------------------------------------------------------------------------

/**
 * @param {Array} apps        summarize().apps
 * @param {object} o          { onStatus(appId, status), locked, limit }
 */
export function appsTable(apps, { onStatus, locked = false, limit = 0, compact = false } = {}) {
  const rows = limit ? apps.slice(0, limit) : apps;
  return h('div.table-wrap', h('table.table',
    h('thead', h('tr',
      h('th', 'App'), compact ? null : h('th', 'Category'), h('th.num', 'Time'), h('th.num', 'Visits'),
      compact ? null : h('th', 'Last used'), h('th', 'Status'))),
    h('tbody', rows.map((a) => h('tr',
      h('td', h('div.app-cell', appDot(a.name), h('div', h('div.app-name', a.name), compact ? h('div.sub', a.category) : null))),
      compact ? null : h('td', a.category),
      h('td.num', formatDuration(a.seconds)),
      h('td.num', String(a.visits)),
      compact ? null : h('td', lastUsedLabel(a.lastUsed)),
      h('td', onStatus ? statusSelect(a.appId, a.status, onStatus, locked) : statusBadge(a.status)))))));
}

// ---- Lists ---------------------------------------------------------------------------------

export function unusedList(unused, values, { trackingSince } = {}) {
  if (!(values.licences || []).length) {
    return h('div.empty', h('div.empty-title', 'No licences added'),
      'Add the paid apps your team has under Settings → Licences to spot seats nobody uses.');
  }
  if (!unused.length) return h('div.empty', h('div.empty-title', 'Every licence is in use'), `All licensed apps were used in the last ${values.unusedAfterDays} days.`);
  return h('div',
    h('ul.mini-list', unused.map((u) => h('li',
      appDot(u.app.name),
      h('div.grow', h('div.app-name', u.app.name),
        h('div.sub', [u.licence.seats ? `${u.licence.seats} seats` : null, u.licence.owner ? `Owner: ${u.licence.owner}` : null,
          u.lastUsed ? `last used ${lastUsedLabel(u.lastUsed).toLowerCase()}` : 'not used since tracking started'].filter(Boolean).join(' · '))),
      u.licence.costPerMonth ? h('span.badge.warn', `${formatMoney(u.licence.costPerMonth, values.currency)}/mo`) : null))),
    trackingSince ? h('p.small.muted', { style: { margin: '8px 0 0' } }, `Usage recorded since ${formatDay(trackingSince, { dateStyle: 'medium' })}.`) : null);
}

export function unapprovedList(apps) {
  const list = apps.filter((a) => a.status === 'unapproved');
  if (!list.length) return h('div.empty', h('div.empty-title', 'No unapproved apps used'), 'Apps marked "Not approved" will show up here when they are used.');
  return h('ul.mini-list', list.map((a) => h('li',
    appDot(a.name),
    h('div.grow', h('div.app-name', a.name), h('div.sub', `${a.category} · last used ${lastUsedLabel(a.lastUsed).toLowerCase()}`)),
    h('span.badge.danger', formatDuration(a.seconds)))));
}

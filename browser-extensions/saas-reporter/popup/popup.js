import { api, send } from '/shared/api.js';
import { mountPopup } from '/shared/app-shell.js';
import { h, add, clear, toggle, lockedBadge } from '/shared/ui.js';
import { settings } from '../settings.js';
import { KEYS, buildIndex, statusOf, dayKey, hostOf, formatDuration } from '../lib.js';
import { statusBadge } from '../dashboard/view.js';

const { body } = await mountPopup('SaaS Usage Reporter', { optionsHash: 'overview' });
const content = h('div');
body.append(content);

const openPage = (path) => {
  api.tabs.create({ url: api.runtime.getURL(path) });
  window.close();
};

async function render() {
  await send({ type: 'saas:flush' });
  const values = await settings.get();
  const index = buildIndex(values);
  const today = dayKey();
  const { [KEYS.usage]: usage = {}, [KEYS.demo]: demo = {} } = await api.storage.local.get([KEYS.usage, KEYS.demo]);
  const day = { ...(demo[today] || {}) };
  for (const [id, v] of Object.entries(usage[today] || {})) {
    day[id] = { seconds: (day[id]?.seconds || 0) + v.seconds, visits: (day[id]?.visits || 0) + v.visits };
  }

  // Current tab
  const [tab] = await api.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const host = tab?.url ? hostOf(tab.url) : '';
  const app = host ? index.match(host) : null;
  let now;
  if (app) {
    const status = statusOf(app.id, values);
    now = h('div.now-card',
      h('div.row.between', h('div', h('div', { style: { fontWeight: 650 } }, app.name), h('div.small.muted', app.category)), statusBadge(status)),
      h('div.row', { style: { marginTop: '8px', alignItems: 'baseline' } },
        h('span.now-time', formatDuration(day[app.id]?.seconds || 0)), h('span.small.muted', 'today')),
      status === 'unapproved' ? h('div.notice.danger.small', { style: { margin: '8px 0 0' } }, 'Your IT team has not approved this app. Check with them before sharing company data here.') : null);
  } else if (host) {
    const excluded = index.isExcluded(host.replace(/^www\./, ''));
    now = h('div.now-card',
      h('div.small.muted', excluded ? 'This site is excluded from tracking.' : 'This site is not a recognised SaaS app, so it is not recorded.'),
      excluded ? null : h('a.small', { href: '#', onclick: (e) => { e.preventDefault(); openPage(`options/options.html?add=${encodeURIComponent(host.replace(/^www\./, ''))}#apps`); } }, 'Add it as a custom app'));
  } else {
    now = h('div.now-card', h('div.small.muted', 'Open a SaaS app such as Slack or Google Docs to see its time here.'));
  }

  // Top 5 today
  const top = Object.entries(day).filter(([, v]) => v.seconds >= 1).sort((a, b) => b[1].seconds - a[1].seconds).slice(0, 5);
  const max = top[0]?.[1].seconds || 1;
  const total = Object.values(day).reduce((s, v) => s + v.seconds, 0);

  const pauseLocked = settings.isLocked('enabled');
  clear(content,
    now,
    h('div.row.between', h('div.section-label', 'Top apps today'), total ? h('div.small.muted', formatDuration(total)) : null),
    top.length ? h('ul.pop-list', top.map(([id, v]) => h('li',
      h('span', index.get(id).name), h('span.muted', formatDuration(v.seconds)),
      h('div.track', h('div.fill', { style: { width: `${Math.max(3, (v.seconds / max) * 100)}%` } })))))
      : h('p.small.muted', values.enabled ? 'Nothing yet today. Time in known apps appears here within a minute.' : 'Tracking is paused.'),
    h('div.pause-row',
      h('div', h('div', { style: { fontWeight: 600 } }, values.enabled ? 'Tracking is on' : 'Tracking is paused'),
        h('div.small.muted', 'Domain and time only. Stored on this device.')),
      h('div.row', pauseLocked ? lockedBadge() : null,
        toggle(values.enabled, async (v) => { await settings.set({ enabled: v }); render(); }, { disabled: pauseLocked, label: 'Record SaaS usage' }))),
    h('button.btn.primary.block', { onclick: () => openPage('dashboard/dashboard.html') }, 'Open dashboard'));
}

add(content, h('div.muted.small', 'Loading…'));
await render();

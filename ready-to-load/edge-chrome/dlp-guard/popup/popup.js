import { api, isFirefox } from '/shared/api.js';
import { mountPopup, openOptions } from '/shared/app-shell.js';
import { h, add, clear, toast, formatDate, toggle, lockedBadge } from '/shared/ui.js';
import { settings } from '../settings.js';
import { normalize, Sites, BASE_NAME } from '../lib/config.js';

const PAUSE_MS = 15 * 60 * 1000;
const MODE_TEXT = {
  off: 'Not checked on this site.',
  monitor: 'Sensitive data is logged, not stopped.',
  warn: 'You are warned before sensitive data is pasted, dropped, sent or uploaded.',
  block: 'Sensitive data is blocked on this site.',
};
const MODE_BADGE = { off: '', monitor: 'primary', warn: 'warn', block: 'danger' };

const { body } = await mountPopup(BASE_NAME, { optionsHash: 'activity' });

async function currentTab() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

async function render() {
  const state = await settings.load();
  const values = normalize(state.values);
  const tab = await currentTab();
  const c = Sites.classify(tab?.url || '', values);
  const { pausedUntil = 0, incidents = [] } = await api.storage.local.get(['pausedUntil', 'incidents']);
  const paused = values.allowPause && pausedUntil > Date.now();
  const locked = (k) => state.locked.has(k);

  // ---- this site
  const site = h('div.card.flat.dlp-site');
  if (c.reason === 'unsupported') {
    add(site, h('div.dlp-site-host', 'Browser page'), h('p.small.muted', { style: { margin: 0 } }, 'Browser and extension pages are not checked.'));
  } else {
    const head = h('div.row.between', h('div.dlp-site-host', c.host || 'This site'));
    if (c.reason === 'disabled') head.append(h('span.badge', 'Off'));
    else if (c.reason === 'approved') head.append(h('span.badge.ok', '✓ Approved'));
    else head.append(h(`span.badge.${MODE_BADGE[c.mode] || 'primary'}`, Sites.MODE_LABELS[c.mode].replace(/ \(.*\)/, '')));
    add(site, head);

    if (c.reason === 'disabled') {
      add(site, h('p.small.muted', 'Protection is turned off.'),
        h('button.btn.primary.sm', {
          disabled: locked('enabled'),
          onclick: async () => { await settings.set({ enabled: true }); render(); },
        }, 'Turn protection on'));
    } else if (c.reason === 'approved') {
      add(site, h('p.small.muted', 'This site is approved. Nothing is checked here.'),
        !locked('approvedSites') ? h('button.btn.sm', {
          onclick: async () => {
            await settings.set({ approvedSites: values.approvedSites.filter((e) => e !== c.entry) });
            toast('Approval removed');
            render();
          },
        }, 'Remove approval') : h('p.small.muted', { style: { margin: 0 } }, 'Approved by your organisation.'));
    } else {
      add(site,
        h('div.small', h('b', c.label), ' · ', MODE_TEXT[c.mode]),
        paused ? h('div.notice.warn.small', { style: { margin: '10px 0 0' } }, `Protection is paused until ${formatDate(pausedUntil, { timeStyle: 'short' })}.`) : null,
        !locked('approvedSites') ? h('div.row', { style: { marginTop: '10px' } },
          h('button.btn.sm', {
            title: 'Add this site to the approved list. Nothing will be checked here.',
            onclick: async () => {
              const list = values.approvedSites.filter((e) => Sites.cleanEntry(e) !== c.host);
              await settings.set({ approvedSites: [...list, c.host] });
              toast(`${c.host} approved`);
              render();
            },
          }, '✓ Approve this site')) : null);
    }
  }

  // ---- today
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = incidents.filter((i) => i.time >= start.getTime());
  const count = (a) => today.filter((i) => i.action === a).length;
  const onSite = c.host ? today.filter((i) => i.domain === c.host).length : 0;
  const stats = h('div.dlp-mini-stats',
    [['Warned', count('warned'), 'warn'], ['Blocked', count('blocked'), 'danger'], ['Overridden', count('overridden'), 'primary'], ['Logged', count('logged'), '']]
      .map(([label, n, cls]) => h('div.dlp-mini', h('div.dlp-mini-value', { class: n ? cls : '' }, String(n)), h('div.dlp-mini-label', label))));

  // ---- pause
  let pauseRow = null;
  if (c.reason !== 'disabled') {
    if (values.allowPause) {
      pauseRow = h('div.row', { style: { marginTop: '12px' } },
        toggle(paused, async (on) => {
          if (on) await api.storage.local.set({ pausedUntil: Date.now() + PAUSE_MS });
          else await api.storage.local.remove('pausedUntil');
          toast(on ? 'Paused for 15 minutes' : 'Protection resumed');
          render();
        }, { label: 'Pause protection for 15 minutes' }),
        h('span.small', paused ? `Paused until ${formatDate(pausedUntil, { timeStyle: 'short' })}` : 'Pause protection for 15 minutes'));
    } else {
      pauseRow = h('p.small.muted', { style: { marginTop: '12px' } }, lockedBadge(), ' Pausing is turned off by your IT department.');
    }
  }

  // ---- Firefox: content scripts need the "all sites" permission
  let permNotice = null;
  if (isFirefox) {
    let ok = true;
    try { ok = await api.permissions.contains({ origins: ['https://*/*', 'http://*/*'] }); } catch { ok = true; }
    if (!ok) {
      permNotice = h('div.notice.warn.small',
        h('div', { style: { marginBottom: '6px' } }, 'Allow access to websites so sensitive data can be checked.'),
        h('button.btn.primary.sm', {
          onclick: async () => {
            const granted = await api.permissions.request({ origins: ['https://*/*', 'http://*/*'] }).catch(() => false);
            toast(granted ? 'Access granted. Reload open tabs.' : 'Access not granted', { error: !granted });
            render();
          },
        }, 'Allow on all websites'));
    }
  }

  clear(body,
    permNotice,
    site,
    h('div.row.between', { style: { margin: '12px 0 6px' } },
      h('b.small', 'Today'),
      c.host && c.reason !== 'unsupported' ? h('span.small.muted', `${onSite} on this site`) : null),
    stats,
    pauseRow,
    h('div.row', { style: { marginTop: '14px' } },
      h('button.btn.sm.grow', { onclick: () => openOptions('activity') }, 'View activity'),
      h('button.btn.sm.grow', { onclick: () => openOptions('test') }, 'Test detection')));
}

await render();

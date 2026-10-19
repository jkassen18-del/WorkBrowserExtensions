// Ticket Snap background: captures the active tab (popup buttons or Alt+Shift+S), collects
// diagnostics, stores them temporarily and opens the editor. Also pushes tickets on "Sync now".
import { api } from './shared/api.js';
import { startBackground, handleMessages } from './shared/background-kit.js';
import { push } from './shared/connections.js';
import { settings } from './settings.js';
import { shareRecord } from './lib/tickets.js';

const CAPTURE_PREFIX = 'capture:';
const CAPTURE_TTL = 24 * 60 * 60 * 1000;

startBackground({
  glyph: 'camera',
  settings,
  onSync: async (conn) => {
    const values = await settings.get();
    const { tickets = [] } = await api.storage.local.get('tickets');
    if (!tickets.length) return { ok: true, message: 'No tickets to send yet.' };
    const r = await push('ticket-snap', 'tickets', tickets.map((t) => shareRecord(t, values)), conn);
    if (!r.ok) return { ok: false, message: r.error };
    return { ok: true, message: `Sent ${tickets.length} ticket${tickets.length === 1 ? '' : 's'}.` };
  },
});

handleMessages({
  'ts:capture': (msg) => capture({ withScreenshot: msg.withScreenshot !== false }),
});

api.commands?.onCommand.addListener((command) => {
  if (command === 'capture-tab') capture({ withScreenshot: true });
});

api.runtime.onStartup?.addListener(() => cleanupCaptures());

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab;
  const [any] = await api.tabs.query({ active: true, currentWindow: true });
  return any;
}

async function capture({ withScreenshot }) {
  const tab = await activeTab();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  let image = null;
  let captureError = '';
  if (withScreenshot && tab) {
    try {
      image = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (e) {
      captureError = /permission|cannot|chrome:|about:|edge:/i.test(String(e.message))
        ? 'This page cannot be captured (browser pages and the extension store are protected). You can attach an image instead.'
        : `The screenshot failed: ${e.message}`;
    }
  }
  const diagnostics = await collectDiagnostics(tab);
  await cleanupCaptures();
  await api.storage.local.set({
    [CAPTURE_PREFIX + id]: { id, createdAt: Date.now(), image, captureError, diagnostics, tabId: tab?.id ?? null },
  });
  const opts = { url: api.runtime.getURL(`editor/editor.html?id=${id}`) };
  if (tab && typeof tab.index === 'number') {
    opts.index = tab.index + 1;
    opts.windowId = tab.windowId;
  }
  await api.tabs.create(opts);
  return { ok: true, id, captureError };
}

async function cleanupCaptures() {
  const all = await api.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith(CAPTURE_PREFIX) && Date.now() - (all[k]?.createdAt || 0) > CAPTURE_TTL);
  if (stale.length) await api.storage.local.remove(stale);
}

// Runs inside the captured page (no extension APIs available there).
function pageProbe() {
  const failed = [];
  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (e.responseStatus >= 400 && !/\/favicon\.ico(\?|$)/.test(e.name)) failed.push(`${e.responseStatus} ${e.name}`);
    }
  } catch { /* not supported */ }
  let loadMs = null;
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav && nav.loadEventEnd > 0) loadMs = Math.round(nav.loadEventEnd);
  } catch { /* not supported */ }
  return {
    url: location.href,
    title: document.title,
    referrer: document.referrer,
    pageLanguage: document.documentElement.lang || '',
    language: navigator.language,
    languages: (navigator.languages || []).join(', '),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: `${screen.width} × ${screen.height}`,
    viewport: `${innerWidth} × ${innerHeight}`,
    dpr: window.devicePixelRatio,
    online: navigator.onLine,
    cookies: navigator.cookieEnabled,
    zoom: Math.round((outerWidth / innerWidth) * 100) || null,
    loadMs,
    failed: failed.slice(-15),
  };
}

async function browserInfo() {
  const out = { name: '', version: '', os: '', ua: navigator.userAgent };
  try {
    if (api.runtime.getBrowserInfo) {
      const b = await api.runtime.getBrowserInfo();
      out.name = b.name;
      out.version = b.version;
    } else if (navigator.userAgentData) {
      const hi = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion']);
      const brands = (hi.fullVersionList || navigator.userAgentData.brands || []).filter((x) => !/not.?a.?brand/i.test(x.brand));
      const pick = brands.find((x) => /Edge/i.test(x.brand)) || brands.find((x) => /Chrome/i.test(x.brand) && !/Chromium/i.test(x.brand)) || brands[0];
      if (pick) {
        out.name = pick.brand === 'Microsoft Edge' ? 'Microsoft Edge' : pick.brand;
        out.version = pick.version;
      }
      out.platformVersion = hi.platformVersion || '';
      out.platform = navigator.userAgentData.platform || '';
    }
  } catch { /* fall back to the user agent */ }
  if (!out.name) {
    const m = /(Edg|Firefox|Chrome|Safari)\/([\d.]+)/.exec(navigator.userAgent);
    if (m) {
      out.name = { Edg: 'Microsoft Edge', Firefox: 'Firefox', Chrome: 'Chrome', Safari: 'Safari' }[m[1]];
      out.version = m[2];
    }
  }
  try {
    const p = await api.runtime.getPlatformInfo();
    const names = { win: 'Windows', mac: 'macOS', linux: 'Linux', cros: 'ChromeOS', android: 'Android', openbsd: 'OpenBSD', fuchsia: 'Fuchsia' };
    out.os = `${names[p.os] || p.os}${out.platformVersion ? ` ${out.platformVersion}` : ''} (${p.arch})`;
  } catch {
    out.os = out.platform || '';
  }
  return out;
}

async function collectDiagnostics(tab) {
  let page = null;
  if (tab?.id != null && api.scripting) {
    try {
      const [res] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: pageProbe });
      page = res?.result || null;
    } catch { /* restricted page: fall back to what the tab tells us */ }
  }
  const b = await browserInfo();
  const rows = [];
  const add = (key, label, value) => {
    if (value === '' || value == null) return;
    rows.push({ key, label, value });
  };
  add('url', 'Page URL', page?.url || tab?.url || '');
  add('title', 'Page title', page?.title || tab?.title || '');
  add('referrer', 'Referrer', page?.referrer || '');
  add('timestamp', 'Captured at', new Date().toISOString());
  add('browser', 'Browser', [b.name, b.version].filter(Boolean).join(' '));
  add('os', 'Operating system', b.os);
  add('language', 'Language', page?.languages || page?.language || navigator.language);
  add('pageLanguage', 'Page language', page?.pageLanguage || '');
  add('timezone', 'Time zone', page?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  add('screen', 'Screen size', page?.screen || '');
  add('viewport', 'Viewport', page ? `${page.viewport} @ ${page.dpr}x pixel ratio` : '');
  if (page?.zoom && page.zoom !== 100 && page.zoom > 25 && page.zoom < 500) add('zoom', 'Approx. page zoom', `${page.zoom}%`);
  add('online', 'Online', page ? (page.online ? 'Yes' : 'No') : (navigator.onLine ? 'Yes' : 'No'));
  add('cookies', 'Cookies enabled', page ? (page.cookies ? 'Yes' : 'No') : '');
  add('loadMs', 'Page load time', page?.loadMs != null ? `${(page.loadMs / 1000).toFixed(2)} s` : '');
  if (page?.failed?.length) add('failedRequests', 'Failed requests (HTTP ≥ 400)', page.failed);
  add('userAgent', 'User agent', b.ua);
  if (!page && tab) add('note', 'Note', 'Page details were not available for this page (browser pages are protected).');
  return rows;
}

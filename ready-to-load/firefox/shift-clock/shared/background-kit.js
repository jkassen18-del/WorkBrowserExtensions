// Common background (service worker / event page) wiring for every extension:
// brand-coloured toolbar icon, welcome page on first install, brand/settings lookups for
// content scripts, and optional scheduled sync with a linked backend.
import { api } from './api.js';
import { loadBrand, onBrandChange } from './brand.js';
import { setActionIcon } from './icon.js';
import { getConnection, isConnected } from './connections.js';

const handlers = new Map();
let listening = false;

/**
 * Registers async message handlers by `type`. Works in Chrome and Firefox
 * (uses sendResponse + `return true`, which both support).
 *   handleMessages({ 'my:type': async (msg, sender) => result })
 */
export function handleMessages(map) {
  for (const [type, fn] of Object.entries(map)) handlers.set(type, fn);
  if (listening) return;
  listening = true;
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const fn = msg && handlers.get(msg.type);
    if (!fn) return false;
    Promise.resolve()
      .then(() => fn(msg, sender))
      .then((result) => sendResponse(result), (err) => sendResponse({ error: String(err?.message || err) }));
    return true;
  });
}

/**
 * @param {object} o
 * @param {string} o.glyph         icon glyph name (see shared/icon.js)
 * @param {object} o.settings      createSettings() instance
 * @param {Function} [o.onSync]    async () => result; called by "Sync now" and the hourly sync when a backend is linked
 * @param {string|false} [o.welcome] page opened on first install (false to skip)
 */
export function startBackground({ glyph, settings, onSync, welcome = 'options/options.html#welcome' }) {
  const paintIcon = async () => setActionIcon(api, glyph, await loadBrand());
  paintIcon();
  onBrandChange(paintIcon);

  api.runtime.onInstalled.addListener(({ reason }) => {
    paintIcon();
    if (reason === 'install' && welcome) api.tabs.create({ url: api.runtime.getURL(welcome) });
    scheduleSync();
  });
  api.runtime.onStartup?.addListener(() => {
    paintIcon();
    scheduleSync();
  });

  handleMessages({
    'wx:getBrand': () => loadBrand(),
    'wx:getSettings': () => settings.get(),
    'wx:sync': () => runSync(),
  });

  async function runSync() {
    const conn = await getConnection();
    if (!isConnected(conn)) return { ok: true, skipped: true, message: 'Local only. Nothing to sync.' };
    if (!onSync) return { ok: true, skipped: true, message: 'Nothing to sync for this extension.' };
    try {
      const result = (await onSync(conn)) || {};
      const status = { at: Date.now(), ok: result.ok !== false, message: result.message || 'Synced.' };
      await api.storage.local.set({ syncStatus: status });
      return status;
    } catch (e) {
      const status = { at: Date.now(), ok: false, message: String(e.message || e) };
      await api.storage.local.set({ syncStatus: status });
      return status;
    }
  }

  async function scheduleSync() {
    if (!api.alarms) return;
    const conn = await getConnection();
    if (isConnected(conn) && conn.autoSync && onSync) api.alarms.create('wx-sync', { periodInMinutes: 60, delayInMinutes: 1 });
    else api.alarms.clear('wx-sync');
  }

  api.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === 'wx-sync') runSync();
  });
  api.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' && 'connection' in changes) || area === 'managed') scheduleSync();
  });

  return { runSync };
}

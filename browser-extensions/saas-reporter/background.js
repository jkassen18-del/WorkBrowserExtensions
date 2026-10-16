// SaaS Usage Reporter background: measures foreground time per known SaaS app (by domain only).
//
// Model: at most one app is "active" at a time, which is the app of the active tab in the focused
// browser window while the user is not idle. Its start time lives in storage.session (or
// storage.local where session storage is missing), so the time survives the service worker being
// stopped. Every event and a one-minute alarm commit the elapsed time into daily totals:
//   usage[YYYY-MM-DD][appId] = { seconds, visits }
import { api } from './shared/api.js';
import { startBackground, handleMessages } from './shared/background-kit.js';
import { getConnection, isConnected, push } from './shared/connections.js';
import { settings } from './settings.js';
import {
  KEYS, VISIT_GAP_MS, DAY_MS, dayKey, addDays, buildIndex, buildReport, getInstallId, loadUsage,
} from './lib.js';

const TICK = 'saas-tick';
const STATE_KEY = 'saasTrackState';
const MAX_SPAN_MS = 5 * 60 * 1000; // longest stretch committed at once (longer gaps = computer asleep)
const sessionStore = api.storage.session ?? api.storage.local;

// ---- Serialise all work so read-modify-write on storage never interleaves ----------------
let chain = Promise.resolve();
const run = (fn) => (chain = chain.then(fn).catch((e) => console.warn('[saas-reporter]', e)));

let indexCache = null;
async function getIndex() {
  if (!indexCache) indexCache = buildIndex(await settings.get());
  return indexCache;
}

async function loadState() {
  const { [STATE_KEY]: st } = await sessionStore.get(STATE_KEY);
  return { appId: null, tabId: null, since: 0, lastActive: {}, tabApps: {}, ...(st || {}) };
}
const saveState = (st) => sessionStore.set({ [STATE_KEY]: st });

/** Adds active seconds between from and to (ms), split across local midnights, plus visits on `to`'s day. */
async function addUsage(appId, from, to, visits = 0) {
  if (!appId || (to <= from && !visits)) return;
  const { [KEYS.usage]: usage = {} } = await api.storage.local.get(KEYS.usage);
  let t = from;
  while (t < to) {
    const d = new Date(t);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const end = Math.min(to, next);
    const day = (usage[dayKey(d)] ||= {});
    const e = (day[appId] ||= { seconds: 0, visits: 0 });
    e.seconds = Math.round((e.seconds + (end - t) / 1000) * 10) / 10;
    t = end;
  }
  if (visits) {
    const day = (usage[dayKey(new Date(to))] ||= {});
    const e = (day[appId] ||= { seconds: 0, visits: 0 });
    e.visits += visits;
  }
  await api.storage.local.set({ [KEYS.usage]: usage });
}

/** Which app (if any) is in front of the user right now. */
async function currentTarget(values) {
  if (!values.enabled) return { appId: null, tabId: null, why: 'paused' };
  try {
    const idle = await api.idle.queryState(Math.max(15, Number(values.idleSeconds) || 120));
    if (idle !== 'active') return { appId: null, tabId: null, why: 'idle' };
  } catch { /* idle API unavailable: assume active */ }
  const win = await api.windows.getLastFocused({}).catch(() => null);
  if (!win || !win.focused) return { appId: null, tabId: null, why: 'unfocused' };
  const [tab] = await api.tabs.query({ active: true, windowId: win.id });
  if (!tab) return { appId: null, tabId: null, why: 'no-tab' };
  const app = tab.url ? (await getIndex()).match(tab.url) : null;
  return { appId: app?.id || null, tabId: tab.id, why: app ? 'app' : 'other' };
}

/**
 * Commits the running stretch and switches to whatever is in front now.
 * @param {string} reason  'tick' | 'switch' | 'nav' | 'focus' | 'idle' | 'settings' | 'flush'
 * @param {number} [navTabId] tab that just navigated (reason 'nav')
 */
async function evaluate(reason, navTabId) {
  const values = await settings.get();
  const now = Date.now();
  const st = await loadState();
  const target = await currentTarget(values);

  // 1. Commit time for the app that was active.
  if (st.appId && st.since) {
    let end = now;
    if (target.why === 'idle') end = Math.max(st.since, now - Math.max(15, Number(values.idleSeconds) || 120) * 1000);
    end = Math.min(end, st.since + MAX_SPAN_MS);
    await addUsage(st.appId, st.since, end);
    st.lastActive[st.appId] = end;
  }

  // 2. Count a visit when an app comes to the front after a 30 minute break, or on navigation into it.
  if (target.appId) {
    const prevTabApp = target.tabId != null ? st.tabApps[target.tabId] : undefined;
    const navigatedIn = reason === 'nav' && navTabId === target.tabId && prevTabApp !== target.appId;
    const cameBack = target.appId !== st.appId && now - (st.lastActive[target.appId] || 0) > VISIT_GAP_MS;
    if (navigatedIn || cameBack) await addUsage(target.appId, now, now, 1);
    st.lastActive[target.appId] = now;
  }
  if (target.tabId != null) st.tabApps[target.tabId] = target.appId;

  // 3. Keep the state small.
  for (const [id, t] of Object.entries(st.lastActive)) if (now - t > DAY_MS) delete st.lastActive[id];
  const tabIds = Object.keys(st.tabApps);
  if (tabIds.length > 200) for (const id of tabIds.slice(0, tabIds.length - 200)) delete st.tabApps[id];

  st.appId = target.appId;
  st.tabId = target.tabId;
  st.since = target.appId ? now : 0;
  await saveState(st);
  return { appId: st.appId, since: st.since, enabled: !!values.enabled, why: target.why };
}

// ---- Housekeeping -------------------------------------------------------------------------

async function prune() {
  const values = await settings.get();
  const keep = Math.max(1, Number(values.retentionDays) || 90);
  const cutoff = addDays(dayKey(), -keep + 1);
  const { [KEYS.usage]: usage = {} } = await api.storage.local.get(KEYS.usage);
  let changed = false;
  for (const day of Object.keys(usage)) {
    if (day < cutoff) {
      delete usage[day];
      changed = true;
    }
  }
  if (changed) await api.storage.local.set({ [KEYS.usage]: usage });
  await sessionStore.set({ saasLastPrune: dayKey() });
}

async function ensureSetup() {
  const got = await api.storage.local.get([KEYS.since]);
  if (!got[KEYS.since]) await api.storage.local.set({ [KEYS.since]: dayKey() });
  await getInstallId();
  const existing = await api.alarms.get(TICK).catch(() => null);
  if (!existing) api.alarms.create(TICK, { periodInMinutes: 1, delayInMinutes: 1 });
  const values = await settings.get();
  try { api.idle.setDetectionInterval(Math.max(15, Number(values.idleSeconds) || 120)); } catch { /* not supported */ }
}

// ---- Reporting (opt-in, only when a backend is linked) ------------------------------------

async function logReport(entry) {
  const { [KEYS.reportLog]: log = [] } = await api.storage.local.get(KEYS.reportLog);
  log.unshift(entry);
  await api.storage.local.set({ [KEYS.reportLog]: log.slice(0, 20) });
}

async function sendReport({ force = false } = {}) {
  const values = await settings.get();
  if (!values.reportingEnabled) return { ok: false, skipped: true, message: 'Reporting is turned off. Turn it on under Reporting first.' };
  const conn = await getConnection();
  if (!isConnected(conn)) return { ok: false, skipped: true, message: 'No shared-data backend is linked. Link one under Shared data first.' };
  const periodMs = Math.max(1, Number(values.reportPeriodDays) || 7) * DAY_MS;
  const { [KEYS.lastReportAt]: last = 0 } = await api.storage.local.get(KEYS.lastReportAt);
  if (!force && last && Date.now() - last < periodMs) return { ok: true, skipped: true, message: 'Report already sent for this period.' };
  const { usage } = await loadUsage({ includeDemo: false });
  const report = buildReport(usage, await getIndex(), values, await getInstallId());
  const res = await push('saas-reporter', 'reports', report, conn);
  const entry = { at: Date.now(), ok: res.ok, periodStart: report.periodStart, periodEnd: report.periodEnd, apps: report.apps.length, error: res.error || '' };
  await logReport(entry);
  if (res.ok) await api.storage.local.set({ [KEYS.lastReportAt]: Date.now() });
  return { ok: res.ok, message: res.ok ? `Report sent (${report.apps.length} apps, ${report.periodStart} to ${report.periodEnd}).` : `Report failed: ${res.error}` };
}

// ---- Wiring --------------------------------------------------------------------------------

startBackground({
  glyph: 'bars',
  settings,
  onSync: async () => {
    await run(() => evaluate('flush'));
    const r = await sendReport();
    return { ok: r.ok || r.skipped, message: r.message };
  },
});

handleMessages({
  'saas:flush': () => run(() => evaluate('flush')),
  'saas:sendReport': async () => {
    await run(() => evaluate('flush'));
    return sendReport({ force: true });
  },
});

api.runtime.onInstalled.addListener(() => run(async () => { await ensureSetup(); await evaluate('switch'); }));
api.runtime.onStartup?.addListener(() => run(async () => { await ensureSetup(); await evaluate('switch'); }));

api.tabs.onActivated.addListener(() => run(() => evaluate('switch')));
api.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.active) return;
  if (info.url) run(() => evaluate('nav', tabId));
  else if (info.status === 'complete') run(() => evaluate('switch'));
});
api.tabs.onRemoved.addListener((tabId) => run(async () => {
  const st = await loadState();
  if (tabId in st.tabApps) {
    delete st.tabApps[tabId];
    await saveState(st);
  }
}));
api.windows.onFocusChanged.addListener(() => run(() => evaluate('focus')));
api.idle?.onStateChanged.addListener(() => run(() => evaluate('idle')));

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK) return;
  run(async () => {
    await evaluate('tick');
    const { saasLastPrune } = await sessionStore.get('saasLastPrune');
    if (saasLastPrune !== dayKey()) await prune();
  });
  // Automatic report once per period, only when the user opted in and a backend is linked.
  run(async () => {
    const values = await settings.get();
    if (values.reportingEnabled && isConnected(await getConnection())) await sendReport();
  });
});

settings.onChange((values) => {
  indexCache = buildIndex(values);
  try { api.idle.setDetectionInterval(Math.max(15, Number(values.idleSeconds) || 120)); } catch { /* not supported */ }
  run(() => evaluate('settings'));
});

// The worker may have been restarted: make sure the minute alarm exists.
run(ensureSetup);

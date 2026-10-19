// Data Leak Guard background: hands the content script its settings, stores incidents
// (metadata only) and, when the user opted in, reports them to the linked backend.
import { api, uid, isFirefox } from './shared/api.js';
import { startBackground, handleMessages } from './shared/background-kit.js';
import { loadBrand, productName } from './shared/brand.js';
import { push, getConnection, isConnected } from './shared/connections.js';
import { settings } from './settings.js';
import { normalize, reportRecord, BASE_NAME } from './lib/config.js';

const KEY = 'incidents';
const ACTIONS = new Set(['logged', 'warned', 'overridden', 'blocked']);
const CHANNELS = new Set(['paste', 'drop', 'upload', 'submit', 'send']);

// Serialise read-modify-write access to the incident list.
let queue = Promise.resolve();
const serial = (fn) => {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
};

async function readIncidents() {
  const { [KEY]: list = [] } = await api.storage.local.get(KEY);
  return Array.isArray(list) ? list : [];
}

/** Keeps only metadata. Matched text never reaches storage. */
function sanitize(raw, sender) {
  const s = (v, n = 200) => String(v ?? '').slice(0, n);
  const detectors = (Array.isArray(raw?.detectors) ? raw.detectors : []).slice(0, 30).map((d) => ({
    id: s(d.id, 80),
    label: s(d.label, 120),
    count: Math.max(0, Math.min(100000, Number(d.count) || 0)),
    kinds: (Array.isArray(d.kinds) ? d.kinds : []).slice(0, 12).map((k) => s(k, 60)),
  }));
  let domain = s(raw?.domain, 255).toLowerCase();
  if (!domain && sender?.tab?.url) {
    try { domain = new URL(sender.tab.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  }
  return {
    id: uid('inc_'),
    time: Date.now(),
    domain,
    category: s(raw?.category, 20) || 'other',
    channel: CHANNELS.has(raw?.channel) ? raw.channel : 'paste',
    action: ACTIONS.has(raw?.action) ? raw.action : 'logged',
    mode: s(raw?.mode, 20),
    detectors,
    files: Math.max(0, Number(raw?.files) || 0),
    justification: s(raw?.justification, 500),
    browser: isFirefox ? 'firefox' : (/Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome'),
    synced: false,
  };
}

// Per-tab badge with the number of warnings/blocks on the current page.
const tabCounts = new Map();
function bumpBadge(tabId, action) {
  if (tabId == null || tabId < 0 || action === 'logged') return;
  const n = (tabCounts.get(tabId) || 0) + 1;
  tabCounts.set(tabId, n);
  try {
    api.action.setBadgeBackgroundColor?.({ tabId, color: action === 'blocked' ? '#DC2626' : '#D97706' });
    api.action.setBadgeText({ tabId, text: String(n) });
  } catch { /* tab gone */ }
}
api.tabs.onRemoved?.addListener((tabId) => tabCounts.delete(tabId));
api.tabs.onUpdated?.addListener((tabId, info) => {
  if (info.status === 'loading' && tabCounts.has(tabId)) {
    tabCounts.delete(tabId);
    try { api.action.setBadgeText({ tabId, text: '' }); } catch { /* ignore */ }
  }
});

async function addIncident(raw, sender) {
  const incident = sanitize(raw, sender);
  const values = normalize(await settings.get());
  const max = Math.max(10, Number(values.maxIncidents) || 500);
  await serial(async () => {
    const list = await readIncidents();
    list.push(incident);
    await api.storage.local.set({ [KEY]: list.length > max ? list.slice(-max) : list });
  });
  bumpBadge(sender?.tab?.id, incident.action);
  if (values.reportIncidents) reportPending().catch(() => {});
  return { ok: true, id: incident.id };
}

/** Pushes every incident not yet reported. Metadata only. */
async function reportPending(conn) {
  conn = conn || (await getConnection());
  if (!isConnected(conn)) return { ok: true, skipped: true, message: 'Local only. Nothing to send.' };
  const pending = (await readIncidents()).filter((i) => !i.synced);
  if (!pending.length) return { ok: true, message: 'All incidents already reported.' };
  const res = await push('dlp-guard', 'incidents', pending.map(reportRecord), conn);
  if (!res.ok) return { ok: false, message: res.error || 'Could not send incidents.' };
  const ids = new Set(pending.map((i) => i.id));
  await serial(async () => {
    const list = await readIncidents();
    for (const i of list) if (ids.has(i.id)) i.synced = true;
    await api.storage.local.set({ [KEY]: list });
  });
  return { ok: true, message: `Reported ${pending.length} incident${pending.length === 1 ? '' : 's'} (metadata only).` };
}

startBackground({
  glyph: 'shield',
  settings,
  onSync: async (conn) => {
    const values = await settings.get();
    if (!values.reportIncidents) return { ok: true, message: 'Incident reporting is off (Settings → Reporting). Nothing sent.' };
    return reportPending(conn);
  },
});

async function buildContext() {
  const values = normalize(await settings.get());
  const { pausedUntil = 0 } = await api.storage.local.get('pausedUntil');
  const brand = await loadBrand();
  return {
    settings: values,
    pausedUntil: values.allowPause && pausedUntil > Date.now() ? pausedUntil : 0,
    brand: {
      primary: brand.primary,
      accent: brand.accent,
      radius: brand.radius,
      companyName: brand.companyName,
      name: productName(brand, BASE_NAME),
      supportUrl: brand.supportUrl,
      supportEmail: brand.supportEmail,
    },
  };
}

// Snapshot the effective settings so content scripts can start checking instantly,
// before the background has woken up (they then ask for the live context).
async function writeSnapshot() {
  try {
    const { settings: s, brand } = await buildContext();
    await api.storage.local.set({ dlpSnapshot: { settings: s, brand, at: Date.now() } });
  } catch { /* ignore */ }
}
writeSnapshot();
// Also keeps the cached settings fresh when the options page or policy changes them.
settings.onChange(() => writeSnapshot());
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'brandOverride' in changes) writeSnapshot();
});

handleMessages({
  'dlp:context': async (msg, sender) => ({ ...(await buildContext()), tabUrl: sender?.tab?.url || '' }),
  'dlp:incident': (msg, sender) => addIncident(msg.incident, sender),
  'dlp:report': () => reportPending(),
});

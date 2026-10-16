// Shared logic for the background, dashboard, settings and popup. No DOM in here.
import { api } from './shared/api.js';
import { CATALOG, CATEGORIES } from './catalog.js';

export { CATALOG, CATEGORIES };

export const KEYS = {
  usage: 'usage', // { 'YYYY-MM-DD': { appId: { seconds, visits } } }   real tracking
  demo: 'demoUsage', // same shape, sample data (never reported)
  demoSeed: 'demoSeed', // { approvedApps, unapprovedApps, licences } added by the demo, removed with it
  installId: 'installId',
  since: 'trackingSince',
  reportLog: 'reportLog',
  lastReportAt: 'lastReportAt',
};

export const DAY_MS = 86400000;
export const VISIT_GAP_MS = 30 * 60 * 1000;

// ---- Dates (local time) -------------------------------------------------------------------

export function dayKey(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

export function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

/** Day keys from (today - n + 1) to today, oldest first. */
export function lastDays(n, today = dayKey()) {
  return Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
}

export function daysBetween(a, b) {
  return Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
}

// ---- Domains & matching ---------------------------------------------------------------------

/** "https://www.Example.com/path" -> "example.com". Returns '' when it is not a plausible domain. */
export function normalizeDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '').split(/[/?#:]/)[0].replace(/^www\./, '').replace(/\.$/, '');
  return /^([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(s) ? s : '';
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

/** Walks "a.b.c.com" -> "a.b.c.com", "b.c.com", "c.com" and returns the first hit in map. */
function lookup(map, host) {
  let h = host;
  while (h) {
    if (map.has(h)) return map.get(h);
    const i = h.indexOf('.');
    if (i < 0) return undefined;
    h = h.slice(i + 1);
  }
  return undefined;
}

export function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Builds the app index from the catalog plus custom apps.
 * Custom app domains take precedence over catalog domains.
 */
export function buildIndex(values = {}) {
  const custom = (values.customApps || [])
    .filter((a) => a && a.id && a.name)
    .map((a) => ({
      id: String(a.id),
      name: String(a.name),
      domains: (a.domains || []).map(normalizeDomain).filter(Boolean),
      category: CATEGORIES.includes(a.category) ? a.category : 'Other',
      custom: true,
    }));
  const apps = new Map();
  const domains = new Map();
  for (const app of [...CATALOG, ...custom]) {
    apps.set(app.id, app);
    for (const d of app.domains) domains.set(d, app.id);
  }
  const excluded = new Map((values.excludedDomains || []).map(normalizeDomain).filter(Boolean).map((d) => [d, true]));
  return {
    apps,
    list: [...apps.values()],
    get: (id) => apps.get(id) || { id, name: id, domains: [], category: 'Other', unknown: true },
    /** App for a host or URL, or null. Excluded domains never match. */
    match(hostOrUrl) {
      const host = hostOrUrl.includes('/') ? hostOf(hostOrUrl) : String(hostOrUrl).toLowerCase();
      if (!host) return null;
      if (lookup(excluded, host)) return null;
      const id = lookup(domains, host);
      return id ? apps.get(id) : null;
    },
    isExcluded: (host) => !!lookup(excluded, host),
  };
}

// ---- Status --------------------------------------------------------------------------------

export function statusOf(appId, values) {
  if ((values.unapprovedApps || []).includes(appId)) return 'unapproved';
  if ((values.approvedApps || []).includes(appId)) return 'approved';
  return 'neutral';
}

export const STATUS_LABEL = { approved: 'Approved', unapproved: 'Not approved', neutral: 'Neutral' };
export const STATUS_BADGE = { approved: 'ok', unapproved: 'danger', neutral: '' };

/** Returns the settings patch that gives appId the new status. */
export function statusPatch(appId, status, values) {
  const approved = (values.approvedApps || []).filter((x) => x !== appId);
  const unapproved = (values.unapprovedApps || []).filter((x) => x !== appId);
  if (status === 'approved') approved.push(appId);
  if (status === 'unapproved') unapproved.push(appId);
  return { approvedApps: approved, unapprovedApps: unapproved };
}

// ---- Storage -------------------------------------------------------------------------------

/** Usage with demo data merged in (demo only when includeDemo). */
export async function loadUsage({ includeDemo = true } = {}) {
  const got = await api.storage.local.get([KEYS.usage, KEYS.demo]);
  const real = got[KEYS.usage] || {};
  const demo = includeDemo ? got[KEYS.demo] || null : null;
  if (!demo) return { usage: real, hasDemo: !!got[KEYS.demo] };
  const merged = JSON.parse(JSON.stringify(real));
  for (const [day, apps] of Object.entries(demo)) {
    const d = (merged[day] ||= {});
    for (const [id, v] of Object.entries(apps)) {
      const e = (d[id] ||= { seconds: 0, visits: 0 });
      e.seconds += v.seconds || 0;
      e.visits += v.visits || 0;
    }
  }
  return { usage: merged, hasDemo: true };
}

export async function getInstallId() {
  const { [KEYS.installId]: id } = await api.storage.local.get(KEYS.installId);
  if (id) return id;
  const fresh = `anon-${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  await api.storage.local.set({ [KEYS.installId]: fresh });
  return fresh;
}

// ---- Aggregation ---------------------------------------------------------------------------

/**
 * Summarises usage over the last `days` days.
 * @returns {{ apps, byCategory, daily, totalSeconds, totalVisits, range }}
 */
export function summarize(usage, index, values, { days = 30, today = dayKey() } = {}) {
  const range = lastDays(days, today);
  const byApp = new Map();
  const lastUsed = lastUsedMap(usage);
  const daily = range.map((day) => ({ day, seconds: 0, apps: 0 }));
  for (const [i, day] of range.entries()) {
    for (const [id, v] of Object.entries(usage[day] || {})) {
      if (!v || (!v.seconds && !v.visits)) continue;
      const e = byApp.get(id) || { seconds: 0, visits: 0, days: 0 };
      e.seconds += v.seconds || 0;
      e.visits += v.visits || 0;
      e.days += 1;
      byApp.set(id, e);
      daily[i].seconds += v.seconds || 0;
      daily[i].apps += 1;
    }
  }
  const apps = [...byApp.entries()].map(([id, e]) => {
    const app = index.get(id);
    return {
      appId: id, name: app.name, category: app.category, custom: !!app.custom,
      seconds: Math.round(e.seconds), visits: e.visits, days: e.days,
      lastUsed: lastUsed[id] || null, status: statusOf(id, values),
    };
  }).sort((a, b) => b.seconds - a.seconds || b.visits - a.visits);
  const cats = new Map();
  for (const a of apps) {
    const c = cats.get(a.category) || { category: a.category, seconds: 0, apps: 0 };
    c.seconds += a.seconds;
    c.apps += 1;
    cats.set(a.category, c);
  }
  return {
    range: { start: range[0], end: range[range.length - 1], days },
    apps,
    byCategory: [...cats.values()].sort((a, b) => b.seconds - a.seconds),
    daily,
    totalSeconds: apps.reduce((s, a) => s + a.seconds, 0),
    totalVisits: apps.reduce((s, a) => s + a.visits, 0),
  };
}

/** { appId: 'YYYY-MM-DD' } latest day each app was used. */
export function lastUsedMap(usage) {
  const out = {};
  for (const day of Object.keys(usage).sort()) {
    for (const [id, v] of Object.entries(usage[day] || {})) if (v && (v.seconds > 0 || v.visits > 0)) out[id] = day;
  }
  return out;
}

/**
 * Licences whose app was not used within `unusedAfterDays`.
 * @returns [{ licence, app, lastUsed, idleDays }]
 */
export function unusedLicences(usage, index, values, today = dayKey()) {
  const last = lastUsedMap(usage);
  const limit = Number(values.unusedAfterDays) || 30;
  return (values.licences || []).map((l) => {
    const lu = last[l.appId] || null;
    const idleDays = lu ? daysBetween(lu, today) : null;
    return { licence: l, app: index.get(l.appId), lastUsed: lu, idleDays };
  }).filter((x) => x.lastUsed == null || x.idleDays >= limit);
}

// ---- Reporting -----------------------------------------------------------------------------

/** The exact anonymous record that "Send report" pushes. Real usage only (never demo data). */
export function buildReport(realUsage, index, values, installId, today = dayKey()) {
  const days = Math.max(1, Math.min(365, Number(values.reportPeriodDays) || 7));
  const s = summarize(realUsage, index, values, { days, today });
  return {
    id: `${installId}:${s.range.start}:${s.range.end}`,
    installId,
    periodStart: s.range.start,
    periodEnd: s.range.end,
    generatedAt: new Date().toISOString(),
    apps: s.apps.map((a) => ({ appId: a.appId, name: a.name, seconds: a.seconds, visits: a.visits, days: a.days })),
  };
}

// ---- Formatting ----------------------------------------------------------------------------

export function formatDuration(seconds, { short = false } = {}) {
  const s = Math.round(seconds || 0);
  if (s < 60) return s ? `${s}s` : '0m';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  const rem = m % 60;
  if (short || hrs >= 100) return `${hrs}h`;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}

export function formatMoney(amount, currency = 'USD') {
  if (amount == null || amount === '' || Number.isNaN(Number(amount))) return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(Number(amount));
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`;
  }
}

export function formatDay(key, opts = { month: 'short', day: 'numeric' }) {
  if (!key) return '';
  return new Intl.DateTimeFormat(undefined, opts).format(parseDay(key));
}

export function lastUsedLabel(key, today = dayKey()) {
  if (!key) return 'Never';
  const n = daysBetween(key, today);
  if (n <= 0) return 'Today';
  if (n === 1) return 'Yesterday';
  if (n < 14) return `${n} days ago`;
  return formatDay(key);
}

export function toCSV(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

// ---- Demo data -----------------------------------------------------------------------------

// [appId, average minutes on an active workday, chance of use on a workday, visits per active day]
const DEMO_APPS = [
  ['slack', 95, 0.97, 9], ['gmail', 55, 0.95, 7], ['google-docs', 70, 0.85, 5], ['google-calendar', 12, 0.9, 6],
  ['jira', 60, 0.85, 5], ['github', 75, 0.8, 6], ['figma', 50, 0.55, 3], ['notion', 35, 0.7, 4],
  ['zoom', 45, 0.75, 3], ['salesforce', 40, 0.45, 3], ['chatgpt', 25, 0.65, 4], ['claude', 30, 0.6, 3],
  ['miro', 25, 0.3, 2], ['asana', 18, 0.5, 3], ['google-drive', 15, 0.7, 4], ['canva', 20, 0.2, 2],
  ['linkedin', 12, 0.55, 3], ['docusign', 6, 0.15, 1], ['workday', 8, 0.1, 1], ['expensify', 10, 0.12, 1],
  ['loom', 9, 0.3, 2], ['wetransfer', 5, 0.12, 1], ['perplexity', 14, 0.35, 2], ['dropbox', 10, 0.2, 2],
];

/** Sample approvals and licences that make the demo dashboard meaningful. */
export const DEMO_SEED = {
  approvedApps: ['slack', 'gmail', 'google-docs', 'google-calendar', 'google-drive', 'jira', 'github', 'figma', 'zoom', 'salesforce', 'notion', 'docusign', 'workday'],
  unapprovedApps: ['wetransfer', 'perplexity', 'dropbox'],
  licences: [
    { id: 'demo-slack', appId: 'slack', seats: 50, costPerMonth: 437.5, owner: 'IT' },
    { id: 'demo-zoom', appId: 'zoom', seats: 25, costPerMonth: 349.75, owner: 'IT' },
    { id: 'demo-salesforce', appId: 'salesforce', seats: 10, costPerMonth: 1650, owner: 'Sales Ops' },
    { id: 'demo-adobe', appId: 'adobe-cc', seats: 5, costPerMonth: 299.95, owner: 'Marketing' },
    { id: 'demo-smartsheet', appId: 'smartsheet', seats: 10, costPerMonth: 90, owner: 'PMO' },
    { id: 'demo-miro', appId: 'miro', seats: 15, costPerMonth: 120, owner: 'Product' },
  ],
};

/** Deterministic pseudo-random sample usage for the last `days` days. */
export function generateDemo(days = 30, today = dayKey()) {
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out = {};
  for (const day of lastDays(days, today)) {
    const dow = parseDay(day).getDay();
    const weekend = dow === 0 || dow === 6;
    const apps = {};
    for (const [id, mins, chance, visits] of DEMO_APPS) {
      const p = weekend ? chance * 0.12 : chance;
      if (rnd() > p) continue;
      const factor = weekend ? 0.3 : 0.55 + rnd() * 0.9;
      const seconds = Math.max(30, Math.round(mins * 60 * factor));
      apps[id] = { seconds, visits: Math.max(1, Math.round(visits * (0.5 + rnd()))) };
    }
    if (Object.keys(apps).length) out[day] = apps;
  }
  return out;
}

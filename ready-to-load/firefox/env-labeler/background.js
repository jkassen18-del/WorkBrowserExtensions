// Environment Labeler background: matches URLs against the rules, paints the toolbar badge per tab,
// remembers per-tab "hide" and per-page "don't ask again", fetches remote rule files and syncs shared rules.
import { api } from './shared/api.js';
import { startBackground, handleMessages } from './shared/background-kit.js';
import { push, pull } from './shared/connections.js';
import { settings } from './settings.js';
import {
  mergeSources, matchUrl, hostPatternFor, normalizeRule, parseRulesFile, isLabelable, NO_LABEL, envTextColor, uid,
} from './rules.js';

const REMOTE_ALARM = 'env-remote';
const SNOOZE_MINUTES = 10;

// ---- Rule set (local settings + remote files + shared rules), cached until storage changes ----

let ruleSetPromise = null;

async function loadRuleSet() {
  const state = await settings.load();
  const { remoteRules = {}, sharedRules = null } = await api.storage.local.get(['remoteRules', 'sharedRules']);
  const s = state.values;
  const merged = mergeSources({ rules: s.rules || [], environments: s.environments || [], remote: activeRemote(remoteRules, s), shared: sharedRules });
  return { ...merged, settings: s, locked: state.locked };
}

/** Remote files still listed in the settings (a removed source stops applying immediately). */
function activeRemote(remoteRules, s) {
  const sources = new Set(s.ruleSources || []);
  return Object.fromEntries(Object.entries(remoteRules || {}).filter(([u, v]) => sources.has(u) && Array.isArray(v?.rules)));
}

function ruleSet() {
  if (!ruleSetPromise) ruleSetPromise = loadRuleSet().catch((e) => { ruleSetPromise = null; throw e; });
  return ruleSetPromise;
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'managed' || (area === 'local' && ('settings' in changes || 'remoteRules' in changes || 'sharedRules' in changes))) {
    ruleSetPromise = null;
  }
  if (area === 'local' && 'settings' in changes) {
    const before = changes.settings.oldValue || {};
    const after = changes.settings.newValue || {};
    if (JSON.stringify(before.ruleSources) !== JSON.stringify(after.ruleSources) || before.remoteRefreshHours !== after.remoteRefreshHours) {
      scheduleRemote();
    }
  }
});

// ---- Per-tab / per-page session state (storage.session when available, memory otherwise) ----

const memory = {};
const session = api.storage.session;
async function sessionGet(key, fallback) {
  if (session) {
    try {
      const r = await session.get(key);
      return r[key] ?? fallback;
    } catch { /* fall through */ }
  }
  return memory[key] ?? fallback;
}
async function sessionSet(key, value) {
  memory[key] = value;
  if (session) {
    try { await session.set({ [key]: value }); } catch { /* memory only */ }
  }
}

async function isTabHidden(tabId) {
  if (tabId == null) return false;
  return (await sessionGet('hiddenTabs', [])).includes(tabId);
}

async function setTabHidden(tabId, hidden) {
  const list = (await sessionGet('hiddenTabs', [])).filter((id) => id !== tabId);
  if (hidden) list.push(tabId);
  await sessionSet('hiddenTabs', list);
}

const pageKey = (href) => {
  try {
    const u = new URL(href);
    return u.origin + u.pathname;
  } catch {
    return href;
  }
};

async function snoozedUntil(href) {
  const map = await sessionGet('confirmSnooze', {});
  return map[pageKey(href)] || 0;
}

async function snooze(href, minutes = SNOOZE_MINUTES) {
  const now = Date.now();
  const map = await sessionGet('confirmSnooze', {});
  for (const [k, until] of Object.entries(map)) if (until < now) delete map[k];
  map[pageKey(href)] = now + minutes * 60000;
  await sessionSet('confirmSnooze', map);
  return map[pageKey(href)];
}

// ---- Matching -----------------------------------------------------------------------

function publicSettings(s) {
  return {
    enabled: s.enabled !== false,
    style: s.style,
    position: s.position,
    size: s.size,
    opacity: s.opacity,
    titleFormat: s.titleFormat,
    hideSeconds: s.hideSeconds,
    showRibbon: s.showRibbon,
    showTitlePrefix: s.showTitlePrefix,
    showFavicon: s.showFavicon,
    showBadge: s.showBadge,
    confirmSubmit: s.confirmSubmit,
  };
}

async function describe(href, tabId) {
  const set = await ruleSet();
  const m = isLabelable(href) ? matchUrl(href, set.rules, set.environments) : null;
  const match = m ? {
    none: !!m.none,
    index: m.index,
    rule: { id: m.rule.id, pattern: m.rule.pattern, label: m.rule.label, env: m.rule.env, source: m.rule.source, sourceUrl: m.rule.sourceUrl || '' },
    env: m.env ? { ...m.env, textColor: envTextColor(m.env) } : null,
  } : null;
  return {
    url: href,
    labelable: isLabelable(href),
    host: hostPatternFor(href),
    match: match && !match.none ? match : null,
    exception: match && match.none ? match : null,
    settings: publicSettings(set.settings),
    tabHidden: await isTabHidden(tabId),
    snoozedUntil: await snoozedUntil(href),
    rulesLocked: set.locked.has('rules'),
  };
}

async function paintBadge(tabId, info) {
  if (tabId == null || tabId < 0 || !api.action) return;
  const env = info?.match?.env;
  const show = env && info.settings.enabled && info.settings.showBadge && env.badge;
  try {
    await api.action.setBadgeText({ tabId, text: show ? env.short.slice(0, 4) : '' });
    if (show) {
      await api.action.setBadgeBackgroundColor({ tabId, color: env.color });
      await api.action.setBadgeTextColor?.({ tabId, color: env.textColor });
    }
  } catch { /* tab closed */ }
}

async function refreshTab(tabId) {
  try {
    await api.tabs.sendMessage(tabId, { type: 'env:refresh' });
  } catch {
    // No content script there (browser pages, or a tab opened before install). Keep the badge right anyway.
    try {
      const tab = await api.tabs.get(tabId);
      if (tab.url) await paintBadge(tabId, await describe(tab.url, tabId));
    } catch { /* gone */ }
  }
}

// ---- Label this site (popup) ----------------------------------------------------------

async function labelHost(href, envId, label) {
  const state = await settings.load();
  if (state.locked.has('rules')) throw new Error('Rules are managed by your IT department.');
  const pattern = hostPatternFor(href);
  if (!pattern) throw new Error('This page has no host name to label.');
  const rules = (state.values.rules || []).map((r) => normalizeRule(r));
  const i = rules.findIndex((r) => r.pattern.toLowerCase() === pattern);
  const existing = i >= 0 ? rules.splice(i, 1)[0] : null;
  if (envId) {
    rules.unshift({ ...(existing || { id: uid('r-'), label: label || '' }), pattern, env: envId, enabled: true });
  } else {
    // Removing: if another (wider) rule still labels this host, add a "No label" exception on top.
    const { remoteRules = {}, sharedRules = null } = await api.storage.local.get(['remoteRules', 'sharedRules']);
    const merged = mergeSources({ rules, environments: state.values.environments, remote: activeRemote(remoteRules, state.values), shared: sharedRules });
    const still = matchUrl(href, merged.rules, merged.environments);
    if (still && !still.none) rules.unshift({ id: uid('r-'), pattern, env: NO_LABEL, label: 'No label', enabled: true });
  }
  await settings.set({ rules });
  ruleSetPromise = null;
}

// ---- Remote rule files ------------------------------------------------------------------

async function fetchRemote(only) {
  const s = (await settings.load()).values;
  const sources = (s.ruleSources || []).filter((u) => !only || u === only);
  const { remoteRules = {} } = await api.storage.local.get('remoteRules');
  for (const url of Object.keys(remoteRules)) if (!(s.ruleSources || []).includes(url)) delete remoteRules[url];
  for (const url of sources) {
    const prev = remoteRules[url] || {};
    try {
      const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      const parsed = parseRulesFile(await res.text());
      remoteRules[url] = { at: Date.now(), ok: true, message: `${parsed.rules.length} rule(s), ${parsed.environments.length} environment(s)`, ...parsed };
    } catch (e) {
      // Keep the last good copy so labels don't disappear when the file is briefly unreachable.
      remoteRules[url] = { ...prev, at: Date.now(), ok: false, message: String(e.message || e), rules: prev.rules || [], environments: prev.environments || [] };
    }
  }
  await api.storage.local.set({ remoteRules });
  return remoteRules;
}

async function scheduleRemote() {
  if (!api.alarms) return;
  const s = (await settings.load()).values;
  const hours = Number(s.remoteRefreshHours) || 0;
  if ((s.ruleSources || []).length && hours > 0) {
    api.alarms.create(REMOTE_ALARM, { periodInMinutes: Math.max(15, hours * 60), delayInMinutes: 1 });
  } else {
    await api.alarms.clear(REMOTE_ALARM);
  }
}

api.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === REMOTE_ALARM) fetchRemote().catch(() => {});
});

// ---- Shared data (optional backend) ----------------------------------------------------

async function onSync(conn) {
  const s = (await settings.load()).values;
  const envs = new Map((s.environments || []).map((e) => [e.id, e]));
  let pushedCount = 0;
  if (s.shareRules) {
    const records = (s.rules || [])
      .filter((r) => r.pattern && !String(r.id).startsWith('builtin-'))
      .map((r) => {
        const e = envs.get(r.env);
        return { ...normalizeRule(r), envName: e?.name || '', envColor: e?.color || '', envShort: e?.short || '' };
      });
    if (records.length) {
      const r = await push('env-labeler', 'env-rules', records, conn);
      if (!r.ok) throw new Error(`Could not share rules: ${r.error}`);
      pushedCount = records.length;
    }
  }
  const pulled = await pull('env-rules', conn);
  const parts = [];
  if (pushedCount) parts.push(`shared ${pushedCount} rule(s)`);
  if (pulled) {
    const rules = pulled.filter((r) => r && r.pattern).map((r) => ({
      ...normalizeRule(r), envName: String(r.envName || ''), envColor: String(r.envColor || ''), envShort: String(r.envShort || ''),
    }));
    await api.storage.local.set({ sharedRules: { at: Date.now(), rules } });
    parts.push(`received ${rules.length} shared rule(s)`);
  } else {
    parts.push('this connection type only sends data');
  }
  return { ok: true, message: `${parts.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()) };
}

// ---- Wiring ---------------------------------------------------------------------------------

startBackground({ glyph: 'flag', settings, onSync });

handleMessages({
  'env:match': async (msg, sender) => {
    const tabId = sender.tab?.id ?? msg.tabId;
    const href = msg.url || sender.tab?.url || '';
    const info = await describe(href, tabId);
    if (sender.tab) await paintBadge(tabId, info);
    return info;
  },
  'env:hideTab': async ({ tabId, hidden }) => {
    await setTabHidden(tabId, !!hidden);
    await refreshTab(tabId);
    return { ok: true };
  },
  'env:snooze': async ({ url, minutes }, sender) => ({ until: await snooze(url || sender.tab?.url, minutes) }),
  'env:setPosition': async ({ position }) => {
    if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(position)) return { ok: false };
    await settings.set({ position });
    return { ok: !settings.isLocked('position') };
  },
  'env:labelHost': async ({ url, envId, label, tabId }) => {
    await labelHost(url, envId, label);
    if (tabId != null) await refreshTab(tabId);
    return describe(url, tabId);
  },
  'env:fetchRemote': async ({ url }) => fetchRemote(url),
  'env:refreshTab': async ({ tabId }) => {
    await refreshTab(tabId);
    return { ok: true };
  },
});

// Badge for navigations the content script can't see (also covers SPA URL changes when the URL is visible to us).
api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.url) return;
  describe(tab.url, tabId).then((info) => paintBadge(tabId, info)).catch(() => {});
});

api.tabs.onRemoved.addListener(async (tabId) => {
  if (await isTabHidden(tabId)) await setTabHidden(tabId, false);
});

api.runtime.onInstalled.addListener(async ({ reason }) => {
  scheduleRemote();
  if (reason !== 'install' && reason !== 'update') return;
  // Label tabs that were already open before the extension was installed or updated.
  if (!api.scripting) return;
  const tabs = await api.tabs.query({}).catch(() => []);
  for (const tab of tabs) {
    if (tab.url && !/^https?:|^file:/.test(tab.url)) continue;
    api.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/indicator.js', 'content/content.js'] }).catch(() => {});
  }
});
api.runtime.onStartup?.addListener(() => {
  scheduleRemote();
  fetchRemote().catch(() => {});
});

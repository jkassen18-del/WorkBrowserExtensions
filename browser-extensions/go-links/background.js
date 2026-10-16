// Go-Links background: omnibox keyword "go", address-bar capture (declarativeNetRequest),
// scheduled refresh of shared link lists, and optional sync with a linked backend.
import { api, isFirefox } from './shared/api.js';
import { startBackground, handleMessages } from './shared/background-kit.js';
import { push, pull } from './shared/connections.js';
import { settings } from './settings.js';
import * as L from './lib/links.js';

const RULESET = 'go_capture';
const GO_HOST_RULE = 1000;
const REFRESH_ALARM = 'go-refresh';

startBackground({ glyph: 'link', settings, onSync });

async function onSync(conn) {
  const parts = [];
  const remote = await pull('links', conn);
  if (Array.isArray(remote)) parts.push(`received ${await L.setSharedLinks(remote)} shared link(s)`);
  if ((await settings.get()).sharePersonalLinks) {
    const mine = await L.personal.all();
    if (mine.length) {
      const r = await push('go-links', 'links', mine, conn);
      if (!r.ok) throw new Error(r.error);
      parts.push(`shared ${mine.length} of your link(s)`);
    }
  }
  const msg = parts.length ? parts.join(', ') : 'nothing to exchange';
  return { ok: true, message: msg.charAt(0).toUpperCase() + msg.slice(1) + '.' };
}

// ---- Address bar capture --------------------------------------------------------------

async function applyCapture() {
  const dnr = api.declarativeNetRequest;
  if (!dnr) return;
  const on = (await settings.get()).captureAddressBar !== false;
  try {
    await dnr.updateEnabledRulesets(on ? { enableRulesetIds: [RULESET] } : { disableRulesetIds: [RULESET] });
  } catch (e) {
    console.warn('Go-Links: could not toggle the static ruleset', e);
  }
  // http(s)://go/<path> -> resolver page. Dynamic, because the target contains this extension's own URL.
  const resolver = api.runtime.getURL('resolver/resolve.html');
  try {
    await dnr.updateDynamicRules({
      removeRuleIds: [GO_HOST_RULE],
      addRules: on ? [{
        id: GO_HOST_RULE,
        priority: 2,
        action: { type: 'redirect', redirect: { regexSubstitution: `${resolver}#\\1` } },
        condition: { regexFilter: '^https?://go/(.*)$', resourceTypes: ['main_frame'] },
      }] : [],
    });
  } catch (e) {
    console.warn('Go-Links: could not register the go/ redirect rule', e);
  }
}

// ---- Shared link lists ----------------------------------------------------------------

async function scheduleRefresh() {
  if (!api.alarms) return;
  const hours = Math.max(1, Number((await settings.get()).refreshHours) || 6);
  const existing = await api.alarms.get(REFRESH_ALARM);
  if (!existing || existing.periodInMinutes !== hours * 60) {
    api.alarms.create(REFRESH_ALARM, { periodInMinutes: hours * 60, delayInMinutes: 1 });
  }
}

async function setup() {
  await applyCapture();
  await scheduleRefresh();
  const opts = await settings.get();
  await L.syncManagedSources(opts.sourceUrls || []);
  await L.refreshAll({ staleHours: Math.max(1, Number(opts.refreshHours) || 6) });
}

api.runtime.onInstalled.addListener(() => setup());
api.runtime.onStartup?.addListener(() => setup());
api.alarms?.onAlarm.addListener((a) => {
  if (a.name === REFRESH_ALARM) L.refreshAll();
});
settings.onChange(async (v) => {
  await applyCapture();
  await scheduleRefresh();
  await L.syncManagedSources(v.sourceUrls || []);
});

handleMessages({
  'go:refreshAll': () => L.refreshAll(),
  'go:applyCapture': () => applyCapture(),
});

// ---- Omnibox: "go" + space -------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function describe(e) {
  const label = e.title || e.description || '';
  if (isFirefox) return `go/${e.name}${label ? ` · ${label}` : ''} — ${e.url}`;
  return `<match>go/${esc(e.name)}</match>${label ? ` <dim>${esc(label)}</dim>` : ''} <url>${esc(e.url)}</url>`;
}

function setDefault(text) {
  const t = text.trim();
  const description = t
    ? (isFirefox ? `Open go/${t}` : `Open <match>go/${esc(t)}</match>`)
    : (isFirefox ? 'Type a go-link name, e.g. payroll or jira/ABC-123' : 'Type a go-link name, e.g. <match>payroll</match> or <match>jira/ABC-123</match>');
  try {
    api.omnibox.setDefaultSuggestion({ description });
  } catch { /* ignore */ }
}

if (api.omnibox) {
  setDefault('');
  api.omnibox.onInputStarted?.addListener(() => setDefault(''));
  api.omnibox.onInputChanged.addListener(async (text, suggestFn) => {
    setDefault(text);
    const m = await L.loadMerged();
    // Full-text matches open the link itself; if only the name part matches
    // ("jira ABC-123"), the extra path is carried over to the suggestion.
    let results = L.search(m.visible, text, 6);
    let suffix = '';
    if (!results.length) {
      const { segments, query } = L.parseInput(text);
      if (segments.length) {
        results = L.search(m.visible, segments[0], 6);
        suffix = (segments.length > 1 ? `/${segments.slice(1).join('/')}` : '') + (query ? `?${query}` : '');
      }
    }
    suggestFn(results
      .map((e) => ({ content: e.name + suffix, description: describe(e) }))
      .filter((s) => s.content !== text.trim()));
  });

  api.omnibox.onInputEntered.addListener(async (text, disposition) => {
    const opts = await settings.get();
    if (disposition === 'currentTab' && opts.openInNewTab) disposition = 'newForegroundTab';
    const r = await L.resolve(text);
    let url;
    if (r.found) {
      await L.recordClick(r.entry);
      url = r.target;
    } else if (!text.trim()) {
      url = api.runtime.getURL('directory/directory.html');
    } else {
      url = L.resolverUrl(encodeURI(text.trim().replace(/^go\//i, '').replace(/^(\S+)\s+/, '$1/')));
    }
    if (disposition === 'newForegroundTab') api.tabs.create({ url });
    else if (disposition === 'newBackgroundTab') api.tabs.create({ url, active: false });
    else {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) api.tabs.update(tab.id, { url });
      else api.tabs.create({ url });
    }
  });
}

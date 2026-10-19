// Go-Links data layer, shared by the background script and every page.
//
// storage.local keys
//   links        personal links (editable)              [{ id, name, url, title, description, tags, aliases, owner, list:'personal', createdAt, updatedAt, clicks, lastUsed }]
//   sources      link-list sources (read-only lists)   [{ id, name, url, department, enabled, managed, kind, lastFetched, status, error, count }]
//   sourceLinks  links downloaded per source            { [sourceId]: [link...] }
//   linkStats    clicks for read-only links              { [entryId]: { clicks, lastUsed } }
//
// Personal links always win over source links with the same name (a "conflict").
import { api, uid } from '../shared/api.js';
import { createCollection } from '../shared/settings.js';
import { settings } from '../settings.js';

export const personal = createCollection('links');
export const SHARED_ID = 'shared';
const K_SOURCES = 'sources';
const K_SOURCE_LINKS = 'sourceLinks';
const K_STATS = 'linkStats';
const MAX_SOURCE_LINKS = 10000;
const FETCH_TIMEOUT = 20000;

export const EXAMPLES = [
  { name: 'Company', department: 'Company', url: 'bundled:examples/company-links.json' },
  { name: 'Engineering', department: 'Engineering', url: 'bundled:examples/engineering-links.json' },
];

// ---- Names, URLs, cleaning ---------------------------------------------------------

const NAME_RE = /^[a-z0-9](?:[a-z0-9\-_./]*[a-z0-9\-_])?$/;

export function normalizeName(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/)?go\//, '')
    .replace(/\s+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

export function validateName(name) {
  if (!name) return 'Enter a short name, for example payroll.';
  if (name.length > 80) return 'Keep the name under 80 characters.';
  if (!NAME_RE.test(name) || /\/\.|\.\//.test(name)) return 'Use lowercase letters, numbers and - _ . / only.';
  return '';
}

export function isSafeUrl(u) {
  return /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(String(u || '').trim());
}

export function validateUrl(u) {
  if (!u) return 'Enter the destination URL.';
  if (!isSafeUrl(u)) return 'Enter a full address starting with https:// (or http://, mailto:).';
  return '';
}

export function splitList(v) {
  return (Array.isArray(v) ? v : String(v ?? '').split(/[,;|]/)).map((s) => String(s).trim()).filter(Boolean);
}

/** Cleans one raw link object (from a form, an import or a remote list). Returns null if unusable. */
export function cleanLink(raw, list = 'personal') {
  if (!raw || typeof raw !== 'object') return null;
  const name = normalizeName(raw.name ?? raw.shortcut ?? raw.key ?? raw.alias);
  const url = String(raw.url ?? raw.target ?? raw.href ?? '').trim();
  if (validateName(name) || validateUrl(url)) return null;
  const aliases = [...new Set(splitList(raw.aliases).map(normalizeName))].filter((a) => a !== name && !validateName(a));
  return {
    name,
    url,
    title: String(raw.title ?? '').trim().slice(0, 200),
    description: String(raw.description ?? '').trim().slice(0, 1000),
    tags: [...new Set(splitList(raw.tags).map((t) => t.toLowerCase()))].slice(0, 20),
    aliases,
    owner: raw.owner ? String(raw.owner).slice(0, 120) : undefined,
    list,
  };
}

// ---- State --------------------------------------------------------------------------

export async function loadState() {
  const s = await api.storage.local.get(['links', K_SOURCES, K_SOURCE_LINKS, K_STATS]);
  const opts = await settings.get();
  return {
    personal: s.links || [],
    sources: s[K_SOURCES] || [],
    sourceLinks: s[K_SOURCE_LINKS] || {},
    stats: s[K_STATS] || {},
    caseInsensitive: opts.caseInsensitive !== false,
  };
}

/**
 * Builds the merged view: entries (every link, personal first), index (name/alias -> winning entry)
 * and conflicts. Each entry: { ...link, id, list, sourceName, department, readOnly, shadowedBy?, overrides[] }
 */
export function merge(state) {
  const entries = [];
  for (const l of state.personal) {
    entries.push({ ...l, list: 'personal', sourceName: 'Personal', department: '', readOnly: false, overrides: [], clicks: l.clicks || 0, lastUsed: l.lastUsed || 0 });
  }
  for (const src of state.sources) {
    if (!src.enabled) continue;
    for (const l of state.sourceLinks[src.id] || []) {
      const id = `${src.id}:${l.name}`;
      const st = state.stats[id] || {};
      entries.push({
        ...l, id, list: src.id, sourceName: src.name, department: src.department || '', readOnly: true, overrides: [],
        clicks: st.clicks || 0, lastUsed: st.lastUsed || 0, createdAt: l.createdAt || 0,
      });
    }
  }
  const index = new Map();
  const conflicts = [];
  const claim = (key, e, isAlias) => {
    const winner = index.get(key);
    if (!winner) {
      index.set(key, e);
      return;
    }
    if (winner === e) return;
    if (!isAlias) {
      e.shadowedBy = winner;
      if (!winner.overrides.includes(e.sourceName)) winner.overrides.push(e.sourceName);
      conflicts.push({ name: key, winner, loser: e });
    }
  };
  for (const e of entries) claim(e.name, e, false);
  // An alias follows its link: if the link is overridden by a personal one, so is the alias.
  for (const e of entries) for (const a of e.aliases || []) claim(a, e.shadowedBy || e, true);
  return { entries, index, conflicts, visible: entries.filter((e) => !e.shadowedBy) };
}

export async function loadMerged() {
  const state = await loadState();
  return { state, ...merge(state) };
}

// ---- Resolving ----------------------------------------------------------------------

/** "jira ABC-123", "go/jira/ABC-123?x=1" -> { segments, query } */
export function parseInput(raw) {
  let s = String(raw ?? '').trim().replace(/^(?:https?:\/\/)?go\//i, '');
  let query = '';
  const qi = s.indexOf('?');
  if (qi >= 0) {
    query = s.slice(qi + 1);
    s = s.slice(0, qi);
  }
  s = s.replace(/^(\S+)\s+/, '$1/');
  return { segments: s.split('/').filter((x) => x !== ''), query };
}

export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Fills a link's URL with path segments: %s, {1} {2} {*}, otherwise appends them. Adds query parameters. */
export function expand(url, rest = [], query = '') {
  const enc = (seg) => encodeURIComponent(seg ?? '');
  const all = rest.map(enc).join('/');
  let out = url;
  if (out.includes('%s')) {
    out = out.split('%s').join(all);
  } else if (/\{(\d+|\*)\}/.test(out)) {
    out = out.replace(/\{(\d+)\}/g, (_, n) => enc(rest[Number(n) - 1])).replace(/\{\*\}/g, all);
  } else if (rest.length) {
    try {
      const u = new URL(out);
      u.pathname = `${u.pathname.replace(/\/+$/, '')}/${all}`;
      out = u.href;
    } catch {
      out = `${out.replace(/\/+$/, '')}/${all}`;
    }
  }
  if (query) {
    try {
      const u = new URL(out);
      for (const [k, v] of new URLSearchParams(query)) u.searchParams.append(k, v);
      out = u.href;
    } catch {
      out += (out.includes('?') ? '&' : '?') + query;
    }
  }
  return out;
}

/**
 * Resolves typed text against the merged index. Longest name wins: go/team/eng/wiki tries
 * "team/eng/wiki", then "team/eng", then "team".
 */
export function resolveIn(merged, text, caseInsensitive = true) {
  const { segments, query } = parseInput(text);
  for (let i = segments.length; i > 0; i--) {
    const key = segments.slice(0, i).join('/');
    const entry = merged.index.get(caseInsensitive ? key.toLowerCase() : key);
    if (entry) {
      const rest = segments.slice(i);
      return { found: true, entry, rest, query, target: expand(entry.url, rest, query) };
    }
  }
  return { found: false, name: normalizeName(segments.join('/')), first: normalizeName(segments[0] || ''), rest: segments.slice(1), query };
}

export async function resolve(text) {
  const m = await loadMerged();
  return { ...resolveIn(m, text, m.state.caseInsensitive), merged: m };
}

export async function recordClick(entry) {
  const now = Date.now();
  if (entry.list === 'personal') {
    const list = await personal.all();
    const l = list.find((x) => x.id === entry.id);
    if (l) {
      l.clicks = (l.clicks || 0) + 1;
      l.lastUsed = now;
      await personal.save(list);
    }
  } else {
    const { [K_STATS]: stats = {} } = await api.storage.local.get(K_STATS);
    const st = stats[entry.id] || { clicks: 0 };
    stats[entry.id] = { clicks: (st.clicks || 0) + 1, lastUsed: now };
    await api.storage.local.set({ [K_STATS]: stats });
  }
}

// ---- Search -------------------------------------------------------------------------

function subsequence(needle, hay) {
  let i = 0;
  for (const c of hay) if (c === needle[i]) i++;
  return i === needle.length;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function scoreEntry(e, q, terms) {
  let s = 0;
  const names = [e.name, ...(e.aliases || [])];
  names.forEach((n, i) => {
    const w = i === 0 ? 1 : 0.85;
    if (n === q) s = Math.max(s, 1000 * w);
    else if (n.startsWith(q)) s = Math.max(s, 600 * w);
    else if (n.includes(q)) s = Math.max(s, 400 * w);
  });
  const title = (e.title || '').toLowerCase();
  const desc = (e.description || '').toLowerCase();
  const tags = (e.tags || []).map((t) => t.toLowerCase());
  for (const t of terms) {
    let ts = 0;
    if (names.some((n) => n.includes(t))) ts = Math.max(ts, 90);
    if (tags.includes(t)) ts = Math.max(ts, 70);
    else if (tags.some((g) => g.includes(t))) ts = Math.max(ts, 35);
    if (title.includes(t)) ts = Math.max(ts, new RegExp(`(^|\\W)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title) ? 65 : 45);
    if (desc.includes(t)) ts = Math.max(ts, 25);
    if (!ts && t.length > 1 && names.some((n) => subsequence(t, n))) ts = 20;
    if (!ts) return s >= 400 ? s : 0;
    s += ts;
  }
  return s + Math.log2(1 + (e.clicks || 0)) * 6;
}

/** Fuzzy search over visible entries (name, aliases, title, tags, description). */
export function search(entries, query, limit = 6) {
  const q = String(query || '').trim().toLowerCase().replace(/^go\//, '');
  if (!q) return [];
  const terms = q.split(/[\s/]+/).filter(Boolean);
  return entries
    .map((e) => ({ e, s: scoreEntry(e, q, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.e.name.localeCompare(b.e.name))
    .slice(0, limit)
    .map((x) => x.e);
}

/** Suggestions for typed text: full-text search first, then the name part only. */
export function suggest(entries, text, limit = 6) {
  let r = search(entries, text, limit);
  if (!r.length) {
    const { segments } = parseInput(text);
    if (segments.length > 1) r = search(entries, segments[0], limit);
  }
  return r;
}

/** Closest existing links for a missing name (spelling distance + fuzzy search). */
export function closest(entries, name, limit = 5) {
  const out = new Map();
  for (const e of search(entries, name, limit)) out.set(e.id, e);
  const ranked = entries
    .map((e) => ({ e, d: Math.min(...[e.name, ...(e.aliases || [])].map((n) => levenshtein(name, n))) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(name.length / 3)))
    .sort((a, b) => a.d - b.d);
  for (const { e } of ranked) if (out.size < limit) out.set(e.id, e);
  return [...out.values()].slice(0, limit);
}

/** Who already uses a name? -> { personal?: entry, source?: entry } */
export function whoHas(merged, name, exceptId) {
  const res = {};
  for (const e of merged.entries) {
    if (e.id === exceptId) continue;
    if (e.name !== name && !(e.aliases || []).includes(name)) continue;
    if (e.list === 'personal') res.personal = res.personal || e;
    else res.source = res.source || e;
  }
  return res;
}

// ---- Personal links -----------------------------------------------------------------

export async function savePersonal(data, existingId) {
  const clean = cleanLink(data, 'personal');
  if (!clean) {
    const name = normalizeName(data?.name);
    throw new Error(validateName(name) || validateUrl(String(data?.url || '').trim()) || 'Check the name and URL.');
  }
  const list = await personal.all();
  const taken = (n) => list.find((l) => l.id !== existingId && (l.name === n || (l.aliases || []).includes(n)));
  for (const n of [clean.name, ...clean.aliases]) {
    const t = taken(n);
    if (t) throw new Error(`go/${n} is already one of your links${t.name !== n ? ` (alias of go/${t.name})` : ''}.`);
  }
  const now = Date.now();
  let record;
  const i = existingId ? list.findIndex((l) => l.id === existingId) : -1;
  if (i >= 0) {
    record = { ...list[i], ...clean, updatedAt: now };
    list[i] = record;
  } else {
    record = { id: uid('l_'), ...clean, createdAt: now, updatedAt: now, clicks: 0, lastUsed: 0 };
    list.push(record);
  }
  if (record.owner === undefined) delete record.owner;
  await personal.save(list);
  return record;
}

export async function deletePersonal(ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  await personal.save((await personal.all()).filter((l) => !set.has(l.id)));
}

/** Imports links (array or { links }). Existing names are updated. */
export async function importPersonal(input) {
  const raw = Array.isArray(input) ? input : Array.isArray(input?.links) ? input.links : [];
  const list = await personal.all();
  const byName = new Map(list.map((l) => [l.name, l]));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const now = Date.now();
  for (const r of raw) {
    const c = cleanLink(r, 'personal');
    if (!c) {
      skipped++;
      continue;
    }
    if (c.owner === undefined) delete c.owner;
    const ex = byName.get(c.name);
    if (ex) {
      Object.assign(ex, c, { updatedAt: now });
      updated++;
    } else {
      const rec = {
        id: uid('l_'), ...c,
        createdAt: Number(r.createdAt) || now, updatedAt: now,
        clicks: Number(r.clicks) || 0, lastUsed: Number(r.lastUsed) || 0,
      };
      list.push(rec);
      byName.set(c.name, rec);
      added++;
    }
  }
  await personal.save(list);
  return { added, updated, skipped };
}

// ---- CSV ----------------------------------------------------------------------------

const CSV_COLS = ['name', 'url', 'title', 'description', 'tags', 'aliases', 'owner', 'clicks'];

export function toCSV(links) {
  const q = (v) => {
    const s = Array.isArray(v) ? v.join(';') : String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLS.join(','), ...links.map((l) => CSV_COLS.map((c) => q(l[c])).join(','))].join('\r\n');
}

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter((r) => r.some((x) => x.trim()));
  if (!clean.length) return [];
  const head = clean[0].map((x) => x.trim().toLowerCase());
  const hasHeader = head.includes('name') && head.includes('url');
  const cols = hasHeader ? head : ['name', 'url', 'title', 'description', 'tags', 'aliases'];
  return (hasHeader ? clean.slice(1) : clean).map((r) => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? '').trim()])));
}

// ---- Sources ------------------------------------------------------------------------

export async function getSources() {
  const { [K_SOURCES]: s = [] } = await api.storage.local.get(K_SOURCES);
  return s;
}

async function saveSources(list) {
  await api.storage.local.set({ [K_SOURCES]: list });
}

async function setSourceLinks(id, links) {
  const { [K_SOURCE_LINKS]: all = {} } = await api.storage.local.get(K_SOURCE_LINKS);
  if (links) all[id] = links;
  else delete all[id];
  await api.storage.local.set({ [K_SOURCE_LINKS]: all });
}

async function patchSource(id, patch) {
  const list = await getSources();
  const s = list.find((x) => x.id === id);
  if (!s) return null;
  Object.assign(s, patch);
  await saveSources(list);
  return s;
}

export function sourceFetchUrl(url) {
  return String(url).startsWith('bundled:') ? api.runtime.getURL(String(url).slice(8)) : url;
}

export function sourceDisplayUrl(url) {
  return String(url).startsWith('bundled:') ? `Built-in example (${String(url).slice(8)})` : url;
}

/** Parses a link-list JSON document: { name?, links: [...] } or a plain array. */
export function parseLinkList(json, sourceId) {
  const raw = Array.isArray(json) ? json : Array.isArray(json?.links) ? json.links : null;
  if (!raw) throw new Error('Expected a JSON array of links or { "links": [...] }.');
  const seen = new Set();
  const links = [];
  for (const r of raw.slice(0, MAX_SOURCE_LINKS)) {
    const c = cleanLink(r, sourceId);
    if (!c || seen.has(c.name)) continue;
    if (c.owner === undefined) delete c.owner;
    seen.add(c.name);
    links.push(c);
  }
  return { name: !Array.isArray(json) && typeof json?.name === 'string' ? json.name.trim() : '', links };
}

export async function fetchLinkList(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(sourceFetchUrl(url), { cache: 'no-store', signal: ctrl.signal, credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('The address did not return JSON.');
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timed out.');
    if (e instanceof TypeError) throw new Error('Could not reach the address (offline, blocked, or access not granted).');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshSource(id) {
  const src = (await getSources()).find((s) => s.id === id);
  if (!src || src.kind === 'connection') return src;
  try {
    const parsed = parseLinkList(await fetchLinkList(src.url), id);
    const prev = (await api.storage.local.get(K_SOURCE_LINKS))[K_SOURCE_LINKS]?.[id] || [];
    const prevAt = new Map(prev.map((l) => [l.name, l.createdAt]));
    const now = Date.now();
    const links = parsed.links.map((l) => ({ ...l, createdAt: prevAt.get(l.name) || (src.firstFetched ? now : 0) }));
    await setSourceLinks(id, links);
    return patchSource(id, {
      name: src.name || parsed.name || hostOf(src.url),
      lastFetched: now, firstFetched: src.firstFetched || now, status: 'ok', error: '', count: links.length,
    });
  } catch (e) {
    return patchSource(id, { lastFetched: Date.now(), status: 'error', error: String(e.message || e) });
  }
}

export async function refreshAll({ staleHours = 0 } = {}) {
  const list = await getSources();
  const cutoff = Date.now() - staleHours * 3600e3;
  const due = list.filter((s) => s.enabled && s.kind !== 'connection' && (!staleHours || !s.lastFetched || s.lastFetched < cutoff));
  await Promise.all(due.map((s) => refreshSource(s.id)));
  return { refreshed: due.length };
}

function hostOf(u) {
  try {
    return new URL(sourceFetchUrl(u)).hostname || 'Link list';
  } catch {
    return 'Link list';
  }
}

export async function addSource({ name = '', url, department = '', managed = false }) {
  url = String(url || '').trim();
  if (!url.startsWith('bundled:') && !/^https?:\/\/\S+$/i.test(url)) throw new Error('Enter a link-list URL starting with https://');
  const list = await getSources();
  if (list.some((s) => s.url === url)) throw new Error('That list is already added.');
  const src = {
    id: uid('s_'), name: String(name).trim(), url, department: String(department).trim(),
    enabled: true, managed, kind: 'url', lastFetched: 0, firstFetched: 0, status: 'pending', error: '', count: 0,
  };
  list.push(src);
  await saveSources(list);
  return refreshSource(src.id);
}

export async function updateSource(id, patch) {
  const allowed = {};
  for (const k of ['name', 'url', 'department', 'enabled']) if (k in patch) allowed[k] = patch[k];
  const s = await patchSource(id, allowed);
  if (s && 'url' in patch) return refreshSource(id);
  return s;
}

export async function removeSource(id) {
  await saveSources((await getSources()).filter((s) => s.id !== id));
  await setSourceLinks(id, null);
  const { [K_STATS]: stats = {} } = await api.storage.local.get(K_STATS);
  for (const k of Object.keys(stats)) if (k.startsWith(`${id}:`)) delete stats[k];
  await api.storage.local.set({ [K_STATS]: stats });
}

/** Keeps policy-provided list URLs (setting "sourceUrls") in the source list. */
export async function syncManagedSources(urls = []) {
  const wanted = new Set(urls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)));
  const list = await getSources();
  let changed = false;
  for (const s of list) {
    if (s.managed && !wanted.has(s.url)) {
      await removeSource(s.id);
      changed = true;
    }
  }
  const have = new Set((await getSources()).map((s) => s.url));
  for (const u of wanted) {
    if (have.has(u)) {
      const cur = (await getSources()).find((s) => s.url === u);
      if (!cur.managed) await patchSource(cur.id, { managed: true });
      continue;
    }
    await addSource({ url: u, managed: true });
    changed = true;
  }
  return changed;
}

/** Stores links pulled from the shared connection as the read-only "Shared" source. */
export async function setSharedLinks(records) {
  const mine = new Set((await personal.all()).map((l) => l.id));
  const parsed = parseLinkList(records.filter((r) => r && !mine.has(r.id)), SHARED_ID);
  await setSourceLinks(SHARED_ID, parsed.links);
  const list = await getSources();
  let s = list.find((x) => x.id === SHARED_ID);
  if (!s) {
    s = { id: SHARED_ID, name: 'Shared', url: '', department: '', enabled: true, managed: false, kind: 'connection', firstFetched: Date.now() };
    list.push(s);
  }
  Object.assign(s, { lastFetched: Date.now(), status: 'ok', error: '', count: parsed.links.length });
  await saveSources(list);
  return parsed.links.length;
}

// ---- Opening ------------------------------------------------------------------------

export function resolverUrl(text) {
  return api.runtime.getURL(`resolver/resolve.html#${text}`);
}

/** Opens a URL from an extension page (popup/directory), honouring "open in new tab". */
export async function openUrl(url, { newTab } = {}) {
  if (newTab === undefined) newTab = (await settings.get()).openInNewTab;
  if (newTab) return api.tabs.create({ url });
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) return api.tabs.update(tab.id, { url });
  return api.tabs.create({ url });
}

/** Records the click and opens the entry (with optional extra path/query). */
export async function openEntry(entry, { rest = [], query = '', newTab } = {}) {
  await recordClick(entry);
  return openUrl(expand(entry.url, rest, query), { newTab });
}

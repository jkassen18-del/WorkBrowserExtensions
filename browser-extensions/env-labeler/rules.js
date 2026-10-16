// Rule matcher shared by the background (labels tabs) and the Settings page (test tool, previews).
// Pure module: no extension APIs, so it also runs in Node for quick checks.
//
// Pattern forms (first enabled rule that matches wins):
//   example.com                 exact host, any port
//   *.example.com               any subdomain of example.com (not example.com itself)
//   *staging*                   wildcard anywhere in the host
//   example.com:8443            host and port   ("*:*" = any host with an explicit port)
//   https://example.com/admin*  URL prefix (* = anything)
//   example.com/admin*          host + path (any scheme)
//   /^https:\/\/.+\.corp\//i    regular expression tested against the full URL

export const NO_LABEL = 'none';

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'ftp:': '21' };
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const globToRe = (s) => escapeRe(s).replace(/\*/g, '.*');

const cache = new Map();

/** Compiles a pattern. Returns { kind, test(urlObject, href) } or { kind: 'invalid', error }. */
export function compilePattern(raw) {
  const pattern = String(raw ?? '').trim();
  if (cache.has(pattern)) return cache.get(pattern);
  let compiled;
  try {
    compiled = compile(pattern);
  } catch (e) {
    compiled = { kind: 'invalid', error: e.message || String(e), test: () => false };
  }
  if (cache.size > 500) cache.clear();
  cache.set(pattern, compiled);
  return compiled;
}

function compile(p) {
  if (!p) throw new Error('Pattern is empty.');
  const rx = /^\/(.+)\/([a-z]*)$/s.exec(p);
  if (rx) {
    const re = new RegExp(rx[1], rx[2].replace(/[gy]/g, ''));
    return { kind: 'regex', test: (_u, href) => re.test(href) };
  }
  if (p.includes('://')) {
    const re = new RegExp(`^${globToRe(p)}`, 'i');
    return { kind: 'prefix', test: (_u, href) => re.test(href) };
  }
  if (p.includes('/')) {
    const re = new RegExp(`^${globToRe(p.toLowerCase())}`);
    return {
      kind: 'hostpath',
      test: (u) => !!u.hostname && (re.test(u.host + u.pathname + u.search) || re.test(u.hostname + u.pathname + u.search)),
    };
  }
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+|\*))?$/.exec(p.toLowerCase());
  if (!m) throw new Error('Not a valid host pattern. Examples: example.com, *.example.com, example.com:8080');
  const [, hostPart, port] = m;
  if (/\s/.test(hostPart)) throw new Error('Host patterns cannot contain spaces.');
  const hostRe = new RegExp(`^${globToRe(hostPart)}$`);
  const kind = port ? 'port' : hostPart.includes('*') ? 'wildcard' : 'host';
  return {
    kind,
    test: (u) => {
      if (!u.hostname || !hostRe.test(u.hostname.toLowerCase())) return false;
      if (!port) return true;
      if (port === '*') return u.port !== '';
      return (u.port || DEFAULT_PORTS[u.protocol] || '') === port;
    },
  };
}

export const PATTERN_KINDS = {
  host: 'Exact host',
  wildcard: 'Wildcard host',
  port: 'Host and port',
  prefix: 'URL prefix',
  hostpath: 'Host and path',
  regex: 'Regular expression',
  invalid: 'Invalid',
};

export function describePattern(pattern) {
  return PATTERN_KINDS[compilePattern(pattern).kind];
}

export function validatePattern(pattern) {
  const c = compilePattern(pattern);
  return c.kind === 'invalid' ? c.error : '';
}

function parseUrl(href) {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

/** True when a page at this URL can carry a label (web pages and local files). */
export function isLabelable(href) {
  const u = parseUrl(href);
  return !!u && /^(https?|file|ftp):$/.test(u.protocol);
}

/** The pattern the popup's "Label this site" writes: host (with port when there is one). */
export function hostPatternFor(href) {
  const u = parseUrl(href);
  if (!u || !u.hostname) return '';
  return (u.port ? u.host : u.hostname).toLowerCase();
}

/** Sanitises one environment and fills in defaults (including an automatic text colour). */
export function normalizeEnv(e = {}) {
  const id = String(e.id || '').trim() || slug(e.name) || 'env';
  const name = String(e.name || id).trim();
  const color = /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : /^#[0-9a-f]{3}$/i.test(e.color) ? expandHex(e.color) : '#6B7280';
  const short = String(e.short || name).trim().slice(0, 6).toUpperCase() || id.slice(0, 4).toUpperCase();
  return {
    id,
    name,
    short,
    color,
    textColor: /^#[0-9a-f]{3,6}$/i.test(e.textColor || '') ? e.textColor : '',
    confirmSubmit: !!e.confirmSubmit,
    ribbon: e.ribbon !== false,
    titlePrefix: e.titlePrefix !== false,
    favicon: e.favicon !== false,
    badge: e.badge !== false,
  };
}

/** Text colour actually used for an environment (custom, or black/white for contrast). */
export function envTextColor(env) {
  return env.textColor || contrastText(env.color);
}

export function normalizeRule(r = {}, idPrefix = '') {
  return {
    id: idPrefix + String(r.id || uid()),
    pattern: String(r.pattern ?? '').trim(),
    env: String(r.env ?? r.environment ?? '').trim(),
    label: String(r.label ?? '').trim(),
    enabled: r.enabled !== false,
  };
}

/**
 * Parses a rules file ({ environments, rules } or a bare array of rules).
 * Returns { environments, rules } or throws with a readable message.
 */
export function parseRulesFile(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const rules = Array.isArray(data) ? data : data && Array.isArray(data.rules) ? data.rules : null;
  if (!rules) throw new Error('Expected { "environments": [...], "rules": [...] } or an array of rules.');
  const environments = !Array.isArray(data) && Array.isArray(data.environments) ? data.environments.map(normalizeEnv) : [];
  const clean = rules.filter((r) => r && typeof r === 'object' && r.pattern).map((r) => normalizeRule(r));
  return { environments, rules: clean };
}

/**
 * Combines local rules (first), remote rule files and shared rules (read-only) into one ordered list,
 * and the local environments with any extra environments those sources define.
 * remote: { [url]: { rules, environments } }, shared: { rules } (shared rules may carry envName/envColor/envShort).
 */
export function mergeSources({ rules = [], environments = [], remote = {}, shared = null }) {
  const envs = environments.map(normalizeEnv);
  const known = new Set(envs.map((e) => e.id));
  const addEnv = (e) => {
    if (!e || !e.id || known.has(e.id)) return;
    known.add(e.id);
    envs.push(normalizeEnv(e));
  };
  const all = rules.map((r) => ({ ...normalizeRule(r), source: 'local' }));
  const localIds = new Set(all.map((r) => r.id));
  for (const [url, src] of Object.entries(remote || {})) {
    if (!src || !Array.isArray(src.rules)) continue;
    (src.environments || []).forEach(addEnv);
    src.rules.forEach((r, i) => all.push({ ...normalizeRule({ ...r, id: r.id || String(i) }, `remote:${url}#`), source: 'remote', sourceUrl: url }));
  }
  if (shared && Array.isArray(shared.rules)) {
    for (const r of shared.rules) {
      if (!r || !r.pattern || localIds.has(String(r.id))) continue;
      if (r.envName || r.envColor) addEnv({ id: r.env, name: r.envName, color: r.envColor, short: r.envShort });
      all.push({ ...normalizeRule(r, 'shared:'), source: 'shared' });
    }
  }
  return { rules: all, environments: envs };
}

/**
 * Finds the first enabled rule matching a URL.
 * Returns null (no rule), { rule, index, env: null, none: true } (explicit "No label" rule),
 * or { rule, index, env } where env is a normalised environment.
 */
export function matchUrl(href, rules, environments) {
  const u = parseUrl(href);
  if (!u) return null;
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule || rule.enabled === false || !rule.pattern) continue;
    if (!compilePattern(rule.pattern).test(u, href)) continue;
    if (rule.env === NO_LABEL) return { rule, index: i, env: null, none: true };
    const env = environments.find((e) => e.id === rule.env)
      || normalizeEnv({ id: rule.env || 'unknown', name: rule.env || 'Unknown', color: '#6B7280' });
    return { rule, index: i, env };
  }
  return null;
}

/** Builds the tab title prefix from a format like "[{short}] ". */
export function formatPrefix(format, env, rule) {
  return String(format ?? '')
    .replace(/\{short\}/g, env.short)
    .replace(/\{name\}/g, env.name)
    .replace(/\{label\}/g, rule?.label || env.name);
}

// ---- small helpers ----------------------------------------------------------------

export function contrastText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(expandHex(hex));
  if (!m) return '#ffffff';
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0b1020' : '#ffffff';
}

function expandHex(hex) {
  const s = String(hex || '').trim();
  return /^#[0-9a-f]{3}$/i.test(s) ? `#${s.slice(1).split('').map((c) => c + c).join('')}` : s;
}

export function slug(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
}

export function uid(prefix = '') {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Optional link to a shared backend ("Connections" in Settings).
//
// Out of the box every extension is local-only: type "none" means nothing ever leaves
// the browser and push()/pull() are no-ops. When a team later wants shared data
// (company-wide go-links, a central ticket inbox, DLP incident reporting...) the user or IT
// picks one of the adapters below. Extensions only call push()/pull(), so new adapters
// can be added here without touching the extensions.
//
//   none      local only (default)
//   webhook   POST every pushed record as JSON to a URL (Zapier, Make, n8n, Power Automate, Slack...)
//   rest      generic JSON API: GET  {url}/{collection} -> [records], POST {url}/{collection} <- [records]
//   supabase  Supabase / PostgREST table per collection: id text primary key, data jsonb, updated_at timestamptz
//
// Records always carry an `id`, so pushes are idempotent upserts.
import { api } from './api.js';
import { readManaged } from './settings.js';

export const CONNECTION_TYPES = {
  none: { label: 'Local only (this browser)', fields: [] },
  webhook: { label: 'Webhook (send records to a URL)', fields: ['url', 'token'] },
  rest: { label: 'REST / JSON API', fields: ['url', 'token'] },
  supabase: { label: 'Supabase (Postgres)', fields: ['url', 'token', 'tablePrefix'] },
};

const DEFAULT_CONNECTION = { type: 'none', url: '', token: '', tablePrefix: 'wx_', autoSync: false };

export async function getConnectionState() {
  const { connection = {} } = await api.storage.local.get('connection');
  const managed = (await readManaged()).connection || {};
  return {
    connection: { ...DEFAULT_CONNECTION, ...connection, ...managed },
    locked: new Set(Object.keys(managed)),
  };
}

export async function getConnection() {
  return (await getConnectionState()).connection;
}

export function isConnected(conn) {
  return !!conn && conn.type !== 'none' && !!conn.url;
}

/** Origin pattern needed to talk to the backend, e.g. "https://abc.supabase.co/*". */
export function originPattern(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * Asks the browser for permission to reach the backend's host. Must be called from a click handler.
 * Returns true when allowed (or nothing is needed).
 */
export async function requestHostAccess(rawUrl) {
  const origin = originPattern(rawUrl);
  if (!origin) return false;
  try {
    if (await api.permissions.contains({ origins: [origin] })) return true;
    return await api.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

export async function saveConnection(conn) {
  const clean = { ...DEFAULT_CONNECTION, ...conn };
  clean.url = String(clean.url || '').trim().replace(/\/+$/, '');
  await api.storage.local.set({ connection: clean });
  return clean;
}

function headers(conn, extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (conn.type === 'supabase') {
    h.apikey = conn.token;
    h.Authorization = `Bearer ${conn.token}`;
  } else if (conn.token) {
    h.Authorization = /^(Bearer|Basic) /i.test(conn.token) ? conn.token : `Bearer ${conn.token}`;
  }
  return h;
}

function table(conn, collection) {
  return `${conn.url}/rest/v1/${encodeURIComponent((conn.tablePrefix || '') + collection)}`;
}

async function check(res) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res;
}

/**
 * Sends records to the linked backend.
 * @returns {{ok:boolean, skipped?:boolean, count?:number, error?:string}}
 */
export async function push(source, collection, records, conn) {
  conn = conn || (await getConnection());
  if (!isConnected(conn)) return { ok: true, skipped: true };
  records = Array.isArray(records) ? records : [records];
  try {
    if (conn.type === 'webhook') {
      await check(await fetch(conn.url, {
        method: 'POST',
        headers: headers(conn),
        body: JSON.stringify({ source, collection, sentAt: new Date().toISOString(), records }),
      }));
    } else if (conn.type === 'rest') {
      await check(await fetch(`${conn.url}/${encodeURIComponent(collection)}`, {
        method: 'POST',
        headers: headers(conn),
        body: JSON.stringify(records),
      }));
    } else if (conn.type === 'supabase') {
      const rows = records.map((r) => ({ id: String(r.id), data: r, updated_at: new Date().toISOString() }));
      await check(await fetch(`${table(conn, collection)}?on_conflict=id`, {
        method: 'POST',
        headers: headers(conn, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows),
      }));
    }
    return { ok: true, count: records.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Reads shared records from the backend. Returns null when not connected or the adapter is push-only.
 */
export async function pull(collection, conn) {
  conn = conn || (await getConnection());
  if (!isConnected(conn) || conn.type === 'webhook') return null;
  if (conn.type === 'rest') {
    const res = await check(await fetch(`${conn.url}/${encodeURIComponent(collection)}`, { headers: headers(conn) }));
    const json = await res.json();
    return Array.isArray(json) ? json : json.records || json.items || [];
  }
  if (conn.type === 'supabase') {
    const res = await check(await fetch(`${table(conn, collection)}?select=data`, { headers: headers(conn) }));
    return (await res.json()).map((row) => row.data);
  }
  return null;
}

/** Checks the connection works. */
export async function testConnection(conn) {
  conn = conn || (await getConnection());
  if (!isConnected(conn)) return { ok: true, message: 'Local only. Nothing to test.' };
  try {
    if (conn.type === 'webhook') {
      await check(await fetch(conn.url, {
        method: 'POST',
        headers: headers(conn),
        body: JSON.stringify({ source: 'connection-test', collection: 'test', sentAt: new Date().toISOString(), records: [] }),
      }));
    } else if (conn.type === 'rest') {
      await check(await fetch(conn.url, { headers: headers(conn) }));
    } else if (conn.type === 'supabase') {
      await check(await fetch(`${conn.url}/rest/v1/`, { headers: headers(conn) }));
    }
    return { ok: true, message: 'Connected.' };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
}

export const SUPABASE_SQL = (prefix, collections) => collections.map((c) => `create table if not exists ${prefix}${c} (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);`).join('\n\n');

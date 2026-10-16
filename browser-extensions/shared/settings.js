// Settings layer: defaults < policy suggestions < the user's own choices < policy-enforced values.
//
//   storage.local   "settings"  -> the user's own choices (everything works with only this)
//   storage.managed "defaults"  -> IT suggestions the user can still change
//   storage.managed <any other> -> enforced by IT, shown as "Managed (locked)"
//
// Policy is optional. With no policy installed the extension is fully self-contained.
import { api } from './api.js';

const USER_KEY = 'settings';
// Managed keys that are not settings (handled elsewhere).
const NON_SETTING_KEYS = new Set(['defaults', 'brand', 'connection']);

export async function readManaged() {
  try {
    if (!api.storage.managed) return {};
    return (await api.storage.managed.get(null)) || {};
  } catch {
    // No policy installed (Firefox throws when there is no managed storage manifest).
    return {};
  }
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export function createSettings(DEFAULTS) {
  let cache = null;

  async function load() {
    const managed = await readManaged();
    const { [USER_KEY]: user = {} } = await api.storage.local.get(USER_KEY);
    const suggested = managed.defaults && typeof managed.defaults === 'object' ? managed.defaults : {};
    const enforced = {};
    for (const [k, v] of Object.entries(managed)) {
      if (!NON_SETTING_KEYS.has(k) && k in DEFAULTS) enforced[k] = v;
    }
    const values = { ...clone(DEFAULTS), ...clone(suggested), ...clone(user), ...clone(enforced) };
    cache = { values, locked: new Set(Object.keys(enforced)), managed, user };
    return cache;
  }

  async function get() {
    return (cache ?? (await load())).values;
  }

  /** Saves one or more user settings. Locked keys are ignored. */
  async function set(patch) {
    const state = cache ?? (await load());
    const { [USER_KEY]: user = {} } = await api.storage.local.get(USER_KEY);
    for (const [k, v] of Object.entries(patch)) {
      if (state.locked.has(k)) continue;
      user[k] = v;
    }
    await api.storage.local.set({ [USER_KEY]: user });
    return load();
  }

  async function reset(keys) {
    if (!keys) {
      await api.storage.local.remove(USER_KEY);
    } else {
      const { [USER_KEY]: user = {} } = await api.storage.local.get(USER_KEY);
      for (const k of keys) delete user[k];
      await api.storage.local.set({ [USER_KEY]: user });
    }
    return load();
  }

  /** Calls cb(values) whenever user settings or policy change. Returns an unsubscribe function. */
  function onChange(cb) {
    const listener = async (changes, area) => {
      if ((area === 'local' && USER_KEY in changes) || area === 'managed') cb((await load()).values);
    };
    api.storage.onChanged.addListener(listener);
    return () => api.storage.onChanged.removeListener(listener);
  }

  return { DEFAULTS, load, get, set, reset, onChange, isLocked: (k) => !!cache?.locked.has(k) };
}

/** Simple keyed local data store for an extension's records (tickets, links, incidents...). */
export function createCollection(key, { max = 0 } = {}) {
  async function all() {
    const { [key]: list = [] } = await api.storage.local.get(key);
    return list;
  }
  async function save(list) {
    if (max && list.length > max) list = list.slice(-max);
    await api.storage.local.set({ [key]: list });
    return list;
  }
  return {
    key,
    all,
    save,
    async add(item) {
      const list = await all();
      list.push(item);
      await save(list);
      return item;
    },
    async upsert(item, idKey = 'id') {
      const list = await all();
      const i = list.findIndex((x) => x[idKey] === item[idKey]);
      if (i >= 0) list[i] = { ...list[i], ...item };
      else list.push(item);
      await save(list);
      return item;
    },
    async remove(id, idKey = 'id') {
      await save((await all()).filter((x) => x[idKey] !== id));
    },
    async clear() {
      await api.storage.local.remove(key);
    },
  };
}

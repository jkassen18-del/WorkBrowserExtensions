// Helpers shared by the background, popup and options page (ES module).
import '../content/sites.js';
import DEFAULTS from '../defaults.js';

export const Sites = globalThis.WxSites;
export const BASE_NAME = 'Data Leak Guard';

/** Fills nested objects that a policy may have set only partially. */
export function normalize(values) {
  const v = { ...values };
  v.categoryModes = { ...DEFAULTS.categoryModes, ...(values.categoryModes || {}) };
  const det = {};
  for (const [id, d] of Object.entries(DEFAULTS.detectors)) det[id] = { ...d, ...(values.detectors?.[id] || {}) };
  v.detectors = det;
  for (const k of ['aiSites', 'emailSites', 'fileSites', 'socialSites', 'approvedSites', 'markers', 'customPatterns']) {
    if (!Array.isArray(v[k])) v[k] = [...DEFAULTS[k]];
  }
  v.customPatterns = v.customPatterns.filter((p) => p && typeof p === 'object' && p.pattern)
    .map((p, i) => ({ id: p.id || `pattern-${i + 1}`, name: p.name || 'Custom pattern', pattern: String(p.pattern), flags: p.flags || '', mode: p.mode || 'site', enabled: p.enabled !== false }));
  return v;
}

export const ACTIONS = {
  logged: { label: 'Logged', badge: '' },
  warned: { label: 'Warned', badge: 'warn' },
  overridden: { label: 'Overridden', badge: 'primary' },
  blocked: { label: 'Blocked', badge: 'danger' },
};

export const CHANNELS = {
  paste: 'Paste',
  drop: 'Drag & drop',
  upload: 'File upload',
  submit: 'Form submit',
  send: 'Chat message',
};

export function categoryLabel(id) {
  if (id === 'other') return Sites.OTHER.plural;
  return Sites.CATEGORIES.find((c) => c.id === id)?.plural || id;
}

/** Metadata-only record for reporting. Never contains matched text. */
export function reportRecord(i) {
  return {
    id: i.id,
    time: new Date(i.time).toISOString(),
    domain: i.domain,
    category: i.category,
    channel: i.channel,
    action: i.action,
    detectors: (i.detectors || []).map((d) => ({ id: d.id, label: d.label, count: d.count, kinds: d.kinds || [] })),
    files: i.files || 0,
    justification: i.justification || '',
    browser: i.browser || '',
  };
}

export { DEFAULTS };

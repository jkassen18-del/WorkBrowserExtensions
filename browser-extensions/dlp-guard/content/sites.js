// Site classification for Data Leak Guard.
// Classic script (content scripts) that can also be imported for its side effect by
// module pages and the background: `import '../content/sites.js'; const S = globalThis.WxSites;`
(function () {
  'use strict';
  if (globalThis.WxSites) return;

  const CATEGORIES = [
    { id: 'ai', label: 'AI chatbot', plural: 'AI chatbots', key: 'aiSites',
      description: 'Chat assistants and AI tools. Text pasted here may be stored or used for training.' },
    { id: 'email', label: 'Personal email', plural: 'Personal email', key: 'emailSites',
      description: 'Private webmail outside company control.' },
    { id: 'files', label: 'File sharing', plural: 'File sharing & paste sites', key: 'fileSites',
      description: 'Upload, transfer and paste sites that make content public or shareable.' },
    { id: 'social', label: 'Social & messaging', plural: 'Social & messaging', key: 'socialSites',
      description: 'Social networks and personal messengers.' },
  ];
  const OTHER = { id: 'other', label: 'Other site', plural: 'Other sites', key: null,
    description: 'Every site not in a list above and not approved.' };
  const MODES = ['off', 'monitor', 'warn', 'block'];
  const RANK = { off: 0, site: 1, monitor: 1, warn: 2, block: 3 };
  const MODE_LABELS = { off: 'Off', monitor: 'Monitor (log only)', warn: 'Warn', block: 'Block' };

  /** "https://www.Example.com/a" -> { host: "example.com" (www stripped), fullHost, path } or null. */
  function parse(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const fullHost = u.hostname.toLowerCase().replace(/\.$/, '');
      return { fullHost, host: fullHost.replace(/^www\./, ''), path: u.pathname.toLowerCase() };
    } catch (e) {
      return null;
    }
  }

  /** Cleans a user-entered entry: strips scheme, query and trailing slash; "*.x.com" -> "x.com". */
  function cleanEntry(entry) {
    return String(entry || '').trim().toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/[?#].*$/, '')
      .replace(/^\*\./, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  }

  /** Does a list entry ("example.com" or "example.com/path") match this parsed URL? */
  function matches(entry, p) {
    const e = cleanEntry(entry);
    if (!e || !p) return false;
    const slash = e.indexOf('/');
    const host = slash < 0 ? e : e.slice(0, slash);
    const path = slash < 0 ? '' : e.slice(slash);
    const hostOk = p.fullHost === host || p.fullHost.endsWith(`.${host}`);
    if (!hostOk) return false;
    if (!path) return true;
    return p.path === path || p.path.startsWith(path.endsWith('/') ? path : `${path}/`);
  }

  function findEntry(list, p) {
    return (Array.isArray(list) ? list : []).find((e) => matches(e, p)) || null;
  }

  /**
   * Classifies a URL with the given settings.
   * Returns { checked, category, label, mode, host, entry, reason }.
   */
  function classify(url, s) {
    const p = parse(url);
    if (!p) return { checked: false, category: 'none', label: 'Browser page', mode: 'off', host: '', reason: 'unsupported' };
    const base = { host: p.host };
    if (!s || s.enabled === false) return { ...base, checked: false, category: 'disabled', label: 'Protection off', mode: 'off', reason: 'disabled' };
    const approved = findEntry(s.approvedSites, p);
    if (approved) return { ...base, checked: false, category: 'approved', label: 'Approved site', mode: 'off', entry: approved, reason: 'approved' };
    const modes = s.categoryModes || {};
    for (const c of CATEGORIES) {
      const entry = findEntry(s[c.key], p);
      if (entry) {
        const mode = MODES.includes(modes[c.id]) ? modes[c.id] : 'warn';
        return { ...base, checked: mode !== 'off', category: c.id, label: c.label, mode, entry, reason: 'list' };
      }
    }
    const mode = MODES.includes(modes.other) ? modes.other : 'monitor';
    return { ...base, checked: mode !== 'off', category: 'other', label: OTHER.label, mode, reason: 'other' };
  }

  const stricter = (a, b) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b);

  /** Effective action for a detector mode on a site mode. "site" follows the site. */
  function effective(siteMode, detectorMode) {
    const m = stricter(siteMode, detectorMode || 'site');
    return m === 'site' ? siteMode : m;
  }

  globalThis.WxSites = { CATEGORIES, OTHER, MODES, MODE_LABELS, RANK, parse, cleanEntry, matches, findEntry, classify, stricter, effective };
})();

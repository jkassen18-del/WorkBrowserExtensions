// Every setting with its default. IT can suggest (policy "defaults") or enforce (top-level policy key) any of them.

// Built-in rules make the extension useful straight after install. Users can disable, edit, reorder or delete them.
// First match wins, so rules the user adds go on top.
export const BUILTIN_RULES = [
  { id: 'builtin-localhost', pattern: 'localhost', env: 'dev', label: 'Local machine', enabled: true },
  { id: 'builtin-subdomain-localhost', pattern: '*.localhost', env: 'dev', label: 'Local machine', enabled: true },
  { id: 'builtin-loopback', pattern: '127.0.0.1', env: 'dev', label: 'Local machine', enabled: true },
  { id: 'builtin-ipv6-loopback', pattern: '[::1]', env: 'dev', label: 'Local machine', enabled: true },
  { id: 'builtin-local', pattern: '*.local', env: 'dev', label: 'Local network name', enabled: true },
  { id: 'builtin-test', pattern: '*.test', env: 'dev', label: 'Test domain', enabled: true },
  {
    id: 'builtin-staging',
    pattern: '/^\\w+:\\/\\/([^\\/?#]*[^a-z\\/?#])?(staging|stage|stg|uat|qa|preprod|pre-prod)([^a-z\\/?#][^\\/?#]*)?([\\/?#]|$)/i',
    env: 'staging',
    label: 'Staging-like host name',
    enabled: true,
  },
  { id: 'builtin-port', pattern: '*:*', env: 'dev', label: 'Host with a port number', enabled: true },
];

export const DEFAULT_ENVIRONMENTS = [
  { id: 'prod', name: 'Production', short: 'PROD', color: '#DC2626', textColor: '', confirmSubmit: true, ribbon: true, titlePrefix: true, favicon: true, badge: true },
  { id: 'staging', name: 'Staging', short: 'STG', color: '#F59E0B', textColor: '', confirmSubmit: false, ribbon: true, titlePrefix: true, favicon: true, badge: true },
  { id: 'dev', name: 'Development', short: 'DEV', color: '#16A34A', textColor: '', confirmSubmit: false, ribbon: true, titlePrefix: true, favicon: true, badge: true },
  { id: 'demo', name: 'Demo', short: 'DEMO', color: '#7C3AED', textColor: '', confirmSubmit: false, ribbon: true, titlePrefix: true, favicon: true, badge: true },
];

export default {
  enabled: true,
  rules: BUILTIN_RULES,
  environments: DEFAULT_ENVIRONMENTS,
  style: 'ribbon',
  position: 'top-right',
  size: 'medium',
  opacity: 92,
  titleFormat: '[{short}] ',
  hideSeconds: 60,
  showRibbon: true,
  showTitlePrefix: true,
  showFavicon: true,
  showBadge: true,
  confirmSubmit: true,
  ruleSources: [],
  remoteRefreshHours: 12,
  shareRules: false,
};

export const DESCRIPTIONS = {
  enabled: 'Master switch. When off, no labels are shown anywhere.',
  rules: 'Ordered list of rules { id, pattern, env, label, enabled }. First match wins. Pattern: exact host, *.wildcard host, host:port, URL prefix (https://x.com/admin*), host/path, or /regex/.',
  environments: 'Environments { id, name, short, color, textColor ("" = automatic), confirmSubmit, ribbon, titlePrefix, favicon, badge }.',
  style: 'Page indicator style: ribbon (corner ribbon), bar (full-width bar) or frame (coloured border around the page).',
  position: 'Corner for the ribbon or frame tag: top-left, top-right, bottom-left, bottom-right. The bar uses the top or bottom edge.',
  size: 'Indicator size: small, medium or large.',
  opacity: 'Indicator opacity in percent (30-100).',
  titleFormat: 'Text put in front of the tab title. Placeholders: {short}, {name}, {label}.',
  hideSeconds: 'Clicking the indicator hides it for this many seconds (0 = until the page is reloaded).',
  showRibbon: 'Show the page indicator (ribbon, bar or frame).',
  showTitlePrefix: 'Add the environment prefix to tab titles.',
  showFavicon: 'Tint the site favicon with the environment colour.',
  showBadge: 'Show the environment on the toolbar icon badge.',
  confirmSubmit: 'Ask "Are you sure?" before submitting forms on environments that have confirmation turned on.',
  ruleSources: 'URLs of JSON rule files ({ environments: [...], rules: [...] }) merged after the local rules.',
  remoteRefreshHours: 'How often remote rule files are fetched again (hours, 0 = only on demand).',
  shareRules: 'Push your own rules to the linked shared backend (Settings -> Shared data) when syncing.',
};

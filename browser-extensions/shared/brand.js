// Brand kit: name, logo, colours and support links. Precedence:
//   built-in kit (shared/brand.json, written by the build from brand/brand.json)
//   < user's Settings -> Branding override (storage.local "brandOverride")
//   < policy "brand" object (enforced, locked in the UI)
import { api, url } from './api.js';
import { readManaged } from './settings.js';

export const BRAND_FIELDS = [
  'companyName', 'productPrefix', 'logo', 'primary', 'accent', 'theme', 'radius',
  'supportUrl', 'supportEmail', 'footerText',
];

export const FALLBACK_BRAND = {
  companyName: 'My Company',
  productPrefix: '',
  logo: '',
  primary: '#4F46E5',
  accent: '#0EA5E9',
  theme: 'auto',
  radius: 10,
  supportUrl: '',
  supportEmail: '',
  footerText: '',
};

let bundled = null;
async function loadBundled() {
  if (bundled) return bundled;
  try {
    const res = await fetch(url('shared/brand.json'));
    bundled = { ...FALLBACK_BRAND, ...(await res.json()) };
  } catch {
    bundled = { ...FALLBACK_BRAND };
  }
  return bundled;
}

/** Returns { brand, locked:Set, bundled, override }. */
export async function loadBrandState() {
  const base = await loadBundled();
  const { brandOverride = {} } = await api.storage.local.get('brandOverride');
  const managed = (await readManaged()).brand || {};
  const brand = { ...base, ...brandOverride, ...managed };
  brand.radius = Number(brand.radius) || 0;
  return { brand, locked: new Set(Object.keys(managed)), bundled: base, override: brandOverride };
}

export async function loadBrand() {
  return (await loadBrandState()).brand;
}

export async function saveBrandOverride(override) {
  await api.storage.local.set({ brandOverride: override });
}

export function onBrandChange(cb) {
  const listener = async (changes, area) => {
    if ((area === 'local' && 'brandOverride' in changes) || area === 'managed') cb(await loadBrand());
  };
  api.storage.onChanged.addListener(listener);
  return () => api.storage.onChanged.removeListener(listener);
}

export function productName(brand, baseName) {
  return brand.productPrefix ? `${brand.productPrefix} ${baseName}` : baseName;
}

/** Logo as an <img>-ready URL (bundled path, http(s) URL or data: URI). */
export function logoSrc(brand) {
  const l = brand.logo || '';
  if (!l) return '';
  if (/^(data:|https?:|chrome-extension:|moz-extension:)/.test(l)) return l;
  return url(`shared/${l.replace(/^\.?\//, '')}`);
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [79, 70, 229];
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** Readable text colour (black/white) for a background. */
export function contrastText(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.4 ? '#0b1020' : '#ffffff';
}

/** Applies the brand to a document: CSS variables and theme. */
export function applyBrand(brand, doc = document) {
  const root = doc.documentElement;
  const [r, g, b] = hexToRgb(brand.primary);
  root.style.setProperty('--wx-primary', brand.primary);
  root.style.setProperty('--wx-primary-rgb', `${r}, ${g}, ${b}`);
  root.style.setProperty('--wx-on-primary', contrastText(brand.primary));
  root.style.setProperty('--wx-accent', brand.accent);
  root.style.setProperty('--wx-radius', `${brand.radius}px`);
  if (brand.theme === 'light' || brand.theme === 'dark') root.dataset.theme = brand.theme;
  else delete root.dataset.theme;
}

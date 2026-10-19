// Link directory and onboarding hub: every link from every list, searchable, grouped by
// list/department and tags. Personal links can be edited here too.
import { api } from '/shared/api.js';
import { h, add, clear, toast, copyText, confirmDialog, debounce, timeAgo } from '/shared/ui.js';
import { brandPage } from '/shared/app-shell.js';
import { productName, logoSrc } from '/shared/brand.js';
import * as L from '../lib/links.js';
import { openLinkForm } from '../lib/link-form.js';

const brand = await brandPage('Go-Links', { titleSuffix: 'Directory' });
const NEW_DAYS = 30;
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

const state = {
  q: new URLSearchParams(location.search).get('q') || '',
  group: '',
  tag: '',
  view: store.get('go-dir-view', 'grid'),
};
let merged = await L.loadMerged();

const search = h('input', {
  type: 'search', value: state.q, placeholder: 'Search links by name, title, tag or description…', 'aria-label': 'Search links', autocomplete: 'off',
});
const viewBtn = h('button.btn', { title: 'Switch between cards and a compact list', onclick: () => {
  state.view = state.view === 'grid' ? 'list' : 'grid';
  store.set('go-dir-view', state.view);
  paint();
} });
const chips = h('div');
const content = h('div');
const logo = logoSrc(brand);

document.body.append(
  h('header.go-page-header',
    logo ? h('img.wx-logo', { src: logo, alt: '' }) : h('div.wx-logo-fallback', (brand.companyName || 'G').charAt(0).toUpperCase()),
    h('div.grow', h('div.title', `${productName(brand, 'Go-Links')} directory`),
      h('div.sub', `Every go-link you can use${brand.companyName ? ` at ${brand.companyName}` : ''}`)),
    h('button.btn.ghost.sm', { onclick: () => api.runtime.openOptionsPage() }, '⚙ Settings')),
  h('main.go-page',
    h('div.go-hero-search', search,
      h('button.btn.primary', { onclick: () => newLink() }, '+ New link'), viewBtn),
    chips,
    content),
);

async function newLink(prefill) {
  if (await openLinkForm({ prefill })) await reload();
}

async function reload() {
  merged = await L.loadMerged();
  paint();
}

const groupOf = (e) => (e.list === 'personal' ? 'My links' : e.department || e.sourceName || 'Shared');

function chip(label, count, pressed, onclick) {
  return h('button.go-chip', { 'aria-pressed': String(pressed), onclick }, label, count != null ? h('span.count', count) : null);
}

function paintChips() {
  const groups = new Map();
  const tags = new Map();
  for (const e of merged.visible) {
    groups.set(groupOf(e), (groups.get(groupOf(e)) || 0) + 1);
    for (const t of e.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  }
  const topTags = [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 18);
  clear(chips,
    groups.size > 1 ? h('div.go-chips', h('span.small.muted', { style: { alignSelf: 'center', marginRight: '4px' } }, 'Lists'),
      chip('All', merged.visible.length, !state.group, () => { state.group = ''; paint(); }),
      [...groups.entries()].map(([g, n]) => chip(g, n, state.group === g, () => { state.group = state.group === g ? '' : g; paint(); }))) : null,
    topTags.length ? h('div.go-chips', h('span.small.muted', { style: { alignSelf: 'center', marginRight: '4px' } }, 'Tags'),
      topTags.map(([t, n]) => chip(`#${t}`, n, state.tag === t, () => { state.tag = state.tag === t ? '' : t; paint(); }))) : null);
}

function card(e) {
  const go = `go/${e.name}`;
  return h('div.go-card',
    h('div.go-main',
      h('div.row', { style: { flexWrap: 'nowrap', gap: '6px' } },
        h('a.go-name.grow', { href: e.url, title: e.url, onclick: (ev) => { ev.preventDefault(); L.openEntry(e); } }, go),
        e.shadowedBy ? h('span.badge.warn', { title: `Your own go/${e.name} is used instead` }, 'Overridden') : null,
        e.overrides?.length ? h('span.badge.warn', { title: `Replaces go/${e.name} from ${e.overrides.join(', ')} for you` }, `Overrides ${e.overrides[0]}`) : null),
      e.title ? h('div.go-title', e.title) : null,
      e.description ? h('div.go-desc', e.description) : null,
      h('span.go-url', e.url)),
    e.tags?.length ? h('div.go-tags', (e.tags || []).slice(0, 4).map((t) => h('button.go-chip.go-tag', { title: `Show #${t}`, onclick: () => { state.tag = t; paint(); } }, `#${t}`))) : null,
    h('div.go-foot',
      e.readOnly ? h('span.badge', e.sourceName) : h('span.badge.primary', 'Yours'),
      e.clicks ? h('span.small.muted', { title: e.lastUsed ? `Last used ${timeAgo(e.lastUsed)}` : '' }, `${e.clicks} visit${e.clicks === 1 ? '' : 's'}`) : null,
      h('span.grow'),
      h('button.btn.sm.ghost', { title: `Copy ${go}`, onclick: async () => { if (await copyText(go)) toast(`Copied ${go}`); } }, 'Copy'),
      h('button.btn.sm', { onclick: () => L.openEntry(e) }, 'Open'),
      e.readOnly ? null : [
        h('button.btn.sm.ghost', { title: 'Edit', 'aria-label': `Edit ${go}`, onclick: async () => {
          const raw = (await L.personal.all()).find((x) => x.id === e.id);
          if (raw && (await openLinkForm({ link: raw }))) await reload();
        } }, '✎'),
        h('button.btn.sm.ghost.danger', { title: 'Delete', 'aria-label': `Delete ${go}`, onclick: async () => {
          if (!(await confirmDialog(`Delete ${go}?`, 'This removes the link from this browser.', { okLabel: 'Delete', danger: true }))) return;
          await L.deletePersonal(e.id);
          toast(`Deleted ${go}`);
          await reload();
        } }, '🗑'),
      ]));
}

const cards = (list) => h(state.view === 'list' ? 'div.go-list' : 'div.go-cards', list.map(card));
const section = (title, note, list) => (list.length ? [h('div.go-section-title', h('h2', title), note ? h('span.small.muted', note) : null), cards(list)] : null);

function paint() {
  viewBtn.textContent = state.view === 'grid' ? '☰ List' : '▦ Cards';
  paintChips();
  if (!merged.entries.length) {
    clear(content, h('div.card', h('div.empty',
      h('div', { style: { fontSize: '40px' } }, '🔗'),
      h('div.empty-title', 'No go-links yet'),
      h('p', 'Add your own short links (go/payroll, go/vpn…) and they work right away in the address bar.'),
      h('div.row', { style: { justifyContent: 'center' } },
        h('button.btn.primary', { onclick: () => newLink() }, 'Add your first link'),
        h('button.btn', { onclick: () => { location.href = api.runtime.getURL('options/options.html#sources'); } }, 'Add a team link list')))));
    return;
  }
  const q = state.q.trim();
  let list = merged.visible;
  if (state.group) list = list.filter((e) => groupOf(e) === state.group);
  if (state.tag) list = list.filter((e) => (e.tags || []).includes(state.tag));

  if (q || state.group || state.tag) {
    const found = q ? L.search(list, q, 500) : [...list].sort((a, b) => a.name.localeCompare(b.name));
    clear(content,
      h('div.go-section-title', h('h2', `${found.length} link${found.length === 1 ? '' : 's'}`),
        h('span.small.muted', [q && `matching "${q}"`, state.group && `in ${state.group}`, state.tag && `tagged #${state.tag}`].filter(Boolean).join(' · ')),
        h('button.btn.sm.ghost', { onclick: () => { state.q = ''; state.group = ''; state.tag = ''; search.value = ''; paint(); } }, 'Clear')),
      found.length ? cards(found) : h('div.card', h('div.empty',
        h('div.empty-title', q ? `Nothing matches "${q}"` : 'Nothing here'),
        q ? h('div.row', { style: { justifyContent: 'center', marginTop: '8px' } },
          h('button.btn.primary', { onclick: () => newLink({ name: L.normalizeName(q) }) }, `Create go/${L.normalizeName(q)}`)) : null)));
    return;
  }

  const onboarding = merged.visible.filter((e) => (e.tags || []).includes('onboarding'));
  const popular = merged.visible.filter((e) => e.clicks > 0).sort((a, b) => b.clicks - a.clicks).slice(0, 6);
  const cutoff = Date.now() - NEW_DAYS * 864e5;
  const fresh = merged.visible.filter((e) => e.createdAt && e.createdAt > cutoff).sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
  const groups = new Map();
  for (const e of merged.entries) {
    const g = groupOf(e);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }

  clear(content,
    onboarding.length ? h('section.go-onboarding',
      h('h2', '👋 New here? Start with these'),
      h('p.small.muted', 'Links tagged "onboarding" by your team.'),
      h('ol', onboarding.map((e) => h('li',
        h('a.go-name', { href: e.url, onclick: (ev) => { ev.preventDefault(); L.openEntry(e); } }, `go/${e.name}`),
        e.title ? h('span.muted', ` · ${e.title}`) : null)))) : null,
    section('Popular', 'most used in this browser', popular),
    section('New', `added in the last ${NEW_DAYS} days`, fresh),
    [...groups.entries()].map(([g, list]) => section(g, `${list.length} link${list.length === 1 ? '' : 's'}`,
      [...list].sort((a, b) => a.name.localeCompare(b.name)))));
}

search.addEventListener('input', debounce(() => { state.q = search.value; paint(); }, 120));
search.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const r = L.resolveIn(merged, search.value, merged.state.caseInsensitive);
  if (r.found) L.openEntry(r.entry, { rest: r.rest, query: r.query });
});
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['links', 'sources', 'sourceLinks', 'linkStats', 'settings'].some((k) => k in changes)) reload();
});
paint();
search.focus();

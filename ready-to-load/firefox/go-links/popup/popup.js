import { api } from '/shared/api.js';
import { mountPopup } from '/shared/app-shell.js';
import { h, add, clear, toast, copyText } from '/shared/ui.js';
import * as L from '../lib/links.js';
import { availability } from '../lib/link-form.js';

const { body } = await mountPopup('Go-Links', { optionsHash: 'links' });
let merged = await L.loadMerged();
let selected = 0;
let shown = [];

const [tab] = await api.tabs.query({ active: true, currentWindow: true }).catch(() => []);
const pageUrl = tab?.url && /^https?:/i.test(tab.url) ? tab.url : '';

const q = h('input', { type: 'search', placeholder: 'Search or type go/name…', 'aria-label': 'Search go-links', autocomplete: 'off', spellcheck: false });
const results = h('div.go-results', { role: 'listbox' });

function topLinks() {
  return [...merged.visible]
    .sort((a, b) => (b.clicks - a.clicks) || ((b.lastUsed || 0) - (a.lastUsed || 0)) || ((b.createdAt || 0) - (a.createdAt || 0)))
    .slice(0, 5);
}

async function open(entry, extra = {}) {
  await L.openEntry(entry, extra);
  window.close();
}

async function openTyped() {
  const text = q.value.trim();
  if (!text) return shown[selected] && open(shown[selected]);
  const r = L.resolveIn(merged, text, merged.state.caseInsensitive);
  if (shown[selected] && selected > 0) return open(shown[selected]);
  if (r.found) return open(r.entry, { rest: r.rest, query: r.query });
  if (shown[0]) return open(shown[0]);
  await L.openUrl(L.resolverUrl(encodeURI(text.replace(/^go\//i, '').replace(/^(\S+)\s+/, '$1/'))));
  window.close();
}

function paintResults() {
  const text = q.value.trim();
  shown = text ? L.suggest(merged.visible, text, 8) : topLinks();
  if (selected >= shown.length) selected = 0;
  if (!merged.visible.length) {
    clear(results, h('div.empty', { style: { padding: '14px 8px' } },
      h('div.empty-title', 'No go-links yet'),
      h('div.small', 'Create one for this page below, or add your company\'s link list in Settings → Sources.')));
    return;
  }
  if (!shown.length) {
    const name = L.normalizeName(L.parseInput(text).segments[0] || text);
    clear(results, h('div.small.muted', { style: { padding: '8px' } },
      'No match for ', h('b', `go/${name}`), '. Press Enter to create it, or use the form below.'));
    if (!nameIn.value || nameIn.dataset.auto) {
      nameIn.value = name;
      nameIn.dataset.auto = '1';
      avail.update(name);
    }
    return;
  }
  clear(results,
    text ? null : h('div.small.muted', { style: { padding: '0 8px 4px' } }, 'Popular'),
    shown.map((e, i) => h('button.go-result', {
      role: 'option',
      'aria-selected': String(i === selected),
      title: e.url,
      onclick: () => open(e),
      onmouseenter: () => { selected = i; markSelected(); },
    },
    h('div.row', { style: { flexWrap: 'nowrap' } },
      h('span.go-name.grow', `go/${e.name}`),
      e.readOnly ? h('span.badge', e.sourceName) : null),
    h('div.go-title', e.title || e.description || e.url))));
}

function markSelected() {
  results.querySelectorAll('.go-result').forEach((b, i) => b.setAttribute('aria-selected', String(i === selected)));
}

q.addEventListener('input', () => { selected = 0; paintResults(); });
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, shown.length - 1); markSelected(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); markSelected(); }
  else if (e.key === 'Enter') { e.preventDefault(); openTyped(); }
});

// ---- Create a link for the current page ----------------------------------------------
const nameIn = h('input', { type: 'text', placeholder: 'name', autocomplete: 'off', spellcheck: false, 'aria-label': 'Name' });
const urlIn = h('input', { type: 'url', value: pageUrl, placeholder: 'https://', 'aria-label': 'URL' });
const titleIn = h('input', { type: 'text', value: pageUrl ? tab?.title || '' : '', placeholder: 'Title (optional)', 'aria-label': 'Title' });
const avail = availability(merged);
avail.update('');
nameIn.addEventListener('input', () => { delete nameIn.dataset.auto; avail.update(nameIn.value); });
const created = h('div');

const form = h('form', {
  onsubmit: async (e) => {
    e.preventDefault();
    try {
      const rec = await L.savePersonal({ name: nameIn.value, url: urlIn.value.trim(), title: titleIn.value });
      merged = await L.loadMerged();
      await copyText(`go/${rec.name}`);
      clear(created, h('div.notice', { style: { margin: '10px 0 0' } }, h('b', `go/${rec.name}`), ' saved and copied to the clipboard.'));
      nameIn.value = '';
      avail.update('');
      paintResults();
    } catch (ex) {
      toast(ex.message, { error: true });
    }
  },
},
h('div.field', { style: { marginBottom: '8px' } }, h('div.go-prefix-input', h('span', 'go/'), nameIn), avail.el),
h('div.field', { style: { marginBottom: '8px' } }, urlIn),
h('div.field', { style: { marginBottom: '8px' } }, titleIn),
h('button.btn.primary.block', { type: 'submit' }, 'Save go-link'));

const details = h('details.go-popup-section', { open: !!pageUrl && !merged.visible.length },
  h('summary', pageUrl ? 'Create a go-link for this page' : 'Create a go-link'),
  h('div', { style: { marginTop: '10px' } }, form, created));

add(body,
  q,
  results,
  details,
  h('div.row.between', { style: { marginTop: '12px' } },
    h('button.btn.sm', { onclick: () => { api.tabs.create({ url: api.runtime.getURL('directory/directory.html') }); window.close(); } }, '📚 Link directory'),
    h('span.small.muted', h('kbd', 'go'), ' + space in the address bar')));

paintResults();
q.focus();

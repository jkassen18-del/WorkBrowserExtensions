import { api } from '/shared/api.js';
import { mountApp } from '/shared/app-shell.js';
import { h, add, clear, toast, confirmDialog, modal, download, pickFile, copyText, debounce, timeAgo, formatDate, toggle, lockedBadge } from '/shared/ui.js';
import { requestHostAccess } from '/shared/connections.js';
import { settings } from '../settings.js';
import * as L from '../lib/links.js';
import { openLinkForm } from '../lib/link-form.js';

const DIRECTORY = api.runtime.getURL('directory/directory.html');
const CAPTURE_HOSTS = (api.runtime.getManifest().host_permissions || []);

// ---- My links ---------------------------------------------------------------------------

async function renderLinks(el, ctx) {
  let merged = await L.loadMerged();
  const selected = new Set();
  let query = '';
  const body = h('div');
  const bulk = h('button.btn.danger', { onclick: bulkDelete }, 'Delete selected');
  const search = h('input', { type: 'search', placeholder: 'Search your links…', 'aria-label': 'Search your links' });
  search.addEventListener('input', debounce(() => { query = search.value; paint(); }, 120));

  async function reload() {
    merged = await L.loadMerged();
    for (const id of [...selected]) if (!merged.entries.some((e) => e.id === id)) selected.delete(id);
    paint();
  }

  async function bulkDelete() {
    if (!selected.size) return;
    if (!(await confirmDialog(`Delete ${selected.size} link${selected.size === 1 ? '' : 's'}?`, 'They are removed from this browser. Export first if you want a copy.', { okLabel: 'Delete', danger: true }))) return;
    await L.deletePersonal([...selected]);
    toast(`Deleted ${selected.size} link${selected.size === 1 ? '' : 's'}`);
    selected.clear();
    reload();
  }

  async function importFile() {
    const f = await pickFile('.json,.csv,application/json,text/csv');
    if (!f) return;
    try {
      const text = await f.text();
      const data = /\.csv$/i.test(f.name) || !/^\s*[[{]/.test(text) ? L.parseCSV(text) : JSON.parse(text);
      const r = await L.importPersonal(data);
      toast(`Imported: ${r.added} new, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped (missing or invalid name/URL)` : ''}`, { error: !r.added && !r.updated });
      reload();
    } catch (e) {
      toast(`Could not import that file: ${e.message}`, { error: true });
    }
  }

  function paint() {
    const mine = merged.entries.filter((e) => e.list === 'personal');
    const q = query.trim();
    const rows = q ? L.search(mine, q, 1000) : [...mine].sort((a, b) => a.name.localeCompare(b.name));
    bulk.disabled = !selected.size;
    bulk.textContent = selected.size ? `Delete selected (${selected.size})` : 'Delete selected';
    if (!mine.length) {
      clear(body, h('div.card', h('div.empty',
        h('div', { style: { fontSize: '36px' } }, '🔗'),
        h('div.empty-title', 'Add your first go-link'),
        h('p', 'Pick a short name and a destination, e.g. ', h('code', 'payroll'), ' → your payroll site. Then type ',
          h('kbd', 'go/payroll'), ' in the address bar, or ', h('kbd', 'go'), ' + space + ', h('kbd', 'payroll'), '.'),
        h('div.row', { style: { justifyContent: 'center' } },
          h('button.btn.primary', { onclick: add1 }, '+ Add link'),
          h('button.btn', { onclick: importFile }, 'Import JSON or CSV'),
          h('button.btn', { onclick: () => ctx.navigate('sources') }, 'Use a team link list')))));
      return;
    }
    const allBox = h('input', { type: 'checkbox', 'aria-label': 'Select all', checked: rows.length > 0 && rows.every((r) => selected.has(r.id)) });
    allBox.addEventListener('change', () => {
      rows.forEach((r) => (allBox.checked ? selected.add(r.id) : selected.delete(r.id)));
      paint();
    });
    clear(body, h('div.card', { style: { padding: '6px 8px' } }, h('div.table-wrap', h('table.table.go-table',
      h('thead', h('tr', h('th', { style: { width: '28px' } }, allBox), h('th', 'Name'), h('th', 'Destination'), h('th', 'Tags'), h('th', 'Visits'), h('th', 'Last used'), h('th'))),
      h('tbody', rows.length ? rows.map((e) => {
        const box = h('input', { type: 'checkbox', checked: selected.has(e.id), 'aria-label': `Select go/${e.name}` });
        box.addEventListener('change', () => { box.checked ? selected.add(e.id) : selected.delete(e.id); bulk.disabled = !selected.size; bulk.textContent = selected.size ? `Delete selected (${selected.size})` : 'Delete selected'; });
        return h('tr',
          h('td', box),
          h('td',
            h('div.go-name', `go/${e.name}`),
            e.aliases?.length ? h('div.small.muted', `also ${e.aliases.map((a) => `go/${a}`).join(', ')}`) : null,
            e.overrides?.length ? h('span.badge.warn', { title: 'Your link is used instead of the shared one with the same name' }, `Overrides ${e.overrides.join(', ')}`) : null),
          h('td', e.title ? h('div', e.title) : null, h('a.go-url', { href: e.url, target: '_blank', rel: 'noopener', title: e.url }, e.url)),
          h('td', h('div.go-tags', (e.tags || []).map((t) => h('span.badge', t)))),
          h('td', String(e.clicks || 0)),
          h('td.small.muted', e.lastUsed ? timeAgo(e.lastUsed) : 'never'),
          h('td.go-actions',
            h('button.btn.sm.ghost', { title: 'Copy go-link', onclick: async () => { if (await copyText(`go/${e.name}`)) toast(`Copied go/${e.name}`); } }, 'Copy'),
            h('button.btn.sm', { onclick: async () => { const raw = (await L.personal.all()).find((x) => x.id === e.id); if (raw && (await openLinkForm({ link: raw }))) reload(); } }, 'Edit'),
            h('button.btn.sm.ghost.danger', { 'aria-label': `Delete go/${e.name}`, title: 'Delete', onclick: async () => {
              if (!(await confirmDialog(`Delete go/${e.name}?`, 'This removes the link from this browser.', { okLabel: 'Delete', danger: true }))) return;
              await L.deletePersonal(e.id);
              selected.delete(e.id);
              reload();
            } }, '🗑')));
      }) : h('tr', h('td', { colSpan: 7 }, h('div.empty', `No links match "${q}".`))))))),
    h('p.small.muted', `${mine.length} personal link${mine.length === 1 ? '' : 's'}. Links from shared lists are under Sources and in the directory.`));
  }

  async function add1() {
    if (await openLinkForm()) reload();
  }

  add(el,
    h('div.row.between', h('h1', 'My links'), h('a.btn', { href: DIRECTORY, target: '_blank' }, '📚 Open directory')),
    h('p.muted', 'Your own short links. They work right away: type ', h('kbd', 'go/name'), ' in the address bar or ', h('kbd', 'go'), ' + space + name. Nothing leaves this browser.'),
    h('div.go-toolbar',
      search,
      h('button.btn.primary', { onclick: add1 }, '+ Add link'),
      h('button.btn', { onclick: importFile }, 'Import'),
      h('button.btn', { onclick: async () => download(`go-links-${new Date().toISOString().slice(0, 10)}.json`, { name: 'My go-links', links: (await L.personal.all()).map(exportable) }) }, 'Export JSON'),
      h('button.btn', { onclick: async () => download(`go-links-${new Date().toISOString().slice(0, 10)}.csv`, L.toCSV(await L.personal.all()), 'text/csv') }, 'Export CSV'),
      bulk),
    body);
  paint();
}

const exportable = ({ name, url, title, description, tags, aliases, owner }) => ({ name, url, title, description, tags, aliases, ...(owner ? { owner } : {}) });

// ---- Sources ----------------------------------------------------------------------------

function statusBadge(s) {
  if (s.status === 'ok') return h('span.badge.ok', { title: `Updated ${formatDate(s.lastFetched)}` }, `✓ ${s.count} link${s.count === 1 ? '' : 's'}`);
  if (s.status === 'error') return h('span.badge.danger', { title: s.error }, 'Error');
  return h('span.badge', 'Not loaded yet');
}

/** Asks for access to a list's host. Must run first in a click handler (user gesture). */
async function grantFor(url) {
  if (String(url).startsWith('bundled:')) return true;
  return requestHostAccess(url);
}

async function renderSources(el, ctx) {
  const body = h('div');
  const conflictsEl = h('div');

  function sourceForm(src = {}) {
    return modal(src.id ? `Edit ${src.name || 'list'}` : 'Add a link list', (close) => {
      const name = h('input', { type: 'text', value: src.name || '', placeholder: 'Company, Engineering, HR…' });
      const url = h('input', { type: 'url', value: src.url?.startsWith('bundled:') ? '' : src.url || '', placeholder: 'https://intranet.example.com/go-links.json', required: true, disabled: !!src.managed || src.url?.startsWith('bundled:') });
      const dept = h('input', { type: 'text', value: src.department || '', placeholder: 'Optional, used to group the directory' });
      const err = h('div.notice.danger.hidden');
      return h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          const u = src.url?.startsWith('bundled:') ? src.url : url.value.trim();
          const changedUrl = u !== src.url;
          if (changedUrl && !(await grantFor(u))) {
            err.textContent = 'Access to that address was not granted, so the list cannot be downloaded.';
            return err.classList.remove('hidden');
          }
          try {
            const res = src.id
              ? await L.updateSource(src.id, { name: name.value.trim(), department: dept.value.trim(), ...(changedUrl ? { url: u } : {}) })
              : await L.addSource({ name: name.value, url: u, department: dept.value });
            if (res?.status === 'error') toast(`Saved, but the list could not be loaded: ${res.error}`, { error: true });
            else toast(`${res?.name || 'List'} saved${res?.count != null ? ` · ${res.count} links` : ''}`);
            close(true);
          } catch (ex) {
            err.textContent = ex.message;
            err.classList.remove('hidden');
          }
        },
      },
      err,
      h('div.field', h('label', 'List URL'), url, h('div.hint', 'A JSON file anywhere your browser can reach: intranet, SharePoint, a GitHub raw link… Format: { "name": "Company", "links": [{ "name", "url", "title", "description", "tags", "aliases" }] } or just the array.')),
      h('div.grid-2', h('div.field', h('label', 'Name'), name, h('div.hint', 'Leave empty to use the name in the file.')), h('div.field', h('label', 'Department'), dept)),
      h('div.row.end', h('button.btn', { type: 'button', onclick: () => close(false) }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, src.id ? 'Save' : 'Add list')));
    });
  }

  async function paint() {
    const sources = await L.getSources();
    const merged = await L.loadMerged();
    const usedExamples = new Set(sources.map((s) => s.url));
    clear(body, sources.length ? h('div.card', { style: { padding: '6px 8px' } }, h('div.table-wrap', h('table.table.go-table',
      h('thead', h('tr', h('th', 'On'), h('th', 'List'), h('th', 'Status'), h('th', 'Updated'), h('th'))),
      h('tbody', sources.map((s) => h('tr',
        h('td', toggle(s.enabled, async (v) => { await L.updateSource(s.id, { enabled: v }); paint(); }, { label: `Use ${s.name}` })),
        h('td',
          h('div', h('b', s.name || 'Untitled list'), ' ', s.department && s.department !== s.name ? h('span.badge', s.department) : null, ' ', s.managed ? lockedBadge() : null),
          h('span.go-url', { title: s.url }, s.kind === 'connection' ? 'From the linked shared database (Shared data panel)' : L.sourceDisplayUrl(s.url))),
        h('td', statusBadge(s), s.status === 'error' ? h('div.small', { style: { color: 'var(--wx-danger)', maxWidth: '260px' } }, s.error) : null),
        h('td.small.muted', s.lastFetched ? timeAgo(s.lastFetched) : '—'),
        h('td.go-actions',
          s.kind === 'connection' ? null : h('button.btn.sm', { onclick: async (ev) => {
            const btn = ev.currentTarget;
            const granted = await grantFor(s.url);
            btn.disabled = true;
            btn.textContent = 'Refreshing…';
            const r = await L.refreshSource(s.id);
            toast(r.status === 'ok' ? `${r.name}: ${r.count} links` : `${r.name}: ${r.error}${granted ? '' : ' (access not granted)'}`, { error: r.status !== 'ok' });
            paint();
          } }, 'Refresh'),
          s.kind === 'connection' || s.managed ? null : h('button.btn.sm.ghost', { onclick: async () => { if (await sourceForm(s)) paint(); } }, 'Edit'),
          s.managed ? null : h('button.btn.sm.ghost.danger', { 'aria-label': `Remove ${s.name}`, onclick: async () => {
            if (!(await confirmDialog(`Remove ${s.name}?`, 'Its links disappear from this browser. Your own links are not affected.', { okLabel: 'Remove', danger: true }))) return;
            await L.removeSource(s.id);
            paint();
          } }, 'Remove'))))))))
      : h('div.card', h('div.empty',
        h('div.empty-title', 'No shared lists yet'),
        h('p', 'Your own links work without any of this. When your team publishes a list of go-links as a JSON file, add its URL here and everyone gets the same links.'),
        h('button.btn.primary', { onclick: async () => { if (await sourceForm()) paint(); } }, '+ Add a link list'))));

    const examples = L.EXAMPLES.filter((x) => !usedExamples.has(x.url));
    if (examples.length) {
      add(body, h('div.card.flat',
        h('h3', 'Try it with example lists'),
        h('p.small.muted', 'Sample company and engineering lists bundled with the extension (payroll, vpn, jira/%s, wiki…). Remove them any time.'),
        h('div.row', examples.map((x) => h('button.btn', { onclick: async () => {
          const r = await L.addSource(x).catch((e) => ({ status: 'error', error: e.message }));
          toast(r.status === 'ok' ? `Added ${r.name} (${r.count} links)` : r.error, { error: r.status !== 'ok' });
          paint();
        } }, `+ ${x.name} example`)))));
    }

    clear(conflictsEl, merged.conflicts.length ? h('div.card',
      h('h3', `Name conflicts (${merged.conflicts.length})`),
      h('p.small.muted', 'The same name exists in more than one place. Your own links win, then lists in the order shown above.'),
      h('table.table', h('tbody', merged.conflicts.map((c) => h('tr',
        h('td.go-name', `go/${c.name}`),
        h('td', 'uses ', h('b', c.winner.sourceName), h('span.go-url', c.winner.url)),
        h('td', 'ignored from ', h('b', c.loser.sourceName), h('span.go-url', c.loser.url))))))) : null);
  }

  add(el,
    h('div.row.between', h('h1', 'Sources'),
      h('div.row',
        h('button.btn', { onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Refreshing…';
          await L.refreshAll();
          btn.disabled = false;
          btn.textContent = 'Refresh all';
          toast('Lists refreshed');
          paint();
        } }, 'Refresh all'),
        h('button.btn.primary', { onclick: async () => { if (await sourceForm()) paint(); } }, '+ Add list'))),
    h('p.muted', `Optional. Read-only link lists shared by your teams, refreshed every ${ctx.values.refreshHours} hours. Your own links override a list's link with the same name.`),
    body,
    conflictsEl,
    h('div.card.flat',
      h('h3', 'Publishing a list for your team'),
      h('p.small', 'Host a JSON file anywhere people can read it (intranet, SharePoint, a GitHub raw URL) and share its address. IT can add lists for everyone with the ', h('code', 'sourceUrls'), ' policy. A linked database under ', h('a', { href: '#connections' }, 'Shared data'), ' also appears here as "Shared".'),
      h('pre.mono', { style: { background: 'var(--wx-surface-2)', padding: '10px', borderRadius: '8px', whiteSpace: 'pre-wrap', margin: 0 } },
        '{\n  "name": "Company",\n  "links": [\n    { "name": "payroll", "url": "https://payroll.example.com", "title": "Payroll", "tags": ["hr"] },\n    { "name": "jira", "url": "https://acme.atlassian.net/browse/%s", "aliases": ["ticket"] }\n  ]\n}')));
  await paint();
}

// ---- Directory ----------------------------------------------------------------------------

async function renderDirectory(el) {
  const m = await L.loadMerged();
  const mine = m.entries.filter((e) => e.list === 'personal').length;
  const clicks = m.entries.reduce((n, e) => n + (e.clicks || 0), 0);
  const stat = (v, label) => h('div.card.stat', h('div.stat-value', String(v)), h('div.stat-label', label));
  add(el,
    h('h1', 'Directory'),
    h('p.muted', 'A searchable page with every link you can use, grouped by list and tag, with Popular, New and onboarding sections. Share it with new starters.'),
    h('div.grid', stat(m.visible.length, 'links available'), stat(mine, 'your own'), stat(m.visible.length - mine, 'from shared lists'), stat(clicks, 'visits from this browser')),
    h('div.card',
      h('div.row',
        h('a.btn.primary', { href: DIRECTORY, target: '_blank' }, 'Open the directory'),
        h('button.btn', { onclick: async () => { if (await copyText(DIRECTORY)) toast('Directory address copied'); } }, 'Copy its address')),
      h('p.small.muted', { style: { margin: '10px 0 0' } }, 'Shortcuts: press Enter on ', h('kbd', 'go'), ' + Space with nothing typed, or open the toolbar popup and pick "Link directory". Tag links with ', h('code', 'onboarding'), ' to feature them for new starters.')));
}

// ---- Behaviour ----------------------------------------------------------------------------

async function renderBehaviour(el, ctx) {
  const permBox = h('div');
  const hosts = CAPTURE_HOSTS;
  async function paintPerm() {
    let ok = true;
    try { ok = await api.permissions.contains({ origins: hosts }); } catch { ok = true; }
    clear(permBox, ok ? null : h('div.notice.warn',
      h('p', 'This browser has not granted access to go/ and the search engines yet, so typing go/name in the address bar cannot be caught. (Firefox asks for this separately.)'),
      h('button.btn.primary', { onclick: async () => {
        let granted = false;
        try { granted = await api.permissions.request({ origins: hosts }); } catch { granted = false; }
        toast(granted ? 'Access granted' : 'Access was not granted', { error: !granted });
        api.runtime.sendMessage({ type: 'go:applyCapture' }).catch(() => {});
        paintPerm();
      } }, 'Grant access')));
  }
  await paintPerm();

  add(el,
    h('h1', 'Behaviour'),
    h('div.card',
      h('h2', 'Omnibox keyword'),
      h('p', 'Click the address bar, type ', h('kbd', 'go'), ' then ', h('kbd', 'Space'), ' or ', h('kbd', 'Tab'), ', and start typing a name. Suggestions match names, titles, tags and descriptions. Extra words become the path: ',
        h('kbd', 'go jira ABC-123'), '.'),
      h('p.small.muted', { style: { margin: 0 } }, 'Popup shortcut: ', h('kbd', 'Alt'), '+', h('kbd', 'G'), ' (change it in your browser\'s extension shortcuts page).')),
    h('div.card',
      h('h2', 'Address bar'),
      ctx.field({ key: 'captureAddressBar', label: 'Open go/name typed in the address bar', type: 'toggle',
        hint: 'Catches http://go/… and searches for exactly "go/something" on Google, Bing, DuckDuckGo, Yahoo, Ecosia and Brave Search, and opens the link instead.',
        onSaved: () => api.runtime.sendMessage({ type: 'go:applyCapture' }).catch(() => {}) }),
      permBox,
      ctx.field({ key: 'caseInsensitive', label: 'Ignore upper/lower case in names', type: 'toggle', hint: 'go/Payroll opens go/payroll. Extra path (go/jira/ABC-123) keeps its case.' })),
    h('div.card',
      h('h2', 'Opening links'),
      ctx.field({ key: 'openInNewTab', label: 'Open links from the popup and directory in a new tab', type: 'toggle', hint: 'Off: replace the current tab. The address bar always uses the current tab (Alt+Enter for a new one).' })),
    h('div.card',
      h('h2', 'Shared lists and data'),
      ctx.field({ key: 'refreshHours', label: 'Refresh shared lists every (hours)', type: 'number', min: 1, max: 168 }),
      ctx.field({ key: 'sharePersonalLinks', label: 'Share my own links through the linked database', type: 'toggle', hint: 'Only matters after a backend is saved under Shared data. Off by default: your links stay private.' }),
      ctx.field({ key: 'sourceUrls', label: 'Lists added for everyone (one URL per line)', type: 'list', rows: 3, placeholder: 'https://intranet.example.com/go-links.json', hint: 'Usually set by IT through policy. These lists cannot be removed under Sources.' })));
}

mountApp({
  baseName: 'Go-Links',
  tagline: 'Short links like go/payroll, go/vpn and go/jira/ABC-123',
  settings,
  syncCollections: ['links'],
  panels: [
    { id: 'links', label: 'My links', icon: '🔗', render: renderLinks },
    { id: 'sources', label: 'Sources', icon: '📥', render: renderSources },
    { id: 'directory', label: 'Directory', icon: '📚', render: renderDirectory },
    { id: 'behaviour', label: 'Behaviour', icon: '⚙️', render: renderBehaviour },
  ],
  welcomeSteps: [
    'Open My links and add one: a short name like payroll and the page it should open.',
    'Type go/payroll in the address bar (or go, then Space, then payroll) and press Enter.',
    'Save the page you are on: click the toolbar icon and use "Create a go-link for this page".',
    'Optional: under Sources, add your team\'s shared link list (or try the bundled examples).',
  ],
  about: h('p.small.muted', 'Your links live in this browser (storage.local). Shared lists are downloaded read-only from the addresses under Sources. Nothing is uploaded unless a backend is linked and "Share my own links" is turned on.'),
});

// Resolver: http://go/<path>, captured searches and the omnibox land here as resolve.html#<path>.
// Found -> location.replace(target) so the back button skips this page.
// Missing -> branded "go/xyz doesn't exist yet" page with closest matches and a create form.
import { api } from '/shared/api.js';
import { h, add, clear, toast } from '/shared/ui.js';
import { brandPage } from '/shared/app-shell.js';
import { productName, logoSrc } from '/shared/brand.js';
import * as L from '../lib/links.js';
import { availability } from '../lib/link-form.js';

/** Hash -> typed text. Encoded paths (from address-bar captures) are decoded; the query stays as-is. */
function readHash() {
  const raw = location.hash.slice(1);
  const qi = raw.indexOf('?');
  if (qi >= 0) return `${L.safeDecode(raw.slice(0, qi))}?${raw.slice(qi + 1)}`;
  return L.safeDecode(raw);
}

async function run() {
  const text = readHash().trim();
  if (!text || text === '/') {
    location.replace(api.runtime.getURL('directory/directory.html'));
    return;
  }
  const r = await L.resolve(text);
  if (r.found && L.isSafeUrl(r.target)) {
    await L.recordClick(r.entry);
    location.replace(r.target);
    return;
  }
  await renderMissing(text, r);
}

async function renderMissing(text, r) {
  const brand = await brandPage('Go-Links', { titleSuffix: `go/${r.first || r.name || text}` });
  const merged = r.merged;
  const full = r.name || L.normalizeName(text);
  // go/jira/ABC-123 -> suggest creating "jira" (the rest is passed along via %s or appended).
  const name = r.first || full;
  const matches = L.closest(merged.visible, name, 5);
  const restPath = r.rest.length ? `/${r.rest.join('/')}` : '';
  const logo = logoSrc(brand);

  const nameIn = h('input', { type: 'text', value: name, autocomplete: 'off', spellcheck: false, 'aria-label': 'Name' });
  const urlIn = h('input', { type: 'url', placeholder: 'https://', autocomplete: 'off', 'aria-label': 'Destination URL', required: true });
  const titleIn = h('input', { type: 'text', placeholder: 'Optional title' });
  const tagsIn = h('input', { type: 'text', placeholder: 'Optional tags, comma separated' });
  const avail = availability(merged);
  nameIn.addEventListener('input', () => avail.update(nameIn.value));
  avail.update(name);
  const err = h('div.notice.danger.hidden');

  const form = h('form.card', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const rec = await L.savePersonal({ name: nameIn.value, url: urlIn.value.trim(), title: titleIn.value, tags: tagsIn.value });
        toast(`Created go/${rec.name}`);
        // Re-resolve what was typed (the new name may be shorter than the full path).
        const again = await L.resolve(text);
        const entry = again.found ? again.entry : (await L.loadMerged()).index.get(rec.name);
        const target = again.found ? again.target : rec.url;
        if (entry) await L.recordClick(entry);
        location.replace(target);
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    },
  },
  h('h2', `Create go/${name}`),
  err,
  h('div.field', h('label', 'Name'), h('div.go-prefix-input', h('span', 'go/'), nameIn), avail.el),
  h('div.field', h('label', 'Where should it go?'), urlIn,
    h('div.hint', 'Tip: use %s where the rest of the path belongs, e.g. https://acme.atlassian.net/browse/%s')),
  h('div.grid-2', h('div.field', h('label', 'Title'), titleIn), h('div.field', h('label', 'Tags'), tagsIn)),
  h('div.row', h('button.btn.primary', { type: 'submit' }, 'Create and open'),
    h('span.small.muted', 'Saved in this browser. It works right away.')));

  clear(document.body,
    h('header.go-page-header',
      logo ? h('img.wx-logo', { src: logo, alt: '' }) : h('div.wx-logo-fallback', (brand.companyName || 'G').charAt(0).toUpperCase()),
      h('div.grow', h('div.title', productName(brand, 'Go-Links'))),
      h('a.btn.ghost.sm', { href: api.runtime.getURL('directory/directory.html') }, 'Browse all links')),
    h('main.go-resolver',
      h('h1', { style: { fontSize: '26px' } }, h('span.go-name', `go/${name}`), ' doesn\'t exist yet'),
      restPath
        ? h('p.muted', `Create go/${name} below and the rest of what you typed (${restPath}) is passed along: appended to the URL, or put where the URL has %s.`)
        : h('p.muted', 'Create it below and it works immediately, or pick one of the closest matches.'),
      matches.length ? h('div.card',
        h('h3', 'Did you mean'),
        matches.map((e) => h('a.go-match', {
          href: `#${e.name}${restPath}`,
          onclick: (ev) => { ev.preventDefault(); location.replace(`#${e.name}${restPath}`); },
        },
          h('span.go-name', `go/${e.name}`),
          h('span.grow.small.muted', e.title || e.url),
          e.readOnly ? h('span.badge', e.sourceName) : h('span.badge.primary', 'Yours')))) : null,
      form));
  setTimeout(() => urlIn.focus(), 0);
}

window.addEventListener('hashchange', () => {
  clear(document.body);
  run();
});
run().catch((e) => {
  console.error(e);
  add(document.body, h('div.go-resolver', h('div.notice.danger', `Could not open this link: ${e.message}`)));
});

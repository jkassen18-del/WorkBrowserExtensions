// Add/edit modal for personal links, used by Settings, the directory and the resolver page.
import { h, modal, toast } from '/shared/ui.js';
import * as L from './links.js';

/** Live "is this name free?" line under a name input. Returns { el, update(name) }. */
export function availability(merged, exceptId) {
  const el = h('div.hint.go-avail');
  const update = (raw) => {
    const name = L.normalizeName(raw);
    el.className = 'hint go-avail';
    if (!name) return void (el.textContent = 'Short and memorable: payroll, vpn, team/wiki');
    const bad = L.validateName(name);
    if (bad) {
      el.classList.add('bad');
      el.textContent = bad;
      return;
    }
    const who = L.whoHas(merged, name, exceptId);
    if (who.personal) {
      el.classList.add('bad');
      el.textContent = `✗ go/${name} is already one of your links${who.personal.name !== name ? ` (alias of go/${who.personal.name})` : ''}.`;
    } else if (who.source) {
      el.classList.add('warn');
      el.textContent = `go/${name} exists in the ${who.source.sourceName} list. Yours will override it for you.`;
    } else {
      el.classList.add('ok');
      el.textContent = `✓ go/${name} is available`;
    }
  };
  return { el, update };
}

/**
 * Opens the link editor. Resolves with the saved record, or undefined when cancelled.
 * @param {object} [o]
 * @param {object} [o.link]     existing personal link to edit
 * @param {object} [o.prefill]  initial values for a new link
 */
export async function openLinkForm({ link, prefill = {}, title } = {}) {
  const merged = await L.loadMerged();
  const v = { name: '', url: '', title: '', description: '', tags: [], aliases: [], ...prefill, ...(link || {}) };
  const avail = availability(merged, link?.id);
  const err = h('div.notice.danger.hidden');
  const inp = (attrs) => h('input', attrs);
  const name = inp({ type: 'text', value: v.name, placeholder: 'payroll', autocomplete: 'off', spellcheck: false, 'aria-label': 'Name' });
  const url = inp({ type: 'url', value: v.url, placeholder: 'https://', autocomplete: 'off', 'aria-label': 'Destination URL' });
  const ttl = inp({ type: 'text', value: v.title, placeholder: 'Payroll portal' });
  const desc = h('textarea', { rows: 2, placeholder: 'What people find there (helps search)' }, v.description);
  const tags = inp({ type: 'text', value: (v.tags || []).join(', '), placeholder: 'hr, onboarding' });
  const aliases = inp({ type: 'text', value: (v.aliases || []).join(', '), placeholder: 'pay, salary' });
  name.addEventListener('input', () => avail.update(name.value));
  avail.update(name.value);

  return modal(title || (link ? `Edit go/${link.name}` : 'New go-link'), (close) => {
    const save = async (e) => {
      e?.preventDefault();
      try {
        const rec = await L.savePersonal({
          name: name.value, url: url.value.trim(), title: ttl.value, description: desc.value,
          tags: tags.value, aliases: aliases.value, owner: v.owner,
        }, link?.id);
        toast(`Saved go/${rec.name}`);
        close(rec);
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    };
    const form = h('form', { onsubmit: save },
      err,
      h('div.field', h('label', 'Name'), h('div.go-prefix-input', h('span', 'go/'), name), avail.el),
      h('div.field', h('label', 'Destination URL'), url,
        h('div.hint', 'Use %s for the rest of the path: https://acme.atlassian.net/browse/%s makes go/jira/ABC-123 work. {1}, {2} insert single segments.')),
      h('div.field', h('label', 'Title'), ttl),
      h('div.field', h('label', 'Description'), desc),
      h('div.grid-2',
        h('div.field', h('label', 'Tags'), tags, h('div.hint', 'Comma separated. Tag "onboarding" to feature it for new starters.')),
        h('div.field', h('label', 'Aliases'), aliases, h('div.hint', 'Other names that open the same link.'))),
      h('div.row.end',
        h('button.btn', { type: 'button', onclick: () => close(undefined) }, 'Cancel'),
        h('button.btn.primary', { type: 'submit' }, link ? 'Save changes' : 'Create link')));
    setTimeout(() => (v.name && !v.url ? url : name).focus(), 0);
    return form;
  });
}

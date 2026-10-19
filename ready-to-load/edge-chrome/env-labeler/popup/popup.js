import { api, send } from '/shared/api.js';
import { mountPopup, openOptions } from '/shared/app-shell.js';
import { h, clear, toast, toggle } from '/shared/ui.js';
import { settings } from '../settings.js';
import { normalizeEnv, envTextColor, describePattern } from '../rules.js';

const { body } = await mountPopup('Environment Labeler', { optionsHash: 'rules' });

const [tab] = await api.tabs.query({ active: true, currentWindow: true });

function chip(env, cls = '') {
  if (!env) return h('span.env-chip.none', { class: cls }, 'No label');
  return h('span.env-chip', { class: cls, style: { background: env.color, color: envTextColor(env) } }, env.name);
}

function sourceText(rule) {
  if (rule.source === 'remote') return ' from a remote rule file';
  if (rule.source === 'shared') return ' shared by your team';
  if (String(rule.id).startsWith('builtin-')) return ' (built in)';
  return '';
}

async function render() {
  if (!tab || !tab.url) {
    clear(body, h('div.empty', h('div.empty-title', 'No page to label'), 'Open a web page, then click the toolbar icon again.'));
    return;
  }
  const info = await send({ type: 'env:match', url: tab.url, tabId: tab.id });
  if (!info || info.error) {
    clear(body, h('div.notice.danger', `Could not check this tab${info?.error ? `: ${info.error}` : '.'}`));
    return;
  }
  if (!info.labelable || !info.host) {
    clear(body,
      h('div.empty', h('div.empty-title', 'Labels work on web pages'),
        'This is a browser page. Open a site such as your production app and click the icon again.'),
      h('button.btn.block', { onclick: () => openOptions('rules') }, 'Manage rules'));
    return;
  }

  const s = await settings.get();
  const envs = (s.environments || []).map(normalizeEnv);
  const m = info.match;
  const current = m?.env || null;
  const locked = info.rulesLocked;

  const matchLine = m
    ? h('div.match-line', 'Matched ', h('code', m.rule.pattern.length > 48 ? `${m.rule.pattern.slice(0, 46)}…` : m.rule.pattern),
      ` · ${describePattern(m.rule.pattern)}${sourceText(m.rule)}`, m.rule.label ? h('div', `Label: ${m.rule.label}`) : null)
    : info.exception
      ? h('div.match-line', 'Marked "No label" by rule ', h('code', info.exception.rule.pattern))
      : h('div.match-line', 'No rule matches this site yet.');

  const label = async (envId) => {
    const r = await send({ type: 'env:labelHost', url: tab.url, envId, tabId: tab.id });
    if (r?.error) return toast(r.error, { error: true });
    const env = envs.find((e) => e.id === envId);
    toast(env ? `${info.host} is now labelled ${env.name}` : `Label removed from ${info.host}`);
    render();
  };

  const isExact = m && m.rule.source === 'local' && m.rule.pattern.toLowerCase() === info.host;

  clear(body,
    !s.enabled ? h('div.notice.warn', 'Labels are switched off. Turn them back on under Settings → Appearance.') : null,
    h('div.row.between', { style: { flexWrap: 'nowrap', alignItems: 'flex-start' } },
      h('div.grow', h('div.small.muted', 'This site'), h('div.site', info.host)),
      chip(current, 'lg')),
    matchLine,

    h('div.section-label', 'Label this site as'),
    locked ? h('div.notice.small', 'Rules are managed by your IT department.') : null,
    h('div.env-btns', envs.map((e) => h('button.btn', {
      disabled: locked,
      'aria-pressed': String(isExact && current?.id === e.id),
      style: `--env: ${e.color}`,
      title: `Add a rule for ${info.host} → ${e.name}`,
      onclick: () => label(e.id),
    }, h('span.env-dot', { style: { background: e.color } }), e.name))),
    h('div.row', { style: { marginTop: '8px' } },
      h('button.btn.sm.ghost', {
        disabled: locked || !current,
        title: current ? `Stop labelling ${info.host}` : 'This site has no label',
        onclick: () => label(null),
      }, 'Remove label'),
      h('span.grow'),
      h('button.btn.sm.ghost', { onclick: () => openOptions('environments') }, '+ Custom environment')),

    h('hr', { style: { margin: '12px 0' } }),
    h('div.row', { style: { flexWrap: 'nowrap' } },
      toggle(info.tabHidden, async (v) => {
        await send({ type: 'env:hideTab', tabId: tab.id, hidden: v });
        toast(v ? 'Label hidden on this tab' : 'Label shown again');
      }, { label: 'Hide label on this tab' }),
      h('div.grow', h('div', { style: { fontWeight: 550 } }, 'Hide label on this tab'),
        h('div.small.muted', 'Ribbon, title and favicon. Until the tab is closed.'))),
    h('div.row', { style: { marginTop: '12px' } },
      h('button.btn.sm', { onclick: () => openOptions('rules') }, 'Manage rules'),
      h('button.btn.sm.ghost', { onclick: () => openOptions('appearance') }, 'Appearance')),
  );
}

await render();

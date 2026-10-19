// Popup: capture buttons, ticket count and the last three tickets.
import { api, send } from '/shared/api.js';
import { h, add, clear, timeAgo } from '/shared/ui.js';
import { mountPopup } from '/shared/app-shell.js';
import { listTickets, STATUS, DEST_LABELS } from '../lib/tickets.js';
import { ICONS } from '../lib/icons.js';

const { body } = await mountPopup('Ticket Snap', { optionsHash: 'destination' });

let shortcut = '';
try {
  const cmds = await api.commands.getAll();
  shortcut = cmds.find((c) => c.name === 'capture-tab')?.shortcut || '';
} catch { /* commands API unavailable */ }

const errorBox = h('div');
const openTickets = (id) => {
  api.tabs.create({ url: api.runtime.getURL(`options/options.html${id ? `?open=${encodeURIComponent(id)}` : ''}#tickets`) });
  window.close();
};

async function startCapture(withScreenshot, btn) {
  btn.disabled = true;
  clear(errorBox);
  const r = await send({ type: 'ts:capture', withScreenshot });
  if (!r || r.error) {
    btn.disabled = false;
    clear(errorBox, h('div.notice.danger.ts-error', `Could not start a ticket: ${r?.error || 'the extension did not respond'}.`));
    return;
  }
  window.close();
}

const capBtn = h('button.btn.primary.block', { html: `${ICONS.camera}<span>Capture this tab</span>` });
if (shortcut) capBtn.append(h('span.ts-kbd', shortcut.split('+').map((k, i) => [i ? '+' : '', h('kbd', k)])));
capBtn.addEventListener('click', () => startCapture(true, capBtn));
const noShotBtn = h('button.btn.block', { html: `${ICONS.note}<span>Capture without screenshot</span>` });
noShotBtn.addEventListener('click', () => startCapture(false, noShotBtn));

const tickets = await listTickets();
const failed = tickets.filter((t) => t.status === 'failed').length;

add(body,
  h('div.ts-capture', capBtn, noShotBtn),
  errorBox,
  h('div.ts-section-head',
    h('h3', 'My tickets'),
    h('span.small.muted', tickets.length
      ? `${tickets.length} saved${failed ? ` · ${failed} not sent` : ''}`
      : 'none yet')),
  tickets.length
    ? h('ul.ts-recent', tickets.slice(0, 3).map((t) => {
      const st = STATUS[t.status] || STATUS.local;
      return h('li', h('button', { onclick: () => openTickets(t.id), title: 'Open in My tickets' },
        t.thumb ? h('img', { src: t.thumb, alt: '' }) : h('span.ts-noimg', { html: ICONS.note }),
        h('div.grow',
          h('div.ts-sum', t.summary || '(no summary)'),
          h('div.ts-meta', timeAgo(t.createdAt), h('span', '·'), DEST_LABELS[t.destination] || 'My tickets',
            h(`span.badge.${st.cls}`, st.label)))));
    }))
    : h('div.ts-popup-empty', 'Tickets you create are listed here. Open the page with the problem, then press ', h('b', 'Capture this tab'), '.'),
  h('div', { style: { marginTop: '10px' } },
    h('button.btn.block', { onclick: () => openTickets() }, tickets.length ? 'Open My tickets' : 'Open Ticket Snap')),
);

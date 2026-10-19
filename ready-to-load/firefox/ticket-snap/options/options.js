// Ticket Snap settings app: My tickets plus Destination, Ticket form, Capture and Privacy panels.
import { api, isFirefox } from '/shared/api.js';
import { h, add, clear, toast, modal, confirmDialog, download, copyText, formatDate, timeAgo, debounce } from '/shared/ui.js';
import { mountApp } from '/shared/app-shell.js';
import { settings } from '../settings.js';
import {
  listTickets, getTicket, updateTicket, deleteTicket, store, shareTicket, ticketText, pngName,
  dataUrlToBlob, priorityLabel, requesterText, visibleDiagnostics, STATUS, DEST_LABELS, PRIORITIES, storageBytes,
} from '../lib/tickets.js';
import {
  DESTINATIONS, needsHost, requestDestinationAccess, deliver, missingConfig, testDestination, sendEmail, originFor,
} from '../lib/destinations.js';
import { ICONS } from '../lib/icons.js';

const BASE_NAME = 'Ticket Snap';

function shortcutPage() {
  if (isFirefox) return { url: 'about:addons', how: 'Open about:addons, click the gear icon, then "Manage Extension Shortcuts".' };
  if (/Edg\//.test(navigator.userAgent)) return { url: 'edge://extensions/shortcuts', how: 'Paste this address into a new tab:' };
  return { url: 'chrome://extensions/shortcuts', how: 'Paste this address into a new tab:' };
}

async function currentShortcut() {
  try {
    const cmds = await api.commands.getAll();
    return cmds.find((c) => c.name === 'capture-tab')?.shortcut || '';
  } catch {
    return '';
  }
}

const fmtBytes = (b) => (b == null ? '-' : b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);

const kbdKeys = (s) => s.split('+').map((k, i) => [i ? ' + ' : '', h('kbd', k)]);

function downloadImage(t) {
  if (!t.image) return toast('The full screenshot was not kept for this ticket.', { error: true });
  download(pngName(t), dataUrlToBlob(t.image));
  return undefined;
}

async function copyTicket(t) {
  toast((await copyText(ticketText(t))) ? 'Ticket text copied' : 'Could not copy', { error: false });
}

/**
 * Sends (or re-sends) a ticket. Must be called straight from a click handler: the host
 * permission request happens before anything is awaited.
 */
function resend(t, dest, ctx) {
  const values = ctx.values;
  const access = needsHost(dest) && !missingConfig(dest, values) ? requestDestinationAccess(dest, values) : Promise.resolve(true);
  return (async () => {
    await access;
    let result;
    try {
      result = await deliver(dest, t, values, ctx.brand);
    } catch (e) {
      result = { status: 'failed', message: String(e.message || e) };
    }
    const updated = await updateTicket(t.id, {
      destination: dest,
      status: result.status,
      statusMessage: result.message || '',
      externalId: result.externalId || t.externalId || '',
      externalUrl: result.externalUrl || t.externalUrl || '',
      sentAt: result.status === 'sent' || result.status === 'emailed' ? Date.now() : t.sentAt || null,
      attempts: (t.attempts || 0) + 1,
    });
    if (updated) shareTicket(updated, values);
    toast(result.status === 'failed' ? `Not sent: ${result.message}` : result.message || 'Sent', { error: result.status === 'failed', timeout: result.status === 'failed' ? 7000 : 3200 });
    return updated;
  })();
}

// ---- My tickets --------------------------------------------------------------------

async function renderTickets(el, ctx) {
  const all = await listTickets();
  const values = ctx.values;
  const dest = values.destination || 'local';
  let query = '';
  let statusFilter = '';
  const listBox = h('div.ts-list');
  const bytes = await storageBytes();
  const notSent = all.filter((t) => t.status === 'failed').length;

  const statusBadge = (t) => {
    const st = STATUS[t.status] || STATUS.local;
    return h(`span.badge.${st.cls}`, { title: t.statusMessage || '' }, st.label);
  };

  const item = (t) => {
    const thumb = t.thumb
      ? h('img.ts-thumb', { src: t.thumb, alt: 'Screenshot', title: 'View ticket', onclick: () => showDetail(t.id, ctx, rerender) })
      : h('button.ts-thumb.none', { title: 'View ticket', html: ICONS.note, onclick: () => showDetail(t.id, ctx, rerender) });
    const retryBtn = t.status === 'failed'
      ? h('button.btn.sm.primary', {
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          await resend(t, t.destination, ctx);
          rerender();
        },
      }, 'Retry')
      : null;
    return h('div.card.ts-item',
      thumb,
      h('div', { style: { minWidth: 0 } },
        h('button.ts-title', { onclick: () => showDetail(t.id, ctx, rerender) }, t.summary || '(no summary)'),
        h('div.ts-meta', h('span', t.ref), h('span', '·'), h('span', { title: formatDate(t.createdAt) }, timeAgo(t.createdAt)),
          t.category ? [h('span', '·'), h('span', t.category)] : null,
          h('span', '·'), h('span', `${priorityLabel(t.priority)} priority`)),
        h('div.ts-badges',
          h('span.badge', DEST_LABELS[t.destination] || 'My tickets'),
          statusBadge(t),
          t.externalId ? (t.externalUrl ? h('a.badge.primary', { href: t.externalUrl, target: '_blank', rel: 'noopener' }, t.externalId) : h('span.badge.primary', t.externalId)) : null),
        t.status === 'failed' && t.statusMessage ? h('div.ts-msg', { title: t.statusMessage }, t.statusMessage) : null),
      h('div.ts-actions',
        retryBtn,
        h('button.btn.sm', { onclick: () => showDetail(t.id, ctx, rerender) }, 'View'),
        t.image ? h('button.btn.sm', { onclick: () => downloadImage(t), title: 'Download the annotated screenshot' }, 'PNG') : null,
        h('button.btn.sm', { onclick: () => copyTicket(t) }, 'Copy'),
        h('button.btn.sm.ghost.danger', {
          'aria-label': `Delete ${t.ref}`,
          onclick: async () => {
            if (!(await confirmDialog('Delete ticket?', `"${t.summary}" will be removed from this browser.`, { okLabel: 'Delete', danger: true }))) return;
            await deleteTicket(t.id);
            ctx.rerender();
          },
        }, 'Delete')));
  };

  const paintList = () => {
    const q = query.toLowerCase();
    const shown = all.filter((t) => (!statusFilter || t.status === statusFilter)
      && (!q || [t.summary, t.description, t.ref, t.category, t.externalId, t.pageUrl, t.pageTitle].join(' ').toLowerCase().includes(q)));
    if (!shown.length) {
      clear(listBox, h('div.card.empty', h('div.empty-title', 'No tickets match'), h('p', 'Try a different search or status.')));
      return;
    }
    clear(listBox, shown.map(item));
  };
  function rerender() { ctx.rerender(); }

  const head = h('div.ts-head',
    h('div', h('h1', 'My tickets'), h('p.muted', 'Every ticket you create is kept here, in this browser.')),
    all.length ? h('div.row',
      h('button.btn', {
        onclick: async () => {
          const list = await store.all();
          download(`tickets-${new Date().toISOString().slice(0, 10)}.json`, { exportedAt: new Date().toISOString(), count: list.length, tickets: list });
        },
      }, 'Export all (JSON)'),
      h('button.btn.ghost.danger', {
        onclick: async () => {
          if (!(await confirmDialog('Delete all tickets?', `All ${all.length} tickets and their screenshots will be removed from this browser. Export them first if you want a copy.`, { okLabel: 'Delete all', danger: true }))) return;
          await store.clear();
          ctx.rerender();
        },
      }, 'Delete all')) : null);

  if (!all.length) {
    const sc = await currentShortcut();
    add(el, head, h('div.card.empty',
      h('div', { style: { width: '56px', height: '56px', margin: '0 auto 12px', borderRadius: '16px', display: 'grid', placeItems: 'center', background: 'rgba(var(--wx-primary-rgb), 0.12)', color: 'var(--wx-primary)' }, html: ICONS.camera.replace('<svg', '<svg width="28" height="28"') }),
      h('div.empty-title', 'No tickets yet'),
      h('p', 'Go to the page that has the problem, click the ', h('b', BASE_NAME), ' button in the toolbar and choose ', h('b', 'Capture this tab'), '.'),
      sc ? h('p', 'Or press ', kbdKeys(sc), ' on any page.') : h('p', 'You can also set a keyboard shortcut under ', h('a', { href: '#capture' }, 'Capture'), '.'),
      h('p.small', dest === 'local'
        ? 'Tickets are saved here. You can download, copy or email them, or send them to your help desk later.'
        : `New tickets are sent to ${DESTINATIONS[dest]?.short || dest} and also kept here.`)));
    return;
  }

  const search = h('input', { type: 'search', placeholder: 'Search tickets', 'aria-label': 'Search tickets' });
  search.addEventListener('input', debounce(() => { query = search.value.trim(); paintList(); }, 150));
  const statusSel = h('select', { 'aria-label': 'Filter by status' },
    h('option', { value: '' }, 'All statuses'),
    Object.entries(STATUS).filter(([k]) => k !== 'sending').map(([k, v]) => h('option', { value: k }, v.label)));
  statusSel.addEventListener('change', () => { statusFilter = statusSel.value; paintList(); });

  add(el, head,
    h('div.ts-stats',
      h('div.card.stat', h('div.stat-value', all.length), h('div.stat-label', `ticket${all.length === 1 ? '' : 's'} kept (max ${values.maxTickets})`)),
      h('div.card.stat', h('div.stat-value', { style: { color: notSent ? 'var(--wx-danger)' : '' } }, notSent), h('div.stat-label', 'not sent')),
      h('div.card.stat', h('div.stat-value', fmtBytes(bytes)), h('div.stat-label', 'used in this browser'))),
    notSent ? h('div.notice.warn', `${notSent} ticket${notSent === 1 ? ' was' : 's were'} not sent. Fix the destination under `, h('a', { href: '#destination' }, 'Destination'), ' if needed, then press Retry.') : null,
    h('div.ts-filters', search, statusSel),
    listBox);
  paintList();

  // Opened from the popup or editor with ?open=<ticket id>.
  const openId = new URLSearchParams(location.search).get('open');
  if (openId) {
    history.replaceState(null, '', `${location.pathname}#tickets`);
    if (all.some((t) => t.id === openId)) setTimeout(() => showDetail(openId, ctx, rerender), 0);
  }
}

async function showDetail(id, ctx, onChange) {
  const t = await getTicket(id);
  if (!t) return toast('That ticket no longer exists.', { error: true });
  const values = ctx.values;
  const dest = values.destination || 'local';
  const st = STATUS[t.status] || STATUS.local;
  const diags = visibleDiagnostics(t);
  let changed = false;

  await modal(`${t.ref} · ${t.summary || '(no summary)'}`, (close) => h('div.ts-detail',
    h('div.row', { style: { marginBottom: '14px' } },
      t.status === 'failed' ? h('button.btn.primary', {
        onclick: (e) => {
          e.currentTarget.disabled = true;
          resend(t, t.destination, ctx).then(() => { changed = true; close(); });
        },
      }, `Retry (${DEST_LABELS[t.destination]})`) : null,
      dest !== 'local' && dest !== 'email' && !(t.destination === dest && t.status === 'sent') && !(t.status === 'failed' && t.destination === dest)
        ? h('button.btn', {
          onclick: (e) => {
            e.currentTarget.disabled = true;
            resend(t, dest, ctx).then(() => { changed = true; close(); });
          },
        }, `Send to ${DESTINATIONS[dest].short}`)
        : null,
      t.image ? h('button.btn', { onclick: () => downloadImage(t) }, 'Download PNG') : null,
      h('button.btn', { onclick: () => copyTicket(t) }, 'Copy text'),
      h('button.btn', {
        title: 'Open an email draft and download the screenshot to attach',
        onclick: () => {
          try {
            sendEmail(t, values, ctx.brand, { requireTo: false });
          } catch (e) {
            toast(e.message, { error: true });
          }
        },
      }, 'Email…'),
      h('span.grow'),
      h('button.btn.ghost.danger', {
        onclick: async () => {
          if (!(await confirmDialog('Delete ticket?', 'This ticket will be removed from this browser.', { okLabel: 'Delete', danger: true }))) return;
          await deleteTicket(t.id);
          changed = true;
          close();
        },
      }, 'Delete'),
      h('button.btn', { onclick: () => close() }, 'Close')),
    t.image || t.thumb ? h('img.ts-detail-img', { src: t.image || t.thumb, alt: 'Screenshot' }) : null,
    !t.image && t.thumb ? h('p.small.muted', 'Only a thumbnail was kept for this ticket ("Keep screenshots" is off).') : null,
    h('div.ts-kv',
      h('div', h('span', 'Status'), h(`span.badge.${st.cls}`, st.label)),
      h('div', h('span', 'Destination'), DEST_LABELS[t.destination] || 'My tickets'),
      h('div', h('span', 'Created'), formatDate(t.createdAt)),
      h('div', h('span', 'Category'), t.category || '-'),
      h('div', h('span', 'Priority'), priorityLabel(t.priority)),
      h('div', h('span', 'Requester'), requesterText(t.requester) || '-'),
      t.externalId ? h('div', h('span', 'Help-desk id'), t.externalUrl ? h('a', { href: t.externalUrl, target: '_blank', rel: 'noopener' }, t.externalId) : t.externalId) : null),
    t.statusMessage ? h(t.status === 'failed' ? 'div.notice.danger' : 'div.notice', t.statusMessage) : null,
    h('h3', 'Description'),
    h('div.ts-desc', t.description || h('span.muted', 'No description.')),
    h('h3', 'Diagnostics'),
    diags.length
      ? h('table.table', h('tbody', diags.map((d) => h('tr', h('th', d.label), h('td', Array.isArray(d.value) ? h('ul', d.value.map((x) => h('li', x))) : String(d.value))))))
      : h('p.muted', t.includeDiagnostics === false ? 'Diagnostics were not included with this ticket.' : 'No diagnostics.')));
  if (changed) onChange();
  return undefined;
}

// ---- Destination -------------------------------------------------------------------

async function renderDestination(el, ctx) {
  const draft = { ...ctx.values };
  const body = h('div');
  const destLocked = ctx.isLocked('destination');

  const paint = () => {
    const meta = DESTINATIONS[draft.destination] || DESTINATIONS.local;
    const options = Object.entries(DESTINATIONS).map(([id, d]) => {
      const radio = h('input', { type: 'radio', name: 'dest', value: id, checked: draft.destination === id, disabled: destLocked && draft.destination !== id });
      radio.addEventListener('change', () => { draft.destination = id; paint(); });
      return h('label.ts-dest-opt', { class: draft.destination === id ? 'selected' : '' }, radio,
        h('div', h('b', id === 'local' ? 'My tickets only' : d.short), h('small', d.blurb)));
    });
    const fieldEls = meta.fields.map((f) => {
      const locked = ctx.isLocked(f.key);
      const inp = h('input', {
        type: f.type || 'text', value: draft[f.key] ?? '', placeholder: f.placeholder || '', disabled: locked,
        autocomplete: f.type === 'password' ? 'new-password' : 'off', spellcheck: 'false',
      });
      inp.addEventListener('input', () => { draft[f.key] = inp.value.trim(); });
      return { half: f.half, el: h('div.field', h('label', f.label, ' ', locked ? ctx.lockedBadge() : null), inp, f.hint ? h('div.hint', f.hint) : null) };
    });
    const full = fieldEls.filter((x) => !x.half).map((x) => x.el);
    const halves = fieldEls.filter((x) => x.half).map((x) => x.el);
    const emailFallback = draft.destination === 'email' && !draft.helpdeskEmail
      ? (ctx.brand.supportEmail ? h('div.notice', `Emails go to the brand support address, ${ctx.brand.supportEmail}, unless you enter another one.`) : h('div.notice.warn', 'Enter the help-desk address. (No brand support email is set.)'))
      : null;

    clear(body,
      h('div.ts-dest-list', options),
      h('div.card.flat', { style: { marginBottom: 0 } },
        h('h3', meta.label, ' ', destLocked ? ctx.lockedBadge() : null),
        h('p.muted', meta.help),
        full,
        halves.length ? h('div.grid-2', halves) : null,
        emailFallback,
        h('div.row',
          h('button.btn.primary', {
            onclick: async () => {
              const d = draft.destination;
              // Ask for host access first, while the click still counts as a user gesture.
              const access = needsHost(d) && originFor(d, draft) ? requestDestinationAccess(d, draft) : Promise.resolve(true);
              if (needsHost(d)) {
                const missing = missingConfig(d, draft);
                if (missing) return toast(missing, { error: true });
                if (!(await access)) return toast('Permission to reach that site was not granted, so the destination was not saved.', { error: true, timeout: 6000 });
              }
              const patch = { destination: d };
              for (const f of DESTINATIONS[d].fields) patch[f.key] = draft[f.key] ?? '';
              await ctx.save(patch);
              return undefined;
            },
          }, 'Save destination'),
          needsHost(draft.destination) ? h('button.btn', {
            onclick: async (e) => {
              const d = draft.destination;
              const access = originFor(d, draft) ? requestDestinationAccess(d, draft) : Promise.resolve(false);
              const btn = e.currentTarget;
              btn.disabled = true;
              try {
                await access;
                toast(await testDestination(d, draft), { timeout: 4500 });
              } catch (err) {
                toast(err.message, { error: true, timeout: 8000 });
              } finally {
                btn.disabled = false;
              }
            },
          }, 'Test connection') : null)));
  };
  paint();

  add(el,
    h('h1', 'Destination'),
    h('p.muted', 'Choose where new tickets go. Whatever you choose, every ticket is also kept in My tickets, and a ticket that cannot be sent is kept with status "Not sent" and a Retry button.'),
    body,
    h('p.small.muted', { style: { marginTop: '14px' } },
      'Sign-in details are stored only in this browser\'s extension storage and are sent only to the service you choose. The browser asks you once for permission to reach that site.'));
}

// ---- Ticket form -------------------------------------------------------------------

async function renderForm(el, ctx) {
  const reqLocked = ctx.isLocked('requiredFields');
  const required = new Set(ctx.values.requiredFields || []);
  const reqOptions = [['summary', 'Summary'], ['description', 'Description'], ['category', 'Category'], ['requesterName', 'Your name'], ['requesterEmail', 'Your email']];
  const checks = h('div.ts-checks', reqOptions.map(([k, l]) => {
    const cb = h('input', { type: 'checkbox', checked: required.has(k), disabled: reqLocked });
    cb.addEventListener('change', () => {
      if (cb.checked) required.add(k); else required.delete(k);
      ctx.save({ requiredFields: reqOptions.map(([x]) => x).filter((x) => required.has(x)) });
    });
    return h('label.check', cb, l);
  }));

  add(el,
    h('h1', 'Ticket form'),
    h('p.muted', 'What people see next to the screenshot when they write a ticket.'),
    h('div.card',
      h('h2', 'Fields'),
      ctx.field({ key: 'categories', label: 'Categories', type: 'list', rows: 6, hint: 'One per line. Shown in the Category menu.' }),
      ctx.field({ key: 'defaultPriority', label: 'Default priority', type: 'select', options: PRIORITIES }),
      h('div.field', h('label', 'Required fields ', reqLocked ? ctx.lockedBadge() : null), checks,
        h('div.hint', 'When the summary is optional and left empty, Ticket Snap uses the first line of the description or the page title.'))),
    h('div.card',
      h('h2', 'Requester'),
      h('p.muted', 'Prefilled in every ticket so you don\'t have to type them again.'),
      h('div.grid-2',
        ctx.field({ key: 'requesterName', label: 'Name', placeholder: 'Your name' }),
        ctx.field({ key: 'requesterEmail', label: 'Email', type: 'email', placeholder: 'you@company.com' })),
      ctx.field({ key: 'rememberRequester', label: 'Remember the name and email typed in the ticket form', type: 'toggle' })));
}

// ---- Capture -----------------------------------------------------------------------

async function renderCapture(el, ctx) {
  const sc = await currentShortcut();
  const page = shortcutPage();
  add(el,
    h('h1', 'Capture'),
    h('p.muted', 'How to start a ticket, and what is collected with it.'),
    h('div.card',
      h('h2', 'Keyboard shortcut'),
      sc
        ? h('p.ts-shortcut', kbdKeys(sc))
        : h('div.notice.warn', 'No shortcut is set. Another extension may already use Alt+Shift+S.'),
      h('p', 'Press it on any page to capture the visible part of the tab and open the editor. You can also click the ',
        h('b', BASE_NAME), ' toolbar button and choose ', h('b', 'Capture this tab'), ' or ', h('b', 'Capture without screenshot'), '.'),
      h('p.muted', 'To change the shortcut, browsers only allow it from their own settings page, which an extension cannot open by link. ', page.how),
      h('div.row',
        h('code', { style: { padding: '6px 10px', background: 'var(--wx-surface-2)', borderRadius: '6px' } }, page.url),
        h('button.btn.sm', { onclick: async () => toast((await copyText(page.url)) ? 'Copied. Paste it into the address bar.' : 'Could not copy') }, 'Copy address'))),
    h('div.card',
      h('h2', 'Diagnostics'),
      ctx.field({ key: 'includeDiagnostics', label: 'Attach diagnostics to new tickets', type: 'toggle', hint: 'People can still switch it off, and see exactly what is attached, on each ticket.' }),
      h('p', { style: { marginBottom: '6px' } }, 'Collected when you capture a tab:'),
      h('ul.ts-collected',
        ['Page address and title', 'Date and time', 'Browser name and version', 'Operating system', 'Language and time zone',
          'Screen size', 'Viewport and pixel ratio', 'Online status', 'Page load time', 'Requests that failed (HTTP 400 or higher)', 'User agent']
          .map((x) => h('li', x))),
      h('p.small.muted', { style: { marginTop: '10px' } },
        'Nothing is collected in the background. Ticket Snap only reads the tab you capture, at the moment you capture it. ',
        'Browser pages (settings, new tab, extension store) cannot be captured; on those you can attach an image instead.')));
}

// ---- Privacy & storage -------------------------------------------------------------

async function renderPrivacy(el, ctx) {
  const bytes = await storageBytes();
  add(el,
    h('h1', 'Privacy & storage'),
    h('p.muted', 'What goes into tickets and how much is kept in this browser.'),
    h('div.card',
      h('h2', 'In tickets'),
      ctx.field({ key: 'includeUrl', label: 'Include the page address (URL)', type: 'toggle', hint: 'Off hides the page address, referrer and failed request addresses. People can also switch it off per ticket.' }),
      ctx.field({ key: 'redactColor', label: 'Redact tool colour', type: 'color', hint: 'Redacted areas are painted over in the saved image, so the content underneath is gone.' })),
    h('div.card',
      h('h2', 'My tickets'),
      h('div.grid-2',
        ctx.field({ key: 'maxTickets', label: 'Tickets to keep', type: 'number', min: 1, max: 1000, hint: 'The oldest tickets are removed first.' }),
        h('div.field', h('label', 'Space used'), h('div', { style: { padding: '8px 0' } }, fmtBytes(bytes)))),
      ctx.field({ key: 'keepScreenshots', label: 'Keep full screenshots with saved tickets', type: 'toggle', hint: 'Off keeps only a small thumbnail, which saves space. Retrying a ticket then sends it without the screenshot.' })),
    h('div.card',
      h('h2', 'Shared data'),
      h('p.muted', 'If a shared backend is linked under Shared data, each saved ticket is also sent there.'),
      ctx.field({ key: 'shareScreenshots', label: 'Include screenshots in shared data', type: 'toggle', hint: 'Off sends the ticket text and diagnostics only.' })));
}

await mountApp({
  baseName: BASE_NAME,
  tagline: 'Screenshot, mark up and report a problem in seconds',
  settings,
  panels: [
    { id: 'tickets', label: 'My tickets', icon: '🎫', render: renderTickets },
    { id: 'destination', label: 'Destination', icon: '📮', render: renderDestination },
    { id: 'form', label: 'Ticket form', icon: '📝', render: renderForm },
    { id: 'capture', label: 'Capture', icon: '📸', render: renderCapture },
    { id: 'privacy', label: 'Privacy & storage', icon: '🛡️', render: renderPrivacy },
  ],
  syncCollections: ['tickets'],
  welcomeSteps: [
    'Pin Ticket Snap to the toolbar: click the puzzle-piece icon, then the pin next to Ticket Snap.',
    'On the page with the problem, click the Ticket Snap button and choose "Capture this tab" (or press Alt+Shift+S).',
    'Mark up the screenshot with arrows, boxes and highlights, and black out anything private with Redact.',
    'Describe the problem and save. The ticket lands in My tickets, ready to download, copy or email. Want it sent to your help desk automatically? Pick a Destination.',
  ],
});

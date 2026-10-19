// Optional ticket destinations. The default ("local") never sends anything anywhere.
// Each remote destination needs host permission for its site, which is requested from a click
// handler (requestDestinationAccess) before settings are saved or a ticket is sent.
import { api } from '../shared/api.js';
import {
  ticketText, ticketTitle, priorityLabel, requesterText, dataUrlToBlob, base64Of, pngName,
} from './tickets.js';

export const DESTINATIONS = {
  local: {
    blurb: 'Saved in this browser. No setup.',
    label: 'Save to My tickets (this browser)',
    short: 'My tickets',
    help: 'Tickets stay in this browser. You can download, copy or email them from My tickets at any time.',
    fields: [],
  },
  email: {
    blurb: 'Pre-filled email plus the PNG',
    label: 'Email to the help desk',
    short: 'Email',
    help: 'Opens a pre-filled email in your mail app and downloads the annotated screenshot so you can attach it.',
    fields: [
      { key: 'helpdeskEmail', label: 'Help-desk email address', type: 'email', placeholder: 'Leave empty to use the brand support email' },
    ],
  },
  webhook: {
    blurb: 'POST JSON to any URL',
    label: 'Webhook (POST JSON)',
    short: 'Webhook',
    help: 'Sends each ticket as JSON, with the screenshot as base64, to a URL such as Zapier, Make, n8n, Power Automate or your own service.',
    fields: [
      { key: 'webhookUrl', label: 'Webhook URL', type: 'url', placeholder: 'https://' },
      { key: 'webhookToken', label: 'Auth token (optional)', type: 'password', hint: 'Sent as "Authorization: Bearer <token>".' },
    ],
  },
  jira: {
    blurb: 'Service desk request or issue',
    label: 'Jira Service Management / Jira',
    short: 'Jira',
    help: 'With a service desk id and request type id, tickets are created as customer requests. Otherwise a plain Jira issue is created in the project key. The screenshot is attached.',
    fields: [
      { key: 'jiraSite', label: 'Site URL', type: 'url', placeholder: 'https://your-company.atlassian.net' },
      { key: 'jiraEmail', label: 'Account email', type: 'email' },
      { key: 'jiraToken', label: 'API token', type: 'password', hint: 'Create one at id.atlassian.com → Security → API tokens.' },
      { key: 'jiraServiceDeskId', label: 'Service desk id', placeholder: 'e.g. 3', half: true },
      { key: 'jiraRequestTypeId', label: 'Request type id', placeholder: 'e.g. 17', half: true },
      { key: 'jiraProjectKey', label: 'Project key (plain Jira)', placeholder: 'e.g. IT', half: true },
      { key: 'jiraIssueType', label: 'Issue type (plain Jira)', placeholder: 'Task', half: true },
    ],
  },
  zendesk: {
    blurb: 'Ticket with attachment',
    label: 'Zendesk',
    short: 'Zendesk',
    help: 'Uploads the screenshot, then creates a ticket with it attached.',
    fields: [
      { key: 'zendeskSubdomain', label: 'Subdomain', placeholder: 'your-company (for your-company.zendesk.com)' },
      { key: 'zendeskEmail', label: 'Agent email', type: 'email' },
      { key: 'zendeskToken', label: 'API token', type: 'password', hint: 'Admin Center → Apps and integrations → Zendesk API.' },
    ],
  },
  freshdesk: {
    blurb: 'Ticket with attachment',
    label: 'Freshdesk',
    short: 'Freshdesk',
    help: 'Creates a ticket with the screenshot attached. Freshdesk needs a requester email on every ticket.',
    fields: [
      { key: 'freshdeskDomain', label: 'Domain', placeholder: 'your-company (for your-company.freshdesk.com)' },
      { key: 'freshdeskApiKey', label: 'API key', type: 'password', hint: 'Profile settings → Your API key.' },
    ],
  },
  servicenow: {
    blurb: 'Incident with attachment',
    label: 'ServiceNow',
    short: 'ServiceNow',
    help: 'Creates an incident through the Table API and attaches the screenshot through the Attachment API.',
    fields: [
      { key: 'servicenowInstance', label: 'Instance', placeholder: 'your-company (for your-company.service-now.com)' },
      { key: 'servicenowUser', label: 'User name' },
      { key: 'servicenowPassword', label: 'Password', type: 'password' },
    ],
  },
};

/** Turns "acme", "acme.zendesk.com" or "https://acme.zendesk.com/..." into "https://acme.zendesk.com". */
export function siteBase(raw, suffix) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = v.includes('.') ? `https://${v}` : `https://${v}.${suffix}`;
  try {
    const u = new URL(v);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** Base URL of the destination's API, or '' when not configured. */
export function destinationBase(dest, v) {
  switch (dest) {
    case 'webhook': return /^https?:\/\//i.test(v.webhookUrl || '') ? v.webhookUrl.trim() : '';
    case 'jira': return siteBase(v.jiraSite, 'atlassian.net');
    case 'zendesk': return siteBase(v.zendeskSubdomain, 'zendesk.com');
    case 'freshdesk': return siteBase(v.freshdeskDomain, 'freshdesk.com');
    case 'servicenow': return siteBase(v.servicenowInstance, 'service-now.com');
    default: return '';
  }
}

export function needsHost(dest) {
  return !['local', 'email'].includes(dest);
}

export function originFor(dest, v) {
  const base = destinationBase(dest, v);
  if (!base) return null;
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/** What is missing before the destination can be used ('' when ready). */
export function missingConfig(dest, v) {
  const need = (keys) => keys.filter((k) => !String(v[k] || '').trim());
  let missing = [];
  switch (dest) {
    case 'webhook': missing = destinationBase(dest, v) ? [] : ['webhookUrl']; break;
    case 'jira':
      missing = need(['jiraSite', 'jiraEmail', 'jiraToken']);
      if (!(v.jiraServiceDeskId && v.jiraRequestTypeId) && !v.jiraProjectKey) missing.push('jiraProjectKey');
      break;
    case 'zendesk': missing = need(['zendeskSubdomain', 'zendeskEmail', 'zendeskToken']); break;
    case 'freshdesk': missing = need(['freshdeskDomain', 'freshdeskApiKey']); break;
    case 'servicenow': missing = need(['servicenowInstance', 'servicenowUser', 'servicenowPassword']); break;
    default: break;
  }
  if (!missing.length) return '';
  const labels = Object.fromEntries((DESTINATIONS[dest]?.fields || []).map((f) => [f.key, f.label]));
  if (dest === 'jira' && missing.includes('jiraProjectKey')) labels.jiraProjectKey = 'Project key (or service desk + request type ids)';
  return `Missing: ${missing.map((k) => labels[k] || k).join(', ')}.`;
}

/**
 * Asks for permission to reach the destination's host. Call it first thing in a click handler
 * (no awaits before it) so the browser still sees the user gesture.
 */
export function requestDestinationAccess(dest, v) {
  if (!needsHost(dest)) return Promise.resolve(true);
  const origin = originFor(dest, v);
  if (!origin) return Promise.resolve(false);
  try {
    return api.permissions.request({ origins: [origin] }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

export async function hasDestinationAccess(dest, v) {
  if (!needsHost(dest)) return true;
  const origin = originFor(dest, v);
  if (!origin) return false;
  try {
    return await api.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

// ---- HTTP helpers --------------------------------------------------------------

const basic = (user, pass) => `Basic ${btoa(unescape(encodeURIComponent(`${user}:${pass}`)))}`;

async function call(url, init, what) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`${what}: could not reach ${new URL(url).host} (${e.message}). Check the address and your network.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 300);
    try {
      const j = JSON.parse(body);
      detail = j.errorMessage || j.error?.message || j.error?.detail || j.description || j.message
        || (j.errorMessages && j.errorMessages.join(' ')) || (j.errors && JSON.stringify(j.errors)) || (typeof j.error === 'string' ? j.error : '') || detail;
    } catch { /* not JSON */ }
    const hint = res.status === 401 ? ' Check the user name and token.' : res.status === 403 ? ' The account may not have permission.' : res.status === 404 ? ' Check the address and ids.' : '';
    throw new Error(`${what} failed (${res.status} ${res.statusText}).${hint}${detail ? ` ${String(detail).slice(0, 300)}` : ''}`);
  }
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

const htmlEscape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const textToHtml = (s) => htmlEscape(s).replace(/\n/g, '<br>');

function adf(text) {
  // Atlassian Document Format: one paragraph per line block.
  return {
    type: 'doc',
    version: 1,
    content: String(text).split(/\n{2,}/).map((block) => ({
      type: 'paragraph',
      content: block.split('\n').flatMap((line, i) => [
        ...(i ? [{ type: 'hardBreak' }] : []),
        ...(line ? [{ type: 'text', text: line }] : []),
      ]),
    })).filter((p) => p.content.length),
  };
}

// ---- Senders -------------------------------------------------------------------

/** Email: opens a mailto: draft and downloads the annotated PNG so it can be attached. */
export function sendEmail(t, v, brand, { requireTo = true } = {}) {
  const to = (v.helpdeskEmail || brand?.supportEmail || '').trim();
  if (!to && requireTo) throw new Error('No help-desk email address is set. Add one under Settings → Destination (or set the brand support email).');
  const subject = ticketTitle(t);
  let body = ticketText(t);
  if (t.image) body += `\n\nScreenshot: please see the attached ${pngName(t)} (it was downloaded to your computer).`;
  const MAX = 1800; // mail apps truncate long mailto: links
  if (encodeURIComponent(body).length > MAX) {
    while (encodeURIComponent(body).length > MAX - 60) body = body.slice(0, Math.floor(body.length * 0.9));
    body += '\n…(shortened, full text is in Ticket Snap → My tickets)';
  }
  const href = `mailto:${to ? encodeURIComponent(to) : ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (t.image) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(dataUrlToBlob(t.image));
    a.download = pngName(t);
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  const m = document.createElement('a');
  m.href = href;
  document.body.append(m);
  m.click();
  m.remove();
  return { status: 'emailed', message: to ? `Email draft opened for ${to}.` : 'Email draft opened.' };
}

async function sendWebhook(t, v) {
  const url = destinationBase('webhook', v);
  const headers = { 'Content-Type': 'application/json' };
  if (v.webhookToken) headers.Authorization = /^(Bearer|Basic) /i.test(v.webhookToken) ? v.webhookToken : `Bearer ${v.webhookToken}`;
  const { image, thumb, ...rest } = t;
  const payload = {
    source: 'ticket-snap',
    sentAt: new Date().toISOString(),
    ticket: { ...rest, priorityLabel: priorityLabel(t.priority), text: ticketText(t) },
    screenshot: image ? { filename: pngName(t), contentType: 'image/png', base64: base64Of(image) } : null,
  };
  const out = await call(url, { method: 'POST', headers, body: JSON.stringify(payload) }, 'Webhook');
  const ext = out && typeof out === 'object' ? (out.id || out.key || out.ticketId || '') : '';
  const link = out && typeof out === 'object' ? (out.url || out.link || '') : '';
  return { status: 'sent', externalId: String(ext || ''), externalUrl: link, message: 'Delivered to the webhook.' };
}

async function sendJira(t, v) {
  const base = destinationBase('jira', v);
  const auth = basic(v.jiraEmail.trim(), v.jiraToken.trim());
  const headers = { Authorization: auth, Accept: 'application/json', 'X-Atlassian-Token': 'no-check' };
  const text = ticketText(t, { withSummary: false });
  let key;
  let attachNote = '';
  if (v.jiraServiceDeskId && v.jiraRequestTypeId) {
    const sd = encodeURIComponent(String(v.jiraServiceDeskId).trim());
    const created = await call(`${base}/rest/servicedeskapi/request`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceDeskId: String(v.jiraServiceDeskId).trim(),
        requestTypeId: String(v.jiraRequestTypeId).trim(),
        requestFieldValues: { summary: ticketTitle(t).slice(0, 250), description: text },
      }),
    }, 'Jira Service Management request');
    key = created.issueKey;
    if (t.image) {
      try {
        const fd = new FormData();
        fd.append('file', dataUrlToBlob(t.image), pngName(t));
        const tmp = await call(`${base}/rest/servicedeskapi/servicedesk/${sd}/attachTemporaryFile`, { method: 'POST', headers, body: fd }, 'Screenshot upload');
        const ids = (tmp.temporaryAttachments || []).map((a) => a.temporaryAttachmentId);
        await call(`${base}/rest/servicedeskapi/request/${encodeURIComponent(key)}/attachment`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ temporaryAttachmentIds: ids, public: true }),
        }, 'Attaching screenshot');
      } catch (e) {
        attachNote = ` Screenshot not attached: ${e.message}`;
      }
    }
  } else {
    const created = await call(`${base}/rest/api/3/issue`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          project: { key: String(v.jiraProjectKey).trim() },
          issuetype: { name: String(v.jiraIssueType || 'Task').trim() },
          summary: ticketTitle(t).slice(0, 250),
          description: adf(text),
        },
      }),
    }, 'Jira issue');
    key = created.key;
    if (t.image) {
      try {
        const fd = new FormData();
        fd.append('file', dataUrlToBlob(t.image), pngName(t));
        await call(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, { method: 'POST', headers, body: fd }, 'Attaching screenshot');
      } catch (e) {
        attachNote = ` Screenshot not attached: ${e.message}`;
      }
    }
  }
  return { status: 'sent', externalId: key, externalUrl: `${base}/browse/${encodeURIComponent(key)}`, message: `Created ${key}.${attachNote}` };
}

async function sendZendesk(t, v) {
  const base = destinationBase('zendesk', v);
  const auth = basic(`${v.zendeskEmail.trim()}/token`, v.zendeskToken.trim());
  const uploads = [];
  if (t.image) {
    const up = await call(`${base}/api/v2/uploads.json?filename=${encodeURIComponent(pngName(t))}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'image/png' },
      body: dataUrlToBlob(t.image),
    }, 'Zendesk upload');
    if (up?.upload?.token) uploads.push(up.upload.token);
  }
  const ticket = {
    subject: ticketTitle(t).slice(0, 250),
    comment: { body: ticketText(t, { withSummary: false }), uploads },
    priority: t.priority || 'normal',
  };
  if (t.requester?.email) ticket.requester = { name: t.requester.name || t.requester.email, email: t.requester.email };
  const out = await call(`${base}/api/v2/tickets.json`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  }, 'Zendesk ticket');
  const id = out?.ticket?.id;
  return { status: 'sent', externalId: `#${id}`, externalUrl: `${base}/agent/tickets/${id}`, message: `Created Zendesk ticket #${id}.` };
}

async function sendFreshdesk(t, v) {
  const base = destinationBase('freshdesk', v);
  const email = t.requester?.email;
  if (!email) throw new Error('Freshdesk needs a requester email. Fill in "Your email" and try again.');
  const prio = { low: 1, normal: 2, high: 3, urgent: 4 }[t.priority] || 2;
  const fd = new FormData();
  fd.append('email', email);
  if (t.requester?.name) fd.append('name', t.requester.name);
  fd.append('subject', ticketTitle(t).slice(0, 250));
  fd.append('description', textToHtml(ticketText(t, { withSummary: false })));
  fd.append('priority', String(prio));
  fd.append('status', '2');
  if (t.image) fd.append('attachments[]', dataUrlToBlob(t.image), pngName(t));
  const out = await call(`${base}/api/v2/tickets`, {
    method: 'POST',
    headers: { Authorization: basic(v.freshdeskApiKey.trim(), 'X') },
    body: fd,
  }, 'Freshdesk ticket');
  return { status: 'sent', externalId: `#${out.id}`, externalUrl: `${base}/a/tickets/${out.id}`, message: `Created Freshdesk ticket #${out.id}.` };
}

async function sendServiceNow(t, v) {
  const base = destinationBase('servicenow', v);
  const auth = basic(v.servicenowUser.trim(), v.servicenowPassword);
  const [urgency, impact] = { low: [3, 3], normal: [2, 2], high: [1, 2], urgent: [1, 1] }[t.priority] || [2, 2];
  const out = await call(`${base}/api/now/table/incident`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      short_description: ticketTitle(t).slice(0, 160),
      description: ticketText(t, { withSummary: false }),
      urgency: String(urgency),
      impact: String(impact),
      contact_type: 'self-service',
    }),
  }, 'ServiceNow incident');
  const { sys_id: sysId, number } = out.result || {};
  let attachNote = '';
  if (t.image && sysId) {
    try {
      await call(`${base}/api/now/attachment/file?table_name=incident&table_sys_id=${encodeURIComponent(sysId)}&file_name=${encodeURIComponent(pngName(t))}`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'image/png', Accept: 'application/json' },
        body: dataUrlToBlob(t.image),
      }, 'Attaching screenshot');
    } catch (e) {
      attachNote = ` Screenshot not attached: ${e.message}`;
    }
  }
  return {
    status: 'sent',
    externalId: number || sysId,
    externalUrl: `${base}/nav_to.do?uri=${encodeURIComponent(`incident.do?sys_id=${sysId}`)}`,
    message: `Created ${number || 'incident'}.${attachNote}`,
  };
}

const SENDERS = { webhook: sendWebhook, jira: sendJira, zendesk: sendZendesk, freshdesk: sendFreshdesk, servicenow: sendServiceNow };

/**
 * Delivers a ticket. Returns { status: 'local'|'sent'|'emailed', message, externalId?, externalUrl? }.
 * Throws an Error with a readable message on failure.
 */
export async function deliver(dest, t, v, brand) {
  if (!dest || dest === 'local') return { status: 'local', message: 'Saved to My tickets.' };
  if (dest === 'email') return sendEmail(t, v, brand);
  const sender = SENDERS[dest];
  if (!sender) throw new Error(`Unknown destination "${dest}".`);
  const missing = missingConfig(dest, v);
  if (missing) throw new Error(`${DESTINATIONS[dest].short} is not set up yet. ${missing}`);
  if (!(await hasDestinationAccess(dest, v))) {
    throw new Error(`Permission to reach ${new URL(destinationBase(dest, v)).host} was not granted.`);
  }
  return sender(t, v);
}

/** Checks the credentials without creating anything. */
export async function testDestination(dest, v) {
  const missing = missingConfig(dest, v);
  if (missing) throw new Error(missing);
  if (!(await hasDestinationAccess(dest, v))) throw new Error('Permission to reach the site was not granted.');
  const base = destinationBase(dest, v);
  switch (dest) {
    case 'webhook':
      await call(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(v.webhookToken ? { Authorization: /^(Bearer|Basic) /i.test(v.webhookToken) ? v.webhookToken : `Bearer ${v.webhookToken}` } : {}) },
        body: JSON.stringify({ source: 'ticket-snap', test: true, sentAt: new Date().toISOString() }),
      }, 'Webhook test');
      return 'The webhook accepted a test message.';
    case 'jira': {
      const me = await call(`${base}/rest/api/3/myself`, { headers: { Authorization: basic(v.jiraEmail.trim(), v.jiraToken.trim()), Accept: 'application/json' } }, 'Jira sign-in');
      return `Signed in to Jira as ${me.displayName || me.emailAddress || 'your account'}.`;
    }
    case 'zendesk': {
      const me = await call(`${base}/api/v2/users/me.json`, { headers: { Authorization: basic(`${v.zendeskEmail.trim()}/token`, v.zendeskToken.trim()) } }, 'Zendesk sign-in');
      if (!me?.user?.id) throw new Error('Zendesk did not accept the email and token.');
      return `Signed in to Zendesk as ${me.user.name}.`;
    }
    case 'freshdesk': {
      const me = await call(`${base}/api/v2/agents/me`, { headers: { Authorization: basic(v.freshdeskApiKey.trim(), 'X') } }, 'Freshdesk sign-in');
      return `Signed in to Freshdesk as ${me?.contact?.name || 'your account'}.`;
    }
    case 'servicenow':
      await call(`${base}/api/now/table/incident?sysparm_limit=1&sysparm_fields=sys_id`, { headers: { Authorization: basic(v.servicenowUser.trim(), v.servicenowPassword), Accept: 'application/json' } }, 'ServiceNow sign-in');
      return 'Signed in to ServiceNow.';
    default:
      return 'Nothing to test. Tickets stay in this browser.';
  }
}

export { requesterText };

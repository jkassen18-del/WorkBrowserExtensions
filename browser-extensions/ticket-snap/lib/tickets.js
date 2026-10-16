// Local ticket store ("My tickets") and ticket formatting shared by the editor, options page,
// popup and background. Everything lives in storage.local under "tickets" (oldest first).
import { api } from '../shared/api.js';
import { createCollection } from '../shared/settings.js';
import { push } from '../shared/connections.js';

export const store = createCollection('tickets');

export const PRIORITIES = [
  ['low', 'Low'],
  ['normal', 'Normal'],
  ['high', 'High'],
  ['urgent', 'Urgent'],
];
export const priorityLabel = (p) => (PRIORITIES.find(([v]) => v === p) || [p, p || 'Normal'])[1];

export const DEST_LABELS = {
  local: 'My tickets',
  email: 'Email',
  webhook: 'Webhook',
  jira: 'Jira',
  zendesk: 'Zendesk',
  freshdesk: 'Freshdesk',
  servicenow: 'ServiceNow',
};

export const STATUS = {
  local: { label: 'Saved', cls: 'primary' },
  sent: { label: 'Sent', cls: 'ok' },
  emailed: { label: 'Email drafted', cls: 'ok' },
  failed: { label: 'Not sent', cls: 'danger' },
  sending: { label: 'Sending…', cls: 'warn' },
};

export async function listTickets() {
  return (await store.all()).slice().reverse(); // newest first
}

export async function getTicket(id) {
  return (await store.all()).find((t) => t.id === id) || null;
}

/** Adds or updates a ticket, applying the "keep N tickets" and "keep screenshots" settings. */
export async function saveTicket(ticket, values) {
  const rec = { ...ticket };
  if (!values.keepScreenshots) delete rec.image;
  let list = await store.all();
  const i = list.findIndex((t) => t.id === rec.id);
  if (i >= 0) list[i] = rec;
  else list.push(rec);
  const max = Math.max(1, Number(values.maxTickets) || 50);
  if (list.length > max) list = list.slice(-max);
  await store.save(list);
  return rec;
}

export async function updateTicket(id, patch) {
  const list = await store.all();
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  await store.save(list);
  return list[i];
}

export const deleteTicket = (id) => store.remove(id);

/** Diagnostics rows that may be included, honouring the "include URL" choice. */
export function visibleDiagnostics(ticket) {
  return (ticket.diagnostics || []).filter((d) => d.value !== '' && d.value != null);
}

export function requesterText(r = {}) {
  if (r.name && r.email) return `${r.name} <${r.email}>`;
  return r.name || r.email || '';
}

/** Plain-text version used for "Copy text", email bodies and help-desk descriptions. */
export function ticketText(t, { withSummary = true } = {}) {
  const lines = [];
  if (withSummary) lines.push(`Summary: ${t.summary || '(no summary)'}`);
  lines.push(`Category: ${t.category || '-'} · Priority: ${priorityLabel(t.priority)}`);
  const req = requesterText(t.requester);
  if (req) lines.push(`Requester: ${req}`);
  lines.push(`Reference: ${t.ref} · Created: ${new Date(t.createdAt).toLocaleString()}`);
  lines.push('', 'Description:', t.description?.trim() || '(none)');
  const diags = visibleDiagnostics(t);
  if (diags.length) {
    lines.push('', 'Diagnostics:');
    for (const d of diags) lines.push(`- ${d.label}: ${Array.isArray(d.value) ? `\n    ${d.value.join('\n    ')}` : d.value}`);
  }
  return lines.join('\n');
}

export function ticketTitle(t) {
  return t.category ? `[${t.category}] ${t.summary}` : t.summary;
}

export function pngName(t) {
  return `${t.ref || 'ticket'}-screenshot.png`;
}

/** The record pushed to a linked shared-data backend (no image unless allowed). */
export function shareRecord(t, values) {
  const { image, thumb, ...rest } = t;
  const out = { ...rest, source: 'ticket-snap' };
  if (values.shareScreenshots) {
    if (image) out.image = image;
    if (thumb) out.thumb = thumb;
  }
  return out;
}

/** Pushes a ticket to the linked shared-data backend. A no-op when nothing is linked. */
export async function shareTicket(t, values) {
  try {
    return await push('ticket-snap', 'tickets', shareRecord(t, values));
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---- Image helpers (pages only) ------------------------------------------------

export function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const type = /data:([^;]+)/.exec(head)?.[1] || 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function base64Of(dataUrl) {
  return dataUrl ? dataUrl.split(',')[1] : '';
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

/** Small JPEG thumbnail of a canvas or image (max 320px wide). */
export function makeThumb(source, maxW = 320) {
  const w = source.width;
  const hgt = source.height;
  const scale = Math.min(1, maxW / w);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(hgt * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

export async function storageBytes() {
  try {
    return await api.storage.local.getBytesInUse?.('tickets');
  } catch {
    return null;
  }
}

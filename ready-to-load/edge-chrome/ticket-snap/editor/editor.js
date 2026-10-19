// Ticket Snap editor: annotate the captured screenshot and fill in the ticket.
import { api, uid } from '/shared/api.js';
import { h, add, clear, toast, confirmDialog, copyText, pickFile, readAsDataURL, toggle, lockedBadge } from '/shared/ui.js';
import { brandPage } from '/shared/app-shell.js';
import { productName, logoSrc } from '/shared/brand.js';
import { settings } from '../settings.js';
import {
  PRIORITIES, saveTicket, updateTicket, shareTicket, ticketText, makeThumb, loadImage, pngName, dataUrlToBlob,
} from '../lib/tickets.js';
import { DESTINATIONS, needsHost, requestDestinationAccess, deliver, missingConfig } from '../lib/destinations.js';
import { ICONS } from '../lib/icons.js';

const BASE_NAME = 'Ticket Snap';
const URL_KEYS = new Set(['url', 'referrer']);
const TOOLS = [
  { id: 'arrow', label: 'Arrow', key: 'a' },
  { id: 'rect', label: 'Box', key: 'r' },
  { id: 'highlight', label: 'Highlight', key: 'h' },
  { id: 'redact', label: 'Redact', key: 'x' },
  { id: 'pen', label: 'Pen', key: 'p' },
  { id: 'text', label: 'Text', key: 't' },
  { id: 'crop', label: 'Crop', key: 'c' },
];
const FIELD_LABELS = { summary: 'Summary', description: 'Description', category: 'Category', requesterName: 'Your name', requesterEmail: 'Your email' };

const brand = await brandPage(BASE_NAME, { titleSuffix: 'New ticket' });
const state = await settings.load();
const values = state.values;
const captureId = new URLSearchParams(location.search).get('id');
const captureKey = captureId ? `capture:${captureId}` : null;
const capture = captureKey ? (await api.storage.local.get(captureKey))[captureKey] : null;

let img = null;
let doc = { shapes: [], crop: null };
const undoStack = [];
const redoStack = [];
let tool = 'arrow';
let color = brand.primary;
let draft = null;
let submitted = false;
let dirty = false;

try {
  const pref = JSON.parse(localStorage.getItem('ts-editor') || '{}');
  if (pref.tool && TOOLS.some((t) => t.id === pref.tool && t.id !== 'crop')) tool = pref.tool;
  if (/^#[0-9a-f]{6}$/i.test(pref.color || '')) color = pref.color;
} catch { /* storage unavailable */ }
const rememberPrefs = () => {
  try { localStorage.setItem('ts-editor', JSON.stringify({ tool: tool === 'crop' ? 'arrow' : tool, color })); } catch { /* ignore */ }
};

// ---- Page chrome -------------------------------------------------------------------

const logo = logoSrc(brand)
  ? h('img.wx-logo', { src: logoSrc(brand), alt: '' })
  : h('div.wx-logo-fallback', (brand.companyName || '?').trim().charAt(0).toUpperCase());
const header = h('header.wx-header', logo,
  h('div.grow', h('div.wx-title', productName(brand, BASE_NAME)), h('div.wx-sub', 'New ticket · mark up the screenshot, then describe the problem')),
  h('button.btn.ghost.sm', { onclick: () => openTickets() }, 'My tickets'));
const toolbar = h('div.ts-toolbar', { role: 'toolbar', 'aria-label': 'Annotation tools' });
const stage = h('div.ts-stage');
const hint = h('div.ts-hint');
const side = h('aside.ts-side');
document.body.append(header, h('div.ts-layout', h('section', toolbar, stage, hint), side));

const canvas = h('canvas', { 'aria-label': 'Screenshot. Draw on it to annotate.' });
const ctx2d = canvas.getContext('2d');
const canvasBox = h('div.ts-canvas-box', canvas);

function openTickets(ticketId) {
  const u = api.runtime.getURL(`options/options.html${ticketId ? `?open=${encodeURIComponent(ticketId)}` : ''}#tickets`);
  api.tabs.create({ url: u });
}

// ---- Toolbar -----------------------------------------------------------------------

const toolButtons = {};
const iconBtn = (id, label, onclick, extra = {}) => h('button.ts-tool', {
  type: 'button', title: label, 'aria-label': label, onclick, html: `${ICONS[id] || ''}<span class="ts-label">${label}</span>`, ...extra,
});
const undoBtn = iconBtn('undo', 'Undo', () => undo(), { title: 'Undo (Ctrl+Z)' });
const redoBtn = iconBtn('redo', 'Redo', () => redo(), { title: 'Redo (Ctrl+Shift+Z)' });
const clearBtn = iconBtn('clear', 'Clear', () => clearAll(), { title: 'Remove all annotations and the crop' });
const colorRow = h('div.ts-colors', { role: 'group', 'aria-label': 'Colour' });
const customColor = h('input', { type: 'color', value: color, title: 'Custom colour', 'aria-label': 'Custom colour' });
customColor.addEventListener('input', () => setColor(customColor.value));

function paintToolbar() {
  clear(toolbar);
  for (const t of TOOLS) {
    toolButtons[t.id] = iconBtn(t.id, t.label, () => setTool(t.id), {
      'aria-pressed': String(tool === t.id), title: `${t.label} (${t.key.toUpperCase()})`, disabled: !img,
    });
    toolbar.append(toolButtons[t.id]);
  }
  const presets = [...new Set([brand.primary, brand.accent, '#E11D48', '#F59E0B', '#16A34A', '#111827', '#FFFFFF'].map((c) => c.toUpperCase()))];
  clear(colorRow, presets.map((c) => h('button.ts-color', {
    type: 'button', title: c, 'aria-label': `Colour ${c}`, 'aria-pressed': String(color.toUpperCase() === c),
    style: { background: c }, disabled: !img, onclick: () => setColor(c),
  })), customColor);
  customColor.disabled = !img;
  toolbar.append(h('div.ts-sep'), colorRow, h('div.ts-sep'), undoBtn, redoBtn, clearBtn, h('div.ts-spacer'),
    iconBtn('image', img ? 'Replace image' : 'Attach image', () => attachImage(), { title: 'Use an image file instead (you can also paste one with Ctrl+V)' }));
  updateHistoryButtons();
}

function setTool(id) {
  tool = id;
  Object.entries(toolButtons).forEach(([k, b]) => b.setAttribute('aria-pressed', String(k === id)));
  canvas.className = id === 'text' ? 'tool-text' : 'tool-draw';
  hint.textContent = {
    arrow: 'Drag to draw an arrow.',
    rect: 'Drag to draw a box around something.',
    highlight: 'Drag over text or an area to highlight it.',
    redact: 'Drag over anything private (passwords, personal data). It is painted over in the saved image.',
    pen: 'Draw freehand.',
    text: 'Click where the text should go, type, then press Enter.',
    crop: 'Drag to keep only part of the screenshot. Undo brings the rest back.',
  }[id];
  rememberPrefs();
}

function setColor(c) {
  color = c;
  customColor.value = /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : customColor.value;
  colorRow.querySelectorAll('.ts-color').forEach((b) => b.setAttribute('aria-pressed', String(b.title.toUpperCase() === c.toUpperCase())));
  rememberPrefs();
}

// ---- History -----------------------------------------------------------------------

const snapshot = () => JSON.stringify(doc);
function commit(mutator) {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
  mutator();
  dirty = true;
  afterChange();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  doc = JSON.parse(undoStack.pop());
  afterChange();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  doc = JSON.parse(redoStack.pop());
  afterChange();
}
async function clearAll() {
  if (!doc.shapes.length && !doc.crop) return;
  if (!(await confirmDialog('Clear annotations', 'Remove every arrow, box, highlight, redaction, drawing and text, and undo the crop?', { okLabel: 'Clear' }))) return;
  commit(() => { doc = { shapes: [], crop: null }; });
}
function updateHistoryButtons() {
  undoBtn.disabled = !undoStack.length;
  redoBtn.disabled = !redoStack.length;
  clearBtn.disabled = !doc.shapes.length && !doc.crop;
}
function afterChange() {
  sizeCanvas();
  render();
  updateHistoryButtons();
}

// ---- Drawing -----------------------------------------------------------------------

const cropRect = () => doc.crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };

function sizeCanvas() {
  if (!img) return;
  const c = cropRect();
  if (canvas.width !== c.w || canvas.height !== c.h) {
    canvas.width = c.w;
    canvas.height = c.h;
  }
}

/** Image pixels per CSS pixel, so strokes look the same on screen at any screenshot size. */
function pxScale() {
  const r = canvas.getBoundingClientRect();
  return r.width ? Math.max(1, canvas.width / r.width) : 1;
}

function norm(s) {
  const x = Math.min(s.x, s.x + s.w);
  const y = Math.min(s.y, s.y + s.h);
  return { ...s, x, y, w: Math.abs(s.w), h: Math.abs(s.h) };
}

function drawShape(g, s) {
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (s.t) {
    case 'rect': {
      const r = norm(s);
      g.strokeStyle = s.color;
      g.lineWidth = s.lw;
      g.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'highlight': {
      const r = norm(s);
      g.globalAlpha = 0.35;
      g.fillStyle = s.color;
      g.fillRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'redact': {
      const r = norm(s);
      g.fillStyle = s.color;
      g.fillRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'arrow': {
      const { x1, y1, x2, y2, lw } = s;
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(10, lw * 4.2);
      g.strokeStyle = s.color;
      g.fillStyle = s.color;
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2 - Math.cos(ang) * head * 0.6, y2 - Math.sin(ang) * head * 0.6);
      g.stroke();
      g.beginPath();
      g.moveTo(x2, y2);
      g.lineTo(x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7));
      g.lineTo(x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7));
      g.closePath();
      g.fill();
      break;
    }
    case 'pen': {
      g.strokeStyle = s.color;
      g.lineWidth = s.lw;
      g.beginPath();
      s.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      if (s.pts.length === 1) g.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
      g.stroke();
      break;
    }
    case 'text': {
      g.font = `600 ${s.size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      g.textBaseline = 'top';
      const light = isLight(s.color);
      g.lineWidth = Math.max(2, s.size / 5);
      g.strokeStyle = light ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)';
      g.strokeText(s.text, s.x, s.y);
      g.fillStyle = s.color;
      g.fillText(s.text, s.x, s.y);
      break;
    }
    default: break;
  }
  g.restore();
}

function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 170;
}

function paint(g, { withDraft }) {
  const c = cropRect();
  g.clearRect(0, 0, c.w, c.h);
  g.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
  g.save();
  g.translate(-c.x, -c.y);
  for (const s of doc.shapes) drawShape(g, s);
  if (withDraft && draft && draft.t !== 'crop') drawShape(g, draft);
  g.restore();
  if (withDraft && draft?.t === 'crop') {
    const r = norm(draft);
    const x = r.x - c.x;
    const y = r.y - c.y;
    g.save();
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.beginPath();
    g.rect(0, 0, c.w, c.h);
    g.rect(x, y, r.w, r.h);
    g.fill('evenodd');
    g.setLineDash([8 * pxScale(), 6 * pxScale()]);
    g.strokeStyle = '#fff';
    g.lineWidth = 2 * pxScale();
    g.strokeRect(x, y, r.w, r.h);
    g.restore();
  }
}

function render() {
  if (img) paint(ctx2d, { withDraft: true });
}

/** The annotated (and cropped) screenshot as a PNG data URL. */
function exportPng() {
  if (!img) return null;
  const c = cropRect();
  const out = document.createElement('canvas');
  out.width = c.w;
  out.height = c.h;
  paint(out.getContext('2d'), { withDraft: false });
  return out;
}

function pointFromEvent(e) {
  const r = canvas.getBoundingClientRect();
  const c = cropRect();
  const x = c.x + ((e.clientX - r.left) / r.width) * c.w;
  const y = c.y + ((e.clientY - r.top) / r.height) * c.h;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

canvas.addEventListener('pointerdown', (e) => {
  if (!img || e.button !== 0) return;
  if (tool === 'text') {
    e.preventDefault();
    startText(e);
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = pointFromEvent(e);
  const k = pxScale();
  const lw = Math.max(2, Math.round(3 * k));
  if (tool === 'arrow') draft = { t: 'arrow', x1: x, y1: y, x2: x, y2: y, color, lw };
  else if (tool === 'pen') draft = { t: 'pen', pts: [[x, y]], color, lw };
  else if (tool === 'redact') draft = { t: 'redact', x, y, w: 0, h: 0, color: values.redactColor || '#000000' };
  else if (tool === 'highlight') draft = { t: 'highlight', x, y, w: 0, h: 0, color };
  else if (tool === 'crop') draft = { t: 'crop', x, y, w: 0, h: 0 };
  else draft = { t: 'rect', x, y, w: 0, h: 0, color, lw };
  render();
});

canvas.addEventListener('pointermove', (e) => {
  if (!draft) return;
  const [x, y] = pointFromEvent(e);
  if (draft.t === 'arrow') {
    draft.x2 = x;
    draft.y2 = y;
  } else if (draft.t === 'pen') {
    const last = draft.pts[draft.pts.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) >= 1.5) draft.pts.push([x, y]);
  } else {
    draft.w = x - draft.x;
    draft.h = y - draft.y;
  }
  render();
});

function finishDraft() {
  if (!draft) return;
  const s = draft;
  draft = null;
  const min = 4 * pxScale();
  if (s.t === 'arrow' && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < min) return render();
  if (s.t === 'pen' && s.pts.length < 2) return render();
  if (['rect', 'highlight', 'redact', 'crop'].includes(s.t) && (Math.abs(s.w) < min || Math.abs(s.h) < min)) return render();
  if (s.t === 'crop') {
    const r = norm(s);
    const c = cropRect();
    const x = Math.max(c.x, Math.round(r.x));
    const y = Math.max(c.y, Math.round(r.y));
    const w = Math.min(c.x + c.w, Math.round(r.x + r.w)) - x;
    const hgt = Math.min(c.y + c.h, Math.round(r.y + r.h)) - y;
    if (w < 8 || hgt < 8) return render();
    commit(() => { doc.crop = { x, y, w, h: hgt }; });
    setTool('arrow');
    toast('Cropped. Use Undo to bring the rest back.');
    return undefined;
  }
  commit(() => doc.shapes.push(['rect', 'highlight', 'redact'].includes(s.t) ? norm(s) : s));
  return undefined;
}
canvas.addEventListener('pointerup', finishDraft);
canvas.addEventListener('pointercancel', () => { draft = null; render(); });

function startText(e) {
  canvasBox.querySelector('.ts-text-input')?.blur();
  const [x, y] = pointFromEvent(e);
  const k = pxScale();
  const size = Math.round(20 * k);
  const r = canvas.getBoundingClientRect();
  const box = canvasBox.getBoundingClientRect();
  const input = h('input.ts-text-input', {
    type: 'text', placeholder: 'Type, then Enter', 'aria-label': 'Annotation text',
    style: {
      left: `${e.clientX - box.left}px`, top: `${e.clientY - box.top - 4}px`,
      fontSize: `${Math.max(12, size / k)}px`, color: isLight(color) ? '#111827' : color,
      maxWidth: `${Math.max(160, r.right - e.clientX)}px`,
    },
  });
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    input.remove();
    if (keep && text) commit(() => doc.shapes.push({ t: 'text', x, y, text, color, size }));
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  canvasBox.append(input);
  input.focus();
  setTimeout(() => input.focus(), 0);
}

// ---- Image source ------------------------------------------------------------------

async function setImage(src, { resetHistory = true } = {}) {
  img = await loadImage(src);
  if (resetHistory) {
    doc = { shapes: [], crop: null };
    undoStack.length = 0;
    redoStack.length = 0;
  }
  paintStage();
  paintToolbar();
  setTool(tool);
  afterChange();
}

async function attachImage(file) {
  const f = file || (await pickFile('image/png,image/jpeg,image/webp,image/gif'));
  if (!f) return;
  if (!/^image\//.test(f.type)) return toast('Please choose an image file.', { error: true });
  if (img && (doc.shapes.length || doc.crop) && !(await confirmDialog('Replace the image?', 'Your annotations on the current image will be lost.', { okLabel: 'Replace' }))) return;
  try {
    await setImage(await readAsDataURL(f));
    dirty = true;
  } catch (e) {
    toast(`Could not open that image: ${e.message}`, { error: true });
  }
  return undefined;
}

document.addEventListener('paste', (e) => {
  if (submitted) return;
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) && img) return;
  e.preventDefault();
  attachImage(file);
});

function paintStage() {
  if (img) {
    clear(stage, canvasBox);
    return;
  }
  clear(stage, h('div.empty.ts-empty-stage',
    h('div.ts-empty-icon', { html: ICONS.image }),
    h('div.empty-title', capture?.captureError ? 'No screenshot for this page' : 'No screenshot attached'),
    h('p', capture?.captureError || 'This ticket was started without a screenshot. That is fine: describe the problem on the right, or add an image.'),
    h('div.row', { style: { justifyContent: 'center' } },
      h('button.btn.primary', { onclick: () => attachImage() }, 'Attach an image…'),
      h('span.small', 'or paste one with ', h('kbd', 'Ctrl'), '+', h('kbd', 'V')))));
  hint.textContent = '';
}

// ---- Keyboard ----------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (submitted) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;
  if (typing) return;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  } else if (!mod && !e.altKey && img) {
    const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
    if (t) setTool(t.id);
  }
});

window.addEventListener('resize', () => render());
window.addEventListener('beforeunload', (e) => {
  if (dirty && !submitted) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---- Ticket form -------------------------------------------------------------------

const required = new Set(values.requiredFields || []);
const label = (key, text) => h('label', { for: `f-${key}` }, text, required.has(key) ? h('span.req', { 'aria-hidden': 'true' }, '*') : null);
const fieldWrap = (key, text, control, hintText) => h('div.field', { dataset: { key } }, label(key, text), control, hintText ? h('div.hint', hintText) : null);

const fSummary = h('input#f-summary', { type: 'text', maxlength: 200, placeholder: 'e.g. Expense report will not submit', required: required.has('summary') });
const fDesc = h('textarea#f-description', { rows: 5, placeholder: 'What were you doing? What happened, and what did you expect?' });
const categories = (values.categories || []).filter(Boolean);
const fCategory = h('select#f-category',
  h('option', { value: '' }, required.has('category') ? 'Choose a category…' : 'No category'),
  categories.map((c) => h('option', { value: c }, c)));
const fPriority = h('select#f-priority', PRIORITIES.map(([v, l]) => h('option', { value: v, selected: v === values.defaultPriority }, l)));
const fName = h('input#f-requesterName', { type: 'text', autocomplete: 'name', value: values.requesterName || '' });
const fEmail = h('input#f-requesterEmail', { type: 'email', autocomplete: 'email', value: values.requesterEmail || '' });
[fSummary, fDesc, fCategory, fName, fEmail].forEach((el) => el.addEventListener('input', () => {
  dirty = true;
  el.closest('.field')?.classList.remove('invalid');
}));

let includeDiag = values.includeDiagnostics !== false;
let includeUrl = values.includeUrl !== false;
const diagRows = capture?.diagnostics || [];
const diagBox = h('div');
let diagOpen = false;

function filteredDiagnostics() {
  if (!includeDiag) return [];
  return diagRows.flatMap((d) => {
    if (!includeUrl && URL_KEYS.has(d.key)) return [];
    if (!includeUrl && d.key === 'failedRequests') {
      return [{ ...d, value: `${d.value.length} request(s) failed (addresses hidden)` }];
    }
    return [d];
  });
}

function paintDiagnostics() {
  const rows = diagRows.map((d) => {
    const excluded = !includeDiag || (!includeUrl && URL_KEYS.has(d.key));
    let v = d.value;
    if (!includeUrl && d.key === 'failedRequests') v = `${d.value.length} request(s) failed (addresses hidden)`;
    return h('tr', { class: excluded ? 'excluded' : '' }, h('th', d.label),
      h('td', Array.isArray(v) ? h('ul', v.map((x) => h('li', x))) : String(v)));
  });
  clear(diagBox,
    h('div.field', h('div.row',
      toggle(includeDiag, (on) => { includeDiag = on; paintDiagnostics(); }, { label: 'Include diagnostics' }),
      h('span', 'Include diagnostics'))),
    h('div.field', h('div.row',
      toggle(includeUrl, (on) => { includeUrl = on; paintDiagnostics(); }, { label: 'Include the page address', disabled: !includeDiag || settings.isLocked('includeUrl') }),
      h('span', 'Include the page address (URL)'), settings.isLocked('includeUrl') ? lockedBadge() : null)),
    diagRows.length
      ? h('details.ts-details', { open: diagOpen, ontoggle: (e) => { diagOpen = e.currentTarget.open; } }, h('summary', `View what is attached (${filteredDiagnostics().length} of ${diagRows.length} items)`),
        h('table.table.ts-diag-table', h('tbody', rows)))
      : h('p.small.muted', 'No diagnostics were collected for this ticket.'));
}

const dest = values.destination || 'local';
const destMeta = DESTINATIONS[dest] || DESTINATIONS.local;
const submitLabel = dest === 'local' ? 'Save ticket' : dest === 'email' ? 'Save and open email' : `Create ${destMeta.short} ticket`;
const submitBtn = h('button.btn.primary.block', { type: 'submit' }, submitLabel);
const formError = h('div');

const form = h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
  fieldWrap('summary', 'Summary', fSummary),
  fieldWrap('description', 'Description', fDesc),
  h('div.grid-2', fieldWrap('category', 'Category', fCategory), h('div.field', h('label', { for: 'f-priority' }, 'Priority'), fPriority)),
  h('div.grid-2', fieldWrap('requesterName', 'Your name', fName), fieldWrap('requesterEmail', 'Your email', fEmail)),
  h('hr'),
  diagBox,
  h('hr'),
  h('div.ts-dest', h('span.muted', 'Goes to'), h('b', dest === 'local' ? 'My tickets (this browser)' : destMeta.short),
    h('a', { href: '#', onclick: (e) => { e.preventDefault(); api.tabs.create({ url: api.runtime.getURL('options/options.html#destination') }); } }, 'Change')),
  formError,
  submitBtn,
  h('div.row', { style: { marginTop: '8px', justifyContent: 'center' } },
    h('button.btn.ghost.sm', { type: 'button', onclick: () => downloadPng() }, 'Download image'),
    h('button.btn.ghost.sm', { type: 'button', onclick: () => discard() }, 'Discard')));

function downloadPng() {
  const out = exportPng();
  if (!out) return toast('There is no image to download.', { error: true });
  const a = h('a', { href: URL.createObjectURL(dataUrlToBlob(out.toDataURL('image/png'))), download: `screenshot-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  return undefined;
}

async function discard() {
  if (dirty && !(await confirmDialog('Discard this ticket?', 'The screenshot, annotations and text will be thrown away.', { okLabel: 'Discard', danger: true }))) return;
  submitted = true;
  if (captureKey) await api.storage.local.remove(captureKey);
  window.close();
  // window.close() is ignored for tabs the user navigated; fall back to My tickets.
  setTimeout(() => { location.href = api.runtime.getURL('options/options.html#tickets'); }, 200);
}

function validate() {
  const vals = { summary: fSummary.value.trim(), description: fDesc.value.trim(), category: fCategory.value, requesterName: fName.value.trim(), requesterEmail: fEmail.value.trim() };
  const missing = [...required].filter((k) => k in vals && !vals[k]);
  if (!vals.summary && !missing.includes('summary')) {
    // A ticket always needs something to call it.
    vals.summary = vals.description.split('\n')[0].slice(0, 80) || (capture?.diagnostics?.find((d) => d.key === 'title')?.value ? `Problem on "${capture.diagnostics.find((d) => d.key === 'title').value}"` : 'Problem report');
  }
  const badEmail = vals.requesterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vals.requesterEmail);
  form.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
  for (const k of missing) form.querySelector(`.field[data-key="${k}"]`)?.classList.add('invalid');
  if (badEmail) form.querySelector('.field[data-key="requesterEmail"]')?.classList.add('invalid');
  if (missing.length || badEmail) {
    const msg = missing.length ? `Please fill in: ${missing.map((k) => FIELD_LABELS[k]).join(', ')}.` : 'Please enter a valid email address.';
    clear(formError, h('div.notice.danger', msg));
    form.querySelector('.field.invalid input, .field.invalid textarea, .field.invalid select')?.focus();
    return null;
  }
  clear(formError);
  return vals;
}

async function submit() {
  const vals = validate();
  if (!vals) return;
  // Ask for host access first, while the click still counts as a user gesture.
  const access = needsHost(dest) && !missingConfig(dest, values) ? requestDestinationAccess(dest, values) : Promise.resolve(true);
  submitBtn.disabled = true;
  submitBtn.textContent = dest === 'local' ? 'Saving…' : 'Sending…';

  const out = exportPng();
  const id = uid('t_');
  const ticket = {
    id,
    ref: `TS-${id.slice(2, 8).toUpperCase()}`,
    createdAt: Date.now(),
    summary: vals.summary,
    description: vals.description,
    category: vals.category,
    priority: fPriority.value,
    requester: { name: vals.requesterName, email: vals.requesterEmail },
    diagnostics: filteredDiagnostics(),
    includeDiagnostics: includeDiag,
    pageTitle: includeDiag ? (diagRows.find((d) => d.key === 'title')?.value || '') : '',
    pageUrl: includeDiag && includeUrl ? (diagRows.find((d) => d.key === 'url')?.value || '') : '',
    destination: dest,
    status: 'local',
    statusMessage: '',
    image: out ? out.toDataURL('image/png') : null,
    thumb: out ? makeThumb(out) : null,
  };

  let result;
  try {
    await access;
    result = await deliver(dest, ticket, values, brand);
  } catch (e) {
    result = { status: 'failed', message: String(e.message || e) };
  }
  Object.assign(ticket, {
    status: result.status,
    statusMessage: result.message || '',
    externalId: result.externalId || '',
    externalUrl: result.externalUrl || '',
    sentAt: result.status === 'sent' || result.status === 'emailed' ? Date.now() : null,
    attempts: dest === 'local' ? 0 : 1,
  });

  try {
    await saveTicket(ticket, values);
  } catch (e) {
    submitBtn.disabled = false;
    submitBtn.textContent = submitLabel;
    clear(formError, h('div.notice.danger', `Could not save the ticket in this browser: ${e.message}`));
    return;
  }
  submitted = true;
  shareTicket(ticket, values);
  if (values.rememberRequester) {
    const patch = {};
    if (vals.requesterName !== values.requesterName && !settings.isLocked('requesterName')) patch.requesterName = vals.requesterName;
    if (vals.requesterEmail !== values.requesterEmail && !settings.isLocked('requesterEmail')) patch.requesterEmail = vals.requesterEmail;
    if (Object.keys(patch).length) settings.set(patch).catch(() => {});
  }
  if (captureKey) api.storage.local.remove(captureKey);
  showDone(ticket);
}

function retryNow(t, btn) {
  const access = needsHost(t.destination) && !missingConfig(t.destination, values) ? requestDestinationAccess(t.destination, values) : Promise.resolve(true);
  btn.disabled = true;
  btn.textContent = 'Sending…';
  (async () => {
    let result;
    try {
      await access;
      result = await deliver(t.destination, t, values, brand);
    } catch (e) {
      result = { status: 'failed', message: String(e.message || e) };
    }
    const updated = await updateTicket(t.id, {
      status: result.status,
      statusMessage: result.message || '',
      externalId: result.externalId || '',
      externalUrl: result.externalUrl || '',
      sentAt: result.status === 'failed' ? null : Date.now(),
      attempts: (t.attempts || 0) + 1,
    }) || { ...t, ...result, statusMessage: result.message };
    shareTicket(updated, values);
    if (result.status === 'failed') toast('Still not sent. Check the destination settings.', { error: true });
    showDone({ ...updated, image: t.image });
  })();
}

function showDone(t) {
  const failed = t.status === 'failed';
  const title = {
    local: 'Ticket saved',
    sent: `Ticket created${t.externalId ? `: ${t.externalId}` : ''}`,
    emailed: 'Email draft opened',
    failed: 'Saved, but not sent',
  }[t.status];
  const body = {
    local: 'It is in My tickets in this browser. Download it, copy the text or email it whenever you like.',
    sent: t.statusMessage,
    emailed: t.image ? `Attach ${pngName(t)} (just downloaded) to the email, then send it.` : 'Check the email and send it.',
    failed: t.statusMessage,
  }[t.status];
  const actions = h('div.stack',
    failed ? h('button.btn.primary', { onclick: (e) => retryNow(t, e.currentTarget) }, 'Retry now') : null,
    t.externalUrl ? h('a.btn.primary', { href: t.externalUrl, target: '_blank', rel: 'noopener' }, `Open ${t.externalId || 'ticket'}`) : null,
    h('button.btn', { class: failed || t.externalUrl ? '' : 'primary', onclick: () => openTickets(t.id) }, 'View in My tickets'),
    h('div.row',
      t.image ? h('button.btn.sm.grow', { onclick: () => downloadPng() }, 'Download image') : null,
      h('button.btn.sm.grow', { onclick: async () => toast((await copyText(ticketText(t))) ? 'Ticket text copied' : 'Copy failed', { error: false }) }, 'Copy text')),
    h('button.btn.ghost', { onclick: () => window.close() }, 'Close this tab'));
  clear(side, h('div.card',
    h('div.ts-done-icon', { class: failed ? 'fail' : '' }, failed ? '!' : '✓'),
    h('h2', title),
    h('p.muted', `${t.ref} · ${t.summary}`),
    body ? h(failed ? 'div.notice.danger' : 'p', body) : null,
    failed ? h('p.small.muted', 'The ticket is kept in My tickets with status "Not sent" so nothing is lost.') : null,
    t.thumb ? h('img.ts-done-thumb', { src: t.thumb, alt: 'Screenshot preview' }) : null,
    actions));
  toolbar.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
  canvas.style.pointerEvents = 'none';
  hint.textContent = 'This ticket is done. Capture again from the toolbar button or with the keyboard shortcut.';
}

// ---- Start -------------------------------------------------------------------------

add(side, h('div.card',
  h('h2', h('span', { html: ICONS.note, style: { width: '20px', height: '20px', display: 'inline-flex', color: 'var(--wx-primary)' } }), 'Describe the problem'),
  !capture && captureId ? h('div.notice.warn', 'The capture for this page has expired. You can still write the ticket and attach an image.') : null,
  form));
paintDiagnostics();
paintStage();
paintToolbar();
if (capture?.image) {
  try {
    await setImage(capture.image);
  } catch {
    paintStage();
  }
}
setTool(tool);
if (!img) hint.textContent = '';
fSummary.focus();

// Small DOM helpers shared by every extension page. No framework.

/**
 * Element builder: h('button.btn.primary', { onclick }, 'Save')
 * Attributes: on* -> listeners, style (object|string), dataset, class, html (innerHTML; trusted only).
 */
export function h(tag, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [name, ...classes] = tag.split('.');
  const [tagName, id] = name.split('#');
  const el = document.createElement(tagName || 'div');
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Appends children, skipping null/false (unlike Element.append, which prints "null"). */
export function add(el, ...children) {
  append(el, children);
  return el;
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function toast(message, { error = false, timeout = 3200 } = {}) {
  let host = document.querySelector('.wx-toasts');
  if (!host) document.body.append((host = h('div.wx-toasts', { role: 'status', 'aria-live': 'polite' })));
  const t = h('div.wx-toast', { class: error ? 'error' : '' }, message);
  host.append(t);
  setTimeout(() => t.remove(), timeout);
}

/** Opens a modal. content: Node or (close) => Node. Resolves with the value passed to close(). */
export function modal(title, content, { actions } = {}) {
  return new Promise((resolve) => {
    const close = (v) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => e.key === 'Escape' && close(undefined);
    const body = typeof content === 'function' ? content(close) : content;
    const box = h('div.wx-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', title), body,
      actions ? h('div.row.end', { style: { marginTop: '16px' } }, actions(close)) : null);
    const backdrop = h('div.wx-modal-backdrop', { onmousedown: (e) => e.target === backdrop && close(undefined) }, box);
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    box.querySelector('input,select,textarea,button')?.focus();
  });
}

export function confirmDialog(title, message, { okLabel = 'OK', danger = false } = {}) {
  return modal(title, h('p', message), {
    actions: (close) => [
      h('button.btn', { onclick: () => close(false) }, 'Cancel'),
      h('button.btn.primary', { class: danger ? 'danger solid' : '', onclick: () => close(true) }, okLabel),
    ],
  }).then(Boolean);
}

export function download(filename, data, type = 'application/json') {
  const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function pickFile(accept = '') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve(input.files?.[0] || null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export const readAsText = (file) => file.text();
export function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function formatDate(ts, opts = { dateStyle: 'medium', timeStyle: 'short' }) {
  if (!ts) return '';
  return new Intl.DateTimeFormat(undefined, opts).format(new Date(ts));
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const units = [[60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  let v = s / 60;
  for (const [n, unit] of units) {
    if (v < n) return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.floor(v), unit);
    v /= n;
  }
  return '';
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Toggle switch element bound to a boolean. */
export function toggle(checked, onchange, { disabled = false, label } = {}) {
  const input = h('input', { type: 'checkbox', checked: !!checked, disabled, 'aria-label': label || '' });
  input.addEventListener('change', () => onchange(input.checked));
  return h('label.switch', input, h('span'));
}

export const lockedBadge = () => h('span.badge.locked-badge', { title: 'Set by your IT department through browser policy' }, 'Managed');

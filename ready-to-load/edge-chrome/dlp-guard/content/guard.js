// Data Leak Guard content script (classic script, runs after sites.js and detectors.js).
// Listens in the capture phase for paste, drop, file uploads, form submits and chat "send"
// actions, scans the content locally and warns or blocks according to settings.
// Matched text never leaves this script: incidents carry detector names and counts only.
(function () {
  'use strict';
  if (globalThis.__wxDlpGuard) return;
  globalThis.__wxDlpGuard = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const D = globalThis.WxDetectors;
  const S = globalThis.WxSites;
  if (!api || !api.runtime || !api.runtime.id || !D || !S) return;

  // ---------------------------------------------------------------- state
  let ctx = null; // { settings, pausedUntil, tabUrl, brand }
  let bypass = 0; // > 0 while we re-dispatch an event the user allowed
  let dialogOpen = false;
  let lastEditable = null;
  const allowed = new Set(); // fingerprints of values the user chose to share on this page
  const monitored = new Set(); // fingerprints already logged in monitor mode
  const recent = new Map(); // dedupe key -> time

  let seq = 0;
  function refresh(attempt = 0) {
    const mine = ++seq;
    const retry = () => {
      // The background may still be starting (first policy read can take a moment).
      if (attempt < 8 && mine === seq) setTimeout(() => refresh(attempt + 1), 250 * (attempt + 1));
    };
    try {
      api.runtime.sendMessage({ type: 'dlp:context', url: location.href }).then((res) => {
        if (res && res.settings) {
          if (mine === seq) ctx = res;
        } else retry();
      }, retry);
    } catch (e) { /* extension reloaded */ }
  }
  try {
    // Start from the last snapshot (instant), then ask the background for the live context.
    api.storage.local.get(['dlpSnapshot', 'pausedUntil']).then((r) => {
      if (!ctx && r && r.dlpSnapshot && r.dlpSnapshot.settings) {
        const s = r.dlpSnapshot.settings;
        ctx = { settings: s, brand: r.dlpSnapshot.brand, tabUrl: '', pausedUntil: s.allowPause && r.pausedUntil > Date.now() ? r.pausedUntil : 0 };
      }
    }, () => {});
  } catch (e) { /* ignore */ }
  refresh();
  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'managed' || 'settings' in changes || 'pausedUntil' in changes || 'brandOverride' in changes) refresh();
    });
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------- helpers
  function fp(v) {
    let h = 0x811c9dc5;
    const s = String(v);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${(h >>> 0).toString(36)}.${s.length}`;
  }

  function topUrl() {
    if (window === window.top) return location.href;
    try {
      const u = window.top.location.href;
      if (u) return u;
    } catch (e) { /* cross-origin */ }
    if (ctx && ctx.tabUrl) return ctx.tabUrl;
    const ao = location.ancestorOrigins;
    if (ao && ao.length) return `${ao[ao.length - 1]}/`;
    return location.href;
  }

  /** The site's classification when checks apply right now, else null. */
  function site() {
    if (!ctx || !ctx.settings || ctx.settings.enabled === false) return null;
    if (ctx.pausedUntil && ctx.pausedUntil > Date.now()) return null;
    const c = S.classify(topUrl(), ctx.settings);
    return c.checked ? c : null;
  }

  /** The strictest action any enabled detector could produce on this site. */
  function maxAction(st) {
    const s = ctx.settings;
    let m = st.mode;
    for (const d of Object.values(s.detectors || {})) if (d && d.enabled !== false) m = S.stricter(m, S.effective(st.mode, d.mode));
    for (const p of s.customPatterns || []) if (p && p.enabled !== false) m = S.stricter(m, S.effective(st.mode, p.mode));
    return m;
  }

  function evaluate(findings, st, skip) {
    const out = [];
    let action = null;
    for (const f of findings) {
      if (f.values.length && f.values.every((v) => allowed.has(fp(v)) || (skip && skip.has(fp(v))))) continue;
      const a = S.effective(st.mode, f.mode);
      if (a === 'off') continue;
      out.push(Object.assign({}, f, { action: a }));
      action = action ? S.stricter(action, a) : a;
    }
    out.sort((a, b) => (S.RANK[b.action] || 0) - (S.RANK[a.action] || 0));
    return { findings: out, action };
  }

  function log(st, channel, action, findings, extra) {
    const incident = Object.assign({
      domain: st.host,
      category: st.category,
      channel,
      action,
      mode: st.mode,
      detectors: findings.map((f) => ({ id: f.id, label: f.label, count: f.count, kinds: f.kinds })),
    }, extra || {});
    try {
      api.runtime.sendMessage({ type: 'dlp:incident', incident }).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  function logMonitored(st, channel, findings, extra) {
    const key = `${channel}|${findings.map((f) => `${f.id}:${f.values.map(fp).sort().join(',')}`).sort().join(';')}`;
    const now = Date.now();
    const prev = recent.get(key);
    if (prev && now - prev < 5000) return;
    recent.set(key, now);
    for (const f of findings) for (const v of f.values) monitored.add(fp(v));
    log(st, channel, 'logged', findings, extra);
  }

  function allow(findings) {
    for (const f of findings) for (const v of f.values) allowed.add(fp(v));
  }

  function stop(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  const cfg = () => ctx.settings;

  function isTextInput(el) {
    return el instanceof HTMLInputElement && /^(?:text|search|email|url|tel|number|)$/i.test(el.type || '');
  }
  function isPassword(el) {
    return el instanceof HTMLInputElement && el.type === 'password';
  }

  /** The editable element (input, textarea or contenteditable host) for an event target. */
  function editableOf(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || el === hostEl) return null;
    if (el instanceof HTMLTextAreaElement || isTextInput(el) || isPassword(el)) return el;
    if (el.isContentEditable) {
      while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
      return el;
    }
    return null;
  }

  function valueOf(el) {
    if (!el) return '';
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function saveSelection(el) {
    try {
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        return { start: el.selectionStart, end: el.selectionEnd };
      }
      const sel = document.getSelection();
      if (sel && sel.rangeCount) return { range: sel.getRangeAt(0).cloneRange() };
    } catch (e) { /* some input types have no selection */ }
    return null;
  }

  function restoreSelection(el, saved) {
    if (!saved) return;
    try {
      if (saved.range) {
        const sel = document.getSelection();
        sel.removeAllRanges();
        sel.addRange(saved.range);
      } else if (saved.start != null) {
        el.setSelectionRange(saved.start, saved.end);
      }
    } catch (e) { /* ignore */ }
  }

  function makeTransfer(text, html, files) {
    const dt = new DataTransfer();
    if (text) dt.setData('text/plain', text);
    if (html) dt.setData('text/html', html);
    for (const f of files || []) {
      try { dt.items.add(f); } catch (e) { /* ignore */ }
    }
    return dt;
  }

  function dispatchAllowed(target, ev) {
    bypass++;
    try {
      target.dispatchEvent(ev);
    } finally {
      bypass--;
    }
    return ev;
  }

  /** Inserts allowed text at the saved caret: first lets the page's editor handle a paste, then native insertion. */
  function insertText(el, saved, text, html, files) {
    try {
      el.focus({ preventScroll: true });
      restoreSelection(el, saved);
      let ev = null;
      try {
        ev = new ClipboardEvent('paste', { clipboardData: makeTransfer(text, html, files), bubbles: true, cancelable: true, composed: true });
      } catch (e) { ev = null; }
      if (ev && ev.clipboardData) {
        dispatchAllowed(el, ev);
        if (ev.defaultPrevented) return;
      }
      if (!text) return;
      bypass++;
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } finally { bypass--; }
      if (ok) return;
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
      }
    } catch (e) { /* never break the page */ }
  }

  function replayPaste(target, text, html, files) {
    try {
      const ev = new ClipboardEvent('paste', { clipboardData: makeTransfer(text, html, files), bubbles: true, cancelable: true, composed: true });
      dispatchAllowed(target, ev);
    } catch (e) { /* ignore */ }
  }

  function replayDrop(target, orig, text, html, files) {
    try {
      const init = {
        bubbles: true, cancelable: true, composed: true,
        clientX: orig.clientX, clientY: orig.clientY, screenX: orig.screenX, screenY: orig.screenY,
        dataTransfer: makeTransfer(text, html, files),
      };
      dispatchAllowed(target, new DragEvent('drop', init));
    } catch (e) { /* ignore */ }
  }

  async function scanFiles(files) {
    const s = cfg();
    const lists = [];
    const maxBytes = Math.max(0.1, Number(s.maxFileSizeMB) || 2) * 1024 * 1024;
    for (const f of files) {
      lists.push(D.scanFileName(f.name, s));
      if (s.scanFileContents !== false && f.size > 0 && f.size <= maxBytes && D.isTextFile(f.name, f.type)) {
        try {
          const text = await f.slice(0, Math.min(f.size, maxBytes)).text();
          lists.push(D.scanText(text, s));
        } catch (e) { /* unreadable */ }
      }
    }
    return D.merge(...lists);
  }

  function needsContentScan(files) {
    const s = cfg();
    if (s.scanFileContents === false) return false;
    const maxBytes = Math.max(0.1, Number(s.maxFileSizeMB) || 2) * 1024 * 1024;
    return files.some((f) => f.size > 0 && f.size <= maxBytes && D.isTextFile(f.name, f.type));
  }

  /**
   * Shared decision step once findings are known.
   *   onAllow(): replays the user's action;  onCancel(): undoes a held action (e.g. clears a file input).
   * Returns true when the event had to be stopped.
   */
  function decide(st, channel, findings, extra, onAllow, onCancel, alreadyStopped, ev, skip) {
    const r = evaluate(findings, st, skip);
    if (!r.findings.length || r.action === 'monitor') {
      if (r.findings.length) logMonitored(st, channel, r.findings, extra);
      if (alreadyStopped && onAllow) onAllow();
      return false;
    }
    if (ev && !alreadyStopped) stop(ev);
    if (dialogOpen) {
      if (onCancel) onCancel();
      return true;
    }
    if (r.action === 'block') log(st, channel, 'blocked', r.findings, extra);
    showDialog({ st, channel, action: r.action, findings: r.findings }).then((res) => {
      if (r.action === 'block') {
        if (onCancel) onCancel();
        return;
      }
      if (res && res.proceed) {
        allow(r.findings);
        log(st, channel, 'overridden', r.findings, Object.assign({}, extra, { justification: res.justification || '' }));
        if (onAllow) onAllow();
      } else {
        log(st, channel, 'warned', r.findings, extra);
        if (onCancel) onCancel();
      }
    }).catch(() => {});
    return true;
  }

  // ---------------------------------------------------------------- paste
  function onPaste(e) {
    if (bypass || !ctx || cfg().checkPaste === false) return;
    if (e.target === hostEl) return;
    const st = site();
    if (!st) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const el = editableOf(e.target);
    if (el && isPassword(el)) return;
    const text = dt.getData('text/plain') || '';
    const html = dt.getData('text/html') || '';
    const files = Array.from(dt.files || []);
    if (!text && !files.length) return;
    const textFindings = text ? D.scanText(text, cfg()) : [];
    const nameFindings = files.length ? D.merge(...files.map((f) => D.scanFileName(f.name, cfg()))) : [];
    const extra = files.length ? { files: files.length } : null;
    const target = e.target;
    const saved = el ? saveSelection(el) : null;
    const onAllow = () => {
      if (el && !files.length) insertText(el, saved, text, html);
      else replayPaste(el || target, text, html, files);
    };

    if (files.length && cfg().checkUploads !== false && needsContentScan(files)) {
      const hold = S.RANK[maxAction(st)] >= S.RANK.warn;
      if (hold) stop(e);
      scanFiles(files).then((ff) => {
        decide(st, 'paste', D.merge(textFindings, ff), extra, onAllow, null, hold, null);
      }).catch(() => { if (hold) onAllow(); });
      return;
    }
    decide(st, 'paste', D.merge(textFindings, nameFindings), extra, onAllow, null, false, e);
  }

  // ---------------------------------------------------------------- drop
  function onDrop(e) {
    if (bypass || !ctx || cfg().checkDrop === false) return;
    if (e.target === hostEl) return;
    const st = site();
    if (!st) return;
    const dt = e.dataTransfer;
    if (!dt) return;
    const el = editableOf(e.target);
    if (el && isPassword(el)) return;
    const text = dt.getData('text/plain') || '';
    const html = dt.getData('text/html') || '';
    const files = Array.from(dt.files || []);
    if (!text && !files.length) return;
    const textFindings = text ? D.scanText(text, cfg()) : [];
    const nameFindings = files.length ? D.merge(...files.map((f) => D.scanFileName(f.name, cfg()))) : [];
    const extra = files.length ? { files: files.length } : null;
    const target = e.target;
    const orig = { clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY };
    const onAllow = () => {
      if (el && !files.length) insertText(el, saveSelection(el), text, html);
      else replayDrop(target, orig, text, html, files);
    };

    if (files.length && cfg().checkUploads !== false && needsContentScan(files)) {
      const hold = S.RANK[maxAction(st)] >= S.RANK.warn;
      if (hold) stop(e);
      scanFiles(files).then((ff) => {
        decide(st, files.length ? 'upload' : 'drop', D.merge(textFindings, ff), extra, onAllow, null, hold, null);
      }).catch(() => { if (hold) onAllow(); });
      return;
    }
    decide(st, files.length ? 'upload' : 'drop', D.merge(textFindings, nameFindings), extra, onAllow, null, false, e);
  }

  // ---------------------------------------------------------------- file inputs
  const heldInputs = new WeakSet();
  function isFileInput(t) {
    return t instanceof HTMLInputElement && t.type === 'file';
  }
  function onFileInput(e) {
    // The "input" event fires right before "change"; hold it too when we may need to block.
    if (bypass || !ctx || cfg().checkUploads === false || !isFileInput(e.target)) return;
    const st = site();
    if (!st || !e.target.files || !e.target.files.length) return;
    if (S.RANK[maxAction(st)] >= S.RANK.warn) {
      heldInputs.add(e.target);
      e.stopImmediatePropagation();
    }
  }
  function onFileChange(e) {
    if (bypass || !ctx || cfg().checkUploads === false || !isFileInput(e.target)) return;
    const input = e.target;
    const st = site();
    if (!st) return;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const hadInput = heldInputs.has(input);
    heldInputs.delete(input);
    const extra = { files: files.length };
    const onAllow = () => {
      if (hadInput) dispatchAllowed(input, new Event('input', { bubbles: true, composed: true }));
      dispatchAllowed(input, new Event('change', { bubbles: true }));
    };
    const onCancel = () => {
      try { input.value = ''; } catch (err) { /* ignore */ }
    };
    const hold = S.RANK[maxAction(st)] >= S.RANK.warn;
    if (!needsContentScan(files)) {
      const nameFindings = D.merge(...files.map((f) => D.scanFileName(f.name, cfg())));
      const stopped = decide(st, 'upload', nameFindings, extra, onAllow, onCancel, false, e);
      if (!stopped && hadInput) dispatchAllowed(input, new Event('input', { bubbles: true, composed: true }));
      return;
    }
    if (hold) e.stopImmediatePropagation();
    scanFiles(files).then((ff) => {
      decide(st, 'upload', ff, extra, onAllow, onCancel, hold, null);
    }).catch(() => { if (hold) onAllow(); });
  }

  // ---------------------------------------------------------------- form submit
  function formText(form) {
    const parts = [];
    let size = 0;
    for (const el of Array.from(form.elements || [])) {
      if (el instanceof HTMLTextAreaElement || isTextInput(el)) {
        if (el.disabled || !el.value) continue;
        parts.push(el.value);
        size += el.value.length;
      }
      if (size > D.MAX_TEXT) break;
    }
    if (size < D.MAX_TEXT) {
      for (const el of form.querySelectorAll('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]')) {
        if (el.parentElement && el.parentElement.isContentEditable) continue;
        parts.push(valueOf(el));
      }
    }
    return parts.join('\n');
  }

  function onSubmit(e) {
    if (bypass || !ctx || cfg().checkSubmit === false) return;
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const st = site();
    if (!st) return;
    const text = formText(form);
    if (!text) return;
    const submitter = e.submitter || null;
    decide(st, 'submit', D.scanText(text, cfg()), null, () => {
      bypass++;
      try {
        if (form.requestSubmit) {
          try { form.requestSubmit(submitter); } catch (err) { form.requestSubmit(); }
        } else {
          form.submit();
        }
      } catch (err) { /* ignore */ } finally { bypass--; }
    }, null, false, e, monitored);
  }

  // ---------------------------------------------------------------- chat "send" (Enter / send button)
  const CHAT_HINT = /(message|prompt|chat|ask|composer|send|question|reply)/i;
  function chatLike(el, st) {
    if (!el || isPassword(el)) return false;
    if (st.category === 'email') return false; // Enter adds a new line in mail; sending is a button click
    if (st.category === 'ai' || st.category === 'social') return true;
    const attrs = ['placeholder', 'aria-label', 'data-placeholder', 'name', 'id', 'data-testid'].map((a) => el.getAttribute(a) || '').join(' ');
    return CHAT_HINT.test(attrs);
  }

  function findSendButton(el) {
    let scope = el;
    for (let i = 0; i < 6 && scope; i++) {
      scope = scope.parentElement;
      if (!scope) break;
      const btn = Array.from(scope.querySelectorAll('button,[role="button"],input[type="submit"]')).find(looksLikeSend);
      if (btn) return btn;
    }
    return null;
  }

  function looksLikeSend(btn) {
    if (!btn || btn.disabled) return false;
    const s = ['aria-label', 'title', 'data-testid', 'name', 'id'].map((a) => btn.getAttribute(a) || '').join(' ');
    const label = (btn.textContent || btn.value || '').trim();
    if (/\b(send|submit|post|reply|ask)\b|send-button|send_button|sendbutton/i.test(s)) return true;
    if (label.length <= 20 && /^(send|submit|post|reply|ask)\b/i.test(label)) return true;
    return false;
  }

  function checkSend(e, el, replay) {
    if (bypass || !ctx || cfg().checkTyped === false || !el || !el.isConnected) return;
    const st = site();
    if (!st || !chatLike(el, st)) return;
    const text = valueOf(el);
    if (!text || !text.trim()) return;
    decide(st, 'send', D.scanText(text, cfg()), null, replay, null, false, e, monitored);
  }

  function onKeydown(e) {
    if (bypass || e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
    if (e.target === hostEl) return;
    const el = editableOf(e.target);
    if (!el || !(el instanceof HTMLTextAreaElement || el.isContentEditable || isTextInput(el))) return;
    if (isTextInput(el) && el.form) return; // handled by the submit check
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
    checkSend(e, el, () => {
      try {
        el.focus({ preventScroll: true });
        const down = dispatchAllowed(el, new KeyboardEvent('keydown', init));
        dispatchAllowed(el, new KeyboardEvent('keypress', init));
        dispatchAllowed(el, new KeyboardEvent('keyup', init));
        if (!down.defaultPrevented) {
          const btn = findSendButton(el);
          if (btn) {
            bypass++;
            try { btn.click(); } finally { bypass--; }
          } else if (el.form && el.form.requestSubmit) {
            bypass++;
            try { el.form.requestSubmit(); } finally { bypass--; }
          }
        }
      } catch (err) { /* ignore */ }
    });
  }

  function onClick(e) {
    if (bypass || !ctx || e.target === hostEl) return;
    const t = e.target;
    const btn = t && t.closest ? t.closest('button,[role="button"],input[type="submit"]') : null;
    if (!btn || !looksLikeSend(btn)) return;
    let el = lastEditable && lastEditable.isConnected ? lastEditable : null;
    if (!el || !valueOf(el).trim()) {
      // Fall back to a text box near the button.
      let scope = btn;
      for (let i = 0; i < 6 && scope && !el; i++) {
        scope = scope.parentElement;
        if (scope) el = editableOf(scope.querySelector('textarea,[contenteditable="true"],[contenteditable=""]'));
      }
    }
    if (!el) return;
    if (btn.form && (btn.type === 'submit' || btn.getAttribute('type') == null) && btn.tagName === 'BUTTON' && cfg().checkSubmit !== false) {
      // A real form submit: the submit check covers it (with all fields of the form).
      if (el.form === btn.form || btn.form.contains(el)) return;
    }
    checkSend(e, el, () => {
      bypass++;
      try { btn.click(); } catch (err) { /* ignore */ } finally { bypass--; }
    });
  }

  function onFocusIn(e) {
    const el = editableOf(e.target);
    if (el && !isPassword(el)) lastEditable = el;
  }

  // ---------------------------------------------------------------- dialog (Shadow DOM)
  let hostEl = null;

  function contrast(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0b1020' : '#ffffff';
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.backdrop { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: rgba(8, 10, 18, .55); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  color: #141826; animation: fade .12s ease-out; }
.box { width: min(480px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: #fff; border-radius: var(--r);
  box-shadow: 0 24px 64px rgba(0,0,0,.35); }
.head { display: flex; gap: 12px; align-items: center; padding: 16px 20px; background: var(--p); color: var(--on); border-radius: var(--r) var(--r) 0 0; }
.head.block { background: #b91c1c; color: #fff; }
.head svg { flex: none; width: 28px; height: 28px; }
.title { font-weight: 700; font-size: 16px; margin: 0; }
.sub { font-size: 12.5px; opacity: .9; margin: 0; }
.body { padding: 16px 20px 6px; }
p { margin: 0 0 10px; }
ul { list-style: none; margin: 0 0 12px; padding: 0; border: 1px solid #e3e6ef; border-radius: 8px; }
li { padding: 9px 12px; border-top: 1px solid #e3e6ef; }
li:first-child { border-top: 0; }
.row { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.name { font-weight: 600; }
.count { font-size: 12px; font-weight: 700; padding: 1px 8px; border-radius: 999px; background: #f1f3f8; color: #5d6478; white-space: nowrap; }
.count.block { background: rgba(220,38,38,.12); color: #b91c1c; }
.count.warn { background: rgba(217,119,6,.14); color: #b45309; }
.kinds { font-size: 12px; color: #5d6478; }
.samples { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 6px; }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f1f3f8; padding: 1px 6px; border-radius: 4px; color: #141826; word-break: break-all; }
.msg { padding: 10px 12px; border-radius: 8px; background: #f6f7fb; border: 1px solid #e3e6ef; font-size: 13px; }
label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 4px; }
textarea { width: 100%; min-height: 60px; resize: vertical; padding: 8px 10px; font: inherit; color: #141826; background: #fff;
  border: 1px solid #d5d9e4; border-radius: 8px; outline: none; }
textarea:focus { border-color: var(--p); box-shadow: 0 0 0 3px var(--ring); }
.err { color: #b91c1c; font-size: 12px; min-height: 16px; margin-top: 2px; }
.foot { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 20px 16px; flex-wrap: wrap; }
button { font: inherit; font-weight: 600; padding: 8px 16px; border-radius: 8px; cursor: pointer; border: 1px solid #d5d9e4; background: #fff; color: #141826; }
button:hover { background: #f1f3f8; }
button.primary { background: var(--p); border-color: var(--p); color: var(--on); }
button.primary:hover { filter: brightness(1.07); background: var(--p); }
button:focus-visible { outline: 3px solid var(--ring); outline-offset: 1px; }
.note { padding: 0 20px 14px; font-size: 11.5px; color: #5d6478; }
@keyframes fade { from { opacity: 0; } }
@media (prefers-color-scheme: dark) {
  .box { background: #161a26; color: #e8ebf4; }
  ul, li { border-color: #2a3043; }
  .msg { background: #1d2231; border-color: #2a3043; }
  code, .count { background: #1d2231; color: #e8ebf4; }
  .kinds, .note { color: #9aa3ba; }
  textarea, button { background: #161a26; color: #e8ebf4; border-color: #2a3043; }
  button:hover { background: #1d2231; }
}`;

  const SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 4 5.5v6c0 5 3.4 9.3 8 10.5 4.6-1.2 8-5.5 8-10.5v-6l-8-3z"/><path d="M12 8v5"/><path d="M12 16.5h.01"/></svg>';

  const VERB = { paste: 'paste', drop: 'drop', upload: 'upload', submit: 'submit', send: 'send' };
  const WHAT = { paste: 'What you are pasting', drop: 'What you are dropping', upload: 'The file you are uploading', submit: 'This form', send: 'This message' };

  function showDialog({ st, channel, action, findings }) {
    return new Promise((resolve) => {
      dialogOpen = true;
      const brand = (ctx && ctx.brand) || {};
      const s = cfg();
      const primary = /^#[0-9a-f]{6}$/i.test(brand.primary || '') ? brand.primary : '#4F46E5';
      const n = parseInt(primary.slice(1), 16);
      const ring = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, .3)`;
      const radius = Math.max(4, Math.min(20, Number(brand.radius) || 12));
      const isBlock = action === 'block';
      const verb = VERB[channel] || 'continue';
      const needReason = !isBlock && !!s.requireJustification;

      hostEl = document.createElement('wx-dlp-guard');
      hostEl.setAttribute('style', 'all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; display: block !important;');
      const root = hostEl.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = CSS;

      const icon = h('span');
      icon.innerHTML = SHIELD; // static, trusted markup
      const list = h('ul', {}, findings.map((f) => h('li', {},
        h('div', { class: 'row' },
          h('span', { class: 'name', text: f.label }),
          h('span', { class: `count ${f.action === 'block' ? 'block' : f.action === 'warn' ? 'warn' : ''}`, text: `× ${f.count}` })),
        f.kinds && f.kinds.length ? h('div', { class: 'kinds', text: f.kinds.join(', ') }) : null,
        f.samples && f.samples.length ? h('div', { class: 'samples' }, f.samples.map((x) => h('code', { text: x }))) : null)));

      const reason = isBlock ? null : h('textarea', { id: 'reason', maxlength: '500', placeholder: 'For example: test data, customer asked for it, approved by my manager' });
      const err = h('div', { class: 'err', role: 'alert' });
      const cancelBtn = h('button', { class: isBlock ? 'primary' : 'primary', type: 'button', text: isBlock ? 'OK, got it' : 'Cancel' });
      const goBtn = isBlock ? null : h('button', { type: 'button', text: `${verb[0].toUpperCase()}${verb.slice(1)} anyway` });

      const box = h('div', { class: 'box', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'wx-t', 'aria-describedby': 'wx-d' },
        h('div', { class: `head ${isBlock ? 'block' : ''}` }, icon,
          h('div', {},
            h('p', { class: 'title', id: 'wx-t', text: isBlock ? 'Blocked: sensitive data' : 'Sensitive data detected' }),
            h('p', { class: 'sub', text: `${st.host} · ${st.label}` }))),
        h('div', { class: 'body' },
          h('p', { id: 'wx-d', text: isBlock
            ? `${WHAT[channel] || 'This'} contains data that may not be shared with ${st.host}. It was stopped.`
            : `${WHAT[channel] || 'This'} looks like it contains sensitive data. Do you want to ${verb} it to ${st.host}?` }),
          list,
          s.dialogMessage ? h('p', { class: 'msg', text: s.dialogMessage }) : null,
          reason ? h('div', {},
            h('label', { for: 'reason', text: needReason ? 'Reason (required)' : 'Reason (optional)' }),
            reason, err) : null),
        h('div', { class: 'foot' }, goBtn, cancelBtn),
        h('div', { class: 'note', text: `Checked in your browser by ${brand.name || 'Data Leak Guard'}. The content was not sent anywhere.${isBlock ? ' Ask your IT team if you need an exception.' : ''}` }));
      const backdrop = h('div', { class: 'backdrop', style: `--p:${primary};--on:${contrast(primary)};--ring:${ring};--r:${radius}px` }, box);
      root.append(style, backdrop);

      const prevFocus = document.activeElement;
      const done = (result) => {
        dialogOpen = false;
        document.removeEventListener('keydown', onKey, true);
        hostEl.remove();
        hostEl = null;
        try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        resolve(result);
      };
      const onKey = (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          done({ proceed: false });
        }
      };
      cancelBtn.addEventListener('click', () => done({ proceed: false }));
      if (goBtn) {
        goBtn.addEventListener('click', () => {
          const why = reason ? reason.value.trim() : '';
          if (needReason && why.length < 3) {
            err.textContent = 'Please enter a short reason to continue.';
            reason.focus();
            return;
          }
          done({ proceed: true, justification: why });
        });
      }
      // Keep keyboard and clipboard events inside the dialog away from the page.
      for (const type of ['keydown', 'keyup', 'keypress', 'input', 'paste', 'copy', 'cut', 'beforeinput', 'focusin', 'focusout', 'mousedown', 'pointerdown', 'click']) {
        hostEl.addEventListener(type, (ev) => ev.stopPropagation());
      }
      document.addEventListener('keydown', onKey, true);
      (document.body || document.documentElement).appendChild(hostEl);
      setTimeout(() => { try { cancelBtn.focus(); } catch (e) { /* ignore */ } }, 0);
    });
  }

  // ---------------------------------------------------------------- wiring
  const safe = (fn) => (e) => {
    try { fn(e); } catch (err) { /* never break the page */ }
  };
  const opts = { capture: true };
  window.addEventListener('paste', safe(onPaste), opts);
  window.addEventListener('drop', safe(onDrop), opts);
  window.addEventListener('input', safe(onFileInput), opts);
  window.addEventListener('change', safe(onFileChange), opts);
  window.addEventListener('submit', safe(onSubmit), opts);
  window.addEventListener('keydown', safe(onKeydown), opts);
  window.addEventListener('click', safe(onClick), opts);
  window.addEventListener('focusin', safe(onFocusIn), opts);
})();

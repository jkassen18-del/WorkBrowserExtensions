// Environment Labeler content script (classic script, top frame only).
// Asks the background which environment this URL is in, then shows the ribbon/bar/frame, prefixes the tab title,
// tints the favicon and asks for confirmation before form submits on environments that want it.
(function () {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;
  const EI = globalThis.EnvIndicator;
  if (!api?.runtime?.id || !EI || window.top !== window) return;

  // One live instance per page. After an extension update the old copy is orphaned: replace it.
  const prev = globalThis.__envLabeler;
  if (prev && prev.alive()) return;
  if (prev) prev.destroy();

  const HOST_TAG = 'env-labeler-root';
  const OUR_ICON = 'data-env-labeler-icon';
  const STASH_ATTR = 'data-env-labeler-rel';

  let info = null; // last answer from the background (see background.js describe())
  let lastUrl = location.href;
  let hiddenUntil = 0;
  let hideTimer = 0;
  let localSnoozeUntil = 0;
  let bypass = false;
  let dialogOpen = null;
  let brand = null;
  let host = null;
  let shadow = null;
  let indicator = null;
  let indicatorKey = '';
  let appliedPrefix = '';
  let favKey = '';
  let favLink = null;
  let headObserver = null;
  let destroyed = false;

  const alive = () => {
    try {
      return !destroyed && !!api.runtime?.id;
    } catch (_) {
      return false;
    }
  };

  // ---- talking to the background ----------------------------------------------------

  async function ask(message) {
    if (!alive()) {
      destroy();
      return undefined;
    }
    try {
      return await api.runtime.sendMessage(message);
    } catch (_) {
      if (!alive()) destroy();
      return undefined;
    }
  }

  let evalSeq = 0;
  async function evaluate() {
    const seq = ++evalSeq;
    const r = await ask({ type: 'env:match', url: location.href });
    if (seq !== evalSeq || !r || r.error) return;
    info = r;
    applyAll();
  }

  const env = () => (info && info.settings.enabled && info.match ? info.match.env : null);
  const visualOn = () => !!env() && !info.tabHidden;

  function applyAll() {
    applyIndicator();
    applyTitle();
    applyFavicon();
  }

  // ---- ribbon / bar / frame -----------------------------------------------------------

  function ensureHost() {
    if (!host) {
      host = document.createElement(HOST_TAG);
      host.setAttribute('style', 'all:initial!important;position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;display:block!important;');
      shadow = host.attachShadow({ mode: 'closed' });
    }
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
    return shadow;
  }

  function applyIndicator() {
    const e = env();
    const s = info && info.settings;
    const show = visualOn() && s.showRibbon && e.ribbon && Date.now() >= hiddenUntil;
    const key = show ? JSON.stringify([e, info.match.rule.label, s.style, s.position, s.size, s.opacity]) : '';
    if (key === indicatorKey && (!show || (host && host.isConnected))) return;
    indicatorKey = key;
    if (indicator) {
      indicator.destroy();
      indicator = null;
    }
    if (!show) return;
    indicator = EI.render(ensureHost(), {
      env: e,
      label: info.match.rule.label,
      style: s.style,
      position: s.position,
      size: s.size,
      opacity: s.opacity,
      title: `${e.name}${info.match.rule.label ? ` · ${info.match.rule.label}` : ''}\nClick to hide${Number(s.hideSeconds) > 0 ? ` for ${s.hideSeconds} s` : ' until reload'}. Drag to another corner to move it.`,
      onHide: () => {
        const secs = Number(info.settings.hideSeconds) || 0;
        hiddenUntil = secs > 0 ? Date.now() + secs * 1000 : Infinity;
        clearTimeout(hideTimer);
        if (secs > 0) hideTimer = setTimeout(applyIndicator, secs * 1000 + 50);
        applyIndicator();
      },
      onMove: (position) => {
        info.settings.position = position;
        applyIndicator();
        ask({ type: 'env:setPosition', position });
      },
    });
  }

  // ---- tab title prefix ------------------------------------------------------------------

  function wantedPrefix() {
    const e = env();
    if (!visualOn() || !info.settings.showTitlePrefix || !e.titlePrefix) return '';
    const label = info.match.rule.label || e.name;
    return String(info.settings.titleFormat || '')
      .replace(/\{short\}/g, e.short).replace(/\{name\}/g, e.name).replace(/\{label\}/g, label);
  }

  function applyTitle() {
    if (!document.head && !document.querySelector('title')) return; // retried once the head exists
    const prefix = wantedPrefix();
    let title = document.title;
    if (appliedPrefix && appliedPrefix !== prefix && title.startsWith(appliedPrefix)) title = title.slice(appliedPrefix.length);
    if (prefix && !title.startsWith(prefix)) title = prefix + title;
    appliedPrefix = prefix;
    if (title !== document.title) document.title = title;
  }

  // ---- favicon tint ------------------------------------------------------------------------

  const iconLinks = () => Array.from(document.querySelectorAll('link[rel]')).filter((l) => !l.hasAttribute(OUR_ICON)
    && l.getAttribute('rel').toLowerCase().split(/\s+/).includes('icon'));

  function originalIconHref() {
    const stashed = document.querySelector(`link[${STASH_ATTR}]`);
    const first = stashed || iconLinks()[0];
    if (first && first.href) return first.href;
    return /^https?:$/.test(location.protocol) ? `${location.origin}/favicon.ico` : '';
  }

  function stashIcons() {
    for (const l of iconLinks()) {
      l.setAttribute(STASH_ATTR, l.getAttribute('rel'));
      l.setAttribute('rel', 'env-labeler-original-icon');
    }
  }

  function restoreFavicon() {
    favKey = '';
    if (favLink) {
      favLink.remove();
      favLink = null;
    }
    for (const l of document.querySelectorAll(`link[${STASH_ATTR}]`)) {
      l.setAttribute('rel', l.getAttribute(STASH_ATTR));
      l.removeAttribute(STASH_ATTR);
    }
  }

  async function applyFavicon() {
    const e = env();
    const want = visualOn() && info.settings.showFavicon && e.favicon;
    if (!want) {
      if (favLink || favKey) restoreFavicon();
      return;
    }
    if (!document.head) return;
    const src = originalIconHref();
    stashIcons();
    if (!favLink) {
      favLink = document.createElement('link');
      favLink.setAttribute('rel', 'icon');
      favLink.setAttribute(OUR_ICON, '');
    }
    if (favLink.parentNode !== document.head || document.head.lastElementChild !== favLink) document.head.appendChild(favLink);
    const key = `${e.color}|${e.textColor}|${e.short}|${src}`;
    if (key === favKey) return;
    favKey = key;
    const data = await EI.favicon(e, src);
    if (favKey === key && favLink) favLink.setAttribute('href', data);
  }

  // ---- "Are you sure?" before submitting -------------------------------------------------------

  function needsConfirm() {
    const e = env();
    if (!e || !e.confirmSubmit || !info.settings.confirmSubmit) return false;
    return Date.now() >= Math.max(localSnoozeUntil, info.snoozedUntil || 0);
  }

  function submitButtonFrom(event) {
    for (const node of event.composedPath()) {
      if (!(node instanceof Element)) continue;
      const tag = node.tagName;
      if (tag === 'BUTTON') {
        const type = (node.getAttribute('type') || 'submit').toLowerCase();
        return type === 'submit' && (node.form || node.hasAttribute('type')) && !node.disabled ? node : null;
      }
      if (tag === 'INPUT') {
        const type = (node.getAttribute('type') || '').toLowerCase();
        return (type === 'submit' || type === 'image') && !node.disabled ? node : null;
      }
      if (tag === 'A' || tag === 'FORM' || tag === 'BODY') return null;
    }
    return null;
  }

  function onClick(event) {
    if (bypass || !event.isTrusted || event.button !== 0 || !needsConfirm()) return;
    const btn = submitButtonFrom(event);
    if (!btn) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    confirmSubmit(btn.form).then((ok) => {
      if (!ok) return;
      bypass = true;
      try {
        btn.click();
      } finally {
        bypass = false;
      }
    });
  }

  function onSubmit(event) {
    if (bypass || !needsConfirm()) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = event.submitter;
    event.preventDefault();
    event.stopImmediatePropagation();
    confirmSubmit(form).then((ok) => {
      if (!ok) return;
      bypass = true;
      try {
        if (typeof form.requestSubmit === 'function') {
          try {
            form.requestSubmit(submitter && submitter.form === form ? submitter : undefined);
          } catch (_) {
            form.requestSubmit();
          }
        } else {
          form.submit();
        }
      } finally {
        bypass = false;
      }
    });
  }

  async function getBrand() {
    if (!brand) brand = (await ask({ type: 'wx:getBrand' })) || {};
    return brand;
  }

  function confirmSubmit(form) {
    if (dialogOpen) return Promise.resolve(false);
    dialogOpen = (async () => {
      const e = env();
      const b = await getBrand();
      const primary = /^#[0-9a-f]{6}$/i.test(b.primary || '') ? b.primary : '#4F46E5';
      const product = [b.productPrefix, 'Environment Labeler'].filter(Boolean).join(' ');
      const root = ensureHost();
      const box = document.createElement('div');
      const style = document.createElement('style');
      style.textContent = `
        .bk { position: fixed; inset: 0; background: rgba(15, 23, 42, .55); display: grid; place-items: center; z-index: 2147483647;
          font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #141826; padding: 16px; }
        .card { background: #fff; width: min(460px, 100%); border-radius: 14px; overflow: hidden; box-shadow: 0 24px 70px rgba(0,0,0,.35);
          animation: pop .14s ease-out; outline: none; }
        @keyframes pop { from { transform: scale(.96); opacity: 0; } }
        .head { background: var(--c); color: var(--t); padding: 12px 18px; font-weight: 750; letter-spacing: .05em; text-transform: uppercase;
          display: flex; align-items: center; gap: 10px; font-size: 13px; }
        .head svg { flex: none; }
        .body { padding: 16px 18px 6px; }
        h2 { font-size: 17px; margin: 0 0 6px; font-weight: 700; }
        p { margin: 0 0 12px; color: #3b4256; }
        b { color: #141826; }
        label { display: flex; gap: 8px; align-items: center; font-size: 13px; color: #3b4256; cursor: pointer; margin: 4px 0 4px; }
        input { width: 16px; height: 16px; accent-color: ${primary}; margin: 0; }
        .actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px 16px; }
        button { font: inherit; font-weight: 600; border-radius: 9px; padding: 8px 16px; cursor: pointer; border: 1px solid #d5d9e4; background: #fff; color: #141826; }
        button:hover { background: #f1f3f8; }
        button:focus-visible { outline: 3px solid ${primary}55; outline-offset: 1px; }
        button.go { background: ${primary}; border-color: ${primary}; color: ${EI.contrast(primary)}; }
        button.go:hover { filter: brightness(1.08); background: ${primary}; }
        .foot { font-size: 11.5px; color: #6b7280; padding: 0 18px 12px; }
      `;
      const bk = document.createElement('div');
      bk.className = 'bk';
      const card = document.createElement('div');
      card.className = 'card';
      card.tabIndex = -1;
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-label', `Submit on ${e.name}?`);
      card.style.setProperty('--c', e.color);
      card.style.setProperty('--t', e.textColor);

      const head = document.createElement('div');
      head.className = 'head';
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      for (const [k, v] of [['width', '18'], ['height', '18'], ['viewBox', '0 0 24 24'], ['fill', 'currentColor'], ['aria-hidden', 'true']]) svg.setAttribute(k, v);
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', 'M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z');
      svg.append(path);
      head.append(svg, document.createTextNode(e.name));

      const body = document.createElement('div');
      body.className = 'body';
      const h2 = document.createElement('h2');
      h2.textContent = 'Are you sure?';
      const p = document.createElement('p');
      p.append('You are about to submit a form on ', Object.assign(document.createElement('b'), { textContent: location.host || location.href }),
        `, which is labelled ${e.name}${info.match.rule.label && info.match.rule.label !== e.name ? ` (${info.match.rule.label})` : ''}.`);
      const lbl = document.createElement('label');
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      lbl.append(chk, "Don't ask again on this page for 10 minutes");
      body.append(h2, p, lbl);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      const go = document.createElement('button');
      go.className = 'go';
      go.textContent = `Yes, submit on ${e.short}`;
      actions.append(cancel, go);
      const foot = document.createElement('div');
      foot.className = 'foot';
      foot.textContent = product;
      card.append(head, body, actions, foot);
      bk.append(card);
      box.append(style, bk);
      root.append(box);

      const previousFocus = document.activeElement;
      return new Promise((resolve) => {
        const done = (ok) => {
          box.remove();
          dialogOpen = null;
          if (ok && chk.checked) {
            localSnoozeUntil = Date.now() + 10 * 60000;
            ask({ type: 'env:snooze', url: location.href, minutes: 10 });
          }
          if (!ok && previousFocus && previousFocus.focus) previousFocus.focus();
          resolve(ok);
        };
        cancel.addEventListener('click', () => done(false));
        go.addEventListener('click', () => done(true));
        bk.addEventListener('mousedown', (ev) => { if (ev.target === bk) done(false); });
        card.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Escape') done(false);
          if (ev.key === 'Tab') {
            const order = [chk, cancel, go];
            const i = order.indexOf(shadowActive());
            ev.preventDefault();
            order[(i + (ev.shiftKey ? order.length - 1 : 1)) % order.length].focus();
          }
        });
        ['keyup', 'keypress'].forEach((t) => card.addEventListener(t, (ev) => ev.stopPropagation()));
        cancel.focus();
      });
    })();
    return dialogOpen;

    function shadowActive() {
      return (shadow && shadow.activeElement) || null;
    }
  }

  // ---- watching the page ----------------------------------------------------------------------

  function watchHead() {
    if (headObserver || !document.head) return;
    headObserver = new MutationObserver(() => {
      if (!info) return;
      if (appliedPrefix && !document.title.startsWith(appliedPrefix)) applyTitle();
      if (favLink && (iconLinks().length || document.head.lastElementChild !== favLink || !favLink.isConnected)) applyFavicon();
    });
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'rel'] });
  }

  const docObserver = new MutationObserver(() => {
    if (document.head) {
      watchHead();
      if (info && (wantedPrefix() !== appliedPrefix || !document.title.startsWith(appliedPrefix))) applyTitle();
      if (info && !favLink && visualOn()) applyFavicon();
    }
    if (indicator && host && !host.isConnected) document.documentElement.appendChild(host);
  });
  docObserver.observe(document.documentElement || document, { childList: true });

  // SPA navigations: the isolated world can't see the page's history.pushState, so poll the URL (cheap) and listen to popstate.
  const checkUrl = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    hiddenUntil = 0;
    evaluate();
  };
  const poll = setInterval(checkUrl, 800);
  window.addEventListener('popstate', checkUrl, true);
  window.addEventListener('hashchange', checkUrl, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('submit', onSubmit, true);

  const onMessage = (msg) => {
    if (msg && msg.type === 'env:refresh') evaluate();
  };
  api.runtime.onMessage.addListener(onMessage);

  let storageTimer = 0;
  const onStorage = (changes, area) => {
    if (area === 'managed' || (area === 'local' && ('settings' in changes || 'remoteRules' in changes || 'sharedRules' in changes || 'brandOverride' in changes))) {
      if ('brandOverride' in changes) brand = null;
      clearTimeout(storageTimer);
      storageTimer = setTimeout(evaluate, 120);
    }
  };
  api.storage?.onChanged.addListener(onStorage);

  document.addEventListener('DOMContentLoaded', () => {
    watchHead();
    if (info) applyAll();
  });
  // Coming back from the back/forward cache: re-check (the rules may have changed meanwhile).
  window.addEventListener('pageshow', (e) => { if (e.persisted) evaluate(); });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearInterval(poll);
    clearTimeout(hideTimer);
    window.removeEventListener('popstate', checkUrl, true);
    window.removeEventListener('hashchange', checkUrl, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('submit', onSubmit, true);
    docObserver.disconnect();
    headObserver?.disconnect();
    try {
      api.runtime.onMessage.removeListener(onMessage);
      api.storage?.onChanged.removeListener(onStorage);
    } catch (_) { /* context gone */ }
    indicator?.destroy();
    host?.remove();
    if (appliedPrefix && document.title.startsWith(appliedPrefix)) document.title = document.title.slice(appliedPrefix.length);
    restoreFavicon();
  }

  globalThis.__envLabeler = { alive, destroy };
  evaluate();
})();

// Environment indicator renderer (ribbon / bar / frame) and favicon tinting.
// Classic script: loaded as a content script before content.js, and by the Settings page for live previews.
// Everything is drawn inside a Shadow DOM so page CSS cannot affect it.
(function () {
  'use strict';
  if (globalThis.EnvIndicator) return;

  const SCALE = { small: 0.8, medium: 1, large: 1.3 };
  const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
      font: 700 12px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: var(--t); }
    .wrap.contained { position: absolute; z-index: 2; }
    .wrap * { box-sizing: border-box; }
    .tag { pointer-events: auto; cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: none;
      background: var(--c); color: var(--t); opacity: var(--o); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      letter-spacing: .06em; text-transform: uppercase; box-shadow: 0 1px 5px rgba(0,0,0,.35); transition: opacity .15s; }
    .tag:hover { opacity: calc(var(--o) * .6); }
    .wrap.dragging .tag { cursor: grabbing; opacity: .85; }
    .sub { font-weight: 600; text-transform: none; letter-spacing: 0; opacity: .9; }

    .rbox { position: absolute; width: calc(130px * var(--s)); height: calc(130px * var(--s)); overflow: hidden; pointer-events: none; }
    .top-left .rbox { top: 0; left: 0; } .top-right .rbox { top: 0; right: 0; }
    .bottom-left .rbox { bottom: 0; left: 0; } .bottom-right .rbox { bottom: 0; right: 0; }
    .ribbon { position: absolute; width: calc(200px * var(--s)); text-align: center; font-size: calc(11.5px * var(--s));
      padding: calc(5px * var(--s)) calc(30px * var(--s)); }
    .top-left .ribbon { left: calc(44px * var(--s)); top: calc(44px * var(--s)); transform: translate(-50%, -50%) rotate(-45deg); }
    .top-right .ribbon { left: calc(86px * var(--s)); top: calc(44px * var(--s)); transform: translate(-50%, -50%) rotate(45deg); }
    .bottom-left .ribbon { left: calc(44px * var(--s)); top: calc(86px * var(--s)); transform: translate(-50%, -50%) rotate(45deg); }
    .bottom-right .ribbon { left: calc(86px * var(--s)); top: calc(86px * var(--s)); transform: translate(-50%, -50%) rotate(-45deg); }

    .bar { position: absolute; left: 0; right: 0; height: calc(24px * var(--s)); display: flex; align-items: center; justify-content: center;
      gap: 10px; padding: 0 36px; font-size: calc(12px * var(--s)); border-radius: 0; }
    .wrap.top-left .bar, .wrap.top-right .bar { top: 0; }
    .wrap.bottom-left .bar, .wrap.bottom-right .bar { bottom: 0; }
    .bar .x { position: absolute; right: 10px; font-weight: 400; opacity: .8; letter-spacing: 0; }

    .frame { position: absolute; inset: 0; border: calc(4px * var(--s)) solid var(--c); opacity: var(--o); pointer-events: none; }
    .ftag { position: absolute; padding: calc(3px * var(--s)) calc(10px * var(--s)); font-size: calc(11px * var(--s)); max-width: 60%; }
    .top-left .ftag { top: 0; left: 0; border-bottom-right-radius: 8px; }
    .top-right .ftag { top: 0; right: 0; border-bottom-left-radius: 8px; }
    .bottom-left .ftag { bottom: 0; left: 0; border-top-right-radius: 8px; }
    .bottom-right .ftag { bottom: 0; right: 0; border-top-left-radius: 8px; }

    .zone { position: absolute; display: none; width: 90px; height: 90px; border: 2px dashed var(--c); border-radius: 12px;
      background: rgba(255,255,255,.35); pointer-events: none; }
    .zone.edge { width: auto; height: 40px; left: 12px; right: 12px; }
    .wrap.dragging .zone { display: block; }
    .zone.hot { background: var(--c); opacity: .45; }
    .zone.top-left { top: 12px; left: 12px; } .zone.top-right { top: 12px; right: 12px; }
    .zone.bottom-left { bottom: 12px; left: 12px; } .zone.bottom-right { bottom: 12px; right: 12px; }
    .zone.edge.top { top: 12px; } .zone.edge.bottom { bottom: 12px; }
    @media print { .wrap { display: none; } }
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function contrast(hex) {
    let h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) return '#ffffff';
    const [r, g, b] = [0, 2, 4].map((i) => {
      const v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0b1020' : '#ffffff';
  }

  function displayName(env) {
    const n = String(env.name || env.short || '').trim();
    return n.length > 13 ? String(env.short || n.slice(0, 12)) : n;
  }

  /**
   * Renders the indicator into `root` (a ShadowRoot or element). Returns { el, destroy }.
   * opts: { env, label, style, position, size, opacity, contained, title, onHide(), onMove(position) }
   */
  function render(root, opts) {
    const env = opts.env;
    const style = ['ribbon', 'bar', 'frame'].includes(opts.style) ? opts.style : 'ribbon';
    const position = CORNERS.includes(opts.position) ? opts.position : 'top-right';
    const wrap = el('div', `wrap s-${style} ${position}${opts.contained ? ' contained' : ''}`);
    wrap.style.setProperty('--c', env.color);
    wrap.style.setProperty('--t', env.textColor || contrast(env.color));
    wrap.style.setProperty('--o', String(Math.min(100, Math.max(30, Number(opts.opacity) || 92)) / 100));
    wrap.style.setProperty('--s', String(SCALE[opts.size] || 1));
    const styleEl = el('style', null, CSS);

    const name = displayName(env);
    let tag;
    if (style === 'ribbon') {
      const box = el('div', 'rbox');
      tag = el('div', 'tag ribbon', name);
      box.append(tag);
      wrap.append(box);
    } else if (style === 'bar') {
      tag = el('div', 'tag bar');
      tag.append(el('span', null, env.name));
      if (opts.label && opts.label !== env.name) tag.append(el('span', 'sub', opts.label));
      tag.append(el('span', 'x', '×'));
      wrap.append(tag);
    } else {
      wrap.append(el('div', 'frame'));
      tag = el('div', 'tag ftag', name);
      wrap.append(tag);
    }
    tag.title = opts.title || `${env.name}${opts.label ? ` · ${opts.label}` : ''}\nClick to hide for a moment. Drag to move.`;
    tag.setAttribute('role', 'note');
    tag.setAttribute('aria-label', `Environment: ${env.name}`);

    const zones = style === 'bar'
      ? ['top', 'bottom'].map((p) => el('div', `zone edge ${p}`))
      : CORNERS.map((c) => el('div', `zone ${c}`));
    zones.forEach((z) => wrap.append(z));

    let start = null;
    let dragging = false;
    const target = (x, y) => {
      const r = wrap.getBoundingClientRect();
      const top = y - r.top < r.height / 2;
      if (style === 'bar') return `${top ? 'top' : 'bottom'}-${position.split('-')[1]}`;
      return `${top ? 'top' : 'bottom'}-${x - r.left < r.width / 2 ? 'left' : 'right'}`;
    };
    const hot = (pos) => zones.forEach((z) => {
      const isHot = style === 'bar' ? z.classList.contains(pos.split('-')[0]) : z.classList.contains(pos);
      z.classList.toggle('hot', isHot);
    });
    tag.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      dragging = false;
      try { tag.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      e.preventDefault();
      e.stopPropagation();
    });
    tag.addEventListener('pointermove', (e) => {
      if (!start) return;
      if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) {
        dragging = true;
        wrap.classList.add('dragging');
      }
      if (dragging) hot(target(e.clientX, e.clientY));
    });
    const end = (e, cancelled) => {
      if (!start) return;
      const wasDragging = dragging;
      start = null;
      dragging = false;
      wrap.classList.remove('dragging');
      if (cancelled) return;
      e.preventDefault();
      e.stopPropagation();
      if (wasDragging) {
        const pos = target(e.clientX, e.clientY);
        if (pos !== position && opts.onMove) opts.onMove(pos);
      } else if (opts.onHide) {
        opts.onHide();
      }
    };
    tag.addEventListener('pointerup', (e) => end(e, false));
    tag.addEventListener('pointercancel', (e) => end(e, true));
    tag.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });

    root.append(styleEl, wrap);
    return {
      el: wrap,
      destroy() {
        styleEl.remove();
        wrap.remove();
      },
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function loadImage(src, cors) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (cors) img.crossOrigin = 'anonymous';
      const t = setTimeout(() => reject(new Error('timeout')), 3000);
      img.onload = () => { clearTimeout(t); resolve(img); };
      img.onerror = () => { clearTimeout(t); reject(new Error('load failed')); };
      img.src = src;
    });
  }

  function letterIcon(env) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = env.color;
    roundRect(ctx, 0, 0, 64, 64, 14);
    ctx.fill();
    ctx.fillStyle = env.textColor || contrast(env.color);
    ctx.font = 'bold 40px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(env.short || env.name || '?').charAt(0).toUpperCase(), 32, 35);
    return c.toDataURL('image/png');
  }

  function tinted(env, img) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 6, 6, 52, 52);
    ctx.lineWidth = 6;
    ctx.strokeStyle = env.color;
    roundRect(ctx, 3, 3, 58, 58, 10);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(49, 49, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(49, 49, 11, 0, Math.PI * 2);
    ctx.fillStyle = env.color;
    ctx.fill();
    return c.toDataURL('image/png'); // throws when the image is cross-origin without CORS
  }

  /** Data URL of the site favicon with a coloured border and dot, or a coloured letter tile. */
  async function favicon(env, src) {
    if (src) {
      for (const cors of [true, false]) {
        try {
          return tinted(env, await loadImage(src, cors));
        } catch (_) { /* try the next way, then fall back */ }
      }
    }
    return letterIcon(env);
  }

  globalThis.EnvIndicator = { render, favicon, contrast, CORNERS };
})();

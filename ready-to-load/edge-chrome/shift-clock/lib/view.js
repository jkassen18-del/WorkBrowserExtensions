// UI pieces shared by the popup and the Settings app: the GitHub-style heatmap, its legend,
// the hover tooltip and a few small widgets.
import { h } from '/shared/ui.js';
import {
  KEYS, HOUR, MIN, dayKey, addDays, parseDay, weekdayOf, summarizeDay, dailyTargetMs, standbyOn, breakType,
  fmtDur, fmtSigned, fmtDay, fmtTime, STATUS, CALLOUT_KINDS,
} from './time.js';
import { api } from '/shared/api.js';

/** Everything the pages need from storage in one read. */
export async function loadData() {
  const r = await api.storage.local.get([KEYS.days, KEYS.standby, KEYS.activity, KEYS.since]);
  const days = r[KEYS.days] || {};
  // Tracking starts at install or the earliest day entered by hand, whichever is first.
  const since = [r[KEYS.since], ...Object.keys(days)].filter(Boolean).sort()[0] || null;
  return { days, standby: r[KEYS.standby] || {}, activity: r[KEYS.activity] || {}, since };
}

// ---- Tooltip --------------------------------------------------------------------------------

let tipEl = null;
function showTip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  if (!tipEl) document.body.append((tipEl = h('div.tk-tip', { role: 'tooltip' })));
  tipEl.textContent = text;
  tipEl.hidden = false;
  const r = target.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  const left = Math.min(Math.max(6, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 6);
  const top = r.top - t.height - 8 < 4 ? r.bottom + 8 : r.top - t.height - 8;
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}
const hideTip = () => { if (tipEl) tipEl.hidden = true; };
document.addEventListener('mouseover', (e) => { const t = e.target.closest?.('[data-tip]'); if (t) showTip(t); else hideTip(); });
document.addEventListener('focusin', (e) => { const t = e.target.closest?.('[data-tip]'); if (t) showTip(t); });
document.addEventListener('focusout', hideTip);
document.addEventListener('scroll', hideTip, true);

// ---- Heatmap --------------------------------------------------------------------------------

export const METRICS = {
  hours: 'Hours worked',
  balance: 'Over / under the day',
  activity: 'Laptop active time',
};

function level(ms, target) {
  if (ms <= 0) return 0;
  const r = ms / (target || 8 * HOUR);
  if (r < 0.5) return 1;
  if (r < 0.85) return 2;
  if (ms < (target || 8 * HOUR) - 5 * MIN) return 3;
  return 4;
}
function divLevel(diff) {
  if (diff <= -2 * HOUR) return 'd-2';
  if (diff < -15 * MIN) return 'd-1';
  if (diff <= 15 * MIN) return 'd0';
  if (diff < 2 * HOUR) return 'd1';
  return 'd2';
}

/** Tooltip + class for one day. */
export function dayCell(key, data, s, metric, now = Date.now()) {
  const today = dayKey(now);
  const day = data.days[key];
  const sb = standbyOn(key, s, data.standby);
  const cls = [];
  if (key > today) return { cls: ['future'], tip: `${fmtDay(key, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}${sb ? ' · standby' : ''}`, standby: !!sb };
  const sum = summarizeDay(key, day, s, now);
  const off = sum.status !== 'work';
  const lines = [fmtDay(key, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })];
  if (off) lines.push(STATUS[sum.status]);
  if (sb) lines.push('📟 Standby');
  const act = data.activity[key]?.min || 0;

  if (metric === 'activity') {
    cls.push(`l${level(act * MIN, dailyTargetMs(s))}`);
    lines.push(act ? `${fmtDur(act * MIN)} laptop active` : 'No laptop activity');
  } else if (metric === 'balance') {
    if (sum.hasData || sum.targetMs) cls.push(divLevel(sum.countedMs - sum.targetMs));
    else cls.push('l0');
    if (sum.hasData || sum.targetMs) lines.push(`${fmtDur(sum.countedMs)} of ${fmtDur(sum.targetMs)} · ${fmtSigned(sum.countedMs - sum.targetMs)}`);
  } else {
    cls.push(`l${level(sum.countedMs, dailyTargetMs(s))}`);
    if (sum.hasData) lines.push(`${fmtDur(sum.countedMs)} counted`);
  }
  if (metric !== 'activity' && sum.firstIn) lines.push(`${fmtTime(sum.firstIn)} – ${sum.lastOut && sum.state === 'out' ? fmtTime(sum.lastOut) : sum.incomplete ? 'no clock-out' : 'now'}`);
  if (sum.calloutMs) lines.push(`${Object.entries(sum.calloutCount).map(([k, n]) => `${n} ${CALLOUT_KINDS[k]?.label.toLowerCase() || k}${n === 1 ? '' : 's'}`).join(', ')} · ${fmtDur(sum.calloutMs)}`);
  const breaks = Object.entries(sum.breakMs).filter(([, v]) => v > 0);
  if (metric !== 'activity' && breaks.length) lines.push(breaks.map(([k, v]) => `${breakType(s, k).icon} ${fmtDur(v)}`).join('  '));
  if (sum.incomplete) lines.push('⚠ Missing clock-out');
  if (off) cls.push('off');
  if (sb) cls.push('sb');
  if (key === today) cls.push('today');
  return { cls, tip: lines.join('\n'), standby: !!sb };
}

/**
 * GitHub-style calendar: one column per week, Monday at the top.
 * o: { data, settings, metric, weeks, endKey, small, onCell(key) }
 */
export function heatmap(o) {
  const end = o.endKey || dayKey();
  const back = (weekdayOf(end) + 6) % 7; // days since Monday
  const firstMonday = addDays(end, -back - (o.weeks - 1) * 7);
  const lastSunday = addDays(end, 6 - back);
  const grid = h('div.hm', { class: o.small ? 'small' : '', role: 'grid', 'aria-label': `${METRICS[o.metric]} calendar` });
  grid.style.gridTemplateColumns = `auto repeat(${o.weeks}, var(--hm-size))`;
  ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].forEach((d, i) => grid.append(h('div.hm-wd', { style: { gridRow: String(i + 2), gridColumn: '1' } }, d)));
  let lastMonth = -1;
  for (let w = 0; w < o.weeks; w++) {
    const monday = addDays(firstMonday, w * 7);
    const m = parseDay(monday).getMonth();
    const firstOfMonthInWeek = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).find((k) => k.endsWith('-01'));
    if (m !== lastMonth && (w === 0 || firstOfMonthInWeek)) {
      const label = new Intl.DateTimeFormat(undefined, { month: 'short' }).format(parseDay(firstOfMonthInWeek || monday));
      if (w < o.weeks - 1 || o.weeks < 3) grid.append(h('div.hm-mo', { style: { gridRow: '1', gridColumn: String(w + 2) } }, label));
      lastMonth = parseDay(firstOfMonthInWeek || monday).getMonth();
    }
    for (let d = 0; d < 7; d++) {
      const key = addDays(monday, d);
      if (key > lastSunday) break;
      const c = dayCell(key, o.data, o.settings, o.metric);
      const el = h(o.onCell ? 'button.c' : 'div.c', {
        class: c.cls.join(' '),
        style: { gridRow: String(d + 2), gridColumn: String(w + 2) },
        dataset: { tip: c.tip, key },
        'aria-label': c.tip.replace(/\n/g, ', '),
        tabindex: o.onCell ? null : '-1',
        onclick: o.onCell && !c.cls.includes('future') ? () => o.onCell(key) : null,
      });
      grid.append(el);
    }
  }
  return h('div.hm-wrap', grid, legend(o.metric, o.small));
}

export function legend(metric, small) {
  const sw = (cls) => h('span.c', { class: cls });
  return h('div.hm-legend', { class: small ? 'small' : '' },
    metric === 'balance'
      ? h('span.row', h('span', 'Under'), ['d-2', 'd-1', 'd0', 'd1', 'd2'].map(sw), h('span', 'Over'))
      : h('span.row', h('span', 'Less'), ['l0', 'l1', 'l2', 'l3', 'l4'].map(sw), h('span', 'More')),
    h('span.row', sw('l0 sb'), h('span', 'Standby')),
    small ? null : h('span.row', sw('l0 off'), h('span', 'Leave / day off')));
}

// ---- Small widgets --------------------------------------------------------------------------

/** Horizontal progress bar; value may exceed max (overflow shown in a second colour). */
export function progress(value, max, { label } = {}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return h('div.tk-progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(max / MIN)), 'aria-valuenow': String(Math.round(value / MIN)), 'aria-label': label || '' },
    h('div.fill', { class: max > 0 && value >= max ? 'full' : '', style: { width: `${pct}%` } }));
}

/** "+2h 10m ahead" style badge. */
export function balanceBadge(ms) {
  const m = Math.round(ms / MIN);
  if (Math.abs(m) <= 15) return h('span.badge', 'On track');
  return h('span.badge', { class: m > 0 ? 'over' : 'under' }, `${fmtSigned(ms)} ${m > 0 ? 'ahead' : 'behind'}`);
}

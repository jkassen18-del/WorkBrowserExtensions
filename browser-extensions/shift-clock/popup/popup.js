import { api, send } from '/shared/api.js';
import { mountPopup } from '/shared/app-shell.js';
import { h, add, clear, toast } from '/shared/ui.js';
import { settings } from '../settings.js';
import {
  KEYS, MIN, dayKey, activeDayKey, summarizeDay, summarizeMonth, standbyStatus, incompleteDays, breakType, atTime,
  fmtDur, fmtTime, fmtDay, fmtIn, fmtMonth, hhmm, CALLOUT_KINDS, STATUS, LIVE_WINDOW_MS,
} from '../lib/time.js';
import { loadData, heatmap, progress, balanceBadge } from '../lib/view.js';

const { body } = await mountPopup('Shift Clock', { optionsHash: 'overview' });
const content = h('div');
body.append(content);
add(content, h('div.muted.small', 'Loading…'));

const openPage = (hash) => {
  api.tabs.create({ url: api.runtime.getURL(`options/options.html#${hash}`) });
  window.close();
};

async function act(msg) {
  const r = await send({ type: 'tk:act', ...msg });
  if (!r || r.error) toast(r?.error || 'Shift Clock is not responding. Try again.', { error: true });
  return r && !r.error;
}

let live = []; // [el, () => text] updated every second

function clockText(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  return [`${hh}:${mm}`, `:${ss}`];
}

function openCallout(days, now) {
  for (const key of [dayKey(now), dayKey(now - 86400000)]) {
    const c = (days[key]?.callouts || []).find((x) => x.end == null && now - x.start < LIVE_WINDOW_MS);
    if (c) return c;
  }
  return null;
}

async function render() {
  const s = await settings.get();
  const data = await loadData();
  const now = Date.now();
  const key = activeDayKey(data.days, s, now);
  const sum = summarizeDay(key, data.days[key], s, now);
  const day = data.days[key];
  const today = dayKey(now);
  const month = summarizeMonth(data.days, new Date(now).getFullYear(), new Date(now).getMonth(), s, now, { since: data.since });
  const sb = standbyStatus(s, data.standby, today);
  const callout = openCallout(data.days, now);
  const missing = incompleteDays(data.days, s, now).filter((k) => k !== key);
  live = [];

  // ---- Now card
  const stateLabel = sum.state === 'in' ? 'Working'
    : sum.state === 'break' ? `On ${breakType(s, sum.currentBreak.kind).label.toLowerCase()} ${breakType(s, sum.currentBreak.kind).icon}`
      : sum.hasData && sum.lastOut ? 'Clocked out' : day?.status && day.status !== 'work' ? STATUS[day.status] : 'Not clocked in';
  const timer = h('div.timer.num');
  const paintTimer = () => {
    const n = Date.now();
    const s2 = summarizeDay(key, data.days[key], s, n);
    const ms = sum.state === 'break' ? n - sum.currentBreak.start : s2.workedMs;
    const [a, b] = clockText(ms);
    clear(timer, a, h('span.secs', b));
  };
  paintTimer();
  live.push(paintTimer);

  let sub = null;
  if (sum.state !== 'out' && sum.leaveAt) {
    const homeLine = h('span');
    const paintHome = () => {
      const s2 = summarizeDay(key, data.days[key], s, Date.now());
      const rem = s2.leaveAt - Date.now();
      clear(homeLine, 'Home time ', h('span.home', fmtTime(s2.leaveAt)),
        rem > 0 ? ` · in ${fmtDur(rem)}` : ` · ${fmtDur(-rem)} extra`);
    };
    paintHome();
    live.push(paintHome);
    sub = h('div.sub', `In ${fmtTime(sum.firstIn)} · `, homeLine,
      sum.state === 'break' ? h('div', `${fmtDur(sum.workedMs)} worked so far`) : null);
  } else if (sum.state !== 'out') {
    sub = h('div.sub', `In since ${fmtTime(sum.firstIn)}. No shift target today${sb.current ? ' (standby)' : ''}.`);
  } else if (sum.hasData && sum.firstIn) {
    sub = h('div.sub', `${fmtTime(sum.firstIn)} – ${fmtTime(sum.lastOut)} · ${fmtDur(sum.workedMs)} worked`,
      sum.targetMs ? ` · ${fmtDur(Math.abs(sum.workedMs - sum.targetMs))} ${sum.workedMs >= sum.targetMs ? 'over' : 'under'}` : '');
  } else {
    sub = h('div.sub', sum.targetMs ? `Today's target: ${fmtDur(sum.targetMs)} (${s.shiftHours}h shift).` : 'No shift today. Weekends only count standby work.');
  }

  const nowCard = h('div.tk-now',
    h('div.state', h('span.dot', { class: sum.state }), stateLabel, key !== today ? h('span.badge', `since ${fmtDay(key)}`) : null),
    sum.state === 'out' && !sum.hasData ? null : timer,
    sub,
    sum.targetMs ? progress(sum.workedMs, sum.targetMs, { label: 'Today' }) : null);

  // ---- Actions
  const at = h('input', { type: 'time', value: hhmm(now), 'aria-label': 'Time' });
  // A time later than now means yesterday (e.g. clocking out after midnight at 23:50).
  const atMs = () => {
    const t = atTime(today, at.value);
    return t > Date.now() ? t - 86400000 : t;
  };
  const doAt = (msg) => async () => { if (await act({ ...msg, at: atMs() })) render(); };
  const doNow = (msg) => async () => { if (await act(msg)) render(); };

  let actions;
  if (sum.state === 'out') {
    actions = h('div.tk-actions',
      h('button.btn.primary.big', { onclick: doNow({ action: 'in' }) }, '▶  ', sum.hasData ? 'Clock back in' : 'Clock in'));
  } else if (sum.state === 'in') {
    actions = h('div.tk-actions',
      h('div.breaks', (s.breakTypes || []).map((b) => h('button.btn', { onclick: doNow({ action: 'break', kind: b.id }), title: b.paid ? 'Paid break' : 'Unpaid break' }, `${b.icon} ${b.label}`))),
      h('button.btn.big', { onclick: doNow({ action: 'out' }) }, '■  Clock out'));
  } else {
    const bt = breakType(s, sum.currentBreak.kind);
    actions = h('div.tk-actions',
      h('div.small.muted', `${bt.icon} ${bt.label} since ${fmtTime(sum.currentBreak.start)}`),
      h('button.btn.primary.big', { onclick: doNow({ action: 'resume' }) }, '▶  End break'),
      h('button.btn', { onclick: doNow({ action: 'out' }) }, '■  Clock out'));
  }
  const nextAction = sum.state === 'out' ? { action: 'in', label: 'Clock in' }
    : sum.state === 'break' ? { action: 'resume', label: 'End break' } : { action: 'out', label: 'Clock out' };
  const more = h('details.tk-more',
    h('summary', 'Forgot to press it? Record an earlier time'),
    h('div.row', at, h('button.btn.sm', { onclick: doAt({ action: nextAction.action }) }, `${nextAction.label} at this time`),
      sum.state === 'in' ? h('select', {
        'aria-label': 'Break started at this time',
        onchange: (e) => { if (e.target.value) doAt({ action: 'break', kind: e.target.value })(); },
      }, h('option', { value: '' }, 'Break started at…'), (s.breakTypes || []).map((b) => h('option', { value: b.id }, `${b.icon} ${b.label}`))) : null),
    h('div.row', h('button.btn.ghost.sm', { disabled: !sum.hasData, onclick: doNow({ action: 'undo' }) }, '↶ Undo last entry'),
      h('button.btn.ghost.sm', { onclick: () => openPage(`timesheet?day=${key}`) }, 'Edit today')));

  // ---- Today's breaks
  const chips = sum.breaks.length ? h('div.chips', sum.breaks.map((b) => {
    const bt = breakType(s, b.kind);
    return h('span.chip', { title: bt.paid ? 'Paid' : 'Unpaid' }, `${bt.icon} ${fmtTime(b.start)}${b.open ? '' : `–${fmtTime(b.end)}`} · ${fmtDur(b.ms)}`);
  })) : null;

  // ---- Month
  const monthBox = h('div.tk-box',
    h('div.row.between', h('div.section-label', fmtMonth(month.year, month.month0)), balanceBadge(month.balanceMs)),
    h('div.row.between', { style: { marginBottom: '6px' } },
      h('span', h('span.big.num', fmtDur(month.countedMs)), h('span.muted', ` of ${fmtDur(month.targetMs)}`)),
      h('span.small.muted', month.countedMs >= month.targetMs ? `Target met · +${fmtDur(month.countedMs - month.targetMs)}` : `${fmtDur(month.remainingMs)} to go`)),
    progress(month.countedMs, month.targetMs, { label: 'Month' }),
    h('div.small.muted', { style: { marginTop: '6px' } },
      month.daysLeft
        ? `${month.daysLeft} work day${month.daysLeft === 1 ? '' : 's'} left · ${month.remainingMs ? `${fmtDur(month.needPerDayMs)}/day needed` : 'target already met'} · normal shifts end the month ${fmtDur(Math.abs(month.projectedBalanceMs))} ${month.projectedBalanceMs >= 0 ? 'over' : 'under'}`
        : `Month ${month.countedMs >= month.targetMs ? 'over' : 'under'} by ${fmtDur(Math.abs(month.countedMs - month.targetMs))}`));

  // ---- Standby
  let standbyBox = null;
  if (s.standbyEnabled) {
    if (callout) {
      const t = h('span.big.num');
      const paint = () => { t.textContent = fmtDur(Date.now() - callout.start, { zero: '0m' }); };
      paint();
      live.push(paint);
      const ref = h('input', { type: 'text', value: callout.ref || '', placeholder: 'Ticket # / caller (optional)' });
      standbyBox = h('div.tk-box',
        h('div.row.between', h('div.state.row', h('span.dot.call'), h('b', `${CALLOUT_KINDS[callout.kind].icon} ${CALLOUT_KINDS[callout.kind].label} running`)), t),
        h('div.row', { style: { marginTop: '8px', flexWrap: 'nowrap' } }, ref,
          h('button.btn.primary', { onclick: async () => { if (await act({ action: 'callout-stop', ref: ref.value })) render(); } }, 'Stop')));
    } else {
      const kinds = Object.entries(CALLOUT_KINDS).map(([k, v]) => h('button.btn.sm', { onclick: doNow({ action: 'callout-start', kind: k }) }, `${v.icon} ${v.label}`));
      if (sb.current) {
        standbyBox = h('div.tk-box',
          h('div.row.between', h('b', '📟 On standby'), h('span.small.muted', `until ${fmtDay(sb.current.end)}`)),
          h('div.small.muted', { style: { margin: '4px 0 8px' } }, 'Log each call-out or ticket you work on:'),
          h('div.row', kinds));
      } else if (sb.next) {
        standbyBox = h('div.tk-box', h('div.row.between',
          h('span', '📟 Next standby ', h('b', fmtDay(sb.next.start))),
          h('span.badge.primary', fmtIn(sb.daysUntilNext))),
        h('div.small.muted', `${fmtDay(sb.next.start)} – ${fmtDay(sb.next.end)}`));
      } else {
        standbyBox = h('div.tk-box.small.muted', '📟 No standby rota yet. ',
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); openPage('standby'); } }, 'Set it up'));
      }
    }
  }

  clear(content,
    missing.length ? h('div.notice.warn.small', `⚠ No clock-out on ${missing.map((k) => fmtDay(k)).join(', ')}. `,
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); openPage(`timesheet?day=${missing[0]}`); } }, 'Fix it')) : null,
    nowCard, actions, chips, more, monthBox, standbyBox,
    h('div.tk-box', h('div.section-label', 'Last 18 weeks'),
      heatmap({ data, settings: s, metric: 'hours', weeks: 18, small: true, onCell: (k) => openPage(`timesheet?day=${k}`) })),
    h('button.btn.primary.block', { onclick: () => openPage('overview') }, 'Open timesheet & history'));
}

await render();
setInterval(() => live.forEach((fn) => fn()), 1000);
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (KEYS.days in changes || 'settings' in changes || KEYS.standby in changes)) {
    if (!document.activeElement || !['INPUT', 'SELECT'].includes(document.activeElement.tagName)) render();
  }
});

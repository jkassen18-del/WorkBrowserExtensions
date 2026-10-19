import { api, send, uid } from '/shared/api.js';
import { mountApp } from '/shared/app-shell.js';
import { h, add, clear, toast, modal, confirmDialog, download, toggle, lockedBadge } from '/shared/ui.js';
import { settings } from '../settings.js';
import { DEFAULT_BREAK_TYPES } from '../defaults.js';
import {
  KEYS, MIN, HOUR, dayKey, addDays, parseDay, weekdayOf, atTime, hhmm, isDayKey, daysBetween,
  summarizeDay, summarizeMonth, standbyStatus, standbyPeriods, standbyOn, incompleteDays, dailyTargetMs, breakType,
  checkEvents, monthCSV, fmtDur, fmtSigned, fmtTime, fmtDay, fmtMonth, fmtIn, STATUS, CALLOUT_KINDS,
} from '../lib/time.js';
import { loadData, heatmap, METRICS, progress, balanceBadge } from '../lib/view.js';

const BASE = 'Shift Clock';
const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

// "#timesheet?day=2026-10-17" (from the popup) opens that day in the editor.
const deepLink = new URLSearchParams(location.hash.split('?')[1] || '');
let pendingDay = deepLink.get('day');

const statusBadge = (st) => (st && st !== 'work' ? h('span.badge', STATUS[st]) : null);
const sbBadge = () => h('span.badge.primary', { title: 'Standby' }, '📟 Standby');

// ---- Day editor ----------------------------------------------------------------------------

/** Converts the editor's HH:MM to ms. Entries earlier than the first clock-in belong to the next day. */
function toMs(key, value, firstInMs) {
  let t = atTime(key, value);
  if (firstInMs != null && t < firstInMs) t += 24 * HOUR;
  return t;
}

async function openDayEditor(key, ctx, onSaved) {
  const s = ctx.values;
  const { days, standby } = await loadData();
  const src = days[key] || {};
  // Rows hold HH:MM strings while editing.
  const rows = (src.events || []).slice().sort((a, b) => a.at - b.at).map((e) => ({ ...e, time: hhmm(e.at) }));
  const callouts = (src.callouts || []).map((c) => ({ ...c, from: hhmm(c.start), to: c.end != null ? hhmm(c.end) : '' }));
  let status = src.status || 'work';
  let note = src.note || '';

  const build = () => {
    const firstIn = rows.filter((r) => r.type === 'in' && r.time).map((r) => atTime(key, r.time)).sort((a, b) => a - b)[0] ?? null;
    const events = rows.filter((r) => r.time).map((r) => {
      const e = { id: r.id || uid('e'), type: r.type, at: toMs(key, r.time, r.type === 'in' ? null : firstIn) };
      if (r.type === 'break') e.kind = r.kind || 'break';
      return e;
    });
    const cos = callouts.filter((c) => c.from).map((c) => {
      const start = atTime(key, c.from);
      let end = c.to ? atTime(key, c.to) : null;
      if (end != null && end < start) end += 24 * HOUR;
      return { id: c.id || uid('c'), kind: c.kind || 'call', start, end, ref: c.ref || '', note: c.note || '' };
    });
    const day = { events, callouts: cos };
    if (status !== 'work') day.status = status;
    if (note.trim()) day.note = note.trim();
    return day;
  };

  return modal(`${fmtDay(key, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`, (close) => {
    const wrap = h('div');
    const preview = h('div.notice.small');
    const paintPreview = () => {
      const day = build();
      const sum = summarizeDay(key, day, s, Date.now());
      const problems = checkEvents(day.events);
      clear(preview,
        problems.length ? h('div', { style: { color: 'var(--wx-danger)' } }, `⚠ ${problems[0]}`) : null,
        h('div', `Worked ${fmtDur(sum.workedMs)}`, Object.entries(sum.breakMs).filter(([, v]) => v).map(([k, v]) => ` · ${breakType(s, k).icon} ${fmtDur(v)}`),
          sum.calloutMs ? ` · call-outs ${fmtDur(sum.calloutMs)}` : '', ` · counted ${fmtDur(sum.countedMs)}`,
          sum.targetMs ? ` (${fmtSigned(sum.countedMs - sum.targetMs)} vs ${fmtDur(sum.targetMs)})` : ' · no target this day'));
      preview.className = `notice small${problems.length ? ' danger' : ''}`;
    };

    const typeOptions = [['in', 'Clock in'], ['break', 'Break start'], ['resume', 'Break end'], ['out', 'Clock out']];
    const evList = h('div.ev-list');
    const paintEvents = () => {
      clear(evList, rows.length ? rows.map((r, i) => {
        const type = h('select', { 'aria-label': 'Entry' },
          typeOptions.map(([v, l]) => h('option', { value: v, selected: r.type === v }, l)));
        const kind = h('select', { 'aria-label': 'Break type', style: { display: r.type === 'break' ? '' : 'none' } },
          (s.breakTypes || []).map((b) => h('option', { value: b.id, selected: r.kind === b.id }, `${b.icon} ${b.label}`)));
        type.addEventListener('change', () => { r.type = type.value; if (r.type === 'break' && !r.kind) r.kind = s.breakTypes?.[0]?.id || 'break'; paintEvents(); paintPreview(); });
        kind.addEventListener('change', () => { r.kind = kind.value; paintPreview(); });
        const time = h('input', { type: 'time', value: r.time, 'aria-label': 'Time' });
        time.addEventListener('change', () => { r.time = time.value; paintPreview(); });
        return h('div.ev-row', h('div.row', { style: { flexWrap: 'nowrap' } }, type, kind), time,
          h('button.icon-btn', { title: 'Remove', 'aria-label': 'Remove entry', onclick: () => { rows.splice(i, 1); paintEvents(); paintPreview(); } }, '✕'));
      }) : h('p.small.muted', 'No clock entries for this day.'));
    };
    const lastTime = () => rows.map((r) => r.time).filter(Boolean).sort().pop();
    const addRow = (type, kind) => { rows.push({ type, kind, time: lastTime() || s.usualStart || '08:00' }); paintEvents(); paintPreview(); };
    const fillShift = () => {
      const start = s.usualStart || '08:00';
      const startMs = atTime(key, start);
      rows.splice(0, rows.length,
        { type: 'in', time: start },
        { type: 'out', time: hhmm(startMs + (Number(s.shiftHours) || 9) * HOUR) });
      if (Number(s.breakAllowanceMinutes) > 0) {
        const lunch = startMs + 4 * HOUR;
        rows.splice(1, 0, { type: 'break', kind: (s.breakTypes || []).find((b) => b.id === 'lunch') ? 'lunch' : s.breakTypes?.[0]?.id, time: hhmm(lunch) },
          { type: 'resume', time: hhmm(lunch + Number(s.breakAllowanceMinutes) * MIN) });
      }
      paintEvents();
      paintPreview();
    };

    const coList = h('div.ev-list');
    const paintCallouts = () => {
      clear(coList, callouts.length ? callouts.map((c, i) => {
        const kind = h('select', { 'aria-label': 'Kind' }, Object.entries(CALLOUT_KINDS).map(([k, v]) => h('option', { value: k, selected: c.kind === k }, `${v.icon} ${v.label}`)));
        kind.addEventListener('change', () => { c.kind = kind.value; paintPreview(); });
        const from = h('input', { type: 'time', value: c.from, 'aria-label': 'Start' });
        from.addEventListener('change', () => { c.from = from.value; paintPreview(); });
        const to = h('input', { type: 'time', value: c.to, 'aria-label': 'End' });
        to.addEventListener('change', () => { c.to = to.value; paintPreview(); });
        const ref = h('input', { type: 'text', value: c.ref || '', placeholder: 'Ticket # / note', 'aria-label': 'Reference' });
        ref.addEventListener('input', () => { c.ref = ref.value; });
        return h('div.ev-row.co', kind, from, to, ref,
          h('button.icon-btn', { title: 'Remove', 'aria-label': 'Remove call-out', onclick: () => { callouts.splice(i, 1); paintCallouts(); paintPreview(); } }, '✕'));
      }) : h('p.small.muted', 'No standby call-outs or tickets logged.'));
    };

    const statusSel = h('select', Object.entries(STATUS).map(([k, v]) => h('option', { value: k, selected: status === k }, v)));
    statusSel.addEventListener('change', () => { status = statusSel.value; paintPreview(); });
    const noteEl = h('textarea', { rows: 2, placeholder: 'Optional note' }, note);
    noteEl.addEventListener('input', () => { note = noteEl.value; });

    paintEvents();
    paintCallouts();
    paintPreview();
    const isSb = !!standbyOn(key, s, standby);
    add(wrap,
      h('div.row', { style: { marginBottom: '10px' } }, statusBadge(status), isSb ? sbBadge() : null,
        !isWorkdayKey(key, s) ? h('span.badge', 'Weekend / no shift') : null),
      h('div.field', h('label', 'Day type'), statusSel),
      h('label', 'Clock entries'),
      evList,
      h('div.row', { style: { marginBottom: '14px' } },
        h('button.btn.sm', { onclick: () => addRow('in') }, '+ Clock in'),
        h('button.btn.sm', { onclick: () => addRow('break', s.breakTypes?.[0]?.id) }, '+ Break'),
        h('button.btn.sm', { onclick: () => addRow('resume') }, '+ Break end'),
        h('button.btn.sm', { onclick: () => addRow('out') }, '+ Clock out'),
        h('button.btn.ghost.sm', { onclick: fillShift, title: `Fill in a normal ${s.shiftHours}h shift from ${s.usualStart}` }, '⟲ Normal shift')),
      h('div.small.muted', { style: { marginTop: '-8px', marginBottom: '12px' } }, 'Times earlier than the first clock-in are treated as after midnight.'),
      s.standbyEnabled ? [h('label', 'Standby call-outs & tickets'), coList,
        h('div.row', { style: { marginBottom: '14px' } }, Object.entries(CALLOUT_KINDS).map(([k, v]) => h('button.btn.sm', {
          onclick: () => { callouts.push({ kind: k, from: lastTime() || '20:00', to: '', ref: '' }); paintCallouts(); paintPreview(); },
        }, `+ ${v.icon} ${v.label}`)))] : null,
      h('div.field', h('label', 'Note'), noteEl),
      preview,
      h('div.row.between', { style: { marginTop: '14px' } },
        h('button.btn.danger', {
          onclick: async () => {
            if (!(await confirmDialog('Clear this day?', `Remove every entry for ${fmtDay(key)}?`, { okLabel: 'Clear', danger: true }))) return;
            const r = await send({ type: 'tk:saveDay', key, day: null });
            if (r?.error) return toast(r.error, { error: true });
            toast('Day cleared');
            close(true);
          },
        }, 'Clear day'),
        h('div.row',
          h('button.btn', { onclick: () => close(false) }, 'Cancel'),
          h('button.btn.primary', {
            onclick: async () => {
              const day = build();
              const problems = checkEvents(day.events);
              if (problems.length) return toast(problems[0], { error: true });
              const r = await send({ type: 'tk:saveDay', key, day });
              if (!r || r.error) return toast(r?.error || 'Could not save.', { error: true });
              toast('Saved');
              close(true);
            },
          }, 'Save'))));
    return wrap;
  }).then((saved) => { if (saved) onSaved?.(); });
}

const isWorkdayKey = (key, s) => (s.workDays || []).map(Number).includes(weekdayOf(key));

// ---- Overview ------------------------------------------------------------------------------

async function renderOverview(el, ctx) {
  const s = ctx.values;
  const data = await loadData();
  const now = Date.now();
  const today = dayKey(now);
  const d = new Date(now);
  const month = summarizeMonth(data.days, d.getFullYear(), d.getMonth(), s, now, { since: data.since });
  const sb = standbyStatus(s, data.standby, today);
  const missing = incompleteDays(data.days, s, now);
  let metric = store.get('tk-metric', 'hours');
  if (!METRICS[metric]) metric = 'hours';

  const stat = (label, value, note, extra) => h('div.card.stat', h('div.stat-label', label), h('div.stat-value.num', value), note ? h('div.stat-note', note) : null, extra || null);

  const hmHost = h('div');
  const paintHeatmap = () => {
    const tabs = h('div.tabs', { role: 'tablist' }, Object.entries(METRICS).map(([k, label]) => h('button', {
      role: 'tab', 'aria-selected': String(k === metric),
      onclick: () => { metric = k; store.set('tk-metric', k); paintHeatmap(); },
    }, label)));
    clear(hmHost, tabs,
      metric === 'activity' && !s.trackActivity ? h('div.notice.small', 'Laptop activity tracking is off. Turn it on under Reminders & tracking.') : null,
      heatmap({ data, settings: s, metric, weeks: 53, onCell: (k) => openDayEditor(k, ctx, () => ctx.rerender()) }),
      h('p.small.muted', { style: { margin: '8px 0 0' } },
        metric === 'balance' ? `Each day compared with its target (${fmtDur(dailyTargetMs(s))} on work days, 0 on weekends and days off).`
          : metric === 'activity' ? 'Minutes the laptop was in use (keyboard/mouse), measured by the browser. Nothing about what you did is stored.'
            : `Darkest = a full ${fmtDur(dailyTargetMs(s))} day. Click any day to edit it.`));
  };
  paintHeatmap();

  // Breaks this month by type
  const breakRows = (s.breakTypes || []).map((b) => [b, month.breakMs[b.id] || 0]);
  const maxBreak = Math.max(1, ...breakRows.map(([, v]) => v));
  const breakCounts = {};
  for (const ds of month.days) for (const b of ds.breaks) breakCounts[b.kind] = (breakCounts[b.kind] || 0) + 1;

  // Last 12 months
  const months = Array.from({ length: 12 }, (_, i) => new Date(d.getFullYear(), d.getMonth() - i, 1))
    .map((m) => summarizeMonth(data.days, m.getFullYear(), m.getMonth(), s, now, { since: data.since }))
    .filter((m, i) => i === 0 || m.countedMs > 0 || m.untracked < m.workdays);

  // Laptop activity today
  const act = data.activity[today];
  const maxH = Math.max(1, ...(act?.hours || [0]));

  add(el,
    h('div.row.between', { style: { marginBottom: '12px' } },
      h('div', h('h1', { style: { margin: 0 } }, 'Overview'), h('p.muted', { style: { margin: 0 } },
        `${fmtMonth(month.year, month.month0)} · ${s.shiftHours}h shifts · ${fmtDur(dailyTargetMs(s))} paid per day · ${fmtDur(month.targetMs)} target`)),
      h('button.btn', { onclick: () => ctx.navigate('timesheet') }, 'Open timesheet')),
    month.untracked ? h('div.notice.small', `Tracking started ${fmtDay(data.since)}. The ${month.untracked} work day${month.untracked === 1 ? '' : 's'} before that ${month.untracked === 1 ? 'is' : 'are'} left out of this month's target. Add them in the timesheet if you want them counted.`) : null,
    missing.length ? h('div.notice.warn', `⚠ You didn't clock out on ${missing.map((k) => fmtDay(k)).join(', ')}. Those days are counted up to the end of a normal shift until you fix them. `,
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); openDayEditor(missing[0], ctx, () => ctx.rerender()); } }, 'Fix now')) : null,
    h('div.stats',
      stat('This month', fmtDur(month.countedMs), `of ${fmtDur(month.targetMs)} target`, h('div', { style: { marginTop: '8px' } }, progress(month.countedMs, month.targetMs))),
      stat('Over / under so far', fmtSigned(month.balanceMs), `vs. where you should be after ${month.completed} of ${month.available} work days`, h('div', { style: { marginTop: '6px' } }, balanceBadge(month.balanceMs))),
      month.daysLeft
        ? stat('Needed per day', fmtDur(month.needPerDayMs), `${month.daysLeft} work day${month.daysLeft === 1 ? '' : 's'} left. Normal shifts finish ${fmtSigned(month.projectedBalanceMs)}`)
        : stat('Month result', fmtSigned(month.countedMs - month.targetMs), month.countedMs >= month.targetMs ? 'Target met' : 'Under target'),
      s.standbyEnabled
        ? sb.current ? stat('Standby', 'On now', `until ${fmtDay(sb.current.end)}`)
          : sb.next ? stat('Next standby', fmtDay(sb.next.start), `${fmtIn(sb.daysUntilNext)} · until ${fmtDay(sb.next.end)}`)
            : stat('Next standby', '–', h('a', { href: '#', onclick: (e) => { e.preventDefault(); ctx.navigate('standby'); } }, 'Set up your rota'))
        : stat('Days worked', String(month.daysWorked), 'this month')),
    h('div.card', h('h2', 'History'), hmHost),
    h('div.grid-2',
      h('div.card',
        h('h2', 'Breaks this month'),
        h('div.hbars', breakRows.map(([b, v]) => h('div.hbar',
          h('span', `${b.icon} ${b.label}`),
          h('div.track', h('div.fill', { style: { width: `${(v / maxBreak) * 100}%` } })),
          h('span.val', `${fmtDur(v)}${breakCounts[b.id] ? ` · ${breakCounts[b.id]}×` : ''}`)))),
        h('p.small.muted', { style: { margin: '10px 0 0' } }, (s.breakTypes || []).some((b) => b.paid) ? 'Paid breaks count as worked time; unpaid breaks are taken off.' : 'All breaks are unpaid and taken off worked time. Change this under Schedule.')),
      h('div.card',
        h('h2', 'Laptop activity today'),
        s.trackActivity
          ? [h('div.row', { style: { marginBottom: '10px' } }, h('span.stat-value', { style: { fontSize: '22px', fontWeight: 700 } }, fmtDur((act?.min || 0) * MIN)),
            act?.first ? h('span.small.muted', `first ${fmtTime(act.first)} · last ${fmtTime(act.last)}`) : null),
          h('div.hours-chart', (act?.hours || Array(24).fill(0)).map((m, i) => h('div.b', { class: m ? '' : 'zero', style: { height: `${(m / maxH) * 100}%` }, dataset: { tip: `${String(i).padStart(2, '0')}:00 · ${m} min active` } }))),
          h('div.hours-axis', Array.from({ length: 24 }, (_, i) => h('span', i % 6 === 0 ? String(i).padStart(2, '0') : '')))]
          : h('p.muted', 'Tracking is off. You can still clock in and out by hand.'))),
    h('div.card',
      h('h2', 'Month by month'),
      h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'Month'), h('th.num', 'Counted'), h('th.num', 'Target'), h('th.num', 'Over / under'), h('th.num', 'Standby work'), h('th.num', 'Days worked'))),
        h('tbody', months.map((m) => {
          const current = m.year === d.getFullYear() && m.month0 === d.getMonth();
          const diff = m.countedMs - m.targetMs;
          return h('tr.clickable', { onclick: () => { tsMonth = { y: m.year, m: m.month0 }; ctx.navigate('timesheet'); } },
            h('td', fmtMonth(m.year, m.month0), current ? h('span.small.muted', ' (so far)') : null),
            h('td.num', fmtDur(m.countedMs)), h('td.num', fmtDur(m.targetMs)),
            h('td.num', current ? balanceBadge(m.balanceMs) : h('span.badge', { class: Math.abs(diff) <= 15 * MIN ? '' : diff > 0 ? 'over' : 'under' }, fmtSigned(diff))),
            h('td.num', m.calloutMs ? fmtDur(m.calloutMs) : '–'), h('td.num', String(m.daysWorked)));
        }))))),
  );
}

// ---- Timesheet -----------------------------------------------------------------------------

let tsMonth = null;

async function renderTimesheet(el, ctx) {
  const s = ctx.values;
  const data = await loadData();
  const now = Date.now();
  const today = dayKey(now);
  if (pendingDay && isDayKey(pendingDay)) {
    const p = parseDay(pendingDay);
    tsMonth = { y: p.getFullYear(), m: p.getMonth() };
  }
  if (!tsMonth) tsMonth = { y: new Date(now).getFullYear(), m: new Date(now).getMonth() };
  const month = summarizeMonth(data.days, tsMonth.y, tsMonth.m, s, now, { since: data.since });
  const go = (delta) => {
    const n = new Date(tsMonth.y, tsMonth.m + delta, 1);
    tsMonth = { y: n.getFullYear(), m: n.getMonth() };
    ctx.rerender();
  };
  const edit = (k) => openDayEditor(k, ctx, () => ctx.rerender());
  const types = s.breakTypes || [];
  const datePick = h('input', { type: 'date', value: today, style: { width: 'auto' }, 'aria-label': 'Date to edit' });
  const isCurrent = tsMonth.y === new Date(now).getFullYear() && tsMonth.m === new Date(now).getMonth();

  add(el,
    h('div.row.between', { style: { marginBottom: '12px' } },
      h('h1', { style: { margin: 0 } }, 'Timesheet'),
      h('div.month-nav',
        h('button.btn.sm', { onclick: () => go(-1), 'aria-label': 'Previous month' }, '◀'),
        h('span.label', fmtMonth(tsMonth.y, tsMonth.m)),
        h('button.btn.sm', { onclick: () => go(1), 'aria-label': 'Next month' }, '▶'),
        !isCurrent ? h('button.btn.ghost.sm', { onclick: () => { tsMonth = null; ctx.rerender(); } }, 'Today') : null)),
    h('div.stats',
      h('div.card.stat', h('div.stat-label', 'Counted'), h('div.stat-value.num', fmtDur(month.countedMs)), h('div.stat-note', `of ${fmtDur(month.targetMs)}`)),
      h('div.card.stat', h('div.stat-label', isCurrent ? 'Over / under so far' : 'Over / under'), h('div.stat-value.num', fmtSigned(isCurrent ? month.balanceMs : month.countedMs - month.targetMs)),
        h('div.stat-note', isCurrent ? `${month.completed} of ${month.available} work days done` : `${month.available} work days`)),
      h('div.card.stat', h('div.stat-label', 'Breaks'), h('div.stat-value.num', fmtDur(Object.values(month.breakMs).reduce((a, b) => a + b, 0))),
        h('div.stat-note', types.map((b) => `${b.icon} ${fmtDur(month.breakMs[b.id] || 0)}`).join('  '))),
      h('div.card.stat', h('div.stat-label', 'Standby work'), h('div.stat-value.num', fmtDur(month.calloutMs)),
        h('div.stat-note', s.calloutsCountTowardMonth ? 'included in counted hours' : 'not counted towards the month'))),
    h('div.card',
      h('div.row.between', { style: { marginBottom: '10px' } },
        h('div.row', datePick, h('button.btn.sm', { onclick: () => isDayKey(datePick.value) && edit(datePick.value) }, 'Add / edit a day')),
        h('div.row',
          h('button.btn.sm', {
            onclick: () => download(`timesheet-${tsMonth.y}-${String(tsMonth.m + 1).padStart(2, '0')}.csv`, monthCSV(month, s, data.days, data.standby), 'text/csv'),
          }, '⬇ Export CSV'),
          h('button.btn.sm', { onclick: () => window.print() }, '🖨 Print'))),
      h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'Day'), h('th', 'In'), h('th', 'Out'), h('th', 'Breaks'), h('th.num', 'Worked'),
          s.standbyEnabled ? h('th.num', 'Standby') : null, h('th.num', 'Counted'), h('th.num', '+/−'), h('th', ''))),
        h('tbody', month.days.map((ds) => {
          const k = ds.key;
          const sb = s.standbyEnabled && standbyOn(k, s, data.standby);
          const future = k > today;
          const weekend = !isWorkdayKey(k, s);
          const diff = ds.countedMs - ds.targetMs;
          const showDiff = !future && (ds.hasData || ds.targetMs) && !(k === today && ds.state !== 'out');
          return h('tr.clickable', { class: [weekend ? 'weekend' : '', k === today ? 'today' : ''].join(' '), onclick: () => edit(k) },
            h('td', h('div', { style: { fontWeight: 600 } }, fmtDay(k)), h('div.row', { style: { gap: '4px' } }, statusBadge(ds.status), sb ? sbBadge() : null,
              data.days[k]?.note ? h('span.small.muted', { title: data.days[k].note }, '📝') : null)),
            h('td.num', ds.firstIn ? fmtTime(ds.firstIn) : '–'),
            h('td.num', ds.incomplete ? h('span.badge.warn', 'missing') : ds.state !== 'out' ? h('span.badge.ok', ds.state === 'break' ? 'on break' : 'working') : ds.lastOut ? fmtTime(ds.lastOut) : '–'),
            h('td.small', Object.entries(ds.breakMs).filter(([, v]) => v).map(([kk, v]) => `${breakType(s, kk).icon} ${fmtDur(v)}`).join('  ') || h('span.muted', '–')),
            h('td.num', ds.workedMs ? fmtDur(ds.workedMs) : '–'),
            s.standbyEnabled ? h('td.num', ds.calloutMs ? h('span', { title: Object.entries(ds.calloutCount).map(([kk, n]) => `${n} ${CALLOUT_KINDS[kk]?.label || kk}`).join(', ') },
              `${Object.entries(ds.calloutCount).map(([kk, n]) => `${CALLOUT_KINDS[kk]?.icon || ''}${n}`).join(' ')} · ${fmtDur(ds.calloutMs)}`) : '–') : null,
            h('td.num', ds.countedMs ? fmtDur(ds.countedMs) : '–'),
            h('td.num', showDiff ? h('span.badge', { class: Math.abs(diff) <= 15 * MIN ? '' : diff > 0 ? 'over' : 'under' }, fmtSigned(diff)) : ''),
            h('td', h('button.btn.ghost.sm', { onclick: (e) => { e.stopPropagation(); edit(k); } }, 'Edit')));
        }))))),
    h('p.small.muted', 'Weekends and days off have no target; anything worked on them (including standby call-outs) adds to the month.'),
  );

  if (pendingDay && isDayKey(pendingDay)) {
    const k = pendingDay;
    pendingDay = null;
    history.replaceState(null, '', '#timesheet');
    edit(k);
  }
}

// ---- Standby -------------------------------------------------------------------------------

async function renderStandby(el, ctx) {
  const s = ctx.values;
  const data = await loadData();
  const extra = { periods: [], skipped: [], ...data.standby };
  const today = dayKey();
  const st = standbyStatus(s, extra, today, 8);
  const saveExtra = async (next) => {
    await api.storage.local.set({ [KEYS.standby]: next });
    send({ type: 'tk:refresh' });
    ctx.rerender();
  };

  const upcoming = standbyPeriods(s, extra, today, addDays(today, 200)).slice(0, 10);

  // Call-outs from the last 90 days, newest first, grouped by standby period.
  const from = addDays(today, -90);
  const log = [];
  for (const [k, day] of Object.entries(data.days)) {
    if (k < from) continue;
    for (const c of day.callouts || []) log.push({ key: k, ...c });
  }
  log.sort((a, b) => b.start - a.start);
  const periodTotals = (p) => {
    const t = { ms: 0, count: {} };
    for (const c of log) if (c.key >= p.start && c.key <= p.end) {
      t.ms += (c.end ?? Date.now()) - c.start;
      t.count[c.kind] = (t.count[c.kind] || 0) + 1;
    }
    return t;
  };
  const recent = standbyPeriods(s, extra, addDays(today, -90), today).filter((p) => !p.skipped).reverse();

  const anchorField = () => {
    const locked = ctx.isLocked('standbyAnchor');
    const inp = h('input', { type: 'date', value: s.standbyAnchor || '', disabled: locked, style: { width: 'auto' } });
    inp.addEventListener('change', async () => { await ctx.save({ standbyAnchor: inp.value }); ctx.rerender(); });
    return h('div.field', h('label', 'First day of one of your standby weeks ', locked ? lockedBadge() : null), inp,
      h('div.hint', 'Pick the start of your current, last or next standby. The rota repeats from it.'));
  };
  const newStart = h('input', { type: 'date', style: { width: 'auto' }, 'aria-label': 'Start' });
  const newEnd = h('input', { type: 'date', style: { width: 'auto' }, 'aria-label': 'End' });
  newStart.addEventListener('change', () => { if (isDayKey(newStart.value)) newEnd.value = addDays(newStart.value, (Number(s.standbyLengthDays) || 7) - 1); });

  add(el,
    h('h1', 'Standby'),
    h('p.muted', `On standby you're on call for ${s.standbyLengthDays} days. Weekend days have no ${s.shiftHours}-hour target; log each call or ticket instead and that time is ${s.calloutsCountTowardMonth ? 'added to' : 'kept separate from'} your month.`),
    h('div.stats',
      h('div.card.stat', h('div.stat-label', 'Right now'), h('div.stat-value', st.current ? 'On standby' : 'Off'), h('div.stat-note', st.current ? `until ${fmtDay(st.current.end)}` : '')),
      h('div.card.stat', h('div.stat-label', 'Next standby'), h('div.stat-value', st.next ? fmtDay(st.next.start) : '–'), h('div.stat-note', st.next ? `${fmtIn(st.daysUntilNext)} · until ${fmtDay(st.next.end)}` : 'Set the rota below')),
      ...(() => {
        const p = st.current || recent[0];
        if (!p) return [h('div.card.stat', h('div.stat-label', 'Last standby'), h('div.stat-value', '–')), h('div.card.stat', h('div.stat-label', 'Call-outs (90 days)'), h('div.stat-value', String(log.length)))];
        const t = periodTotals(p);
        return [
          h('div.card.stat', h('div.stat-label', st.current ? 'This standby' : 'Last standby'), h('div.stat-value.num', fmtDur(t.ms)), h('div.stat-note', `${fmtDay(p.start)} – ${fmtDay(p.end)}`)),
          h('div.card.stat', h('div.stat-label', 'Calls / tickets'), h('div.stat-value.num', `${t.count.call || 0} / ${t.count.ticket || 0}`), h('div.stat-note', t.count.onsite ? `+ ${t.count.onsite} on-site` : 'in that period')),
        ];
      })()),
    h('div.grid-2',
      h('div.card',
        h('h2', 'Your rota'),
        ctx.field({ key: 'standbyEnabled', label: 'I do standby', type: 'toggle', onSaved: () => ctx.rerender() }),
        s.standbyEnabled ? [
          anchorField(),
          h('div.grid-2',
            ctx.field({ key: 'standbyEveryWeeks', label: 'Repeats every (weeks)', type: 'number', min: 1, max: 52, hint: 'Usually the number of people on the rota.', onSaved: () => ctx.rerender() }),
            ctx.field({ key: 'standbyLengthDays', label: 'Length (days)', type: 'number', min: 1, max: 31, onSaved: () => ctx.rerender() })),
          ctx.field({ key: 'calloutsCountTowardMonth', label: 'Count call-out time towards my monthly hours', type: 'toggle', onSaved: () => ctx.rerender() }),
          ctx.field({ key: 'standbyReminderDays', label: 'Remind me this many days before standby starts', type: 'number', min: 0, max: 14, hint: '0 = no reminder.' }),
        ] : null),
      h('div.card',
        h('h2', 'Coming up'),
        upcoming.length ? h('ul.sb-list', upcoming.map((p) => h('li', { class: p.skipped ? 'skipped' : '' },
          h('span', p.start <= today && p.end >= today ? '🟢' : '📟'),
          h('div.grow', h('div', { style: { fontWeight: 600 } }, `${fmtDay(p.start)} – ${fmtDay(p.end)}`),
            h('div.small.muted', p.skipped ? 'Skipped (swapped or covered)' : p.source === 'manual' ? `Added by hand · ${fmtIn(Math.max(0, daysBetween(today, p.start)))}` : p.start <= today ? 'Now' : fmtIn(daysBetween(today, p.start)))),
          p.source === 'rotation'
            ? h('button.btn.ghost.sm', {
              onclick: () => saveExtra({ ...extra, skipped: p.skipped ? extra.skipped.filter((x) => x !== p.start) : [...extra.skipped, p.start] }),
            }, p.skipped ? 'Restore' : 'Skip')
            : h('button.btn.ghost.sm', { onclick: () => saveExtra({ ...extra, periods: extra.periods.filter((x) => x.id !== p.id) }) }, 'Remove'))))
          : h('div.empty', h('div.empty-title', 'No standby scheduled'), s.standbyEnabled ? 'Set the first day of a standby week, or add one by hand below.' : 'Turn on "I do standby".'),
        s.standbyEnabled ? h('div', { style: { marginTop: '14px' } },
          h('label', 'Add a standby period (a swap or an extra week)'),
          h('div.row', newStart, h('span.muted', 'to'), newEnd,
            h('button.btn.sm', {
              onclick: () => {
                if (!isDayKey(newStart.value) || !isDayKey(newEnd.value) || newEnd.value < newStart.value) return toast('Pick a start and an end date.', { error: true });
                saveExtra({ ...extra, periods: [...extra.periods, { id: uid('sb'), start: newStart.value, end: newEnd.value }] });
              },
            }, 'Add'))) : null)),
    h('div.card',
      h('h2', 'Call-outs & tickets (last 90 days)'),
      log.length ? h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'Day'), h('th', 'Type'), h('th', 'Time'), h('th.num', 'Duration'), h('th', 'Reference'))),
        h('tbody', log.map((c) => h('tr.clickable', { onclick: () => openDayEditor(c.key, ctx, () => ctx.rerender()) },
          h('td', fmtDay(c.key), standbyOn(c.key, s, extra) ? '' : h('span.small.muted', ' (off rota)')),
          h('td', `${CALLOUT_KINDS[c.kind]?.icon || ''} ${CALLOUT_KINDS[c.kind]?.label || c.kind}`),
          h('td', `${fmtTime(c.start)} – ${c.end != null ? fmtTime(c.end) : 'running'}`),
          h('td.num', fmtDur((c.end ?? Date.now()) - c.start)),
          h('td', c.ref || h('span.muted', '–')))))))
        : h('div.empty', h('div.empty-title', 'Nothing logged yet'), 'While on standby, use the 📞 Call / 🎫 Ticket buttons in the toolbar popup to time each one.')),
  );
}

// ---- Schedule ------------------------------------------------------------------------------

async function renderSchedule(el, ctx) {
  const s = ctx.values;
  const wdLocked = ctx.isLocked('workDays');
  const btLocked = ctx.isLocked('breakTypes');
  const workDays = new Set((s.workDays || []).map(Number));
  const wdPick = h('div.wd-pick', WEEKDAYS.map(([n, label]) => {
    const cb = h('input', { type: 'checkbox', checked: workDays.has(n), disabled: wdLocked });
    cb.addEventListener('change', async () => {
      if (cb.checked) workDays.add(n); else workDays.delete(n);
      await ctx.save({ workDays: [...workDays].sort() });
    });
    return h('label', cb, label);
  }));

  const types = (s.breakTypes || []).map((b) => ({ ...b }));
  const btHost = h('div');
  const saveTypes = async () => {
    const clean = types.filter((b) => b.label.trim()).map((b) => ({ ...b, id: b.id || b.label.toLowerCase().replace(/[^a-z0-9]+/g, '-') }));
    await ctx.save({ breakTypes: clean }, { quiet: true });
    toast('Break types saved');
  };
  const paintTypes = () => {
    clear(btHost, types.map((b, i) => {
      const icon = h('input', { type: 'text', value: b.icon, maxLength: 4, disabled: btLocked, 'aria-label': 'Icon', style: { textAlign: 'center' } });
      icon.addEventListener('change', () => { b.icon = icon.value || '⏸️'; saveTypes(); });
      const label = h('input', { type: 'text', value: b.label, disabled: btLocked, 'aria-label': 'Name' });
      label.addEventListener('change', () => { b.label = label.value; saveTypes(); });
      return h('div.bt-row', icon, label,
        h('div.row', toggle(b.paid, (v) => { b.paid = v; saveTypes(); }, { disabled: btLocked, label: 'Paid' }), h('span.small', 'Paid')),
        h('button.icon-btn', { disabled: btLocked || types.length <= 1, title: 'Remove', 'aria-label': `Remove ${b.label}`, onclick: () => { types.splice(i, 1); saveTypes(); paintTypes(); } }, '✕'));
    }),
    h('div.row', { style: { marginTop: '8px' } },
      h('button.btn.sm', { disabled: btLocked, onclick: () => { types.push({ id: uid('b'), label: 'New break', icon: '⏸️', paid: false }); paintTypes(); saveTypes(); } }, '+ Add break type'),
      h('button.btn.ghost.sm', { disabled: btLocked, onclick: async () => { types.splice(0, types.length, ...DEFAULT_BREAK_TYPES.map((b) => ({ ...b }))); await saveTypes(); paintTypes(); } }, 'Reset')));
  };
  paintTypes();

  const daily = dailyTargetMs(s);
  add(el,
    h('h1', 'Schedule'),
    h('p.muted', 'Your normal day and the hours you owe each month.'),
    h('div.grid-2',
      h('div.card',
        h('h2', 'Daily shift'),
        h('div.grid-2',
          ctx.field({ key: 'shiftHours', label: 'Shift length (hours)', type: 'number', min: 1, max: 24, hint: 'Clock-in to going home, breaks included.', onSaved: () => ctx.rerender() }),
          ctx.field({ key: 'breakAllowanceMinutes', label: 'Breaks included (minutes)', type: 'number', min: 0, max: 240, hint: 'E.g. a 1-hour lunch.', onSaved: () => ctx.rerender() })),
        h('div.notice', `Paid hours per work day: `, h('b', fmtDur(daily)), `. Home time = clock-in + ${s.shiftHours}h, pushed later only when unpaid breaks go over ${s.breakAllowanceMinutes} minutes.`),
        ctx.field({ key: 'usualStart', label: 'Usual start time', type: 'time', hint: 'Used for the clock-in reminder and "Normal shift" in the editor.' }),
        h('div.field', h('label', 'Work days ', wdLocked ? lockedBadge() : null), wdPick, h('div.hint', 'Other days have no target; only time you actually log (e.g. standby) counts.'))),
      h('div.card',
        h('h2', 'Monthly target'),
        ctx.field({ key: 'targetMode', label: 'Target', type: 'select', options: [['fixed', 'Fixed hours per month'], ['workdays', 'Work days in the month × paid hours per day']], onSaved: () => ctx.rerender() }),
        s.targetMode !== 'workdays' ? ctx.field({ key: 'monthlyTargetHours', label: 'Hours per month', type: 'number', min: 0, max: 400, onSaved: () => ctx.rerender() }) : null,
        ctx.field({ key: 'leaveReducesTarget', label: 'Leave, sick days and public holidays lower the target', type: 'toggle', hint: `Each one on a work day takes ${fmtDur(daily)} off the month. Mark days in the timesheet.` }),
        h('p.small.muted', 'Over / under is worked out against an even pace through the month, so you can see mid-month whether you are ahead or behind.'))),
    h('div.card',
      h('h2', 'Break buttons ', btLocked ? lockedBadge() : null),
      h('p.muted', 'One button per break type in the popup. Unpaid breaks are taken off worked time; paid ones are not.'),
      btHost),
    h('div.card',
      h('h2', 'Sharing'),
      ctx.field({ key: 'displayName', label: 'Your name', placeholder: 'Only used if your team links a shared backend', hint: 'Attached to each day sent under Shared data. Nothing is sent unless a backend is linked.' })),
  );
}

// ---- Reminders & tracking ------------------------------------------------------------------

async function renderReminders(el, ctx) {
  add(el,
    h('h1', 'Reminders & tracking'),
    h('div.grid-2',
      h('div.card',
        h('h2', 'Notifications'),
        ctx.field({ key: 'leaveWarningMinutes', label: 'Almost-home warning (minutes before)', type: 'number', min: 0, max: 240, hint: '0 = off.' }),
        ctx.field({ key: 'notifyShiftDone', label: 'Tell me when my shift is complete', type: 'toggle' }),
        ctx.field({ key: 'breakReminderMinutes', label: 'Break running long after (minutes)', type: 'number', min: 0, max: 240, hint: '0 = off.' }),
        ctx.field({ key: 'forgotClockOutHours', label: 'Still clocked in reminder (hours after home time)', type: 'number', min: 0, max: 12, hint: '0 = off.' }),
        ctx.field({ key: 'clockInPrompt', label: 'When I first use the laptop on a work day', type: 'select', options: [['remind', 'Ask me to clock in'], ['auto', 'Clock me in automatically'], ['off', 'Do nothing']] }),
        h('button.btn.sm', {
          onclick: async () => {
            try {
              await api.notifications.create('tk-test', { type: 'basic', iconUrl: api.runtime.getURL('icons/icon-128.png'), title: 'Almost home time 🏠', message: '30m to go. This is what reminders look like.' });
              toast('Test notification sent. If nothing appeared, allow notifications for your browser in the OS settings.');
            } catch (e) { toast(String(e.message || e), { error: true }); }
          },
        }, 'Send a test notification')),
      h('div.card',
        h('h2', 'Toolbar & laptop activity'),
        ctx.field({ key: 'badge', label: 'Toolbar badge', type: 'select', options: [['remaining', 'Time until home time'], ['worked', 'Time worked today'], ['status', 'IN / BRK'], ['off', 'Nothing']] }),
        ctx.field({ key: 'trackActivity', label: 'Track laptop active time', type: 'toggle', hint: 'Counts minutes with keyboard/mouse activity, like an activity tracker, but only the minutes: no sites, apps or screenshots. Shown under Overview → Laptop active time.' }),
        ctx.field({ key: 'idleMinutes', label: 'Idle after (minutes without input)', type: 'number', min: 1, max: 60 }),
        h('div.notice.small', 'Activity tracking is separate from your hours. Your timesheet only changes when you clock in/out (or when you choose automatic clock-in).'))),
  );
}

// ---- App -----------------------------------------------------------------------------------

const app = await mountApp({
  baseName: BASE,
  tagline: 'Clock in, breaks, clock out. Shift, monthly hours and standby at a glance.',
  settings,
  syncCollections: ['timesheet'],
  welcomeSteps: [
    'Click the Shift Clock icon in the toolbar (pin it so it is always visible) and press Clock in.',
    'Use the ☕ Break / 🚬 Smoke break / 🍽️ Lunch buttons, then End break. Clock out when you leave.',
    "You'll get a notification 30 minutes before home time. Shift length and the 160-hour month are under Schedule.",
    'Under Standby, pick the first day of one of your standby weeks to see when the next one is.',
  ],
  panels: [
    { id: 'overview', label: 'Overview', icon: '📊', render: renderOverview },
    { id: 'timesheet', label: 'Timesheet', icon: '🗓️', render: renderTimesheet },
    { id: 'standby', label: 'Standby', icon: '📟', render: renderStandby },
    { id: 'schedule', label: 'Schedule', icon: '⏱️', render: renderSchedule },
    { id: 'reminders', label: 'Reminders & tracking', icon: '🔔', render: renderReminders },
  ],
});

api.storage.onChanged.addListener((changes, area) => {
  // Keep the open panel current when the popup clocks in/out, unless a dialog is open.
  if (area === 'local' && KEYS.days in changes && !document.querySelector('.wx-modal')) {
    const id = location.hash.slice(1).split('?')[0];
    if (['overview', 'timesheet', 'standby'].includes(id)) app.rerender();
  }
});

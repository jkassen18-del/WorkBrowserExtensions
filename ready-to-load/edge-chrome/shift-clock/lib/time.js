// Shift Clock time logic. Pure functions with no extension APIs, so the background, the pages and
// Node (tests) share exactly the same maths.
//
// Storage model (storage.local):
//   tkDays[YYYY-MM-DD] = { events: [{ id, type: in|out|break|resume, kind?, at }], status?, note?, callouts: [...] }
//     events belong to the day of the clock-in, even when clock-out happens after midnight.
//     callouts = standby calls/tickets: [{ id, kind: call|ticket|onsite, start, end|null, ref, note }]
//   tkStandby = { periods: [{ id, start, end }], skipped: [startKey] }   manual standby weeks + skipped rotation weeks
//   tkActivity[YYYY-MM-DD] = { min, hours: [24] }                          laptop active minutes (optional)
//   tkFlags = { '<day>:<what>': value }                                    which reminders were already shown
//   tkSince = 'YYYY-MM-DD'                                                 install day; earlier days are not expected

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY_MS = 24 * HOUR;

export const KEYS = { days: 'tkDays', standby: 'tkStandby', activity: 'tkActivity', flags: 'tkFlags', since: 'tkSince' };

// Day statuses. leave/sick/holiday lower the month target (when leaveReducesTarget is on);
// toil (time off in lieu) is a day off paid for out of your balance, so the target stays.
export const STATUS = {
  work: 'Work day',
  leave: 'Annual leave',
  sick: 'Sick',
  holiday: 'Public holiday',
  toil: 'Time off in lieu',
};
export const OFF_STATUSES = new Set(['leave', 'sick', 'holiday']);

export const CALLOUT_KINDS = {
  call: { label: 'Call', icon: '📞' },
  ticket: { label: 'Ticket', icon: '🎫' },
  onsite: { label: 'On-site', icon: '🛠️' },
};

// An open (not clocked out) day stays "live" for this long after its last event. After that it
// counts as a forgotten clock-out and a new clock-in starts a fresh day.
export const LIVE_WINDOW_MS = 16 * HOUR;

const pad = (n) => String(n).padStart(2, '0');

// ---- Dates (local time, keyed YYYY-MM-DD) ----------------------------------------------------

export function dayKey(d = new Date()) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}
export const isDayKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);
export function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(key, n) {
  const d = parseDay(key);
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}
/** Whole days from a to b (DST-safe). */
export const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
export const weekdayOf = (key) => parseDay(key).getDay();
export function monthDays(year, month0) {
  const n = new Date(year, month0 + 1, 0).getDate();
  return Array.from({ length: n }, (_, i) => dayKey(new Date(year, month0, i + 1)));
}
/** ms for HH:MM on a day. */
export function atTime(key, hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const d = parseDay(key);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}
/** HH:MM (24h) for <input type=time>. */
export function hhmm(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- Formatting -----------------------------------------------------------------------------

export function fmtDur(ms, { zero = '0m' } = {}) {
  const total = Math.round(Math.abs(ms) / MIN);
  if (!total) return zero;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${pad(m)}m` : `${m}m`;
}
export const fmtSigned = (ms) => (Math.round(ms / MIN) === 0 ? '±0m' : `${ms > 0 ? '+' : '−'}${fmtDur(ms)}`);
export const fmtHours = (ms) => `${(ms / HOUR).toFixed(1)}h`;
export const fmtTime = (ms) => (ms == null ? '–' : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms)));
export const fmtDay = (key, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Intl.DateTimeFormat(undefined, opts).format(parseDay(key));
export const fmtMonth = (year, month0) => new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(year, month0, 1));
/** "in 3 days", "tomorrow", "today" */
export function fmtIn(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

// ---- Schedule -------------------------------------------------------------------------------

/** Paid hours expected on a normal work day: shift length minus the breaks included in it. */
export const dailyTargetMs = (s) => Math.max(0, (Number(s.shiftHours) || 0) * HOUR - (Number(s.breakAllowanceMinutes) || 0) * MIN);
export const isWorkday = (key, s) => (s.workDays || []).map(Number).includes(weekdayOf(key));
export function breakType(s, id) {
  return (s.breakTypes || []).find((b) => b.id === id) || { id, label: id || 'Break', icon: '⏸️', paid: false };
}
/** What this day is expected to contribute (0 on weekends and days off). */
export function dayTargetMs(key, day, s) {
  if (!isWorkday(key, s)) return 0;
  if (day?.status && OFF_STATUSES.has(day.status) && s.leaveReducesTarget) return 0;
  return dailyTargetMs(s);
}

export const sortedEvents = (day) => [...(day?.events || [])].sort((a, b) => a.at - b.at);

/**
 * Everything about one day. `now` decides whether an open day is still running (live) or was
 * left open by mistake (incomplete: counted up to the expected end of the shift).
 */
export function summarizeDay(key, day, s, now = Date.now()) {
  const events = sortedEvents(day);
  const target = dayTargetMs(key, day, s);
  let state = 'out';
  let sessionStart = 0;
  let breakStart = 0;
  let breakKind = null;
  let firstIn = null;
  let lastOut = null;
  let spanMs = 0;
  let unpaidMs = 0;
  const breakMs = {};
  const breaks = [];
  const sessions = [];

  const closeBreak = (t, open = false) => {
    const d = Math.max(0, t - breakStart);
    breaks.push({ kind: breakKind, start: breakStart, end: t, ms: d, open });
    breakMs[breakKind] = (breakMs[breakKind] || 0) + d;
    if (!breakType(s, breakKind).paid) unpaidMs += d;
  };
  const closeSession = (t, open = false) => {
    sessions.push({ start: sessionStart, end: t, open });
    spanMs += Math.max(0, t - sessionStart);
  };

  for (const e of events) {
    if (e.type === 'in' && state === 'out') {
      state = 'in';
      sessionStart = e.at;
      if (firstIn == null) firstIn = e.at;
    } else if (e.type === 'break' && state === 'in') {
      state = 'break';
      breakStart = e.at;
      breakKind = e.kind || 'break';
    } else if (e.type === 'resume' && state === 'break') {
      closeBreak(e.at);
      state = 'in';
    } else if (e.type === 'out' && state !== 'out') {
      if (state === 'break') closeBreak(e.at);
      closeSession(e.at);
      state = 'out';
      lastOut = e.at;
    }
  }

  const lastAt = events.length ? events[events.length - 1].at : 0;
  const open = state !== 'out';
  const live = open && now >= lastAt && now - lastAt < LIVE_WINDOW_MS;
  const incomplete = open && !live;
  const currentBreak = state === 'break' ? { kind: breakKind, start: breakStart } : null;
  if (open) {
    const end = live ? now : Math.max(lastAt, firstIn + (Number(s.shiftHours) || 0) * HOUR);
    if (state === 'break') closeBreak(end, live);
    closeSession(end, live);
  }

  let calloutMs = 0;
  let openCallout = null;
  const calloutCount = {};
  for (const c of day?.callouts || []) {
    const end = c.end ?? (now - c.start < LIVE_WINDOW_MS ? now : c.start);
    if (c.end == null && end === now) openCallout = c;
    calloutMs += Math.max(0, end - c.start);
    calloutCount[c.kind] = (calloutCount[c.kind] || 0) + 1;
  }

  const workedMs = Math.max(0, spanMs - unpaidMs);
  const countedMs = workedMs + (s.calloutsCountTowardMonth ? calloutMs : 0);

  // Time to go home: first clock-in + paid hours + time off the clock (unpaid breaks and gaps
  // between sessions), but never less than the break allowance included in the shift.
  let leaveAt = null;
  if (live && target > 0) {
    const offClockMs = Math.max(0, now - firstIn - workedMs);
    leaveAt = firstIn + target + Math.max((Number(s.breakAllowanceMinutes) || 0) * MIN, offClockMs);
  }

  return {
    key, state: live ? state : 'out', live, incomplete, firstIn, lastOut, spanMs, workedMs, unpaidMs, breakMs,
    breaks, sessions, currentBreak: live ? currentBreak : null, sessionStart: live ? sessionStart : null,
    calloutMs, calloutCount, openCallout, countedMs, targetMs: target, leaveAt,
    status: day?.status || 'work', hasData: events.length > 0 || (day?.callouts || []).length > 0,
  };
}

/** The day new clock events go to: yesterday while its shift is still open and live, else today. */
export function activeDayKey(days, s, now = Date.now()) {
  const today = dayKey(now);
  const y = addDays(today, -1);
  if (!(days[today]?.events || []).length && days[y]) {
    const sum = summarizeDay(y, days[y], s, now);
    if (sum.live && sum.state !== 'out') return y;
  }
  return today;
}

/** Days before today that were left clocked in. */
export function incompleteDays(days, s, now = Date.now(), lookback = 45) {
  const today = dayKey(now);
  const from = addDays(today, -lookback);
  return Object.keys(days).filter((k) => k >= from && k <= today)
    .filter((k) => summarizeDay(k, days[k], s, now).incomplete).sort();
}

// ---- Month ----------------------------------------------------------------------------------

/**
 * Month totals against the target.
 *   targetMs      fixed: monthlyTargetHours (minus days off), workdays: available days × daily hours
 *   expectedMs    where you should be by now (target spread evenly over the available work days)
 *   balanceMs     counted on finished days minus expectedMs (+ = ahead / over, − = behind / under)
 *   needPerDayMs  what each remaining work day needs to hit the target
 * Work days before `since` (the day tracking started) are left out, like days off, so the first
 * month isn't shown as behind for days before you installed.
 */
export function summarizeMonth(days, year, month0, s, now = Date.now(), { since = null } = {}) {
  const today = dayKey(now);
  const daily = dailyTargetMs(s);
  const r = {
    year, month0, workdays: 0, offDays: 0, available: 0, completed: 0, countedMs: 0, countedDoneMs: 0,
    workedMs: 0, calloutMs: 0, breakMs: {}, daysWorked: 0, untracked: 0, incomplete: [], days: [],
  };
  for (const key of monthDays(year, month0)) {
    const day = days[key];
    const sum = summarizeDay(key, day, s, now);
    r.days.push(sum);
    const wd = isWorkday(key, s);
    const off = !!(day?.status && OFF_STATUSES.has(day.status));
    if (wd && since && key < since && !sum.hasData) {
      r.workdays++;
      r.untracked++;
    } else if (wd) {
      r.workdays++;
      if (off) r.offDays++;
      else r.available++;
    }
    if (key > today) continue;
    const done = key < today || (sum.hasData && sum.state === 'out') || off;
    const untracked = since && key < since && !sum.hasData;
    r.countedMs += sum.countedMs;
    r.workedMs += sum.workedMs;
    r.calloutMs += sum.calloutMs;
    for (const [k, v] of Object.entries(sum.breakMs)) r.breakMs[k] = (r.breakMs[k] || 0) + v;
    if (sum.workedMs > 0) r.daysWorked++;
    if (sum.incomplete) r.incomplete.push(key);
    if (done) {
      r.countedDoneMs += sum.countedMs;
      if (wd && !off && !untracked) r.completed++;
    }
  }
  const reduce = (s.leaveReducesTarget ? r.offDays : 0) + r.untracked;
  r.targetMs = s.targetMode === 'workdays'
    ? (r.workdays - reduce) * daily
    : Math.max(0, (Number(s.monthlyTargetHours) || 0) * HOUR - reduce * daily);
  r.expectedMs = r.available ? (r.targetMs * r.completed) / r.available : 0;
  r.balanceMs = r.countedDoneMs - r.expectedMs;
  r.remainingMs = Math.max(0, r.targetMs - r.countedMs);
  r.daysLeft = Math.max(0, r.available - r.completed);
  r.needPerDayMs = r.daysLeft ? r.remainingMs / r.daysLeft : 0;
  // If every remaining work day is a normal shift, where does the month end up?
  r.projectedMs = r.countedMs + r.daysLeft * daily;
  r.projectedBalanceMs = r.projectedMs - r.targetMs;
  return r;
}

// ---- Standby --------------------------------------------------------------------------------

/**
 * Standby periods overlapping [fromKey, toKey]: the repeating rotation (anchor + every N weeks)
 * plus manual periods. Rotation weeks the user skipped are returned with skipped: true.
 */
export function standbyPeriods(s, extra = {}, fromKey, toKey) {
  if (!s.standbyEnabled) return [];
  const out = [];
  const len = Math.max(1, Math.round(Number(s.standbyLengthDays) || 7));
  const every = Math.max(1, Math.round(Number(s.standbyEveryWeeks) || 1)) * 7;
  const skipped = new Set(extra.skipped || []);
  if (isDayKey(s.standbyAnchor)) {
    let k = Math.floor((daysBetween(s.standbyAnchor, fromKey) - len + 1) / every);
    for (;; k++) {
      const start = addDays(s.standbyAnchor, k * every);
      if (start > toKey) break;
      const end = addDays(start, len - 1);
      if (end < fromKey) continue;
      out.push({ id: `rot-${start}`, start, end, source: 'rotation', skipped: skipped.has(start) });
    }
  }
  for (const p of extra.periods || []) {
    if (isDayKey(p.start) && isDayKey(p.end) && p.end >= fromKey && p.start <= toKey) out.push({ ...p, source: 'manual', skipped: false });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export function standbyOn(key, s, extra) {
  return standbyPeriods(s, extra, key, key).find((p) => !p.skipped) || null;
}

/** { current, next, daysUntilNext, upcoming: [...] } looking a year ahead. */
export function standbyStatus(s, extra, today = dayKey(), count = 6) {
  const periods = standbyPeriods(s, extra, today, addDays(today, 400)).filter((p) => !p.skipped);
  const current = periods.find((p) => p.start <= today && p.end >= today) || null;
  const future = periods.filter((p) => p.start > today);
  const next = future[0] || null;
  return { current, next, daysUntilNext: next ? daysBetween(today, next.start) : null, upcoming: future.slice(0, count) };
}

// ---- Validation for edited days ---------------------------------------------------------------

/** Problems with a day's events (shown in the editor). Empty array = fine. */
export function checkEvents(events) {
  const problems = [];
  let state = 'out';
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (e.type === 'in' && state !== 'out') problems.push(`Clock in at ${hhmm(e.at)} while already clocked in.`);
    else if (e.type === 'break' && state !== 'in') problems.push(`Break at ${hhmm(e.at)} while not working.`);
    else if (e.type === 'resume' && state !== 'break') problems.push(`Break end at ${hhmm(e.at)} without a break.`);
    else if (e.type === 'out' && state === 'out') problems.push(`Clock out at ${hhmm(e.at)} while not clocked in.`);
    if (e.type === 'in' && state === 'out') state = 'in';
    else if (e.type === 'break' && state === 'in') state = 'break';
    else if (e.type === 'resume' && state === 'break') state = 'in';
    else if (e.type === 'out') state = 'out';
  }
  return problems;
}

// ---- Export ---------------------------------------------------------------------------------

const csvCell = (v) => {
  const t = String(v ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const hrs = (ms) => (ms / HOUR).toFixed(2);

export function monthCSV(month, s, days, extra) {
  const types = s.breakTypes || [];
  const head = ['Date', 'Weekday', 'Status', 'Standby', 'Clock in', 'Clock out', ...types.map((b) => `${b.label} (h)`),
    'Worked (h)', 'Callouts (h)', 'Calls', 'Tickets', 'Counted (h)', 'Target (h)', 'Difference (h)', 'Note'];
  const rows = month.days.map((d) => [
    d.key, fmtDay(d.key, { weekday: 'short' }), STATUS[d.status] || d.status, standbyOn(d.key, s, extra) ? 'yes' : '',
    d.firstIn ? hhmm(d.firstIn) : '', d.lastOut ? hhmm(d.lastOut) : d.incomplete ? 'missing' : '',
    ...types.map((b) => hrs(d.breakMs[b.id] || 0)), hrs(d.workedMs), hrs(d.calloutMs),
    d.calloutCount.call || 0, d.calloutCount.ticket || 0, hrs(d.countedMs), hrs(d.targetMs),
    hrs(d.countedMs - d.targetMs), days[d.key]?.note || '',
  ]);
  rows.push([], ['Month target (h)', hrs(month.targetMs)], ['Counted (h)', hrs(month.countedMs)], ['Over / under (h)', hrs(month.countedMs - month.targetMs)]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

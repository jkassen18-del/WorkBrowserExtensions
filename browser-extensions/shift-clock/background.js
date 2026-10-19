// Shift Clock background: the only writer of the timesheet (clock in/out, breaks, standby
// call-outs, day edits), plus a one-minute tick that keeps the toolbar badge current, sends
// reminders (almost home time, shift done, long break, clock in, forgot to clock out, standby)
// and optionally counts active laptop minutes.
import { api, isFirefox, uid } from './shared/api.js';
import { startBackground, handleMessages } from './shared/background-kit.js';
import { push } from './shared/connections.js';
import { settings } from './settings.js';
import {
  KEYS, MIN, HOUR, dayKey, addDays, activeDayKey, summarizeDay, standbyStatus, standbyOn, isWorkday, atTime,
  fmtDur, fmtTime, fmtDay, fmtIn, breakType, checkEvents, CALLOUT_KINDS, OFF_STATUSES, LIVE_WINDOW_MS,
} from './lib/time.js';

const TICK = 'tk-tick';
const FLAG_DAYS = 14;

// Serialise all storage read-modify-write so actions and the tick never interleave.
let chain = Promise.resolve();
function run(fn) {
  const p = chain.then(fn);
  chain = p.catch((e) => console.warn('[shift-clock]', e));
  return p;
}

const getDays = async () => (await api.storage.local.get(KEYS.days))[KEYS.days] || {};
const getStandby = async () => (await api.storage.local.get(KEYS.standby))[KEYS.standby] || {};

startBackground({
  glyph: 'clock',
  settings,
  onSync: async (conn) => {
    const s = await settings.get();
    const days = await getDays();
    const extra = await getStandby();
    const now = Date.now();
    const keys = Object.keys(days).filter((k) => k >= addDays(dayKey(now), -90)).sort();
    if (!keys.length) return { ok: true, message: 'No days to send yet.' };
    const person = s.displayName || 'me';
    const records = keys.map((k) => {
      const d = summarizeDay(k, days[k], s, now);
      return {
        id: `${person}:${k}`, person, date: k, status: d.status, standby: !!standbyOn(k, s, extra),
        clockIn: d.firstIn ? new Date(d.firstIn).toISOString() : null, clockOut: d.lastOut ? new Date(d.lastOut).toISOString() : null,
        workedMinutes: Math.round(d.workedMs / MIN), breakMinutes: Math.round((d.spanMs - d.workedMs) / MIN),
        calloutMinutes: Math.round(d.calloutMs / MIN), calls: d.calloutCount.call || 0, tickets: d.calloutCount.ticket || 0,
        countedMinutes: Math.round(d.countedMs / MIN), targetMinutes: Math.round(d.targetMs / MIN),
      };
    });
    const r = await push('shift-clock', 'timesheet', records, conn);
    if (!r.ok) return { ok: false, message: r.error };
    return { ok: true, message: `Sent ${records.length} day${records.length === 1 ? '' : 's'}.` };
  },
});

// ---- Clock actions ----------------------------------------------------------------------------

/**
 * msg: { action: in|out|break|resume|undo|callout-start|callout-stop, kind?, at?, ref? }
 * `at` lets the user record a time they forgot (it must be in the past and after the day's last entry).
 */
async function act(msg) {
  const s = await settings.get();
  const now = Date.now();
  const at = Number.isFinite(msg.at) ? Math.min(msg.at, now) : now;
  const days = await getDays();

  if (msg.action === 'callout-start' || msg.action === 'callout-stop') {
    const open = findOpenCallout(days, now);
    if (msg.action === 'callout-start') {
      if (open) throw new Error('A call-out is already running. Stop it first.');
      const key = dayKey(at);
      const day = (days[key] ||= { events: [] });
      (day.callouts ||= []).push({ id: uid('c'), kind: CALLOUT_KINDS[msg.kind] ? msg.kind : 'call', start: at, end: null, ref: String(msg.ref || ''), note: '' });
    } else {
      if (!open) throw new Error('No call-out is running.');
      open.callout.end = Math.max(open.callout.start, at);
      if (msg.ref != null) open.callout.ref = String(msg.ref);
    }
    await api.storage.local.set({ [KEYS.days]: days });
    return refresh();
  }

  const key = activeDayKey(days, s, now);
  const day = (days[key] ||= { events: [] });
  day.events ||= [];
  const sum = summarizeDay(key, day, s, now);
  const last = day.events.reduce((m, e) => Math.max(m, e.at), 0);
  if (msg.action !== 'undo' && at < last) {
    throw new Error(`That time is before your last entry (${fmtTime(last)}). Edit the day in the timesheet instead.`);
  }
  const add = (type, extra = {}) => day.events.push({ id: uid('e'), type, at, ...extra });

  switch (msg.action) {
    case 'in':
      if (sum.state !== 'out') throw new Error('You are already clocked in.');
      add('in');
      break;
    case 'out':
      if (sum.state === 'out') throw new Error('You are not clocked in.');
      add('out');
      break;
    case 'break':
      if (sum.state === 'break') throw new Error('You are already on a break.');
      if (sum.state !== 'in') throw new Error('Clock in first.');
      add('break', { kind: msg.kind || 'break' });
      break;
    case 'resume':
      if (sum.state !== 'break') throw new Error('You are not on a break.');
      add('resume');
      break;
    case 'undo': {
      if (!day.events.length) throw new Error('Nothing to undo today.');
      const i = day.events.reduce((best, e, idx, arr) => (e.at >= arr[best].at ? idx : best), 0);
      day.events.splice(i, 1);
      break;
    }
    default:
      throw new Error(`Unknown action "${msg.action}".`);
  }
  if (!day.events.length && !(day.callouts || []).length && !day.status && !day.note) delete days[key];
  await api.storage.local.set({ [KEYS.days]: days });
  return refresh();
}

function findOpenCallout(days, now) {
  for (const key of [dayKey(now), addDays(dayKey(now), -1)]) {
    const c = (days[key]?.callouts || []).find((x) => x.end == null && now - x.start < LIVE_WINDOW_MS);
    if (c) return { key, callout: c };
  }
  return null;
}

/** Replaces one day from the timesheet editor (null/empty day deletes it). */
async function saveDay({ key, day }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('Bad date.');
  const days = await getDays();
  const empty = !day || (!(day.events || []).length && !(day.callouts || []).length && !day.status && !day.note);
  if (empty) delete days[key];
  else {
    const problems = checkEvents(day.events || []);
    if (problems.length) throw new Error(problems[0]);
    days[key] = day;
  }
  await api.storage.local.set({ [KEYS.days]: days });
  return refresh();
}

// ---- Badge, reminders, activity ---------------------------------------------------------------

function shortDur(ms) {
  const m = Math.round(Math.abs(ms) / MIN);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h >= 10 ? `${h}h` : `${h}:${String(m % 60).padStart(2, '0')}`;
}

async function paintBadge(s, sum, callout, now) {
  if (!api.action?.setBadgeText) return;
  let text = '';
  let color = '#16A34A';
  let title = 'Not clocked in';
  if (callout) {
    text = 'CALL';
    color = '#DC2626';
    title = `Standby ${CALLOUT_KINDS[callout.kind]?.label.toLowerCase() || 'call-out'} running for ${fmtDur(now - callout.start)}`;
  } else if (sum.state === 'break') {
    text = 'BRK';
    color = '#D97706';
    const bt = breakType(s, sum.currentBreak.kind);
    title = `On ${bt.label.toLowerCase()} for ${fmtDur(now - sum.currentBreak.start)}`;
  } else if (sum.state === 'in') {
    const rem = sum.leaveAt ? sum.leaveAt - now : null;
    if (s.badge === 'remaining' && rem != null) {
      text = rem > 0 ? shortDur(rem) : `+${shortDur(rem)}`;
      if (rem <= 0) color = '#2563EB';
    } else if (s.badge === 'status') text = 'IN';
    else text = shortDur(sum.workedMs);
    title = `Working since ${fmtTime(sum.firstIn)} · ${fmtDur(sum.workedMs)} worked${sum.leaveAt ? ` · home time ${fmtTime(sum.leaveAt)}` : ''}`;
  }
  if (s.badge === 'off' && !callout) text = '';
  try {
    await api.action.setBadgeText({ text });
    await api.action.setBadgeBackgroundColor({ color });
    await api.action.setBadgeTextColor?.({ color: '#FFFFFF' });
    await api.action.setTitle({ title: `${api.runtime.getManifest().name} · ${title}` });
  } catch { /* badge API differences between browsers */ }
}

const NOTE_ACTIONS = new Map(); // notificationId -> { body: action, buttons: [action] }

async function notify(id, title, message, { body, buttons = [] } = {}) {
  const opts = { type: 'basic', iconUrl: api.runtime.getURL('icons/icon-128.png'), title, message, priority: 2 };
  if (!isFirefox && buttons.length) opts.buttons = buttons.map((b) => ({ title: b.title }));
  NOTE_ACTIONS.set(id, { body, buttons: buttons.map((b) => b.action) });
  await api.storage.session?.set({ [`note:${id}`]: { body, buttons: buttons.map((b) => b.action) } }).catch(() => {});
  try {
    await api.notifications.clear(id);
    await api.notifications.create(id, opts);
  } catch (e) {
    console.warn('[shift-clock] notification failed', e);
  }
}

async function noteAction(id, index) {
  let entry = NOTE_ACTIONS.get(id);
  if (!entry) entry = (await api.storage.session?.get(`note:${id}`).catch(() => ({})))?.[`note:${id}`];
  const action = index == null ? entry?.body : entry?.buttons?.[index];
  api.notifications.clear(id);
  if (!action) return;
  if (action.open) {
    api.tabs.create({ url: api.runtime.getURL(`options/options.html#${action.open}`) });
    return;
  }
  try {
    await run(() => act(action));
  } catch (e) {
    notify('tk-error', 'Shift Clock', String(e.message || e));
  }
}
api.notifications?.onClicked.addListener((id) => noteAction(id, null));
api.notifications?.onButtonClicked?.addListener((id, i) => noteAction(id, i));

async function reminders(s, days, sum, key, now) {
  const { [KEYS.flags]: flags = {} } = await api.storage.local.get(KEYS.flags);
  let changed = false;
  const flag = (k, v = true) => { flags[k] = v; changed = true; };
  const today = dayKey(now);

  if (sum.live && sum.state !== 'out' && sum.leaveAt) {
    const warnMs = (Number(s.leaveWarningMinutes) || 0) * MIN;
    const fk = `${key}:warn`;
    // Re-warn only if a long break pushed home time out by more than 10 minutes since the last warning.
    if (warnMs > 0 && sum.state === 'in' && now >= sum.leaveAt - warnMs && now < sum.leaveAt
      && !(flags[fk] && sum.leaveAt <= flags[fk] + 10 * MIN)) {
      flag(fk, sum.leaveAt);
      await notify('tk-leave-warn', 'Almost home time 🏠',
        `${fmtDur(sum.leaveAt - now)} to go. You can leave at ${fmtTime(sum.leaveAt)}.`, { body: { open: 'overview' } });
    }
    if (s.notifyShiftDone && sum.state === 'in' && now >= sum.leaveAt && !flags[`${key}:done`]) {
      flag(`${key}:done`);
      await notify('tk-done', 'Shift complete ✅', `You've put in ${fmtDur(sum.workedMs)} today. Time to go home. Remember to clock out.`,
        { body: { open: 'overview' }, buttons: [{ title: 'Clock out now', action: { action: 'out' } }] });
    }
    const forgotMs = (Number(s.forgotClockOutHours) || 0) * HOUR;
    if (forgotMs > 0 && now >= sum.leaveAt + forgotMs && !flags[`${key}:forgot`]) {
      flag(`${key}:forgot`);
      await notify('tk-forgot', 'Still clocked in?', `Your shift ended at ${fmtTime(sum.leaveAt)}. Clock out, or fix the time in the timesheet.`,
        { body: { open: 'timesheet' }, buttons: [{ title: 'Clock out now', action: { action: 'out' } }, { title: `Clock out at ${fmtTime(sum.leaveAt)}`, action: { action: 'out', at: sum.leaveAt } }] });
    }
  }

  const breakMin = Number(s.breakReminderMinutes) || 0;
  if (breakMin > 0 && sum.state === 'break' && now - sum.currentBreak.start >= breakMin * MIN && !flags[`${key}:break:${sum.currentBreak.start}`]) {
    flag(`${key}:break:${sum.currentBreak.start}`);
    const bt = breakType(s, sum.currentBreak.kind);
    await notify('tk-break', `${bt.icon} Break reminder`, `Your ${bt.label.toLowerCase()} has run for ${fmtDur(now - sum.currentBreak.start)}.`,
      { body: { action: 'resume' }, buttons: [{ title: 'End break', action: { action: 'resume' } }] });
  }

  // Clock-in prompt: first laptop use on a work day without any entries yet.
  if (s.clockInPrompt !== 'off' && key === today && !sum.hasData && isWorkday(today, s)
    && !OFF_STATUSES.has(days[today]?.status) && days[today]?.status !== 'toil'
    && now >= atTime(today, s.usualStart) - 2 * HOUR && now < atTime(today, s.usualStart) + 6 * HOUR
    && !flags[`${today}:prompt`]) {
    const state = await api.idle.queryState(Math.max(60, (Number(s.idleMinutes) || 5) * 60)).catch(() => 'active');
    if (state === 'active') {
      flag(`${today}:prompt`);
      if (s.clockInPrompt === 'auto') {
        await act({ action: 'in' }).catch(() => {});
        await notify('tk-auto-in', 'Clocked in ⏱️', `Clocked in at ${fmtTime(now)}. Not right? Open Shift Clock and press Undo.`,
          { body: { open: 'overview' }, buttons: [{ title: 'Undo', action: { action: 'undo' } }] });
      } else {
        await notify('tk-prompt', 'Good morning! Clock in?', `Click here to clock in at ${fmtTime(now)}.`,
          { body: { action: 'in', at: now }, buttons: [{ title: 'Clock in', action: { action: 'in', at: now } }] });
      }
    }
  }

  // Standby: a heads-up N days before, and on the first morning.
  const extra = await getStandby();
  const st = standbyStatus(s, extra, today);
  const ahead = Number(s.standbyReminderDays) || 0;
  if (ahead > 0 && st.next && st.daysUntilNext <= ahead && !flags[`sb:${st.next.start}:soon`] && new Date(now).getHours() >= 9) {
    flag(`sb:${st.next.start}:soon`);
    await notify('tk-standby', 'Standby coming up 📟', `Your standby starts ${fmtIn(st.daysUntilNext)}: ${fmtDay(st.next.start)} to ${fmtDay(st.next.end)}.`, { body: { open: 'standby' } });
  }
  if (st.current && st.current.start === today && !flags[`sb:${st.current.start}:start`] && new Date(now).getHours() >= 7) {
    flag(`sb:${st.current.start}:start`);
    await notify('tk-standby', "You're on standby 📟", `Standby runs until ${fmtDay(st.current.end)}. Log calls and tickets from the toolbar button.`, { body: { open: 'standby' } });
  }

  if (changed) {
    const cutoff = addDays(today, -FLAG_DAYS);
    for (const k of Object.keys(flags)) {
      const d = k.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      if (d && d < cutoff) delete flags[k];
    }
    await api.storage.local.set({ [KEYS.flags]: flags });
  }
}

/** Adds one active minute when the laptop is in use (alarm ticks only). */
async function recordActivity(s, now) {
  if (!s.trackActivity || !api.idle) return;
  const state = await api.idle.queryState(Math.max(60, (Number(s.idleMinutes) || 5) * 60)).catch(() => 'idle');
  if (state !== 'active') return;
  const { [KEYS.activity]: activity = {}, tkLastActive = 0 } = await api.storage.local.get([KEYS.activity, 'tkLastActive']);
  if (now - tkLastActive < 50 * 1000) return; // a duplicate tick
  const key = dayKey(now);
  const day = (activity[key] ||= { min: 0, hours: Array(24).fill(0) });
  day.min += 1;
  day.hours[new Date(now).getHours()] += 1;
  if (!day.first) day.first = now;
  day.last = now;
  // Keep about 13 months for the yearly heatmap.
  const cutoff = addDays(key, -400);
  for (const k of Object.keys(activity)) if (k < cutoff) delete activity[k];
  await api.storage.local.set({ [KEYS.activity]: activity, tkLastActive: now });
}

async function refresh({ tick = false } = {}) {
  const s = await settings.get();
  const now = Date.now();
  const days = await getDays();
  const key = activeDayKey(days, s, now);
  const sum = summarizeDay(key, days[key], s, now);
  const callout = findOpenCallout(days, now)?.callout || null;
  await paintBadge(s, sum, callout, now);
  if (tick) await recordActivity(s, now);
  await reminders(s, days, sum, key, now);
  return { ok: true, key, state: sum.state };
}

function ensureTick() {
  api.alarms.get(TICK).then((a) => { if (!a) api.alarms.create(TICK, { periodInMinutes: 1, delayInMinutes: 1 }); });
}

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK) run(() => refresh({ tick: true }));
});
api.idle?.onStateChanged.addListener((state) => {
  if (state === 'active') run(() => refresh());
});
api.runtime.onInstalled.addListener(async () => {
  const { [KEYS.since]: since } = await api.storage.local.get(KEYS.since);
  if (!since) await api.storage.local.set({ [KEYS.since]: dayKey() });
  ensureTick();
  run(() => refresh());
});
api.runtime.onStartup?.addListener(() => { ensureTick(); run(() => refresh()); });
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'settings' in changes) run(() => refresh());
});
ensureTick();
run(() => refresh());

handleMessages({
  'tk:act': (msg) => run(() => act(msg)),
  'tk:saveDay': (msg) => run(() => saveDay(msg)),
  'tk:refresh': () => run(() => refresh()),
});

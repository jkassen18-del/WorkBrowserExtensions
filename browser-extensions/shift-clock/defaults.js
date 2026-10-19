// Every Shift Clock setting with its default. Policy can suggest ("defaults") or enforce any of these keys,
// so a team lead can roll out the same shift length, monthly target and standby rotation to everyone.

export const DEFAULT_BREAK_TYPES = [
  { id: 'break', label: 'Break', icon: '☕', paid: false },
  { id: 'smoke', label: 'Smoke break', icon: '🚬', paid: false },
  { id: 'lunch', label: 'Lunch', icon: '🍽️', paid: false },
];

export default {
  // Schedule
  shiftHours: 9,
  breakAllowanceMinutes: 60,
  monthlyTargetHours: 160,
  targetMode: 'fixed',
  leaveReducesTarget: true,
  workDays: [1, 2, 3, 4, 5],
  usualStart: '08:00',
  breakTypes: DEFAULT_BREAK_TYPES,
  displayName: '',

  // Standby
  standbyEnabled: true,
  standbyAnchor: '',
  standbyEveryWeeks: 4,
  standbyLengthDays: 7,
  calloutsCountTowardMonth: true,

  // Reminders
  leaveWarningMinutes: 30,
  notifyShiftDone: true,
  breakReminderMinutes: 0,
  clockInPrompt: 'remind',
  forgotClockOutHours: 2,
  standbyReminderDays: 1,
  badge: 'remaining',

  // Laptop activity
  trackActivity: true,
  idleMinutes: 5,
};

export const DESCRIPTIONS = {
  shiftHours: 'Length of a normal work day from clock-in to going home, including breaks (hours).',
  breakAllowanceMinutes: 'Break time already included in the shift. Paid hours per day = shift length minus this.',
  monthlyTargetHours: 'Hours required per month when targetMode is "fixed".',
  targetMode: '"fixed" = monthlyTargetHours every month; "workdays" = work days in the month x paid hours per day.',
  leaveReducesTarget: 'Annual leave, sick days and public holidays on work days lower the month target by one day of paid hours.',
  workDays: 'Days of the week with a normal shift (0 = Sunday ... 6 = Saturday). Other days only count standby call-outs.',
  usualStart: 'Usual start time (HH:MM). The clock-in reminder starts up to two hours before it.',
  breakTypes: 'Break buttons: { id, label, icon, paid }. Unpaid breaks are taken off worked time.',
  displayName: 'Name attached to shared records when a team backend is linked.',
  standbyEnabled: 'Show the standby rotation and call-out log.',
  standbyAnchor: 'First day (YYYY-MM-DD) of any one of your standby periods. The rotation repeats from it.',
  standbyEveryWeeks: 'Weeks between the start of one standby period and the next (usually the number of people on the rota).',
  standbyLengthDays: 'Days in one standby period.',
  calloutsCountTowardMonth: 'Count standby call-out and ticket time towards the monthly hours.',
  leaveWarningMinutes: 'Notify this many minutes before the shift is complete (0 = off).',
  notifyShiftDone: 'Notify when the shift is complete.',
  breakReminderMinutes: 'Notify when a break runs longer than this (0 = off).',
  clockInPrompt: '"off", "remind" (notification when the laptop is first used on a work day) or "auto" (clock in automatically then).',
  forgotClockOutHours: 'Remind if still clocked in this many hours after the shift ended (0 = off).',
  standbyReminderDays: 'Notify this many days before a standby period starts (0 = off).',
  badge: 'Toolbar badge: "remaining" (time to go home), "worked", "status" or "off".',
  trackActivity: 'Record how many minutes the laptop is actively used per day (minutes only, nothing about what was used).',
  idleMinutes: 'Minutes without keyboard or mouse input before the laptop counts as idle.',
};

export const SCHEMA = {
  workDays: { type: 'array', items: { type: 'integer' } },
  breakTypes: {
    type: 'array',
    items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, icon: { type: 'string' }, paid: { type: 'boolean' } } },
  },
};

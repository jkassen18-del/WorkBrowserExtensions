# Shift Clock

A personal time clock in the toolbar. Clock in, log breaks and smoke breaks, clock out. Shift Clock tracks your shifts
against the monthly target, tells you when it's almost time to go home and keeps your standby rota. Everything is stored
in this browser (`storage.local`). Nothing is sent anywhere unless your team links a backend under **Settings → Shared data**.

## What it does

- **One-click clock.** The popup shows a live timer, your home time and a progress bar for the day. It has **Clock in**,
  one button per break type (☕ Break, 🚬 Smoke break, 🍽️ Lunch by default), **End break** and **Clock out**.
  If you forgot to press it, *Record an earlier time* clocks in, out or starts a break at a time you pick. **Undo** removes the last entry.
- **9-hour shifts, 160-hour months.** A shift is 9 hours from clock-in to going home, and 60 minutes of breaks are included,
  so a normal day is 8 paid hours. Home time is *clock-in + 9h*. It only moves later when unpaid breaks (or time clocked out
  in the middle of the day) go over the 60 minutes. All of these numbers are settings.
- **Over / under.** The month target (160h by default, or *work days × 8h*) is spread evenly over the work days. The popup and
  Overview show how far ahead or behind you are, the hours each remaining day needs and where normal shifts would leave
  the month. Annual leave, sick days and public holidays lower the target. *Time off in lieu* comes out of your balance.
- **Almost-home reminder.** A notification 30 minutes before home time, another when the shift is complete (with a
  **Clock out now** button) and a nudge if you're still clocked in 2 hours later. Optional reminders: a break running long,
  a "Clock in?" prompt the first time the laptop is used on a work day (or automatic clock-in), and standby coming up.
- **Standby.** Pick the first day of any one of your standby weeks and how often the rota repeats (every 4 weeks by default).
  You'll see when you're on standby and when the next one starts. Swapped weeks can be skipped and extra weeks added by hand.
  Weekends have no 9-hour target. On standby you log each **📞 call**, **🎫 ticket** or **🛠️ on-site** visit with a start/stop
  timer and an optional ticket number. That time counts towards the month (this can be switched off).
- **History heatmap.** A GitHub-style grid of the last year. It can show *hours worked*, *over / under the day* or
  *laptop active time*. Standby days are outlined and leave is hatched. Hover a day for its details, or click it to edit.
- **Timesheet.** A month view with in/out, breaks per type, worked, standby, counted and +/− per day. It also has a day
  editor (entries, call-outs, day type, note and a "Normal shift" filler), **CSV export** and print.
- **Laptop activity (optional).** It counts the minutes the laptop is actively used (keyboard/mouse, via `chrome.idle`) per day
  and per hour, similar to ActivTrak but storing only the minutes. No sites, apps or screenshots are recorded. This is useful for
  colleagues who spend the day at the laptop. It never changes your hours unless you choose automatic clock-in.
- **Toolbar badge.** It shows the time left until home time (`1:45`, `30m`, then `+15m` when you stay late), `BRK` on a break
  and `CALL` during a standby call-out.

## Using it with no setup

1. Load the extension (see the top-level README) and pin the clock icon to the toolbar.
2. Press **Clock in**. Use the break buttons through the day and **Clock out** when you leave.
3. Optional: open **Settings → Standby** and set the first day of one of your standby weeks.
4. Optional: open **Settings → Schedule** to change the shift length, the included breaks, work days or the monthly target.

Days before you installed it are left out of that month's target. Add them in the timesheet if you want them counted.

## How the numbers work

| | |
| --- | --- |
| Worked | Time clocked in minus unpaid breaks (mark a break type *Paid* to keep it in) |
| Counted | Worked plus standby call-outs (if *Count call-out time towards my monthly hours* is on) |
| Paid hours per day | `shiftHours − breakAllowanceMinutes` (9h − 60m = 8h) |
| Home time | `first clock-in + paid hours + max(break allowance, time off the clock so far)` |
| Month target | `fixed`: `monthlyTargetHours` minus 8h for each leave/sick/holiday work day. `workdays`: work days × 8h |
| Over / under so far | Counted on finished days minus `target × finished work days ÷ work days in the month` |

A day you forgot to clock out of is counted up to the end of a normal shift and flagged in the popup and the timesheet
until you fix it. Clock-outs after midnight stay with the day of the clock-in.

## Data

| Key (`storage.local`) | Contents |
| --- | --- |
| `tkDays` | `{ "YYYY-MM-DD": { events: [{ type: in/out/break/resume, kind, at }], callouts: [...], status, note } }` |
| `tkStandby` | Manual standby periods and skipped rota weeks |
| `tkActivity` | Active minutes per day and per hour (kept about 13 months) |
| `tkSince`, `tkFlags` | Install day and which reminders were already shown |

**Backup & policy → Export backup** saves all of it as one file. With a backend linked, **Sync now** sends one record per
day for the last 90 days to the `timesheet` collection (`person`, `date`, clock in/out, worked/break/call-out/counted minutes, standby).

## Policy

Every setting in `defaults.js` can be suggested or enforced. A team lead can use this to roll out the same shift, target
and rota anchor to everyone. Examples: `shiftHours`, `breakAllowanceMinutes`, `monthlyTargetHours`, `targetMode`, `workDays`,
`breakTypes`, `standbyAnchor`, `standbyEveryWeeks`, `leaveWarningMinutes`, `clockInPrompt`, `trackActivity`. See `schema.json`.

Permissions: `storage`, `unlimitedStorage`, `alarms` (one-minute tick for the badge and reminders), `idle` (laptop activity
and the clock-in prompt) and `notifications`. Host access is requested only when a shared backend is saved.

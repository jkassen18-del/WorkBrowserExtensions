# SaaS Usage Reporter

Shows which SaaS apps you use and for how long, which paid licences nobody opens, and which
unapproved tools are in use. Works on its own: install it and keep working. Everything is stored in
this browser (`storage.local`) and nothing is sent anywhere unless you turn on reporting **and** link a backend.

## What it does

- **Recognises 640+ SaaS apps by domain** (`catalog.js`): Slack, Google Workspace, Microsoft 365, Jira & Confluence
  (`atlassian.net`), GitHub, Figma, Notion, Salesforce, Zoom, ChatGPT, Claude and many more in 20 categories. A host matches
  an app when it equals one of the app's domains or ends with `.<domain>`; the most specific domain wins
  (`sign.dropbox.com` is Dropbox Sign, `dropbox.com` is Dropbox). You can add custom apps.
- **Measures active time.** Time counts only while a known app is the active tab of the focused window and you are not idle.
  A *visit* is navigating into the app, or coming back to it after a 30 minute break.
- **Stores daily totals only:** `usage[YYYY-MM-DD][appId] = { seconds, visits }`. Never URLs, paths, titles or page content.
  Other websites are ignored completely. Old days are deleted after the retention period (90 days by default).
- **Dashboard** (toolbar popup → *Open dashboard*): 7/30/90 day range, stat cards (apps used, active time, unapproved apps used,
  unused licences), daily activity chart, time by category, searchable/filterable top apps table with one-click approval status,
  unused licences, unapproved apps used, CSV export.
- **Approvals:** mark any app as Approved, Neutral or Not approved. The popup warns when you are in a not-approved app.
- **Licences:** record paid apps with optional seats, monthly cost and owner. A licence is *unused* when its app was not opened
  for `unusedAfterDays` (30 by default).
- **Popup:** the current site's app with its status and today's time, today's top 5 apps, a pause switch and the dashboard button.

## Using it with no setup

1. Install the extension. The welcome page opens.
2. Keep working. After a minute in Slack, Google Docs, etc. the popup shows today's time.
3. Open **Settings → Overview → Load demo data** to see a populated dashboard right away. *Remove demo data* restores
   everything it added (sample approvals and licences are only added to empty lists).

## How tracking works

The background script listens to `tabs.onActivated`, `tabs.onUpdated`, `windows.onFocusChanged` and `idle.onStateChanged`,
plus a one-minute `alarms` tick. On each event it commits the elapsed time of the running stretch and starts a new one.
The running stretch (app + start time) is kept in `storage.session` (or `storage.local` where unavailable) so it survives
the service worker being stopped. A single stretch never commits more than 5 minutes, so a computer that went to sleep does
not count as usage. When the user goes idle the idle threshold is subtracted.

Permissions: `storage`, `unlimitedStorage`, `tabs` (to read the active tab's domain), `idle`, `alarms`. Host permissions are
only requested (optional) when a shared-data backend is linked.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Record usage. Can be paused from the popup. |
| `retentionDays` | `90` | Days of daily totals kept. |
| `idleSeconds` | `120` | Stop counting after this many seconds without input (min 15). |
| `excludedDomains` | `[]` | Domains never recorded (subdomains included). |
| `approvedApps` / `unapprovedApps` | `[]` | App ids (see `catalog.js`). |
| `licences` | `[]` | `[{ id, appId, seats, costPerMonth, owner }]` |
| `customApps` | `[]` | `[{ id, name, domains: [...], category }]` |
| `unusedAfterDays` | `30` | Licence counts as unused after this many days without use. |
| `currency` | `"USD"` | Currency for licence costs. |
| `reportingEnabled` | `false` | Allow sending anonymous totals to the linked backend. |
| `reportPeriodDays` | `7` | Days covered by each report; automatic reports are sent once per period. |

## Optional: reporting to IT

Off by default. To use it, link a backend under **Settings → Shared data** (webhook, REST or Supabase) and turn on
**Settings → Reporting**. The Reporting panel shows a preview of exactly what will be sent. Each report is pushed with
`push('saas-reporter', 'reports', report)` to the `reports` collection:

```json
{
  "id": "anon-3f9c…:2026-10-10:2026-10-16",
  "installId": "anon-3f9c…",
  "periodStart": "2026-10-10",
  "periodEnd": "2026-10-16",
  "generatedAt": "2026-10-16T09:12:00.000Z",
  "apps": [{ "appId": "slack", "name": "Slack", "seconds": 18234, "visits": 41, "days": 5 }]
}
```

The install id is random and not tied to the user, account or device. Demo data is never reported. With *Sync
automatically* on, the hourly sync also sends a report when one is due; **Send report now** sends immediately.
For Supabase, create table `wx_reports` (the SQL is shown under Shared data).

## Policy example

Chrome/Edge (`3rdparty → extensions → <id> → policy`) or Firefox `policies.json` (`3rdparty.Extensions`):

```json
{
  "approvedApps": ["slack", "google-docs", "gmail", "jira", "github", "figma", "zoom"],
  "unapprovedApps": ["wetransfer", "dropbox", "mega"],
  "excludedDomains": ["linkedin.com"],
  "defaults": { "retentionDays": 180, "unusedAfterDays": 45, "currency": "EUR" },
  "reportingEnabled": true,
  "connection": { "type": "webhook", "url": "https://hooks.example.com/saas-usage" }
}
```

Top-level keys are enforced (locked in the UI); keys under `defaults` are suggestions the user can change.

Note: `licences` and `customApps` are lists of objects. The generated Chrome/Edge `schema.json` currently types empty
arrays as string lists, so set those two through Firefox policy or the Backup panel's restore until the shared build
supports object schemas. Everything else works in all browsers.

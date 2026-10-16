# Environment Labeler

Makes it obvious which environment a tab is in (production, staging, development or your own), so nobody
changes production by mistake.

On a labelled tab you get:

- a **ribbon** in a corner, or a full-width **bar**, or a coloured **frame** around the page. Click it to hide it for a
  moment, or drag it to another corner.
- a **tab title prefix** such as `[PROD] Orders admin`
- a **tinted favicon** (the site icon with a coloured border and dot, or a coloured letter tile)
- a **toolbar badge** (`PROD`, `STG`, `DEV`…) in the environment colour
- an **"Are you sure?"** dialog before a form is submitted on environments that ask for it (Production by default),
  with "Don't ask again on this page for 10 minutes"

## Works with no setup

Install it and it already labels:

| Site | Label |
| --- | --- |
| `localhost`, `*.localhost`, `127.0.0.1`, `[::1]`, `*.local`, `*.test` | Development |
| host names with `staging`, `stage`, `stg`, `uat`, `qa`, `preprod` as a word (`staging.acme.com`, `api-qa.acme.com`) | Staging |
| any host with an explicit port (`intranet:8080`) | Development |

To label production, open the site, click the toolbar icon and pick **Label this site as → Production**. That adds a
rule for the host (with the port when there is one) at the top of your list. **Remove label** deletes that rule, or adds
a "No label" exception when a wider rule (such as the staging one) would still match.

Everything is stored in this browser (`storage.local`). Nothing is sent anywhere unless you add a remote rule file or link a
shared backend.

## Rules

Settings → **Rules** is an ordered list. The first enabled rule that matches wins. Reorder with drag and drop or the
arrows, toggle rules on and off, and use **Test a URL** to see which rule labels an address.

| Pattern | Matches |
| --- | --- |
| `app.example.com` | that host, any port |
| `*.example.com` | any subdomain (not `example.com` itself) |
| `*staging*` | wildcard anywhere in the host |
| `api.example.com:8443` | host and port; `*:*` = any host with a port |
| `https://example.com/admin*` | URL prefix, `*` = anything |
| `example.com/admin*` | host and path, any scheme |
| `/^https:\/\/.+\.corp\.net\//i` | regular expression tested against the full URL |

A rule's environment can be **No label** to make an exception.

## Environments

Settings → **Environments**: name, short tag, colour, text colour (automatic contrast or custom) and, per environment,
which indicators it shows and whether it asks before submitting forms. Defaults: Production (red, asks before
submitting), Staging (amber), Development (green), Demo (purple). Add as many as you like.

## Settings

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `rules` | built-in rules | Ordered rules `{ id, pattern, env, label, enabled }` |
| `environments` | Production, Staging, Development, Demo | `{ id, name, short, color, textColor, confirmSubmit, ribbon, titlePrefix, favicon, badge }` |
| `style` | `ribbon` | `ribbon`, `bar` or `frame` |
| `position` | `top-right` | `top-left`, `top-right`, `bottom-left`, `bottom-right` (the bar uses top or bottom) |
| `size` | `medium` | `small`, `medium`, `large` |
| `opacity` | `92` | Percent, 30-100 |
| `titleFormat` | `[{short}] ` | Placeholders `{short}`, `{name}`, `{label}` |
| `hideSeconds` | `60` | Click-to-hide duration (0 = until reload) |
| `showRibbon`, `showTitlePrefix`, `showFavicon`, `showBadge` | `true` | Global indicator switches |
| `confirmSubmit` | `true` | Global switch for the "Are you sure?" dialog |
| `ruleSources` | `[]` | URLs of remote rule files |
| `remoteRefreshHours` | `12` | Refresh interval for remote rule files (0 = manual) |
| `shareRules` | `false` | Push your own rules to the shared backend on sync |

The popup also has **Hide label on this tab**, which hides the ribbon, title prefix and favicon tint until the tab is
closed. The badge and the submit check stay on.

## Remote rule files (optional)

Settings → **Remote rules** takes the URL of a JSON file. The browser asks for permission to read that host when you
add it. Files are fetched on add, on browser start and every `remoteRefreshHours`. Their rules apply after your own
rules and are read-only. If a fetch fails, the last good copy keeps working and the error is shown.

Format (also what **Import / Export** produces). See [`examples/env-rules.json`](examples/env-rules.json):

```json
{
  "environments": [{ "id": "training", "name": "Training", "short": "TRN", "color": "#0EA5E9" }],
  "rules": [
    { "id": "crm-prod", "pattern": "crm.example.com", "env": "prod", "label": "CRM" },
    { "id": "staging-all", "pattern": "*.staging.example.com", "env": "staging" }
  ]
}
```

Environments in the file are added only when you don't already have one with that `id`. A bare array of rules is also
accepted.

## Shared data (optional)

When a backend is linked under Settings → **Shared data**, every sync pulls the `env-rules` collection and shows those
rules as a read-only "shared" source after your own. If **Share my rules** is on, your own rules (not the built-in ones)
are pushed first. Each pushed record carries `envName`, `envColor` and `envShort` so teammates without that environment
still see the right colour.

## Policy example

Enforce production hosts for everyone and make the frame style the default (Chrome/Edge
`3rdparty → extensions → <id> → policy`, or Firefox `policies.json → 3rdparty → Extensions → <id>`):

```json
{
  "defaults": { "style": "frame", "position": "top-left" },
  "ruleSources": ["https://intranet.example.com/env-rules.json"],
  "confirmSubmit": true
}
```

A rule file set by policy is fetched without a permission prompt, so its server must allow cross-origin requests
(`Access-Control-Allow-Origin: *`). You can also lock the whole rule list with a top-level `"rules": [...]`, but users
then can't add their own labels, so a remote rule file is usually the better choice.

## Permissions

`storage`, `unlimitedStorage`, `alarms` (remote refresh, sync), `activeTab` (the popup reads the current tab's address),
`scripting` (labels tabs that were already open when the extension was installed or updated) and a content script on
all pages (to draw the label). Remote rule files and a shared backend use optional host permissions, asked for when you
add them.

## Files

- `rules.js`: rule matcher shared by the background and the Settings page
- `content/indicator.js`: ribbon/bar/frame and favicon renderer, shared by the content script and the Settings previews
- `content/content.js`: in-page label, title prefix, favicon tint, submit check, SPA URL tracking
- `background.js`: matching, badges, tab hide, snooze, remote rule files, shared sync

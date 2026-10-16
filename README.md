# Workplace browser extensions

Five branded extensions for Chrome, Edge and Firefox, built from one Manifest V3 codebase.

**Plug and play.** Load an extension, open it and add your own links, rules and settings. You don't need a server, an account or any setup.
Everything is stored in your browser, for you only. When a team later wants shared data, link a database
or webhook under **Settings → Shared data**. Until then, nothing leaves the browser.

| Extension | What it does | Docs |
| --- | --- | --- |
| **Ticket Snap** | Screenshots the tab and lets you annotate it (arrows, boxes, highlights, redaction, crop). It attaches browser/OS diagnostics automatically and creates a ticket. Tickets are saved in *My tickets*, where you can download, copy or email them. Optionally they can also go to Jira Service Management, Zendesk, Freshdesk, ServiceNow or a webhook. | [ticket-snap/](browser-extensions/ticket-snap/) |
| **Data Leak Guard** | Detects card numbers, national ID numbers, secrets/API keys, "Confidential" markers and custom patterns when they are pasted, dropped, uploaded or submitted to unapproved sites (AI chatbots, personal email, file sharing). It then warns or blocks. Content never leaves the browser. | [dlp-guard/](browser-extensions/dlp-guard/) |
| **SaaS Usage Reporter** | Records which SaaS apps you use (by domain only) against a catalog of about 330 apps. A dashboard shows approved, unapproved and unused-licence apps. Reporting anonymous totals is optional. | [saas-reporter/](browser-extensions/saas-reporter/) |
| **Environment Labeler** | Red/amber/green ribbons, tinted favicons, title prefixes, toolbar badges and an "are you sure?" before you submit forms on production. Works on localhost right away. You can label any site from the popup. | [env-labeler/](browser-extensions/env-labeler/) |
| **Go-Links** | Type `go/payroll`, `go/vpn` or `go/jira/ABC-123` in the address bar. Add your own links in seconds. A searchable directory doubles as an onboarding hub. Shared link lists are optional. | [go-links/](browser-extensions/go-links/) |

## Quick start

Requires Node 18+. You don't need `npm install`: the build has no dependencies.

```bash
cd browser-extensions
npm run build          # builds all 5 extensions for chrome, edge and firefox
```

Then load an unpacked build:

| Browser | How |
| --- | --- |
| Chrome | `chrome://extensions` → enable **Developer mode** → **Load unpacked** → `dist/chrome/<extension>` |
| Edge | `edge://extensions` → enable **Developer mode** → **Load unpacked** → `dist/edge/<extension>` |
| Firefox | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `dist/firefox/<extension>/manifest.json` |

A welcome page opens on install with three or four getting-started steps. Store-ready zips are written next to each
folder (`dist/<browser>/<extension>-<version>.zip`).

### Try each one

- **Ticket Snap.** Click the toolbar icon (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>) on any page, annotate it, then **Create ticket**. It shows up under **My tickets**.
- **Data Leak Guard.** Open an AI chatbot such as chatgpt.com and paste `4111 1111 1111 1111` into the message box.
- **SaaS Usage Reporter.** Browse a few SaaS sites, then open the dashboard from the popup. **Settings → Overview → Load demo data** fills it with sample data.
- **Environment Labeler.** Open any `http://localhost:<port>` page to see the DEV label, or open your production site and pick **Production** in the popup.
- **Go-Links.** Open the popup on any page and choose **Create link**, or use **Settings → My links → Add**. Then type `go/<name>` in the address bar, or `go` + <kbd>Space</kbd> + `<name>`.

## Data and sharing

| | Default | Optional, later |
| --- | --- | --- |
| Where data lives | `storage.local` in the user's browser | Plus a linked backend |
| Who sees it | Only the user | The team, through the backend |
| Setup | None | **Settings → Shared data** |

**Settings → Shared data** in every extension offers these options:

- **Local only** (default). Nothing is sent anywhere.
- **Webhook.** Each new record is POSTed as JSON to a URL (Zapier, Make, n8n, Power Automate, Slack workflow…).
- **REST / JSON API.** `GET {url}/{collection}` returns a JSON array of records, and `POST {url}/{collection}` sends an array of records to the API.
- **Supabase (Postgres).** One table per collection (`id text primary key, data jsonb, updated_at timestamptz`). The panel shows the SQL.

The extension asks the browser for access to that one host only when a connection is saved. Go-Links and Environment
Labeler can also read shared lists from plain JSON files hosted anywhere (intranet, SharePoint, GitHub raw).
**Backup & policy → Export backup / Restore** moves a user's data between browsers without any backend.

New adapters live in `browser-extensions/shared/connections.js`. Extensions only call `push()` and `pull()`.

## Branding (per company)

Every page, popup, in-page dialog and toolbar icon takes its look from the brand kit.

```jsonc
// browser-extensions/brand/brand.json
{
  "companyName": "Acme Inc.",
  "productPrefix": "Acme",              // store name becomes "Acme Go-Links"
  "logo": "logo.svg",                   // path relative to this file (SVG/PNG), URL or data: URI
  "primary": "#4F46E5",                 // buttons, highlights and toolbar icon colour
  "accent": "#0EA5E9",                  // gradients and secondary actions
  "theme": "auto",                      // auto | light | dark
  "radius": 10,                         // corner roundness in px
  "supportUrl": "https://intranet.acme.example/it-help",
  "supportEmail": "it-help@acme.example",
  "footerText": "Managed by Acme IT",
  "extensionIdDomain": "acme.example"   // Firefox add-on IDs become <extension>@acme.example
}
```

There are three ways to apply a brand:

1. **At build time.** Edit `brand/brand.json` or pass another kit:
   `node tools/build.mjs --brand brand/examples/summit-logistics.json` (two sample kits are included). Icons are re-coloured automatically.
2. **In the UI.** Every extension has **Settings → Branding** with a live preview, logo upload, colour presets and theme.
   It can export the result as a brand kit file to drop into `brand/brand.json`.
3. **By policy.** Push a `brand` object (or just some of its fields). Enforced fields are locked in the UI.

## Managing with policy (optional)

Every extension reads `storage.managed`, which is set through Chrome or Edge policy, macOS profiles or Firefox `policies.json`:

- keys inside `defaults` are suggestions that users can change
- `brand` and `connection` set the brand kit and the shared-data backend
- every other key is enforced and shows as **Managed** (locked) in Settings

Each extension's `schema.json` (generated from its `defaults.js`) documents its keys. **Settings → Backup & policy → Generate policy**
turns a configured browser into ready-to-deploy JSON. See [`examples/policies/`](browser-extensions/examples/policies/) for Windows
registry, macOS, Linux and Firefox examples and for force-installing the extensions.

## Repository layout

```
browser-extensions/
├── brand/                 brand kit (brand.json + logo) and example kits
├── shared/                shared UI, settings/policy layer, branding, shared-data connections (see shared/README.md)
├── ticket-snap/  dlp-guard/  saas-reporter/  env-labeler/  go-links/
├── examples/policies/     enterprise policy examples
├── tools/
│   ├── build.mjs          builds dist/<browser>/<extension> + zips, generates brand icons and schema.json
│   ├── check.mjs          syntax check + full build with reference validation (npm run check)
│   └── screenshot.mjs     headless Chromium screenshots of any extension page (needs Playwright)
└── dist/                  build output (git-ignored)
```

How the build handles each browser:

- **Chrome and Edge.** The manifest is used as is, plus `storage.managed_schema`.
- **Firefox.** The service worker becomes `background.scripts`, and the build adds a gecko ID (`<extension>@<extensionIdDomain>`) and a
  `strict_min_version` of 128. It also removes keys Firefox doesn't support.
- **Per-browser differences.** Anything else that differs lives under `browser_overrides` in each `manifest.json`.

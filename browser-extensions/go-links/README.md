# Go-Links

Short links like `go/payroll`, `go/vpn` and `go/jira/ABC-123`. You install the extension, add your own links, and they work right away. No server, account or setup is needed. Teams can share lists later if they want to.

## Using it with no setup

1. Open **Settings → My links** (it opens on install) and click **+ Add link**: name `payroll`, URL `https://payroll.example.com`.
2. Open it in any of these ways:
   - **Address bar:** type `go/payroll` and press Enter.
   - **Omnibox keyword:** type `go`, press Space or Tab, then type `payroll`. As you type, you get up to 6 suggestions matched against name, title, tags and description.
   - **Toolbar popup** (`Alt+G`): search, then press Enter to open the top result.
   - **Directory page:** a searchable list of every link.
3. To save the page you are on, click the toolbar icon and use **Create a go-link for this page**. The URL and title are filled in, and the name field tells you whether the name is free.

If you open a go-link that doesn't exist, a branded page says **"go/xyz doesn't exist yet"**. It lists the closest matches and has a form to create the link, with the name already filled in. When you save, it redirects you. Redirects use `location.replace`, so the Back button skips the resolver page.

## Link features

| Feature | Example |
| --- | --- |
| `%s` template | `jira` → `https://acme.atlassian.net/browse/%s`, so `go/jira/ABC-123` opens `…/browse/ABC-123` |
| Positional placeholders | `pr` → `https://github.com/acme/{1}/pull/{2}`, so `go/pr/website/42` opens that pull request. `{*}` is the whole rest of the path. |
| Path append | `docs` → `https://docs.example.com`, so `go/docs/setup` opens `https://docs.example.com/setup` |
| Query passthrough | `go/wiki?search=vpn` adds `search=vpn` to the destination |
| Longest match | `go/team/eng/wiki` tries `team/eng/wiki`, then `team/eng`, then `team` |
| Aliases | `payroll` with aliases `pay, payslip` |
| Case-insensitive | `go/Payroll` = `go/payroll`. Only the name part is matched without case; the extra path keeps its case. |
| Stats | Visits and last-used time are counted for each link and shown as **Popular** in the directory |

Names use lowercase letters, numbers and `- _ . /`.

## Settings panels

- **My links:** a table with search, add/edit dialog, bulk delete, import (JSON or CSV), and export to JSON or CSV. CSV columns are `name,url,title,description,tags,aliases,owner,clicks`, with tags and aliases separated by `;`.
- **Sources:** optional read-only link lists. You can add, edit, enable or disable, refresh and remove them. The panel shows each list's status and link count, and a table of name conflicts. It also has one-click **example lists** (`examples/company-links.json`, `examples/engineering-links.json`).
- **Directory:** counts and a button that opens `directory/directory.html`. That page is searchable and has filter chips for each list or department and for tags. It has **Popular**, **New** (last 30 days) and **onboarding** sections, the onboarding one showing links tagged `onboarding`. Each link has copy and open buttons, and your own links can be edited and deleted from the page.
- **Behaviour:** omnibox help, the address-bar capture toggle, case-insensitive matching, new tab vs current tab, refresh interval, and sharing.
- The shared **Branding**, **Shared data**, **Backup & policy** and **About** panels.

| Setting | Default | Meaning |
| --- | --- | --- |
| `captureAddressBar` | `true` | Catch `go/…` typed in the address bar (see below) |
| `openInNewTab` | `false` | The popup and directory open links in a new tab |
| `caseInsensitive` | `true` | `go/Payroll` = `go/payroll` |
| `refreshHours` | `6` | How often source lists are downloaded again (alarm) |
| `sharePersonalLinks` | `false` | Upload your own links when a backend is linked |
| `sourceUrls` | `[]` | List URLs added for everyone. They can't be removed in the UI. |

## How the address bar works

- `http(s)://go/<path>` is redirected to `resolver/resolve.html#<path>` by a **dynamic** declarativeNetRequest rule. It's dynamic because the target includes the extension's own URL, which is only known at runtime.
- When the browser turns `go/payroll` into a web search, the static ruleset `rules.json` (`go_capture`) catches it. It covers queries that are **exactly** `go/<something>` on Google (google.com, .co.uk, .ca, .de, .fr, .com.au, .co.in), Bing, DuckDuckGo, Yahoo, Ecosia and Brave Search, and sends them to `http://go/<something>`. The dynamic rule then sends that to the resolver.
- The **Behaviour → Address bar** toggle turns the ruleset on or off (`updateEnabledRulesets`) and adds or removes the dynamic rule.
- Host permissions are kept narrow: `*://go/*` plus those search hosts. Google regional domains not in that list still work through the omnibox keyword and the popup.
- **Firefox:** declarativeNetRequest works the same way, but Firefox may treat host permissions as optional. If so, the Behaviour panel shows a **Grant access** button. Until access is granted, use the `go` keyword or the popup.

## Optional: shared link lists

A source is any JSON file the browser can reach, for example on the intranet, SharePoint or a GitHub raw URL:

```json
{
  "name": "Company",
  "links": [
    { "name": "payroll", "url": "https://payroll.example.com", "title": "Payroll", "description": "Payslips", "tags": ["hr"], "aliases": ["pay"] },
    { "name": "jira", "url": "https://acme.atlassian.net/browse/%s", "title": "Jira" }
  ]
}
```

A plain array of links works too. When you add a list, the browser asks for access to that host. Lists are downloaded when added, when you click Refresh, and every `refreshHours` hours. Links from lists are read-only. Your own links with the same name override them, and both the Sources panel and the directory show these conflicts. Only `http(s)` and `mailto` destinations are accepted.

## Optional: shared database

Under **Settings → Shared data**, link a REST or Supabase backend. The extension syncs the collection `links`:

- **Pull:** shared records appear as the read-only source **Shared**.
- **Push:** your own links are uploaded only if `sharePersonalLinks` is on. It is off by default.

## Policy example

Chrome/Edge managed storage (`3rdparty → extensions → <id> → policy`) or Firefox `policies.json` → `3rdparty`:

```json
{
  "sourceUrls": ["https://intranet.example.com/go/company-links.json"],
  "defaults": { "openInNewTab": true },
  "captureAddressBar": true,
  "brand": { "companyName": "Acme Inc.", "primary": "#4F46E5" }
}
```

Keys at the top level are enforced and locked. Values under `defaults` are suggestions that people can change.

## Files

`background.js` handles the omnibox, address-bar rules, refresh alarm and sync. `lib/links.js` holds the data, resolving, search and sources. `lib/link-form.js` is the add/edit dialog. The pages are `resolver/`, `directory/`, `options/` and `popup/`. `rules.json` holds the static search-engine rules, and `examples/` holds the sample lists.

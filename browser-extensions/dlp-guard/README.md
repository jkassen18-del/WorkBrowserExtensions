# Data Leak Guard

Warns or blocks when sensitive data is about to leave the company through the browser. It covers card numbers, ID numbers, API keys, confidential documents and email lists that get pasted, dropped, typed and sent, or uploaded to AI chatbots, personal email, file-sharing and social sites.

**Content never leaves the browser.** All checks run locally in the page. Incidents store only metadata: the detector type, count, site, channel, action and time. They never contain the matched text, file names or file content.

## Use it with no setup

1. Install the extension. The welcome page opens, and protection is already on.
2. Paste `4111 1111 1111 1111` into a text box on chatgpt.com. A branded dialog shows what was found (`4111 •••• •••• 1111`). You can **Cancel** or **Paste anyway** and give an optional reason.
3. Add your company's own domains under **Settings → Sites → Approved sites** (or click **Approve this site** in the toolbar popup). Approved sites are never checked.
4. Review what was caught under **Settings → Activity**.

No account, server or policy is needed.

## What is checked

| Channel | How |
| --- | --- |
| Paste | Text, plus file names and the content of text files pasted from the clipboard |
| Drag & drop | Dropped text and files |
| File upload | `input[type=file]`: file names (markers, custom patterns, key files such as `id_rsa`, `.env` and `.pem`). Text-like files under 2 MB (txt, csv, json, md, log, env, pem, key, yaml, sql, …) are read and scanned. A blocked upload clears the input, so the page never sees the file. |
| Form submit | Visible text fields of the form. Password and hidden fields are ignored. |
| Chat message | Enter (or Ctrl/Cmd+Enter) in chat boxes and clicks on send buttons. The box is checked before the message is sent. |

All listeners run in the capture phase. Warn and block stop the event (`preventDefault` and `stopImmediatePropagation`). An allowed action is replayed: the text is re-inserted at the caret, or the submit, Enter, click, drop or upload event is re-dispatched. Text over 200 KB is truncated before scanning. The content script never throws into the page, and it only uses a closed Shadow DOM for its UI.

## Detectors

| Detector | Notes | Default mode |
| --- | --- | --- |
| Payment card | 13–19 digits with optional spaces or dashes, Luhn check, known IIN ranges (Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay, Maestro, Mir) | site |
| US SSN | `123-45-6789` / `123 45 6789`, or 9 digits after "SSN". Ranges 000, 666 and 9xx, group 00, serial 0000 and known sample numbers are excluded. | site |
| UK NINO | `AB 12 34 56 C`. Invalid prefixes are excluded. | site |
| Canadian SIN | `130 692 544` or after "SIN", Luhn check | site |
| IBAN | Country length table plus mod-97 checksum | site |
| Secrets | AWS access key ID, AWS secret key near a keyword, GitHub `ghp_`/`github_pat_`, Slack `xox[baprs]-`, Stripe `sk_live_`, Google `AIza…`, OpenAI-style `sk-…`, PEM private keys, JWTs, and `password=` / `api_key=` assignments | **block** |
| Confidentiality markers | Editable list: "Confidential", "Internal only", "Strictly private", "Do not distribute"… | site |
| Bulk emails | At least *N* different addresses (default 10) | site |
| Custom patterns | Your own regexes (name, pattern, flags, mode), with a live tester | per pattern |

Detector mode `site` follows the site category. `warn` means at least warn, and `block` means always block. **The stricter of the site mode and the detector mode wins.**

## Site categories

| Category | Default mode | Examples (editable) |
| --- | --- | --- |
| AI chatbots | warn | chatgpt.com, claude.ai, gemini.google.com, copilot.microsoft.com, perplexity.ai, deepseek.com, huggingface.co/chat, grok.com … |
| Personal email | warn | mail.google.com, outlook.live.com, mail.yahoo.com, proton.me, icloud.com/mail, gmx, aol … |
| File sharing | warn | wetransfer.com, dropbox.com, drive.google.com, onedrive.live.com, box.com, mega.nz, pastebin.com, gist.github.com … |
| Social & messaging | warn | web.whatsapp.com, web.telegram.org, discord.com, facebook.com, x.com, linkedin.com/messaging … |
| Other sites | monitor | everything else |
| Approved sites | never checked | your own domains |

An entry matches the host and its subdomains. Add a path (`linkedin.com/messaging`) to match only part of a site. The modes are `off`, `monitor` (log only), `warn` (dialog with **Cancel** or **… anyway** plus an optional reason) and `block` (dialog, no override).

## Pages

- **Activity**: weekly stats (warned, blocked, overridden, logged) and filters by date, category, result, data type and site. You can export CSV or JSON, or clear the log. Up to 500 incidents are kept (`maxIncidents`).
- **Sites**: categories, their modes and domain lists, approved sites, and a "Check a site" tool.
- **Detectors**: turn each detector on or off and set its mode, edit markers, set the email threshold, manage custom patterns, and choose which channels are checked.
- **Test**: paste sample text (or pick a file) and see what is found and what would happen on a given site. Nothing is logged.
- **Reporting**: optional incident reporting, dialog options (required reason, custom message), pause permission and a policy example.
- **Popup**: status for the current site (category and mode, or "approved"), **Approve this site**, today's counts and **Pause protection for 15 minutes** (hidden when `allowPause` is false).

## Settings (`defaults.js`)

`enabled`, `categoryModes` `{ai, email, files, social, other}`, `aiSites`, `emailSites`, `fileSites`, `socialSites`, `approvedSites`, `detectors` `{card, ssn, nino, sin, iban, secrets, markers, emails}: {enabled, mode}`, `markers`, `emailThreshold`, `customPatterns`, `checkPaste`, `checkDrop`, `checkUploads`, `checkSubmit`, `checkTyped`, `scanFileContents`, `maxFileSizeMB`, `requireJustification`, `dialogMessage`, `allowPause`, `maxIncidents`, `reportIncidents`.

## Optional: shared data and policy

Incidents can be collected centrally. Link a backend under **Settings → Shared data** (webhook, REST or Supabase) and turn on **Reporting → Report incidents**. Each incident is pushed with `push('dlp-guard', 'incidents', records)`. A record looks like this:

```json
{
  "id": "inc_3f9a12c0b7d4e581",
  "time": "2026-10-16T09:12:44.000Z",
  "domain": "chatgpt.com",
  "category": "ai",
  "channel": "paste",
  "action": "overridden",
  "detectors": [{ "id": "card", "label": "Payment card number", "count": 1, "kinds": ["Visa"] }],
  "files": 0,
  "justification": "Test card from the docs",
  "browser": "chrome"
}
```

Example managed policy (Chrome/Edge `3rdparty.extensions.<id>`, or Firefox `policies.json` → `3rdparty`):

```json
{
  "approvedSites": ["acme.com", "acme.sharepoint.com", "acme.atlassian.net"],
  "categoryModes": { "ai": "block", "email": "warn", "files": "warn", "social": "warn", "other": "monitor" },
  "detectors": {
    "card": { "enabled": true, "mode": "site" }, "ssn": { "enabled": true, "mode": "site" },
    "nino": { "enabled": true, "mode": "site" }, "sin": { "enabled": true, "mode": "site" },
    "iban": { "enabled": true, "mode": "site" }, "secrets": { "enabled": true, "mode": "block" },
    "markers": { "enabled": true, "mode": "warn" }, "emails": { "enabled": true, "mode": "site" }
  },
  "customPatterns": [{ "id": "cust", "name": "Customer ID", "pattern": "\\bCUST-\\d{6}\\b", "flags": "", "mode": "warn", "enabled": true }],
  "requireJustification": true,
  "allowPause": false,
  "reportIncidents": true,
  "connection": { "type": "webhook", "url": "https://hooks.example.com/dlp" }
}
```

Keys at the top level are enforced, and their controls show **Managed**. Put keys under `"defaults": { … }` to suggest values that users can still change.

## Limitations

- A browser extension is a guard rail, not a complete DLP system. It cannot see native apps, screenshots or other browsers, and a determined user can disable it unless it is force-installed.
- Pages that ignore synthetic (untrusted) events may need the user to repeat the action after **… anyway**.
- On Firefox, the user may need to allow access to all websites (the popup offers a button) before content checks run.

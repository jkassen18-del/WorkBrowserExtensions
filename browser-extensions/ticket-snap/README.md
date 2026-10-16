# Ticket Snap

Screenshot the current tab, mark it up, and turn it into a support ticket with browser and page
diagnostics attached. It works as soon as it is installed: no server, no account, no setup.
Tickets are saved in **My tickets** in this browser, where you can download, copy or email them.
Sending tickets to a help desk is optional and off by default.

## Use it (no setup)

1. Pin the extension: puzzle-piece icon → pin **Ticket Snap**.
2. On the page with the problem, click the toolbar button → **Capture this tab**, or press
   **Alt+Shift+S**. Use **Capture without screenshot** when the page shows something you would rather not share.
3. The editor opens in a new tab. Annotate the screenshot:
   - **Arrow**, **Box**, **Highlight** (see-through marker), **Redact** (solid box; the pixels underneath are gone in the saved image),
     **Pen** (freehand), **Text** and **Crop**
   - brand colour presets plus a custom colour, **Undo / Redo** (Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y) and **Clear**
   - keyboard: A arrow, R box, H highlight, X redact, P pen, T text, C crop
   - no screenshot (or a protected browser page)? Attach an image file or paste one with Ctrl+V
4. Fill in the summary, description, category, priority, your name and email (remembered for next time).
   Diagnostics are attached by default. Switch them off, or switch off just the page address, and open
   **View what is attached** to see exactly what is included.
5. Press **Save ticket**. The ticket appears in **Settings → My tickets**.

### My tickets

Each ticket shows a thumbnail, summary, date, destination and status (**Saved**, **Sent**, **Email drafted**
or **Not sent**). From the list or the detail view you can view the screenshot and diagnostics, download the
PNG, copy the ticket as text, open an email draft, retry or send it to the configured destination, and delete it.
**Export all (JSON)** downloads every ticket, including screenshots. The popup shows the ticket count and the last three tickets.

### Diagnostics collected

They are collected only for the tab you capture, at the moment you capture it: page URL and title, referrer,
time, browser name and version (User-Agent Client Hints when available), operating system, language and time zone,
screen size, viewport and device pixel ratio, approximate zoom, online status, cookies enabled, page load time,
requests that failed with HTTP 400 or higher (from the page's Resource Timing data, so no extra permissions are needed),
and the user agent. Console errors are not collected, because that would need access to every site all the time.

## Destinations (optional)

Pick one under **Settings → Destination**. Every ticket is always kept in My tickets as well. If sending fails,
the ticket is kept with status **Not sent** and a **Retry** button. When you save a remote destination,
the browser asks once for permission to reach that one site (`optional_host_permissions`). **Test connection** checks
the sign-in details without creating anything.

| Destination | What happens |
| --- | --- |
| My tickets (default) | Nothing leaves the browser. |
| Email | Opens a `mailto:` draft with the subject and body filled in, and downloads the annotated PNG so you can attach it. The address defaults to the brand's `supportEmail`. |
| Webhook | `POST` JSON `{ source, sentAt, ticket, screenshot: { filename, contentType, base64 } }` with optional `Authorization: Bearer <token>`. If the response JSON has `id`/`key` and `url`, they are shown on the ticket. |
| Jira Service Management / Jira | With a service desk id and request type id, it creates a customer request (`/rest/servicedeskapi/request`) and attaches the screenshot through a temporary file. Otherwise it creates an issue in the project key (`/rest/api/3/issue`) and attaches the screenshot to it. Signs in with the account email and an API token. |
| Zendesk | Uploads the screenshot (`/api/v2/uploads`) and creates a ticket with it attached. Uses `email/token` authentication. |
| Freshdesk | Creates a multipart ticket with the screenshot as an attachment. Uses API key authentication. Needs a requester email. |
| ServiceNow | Creates an incident (Table API) and attaches the screenshot (Attachment API). Uses basic authentication. Priority is mapped to urgency and impact. |

Sign-in details are stored in this browser's extension storage and are sent only to the chosen service.
For a whole team, IT can set them by policy (see below). A service account with "create ticket" rights is a good fit.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `destination` | `"local"` | `local`, `email`, `webhook`, `jira`, `zendesk`, `freshdesk` or `servicenow` |
| `helpdeskEmail` | `""` | Email destination address (empty uses the brand support email) |
| `webhookUrl`, `webhookToken` | `""` | Webhook destination |
| `jiraSite`, `jiraEmail`, `jiraToken` | `""` | Jira Cloud site and API credentials |
| `jiraServiceDeskId`, `jiraRequestTypeId` | `""` | Jira Service Management request (preferred when both are set) |
| `jiraProjectKey`, `jiraIssueType` | `""`, `"Task"` | Plain Jira issue |
| `zendeskSubdomain`, `zendeskEmail`, `zendeskToken` | `""` | Zendesk |
| `freshdeskDomain`, `freshdeskApiKey` | `""` | Freshdesk |
| `servicenowInstance`, `servicenowUser`, `servicenowPassword` | `""` | ServiceNow |
| `categories` | 5 common categories | Category menu in the ticket form |
| `defaultPriority` | `"normal"` | `low`, `normal`, `high` or `urgent` |
| `requiredFields` | `["summary"]` | Any of `summary`, `description`, `category`, `requesterName`, `requesterEmail` |
| `requesterName`, `requesterEmail` | `""` | Prefilled requester |
| `rememberRequester` | `true` | Remember what was typed in the form |
| `includeDiagnostics` | `true` | Attach diagnostics by default |
| `includeUrl` | `true` | Include page URL, referrer and failed request URLs |
| `redactColor` | `"#000000"` | Redact tool fill colour |
| `maxTickets` | `50` | Tickets kept in My tickets (oldest removed first) |
| `keepScreenshots` | `true` | Keep full screenshots with saved tickets. Off keeps only a thumbnail. |
| `shareScreenshots` | `false` | Include screenshots in shared data |

## Shared data (optional)

When a backend is linked under **Settings → Shared data**, each saved or updated ticket is pushed with
`push('ticket-snap', 'tickets', record)`. **Sync now** pushes all of them. Screenshots and thumbnails are left out
unless `shareScreenshots` is on. With nothing linked, nothing is sent.

## Policy example

Suggest defaults that people can still change, and enforce the Zendesk destination for everyone:

```json
{
  "defaults": {
    "categories": ["Laptop or hardware", "Software or app", "Access or account", "Network or VPN", "Other"],
    "requiredFields": ["summary", "description"]
  },
  "destination": "zendesk",
  "zendeskSubdomain": "acme",
  "zendeskEmail": "ticket-bot@acme.com",
  "zendeskToken": "<api token>",
  "includeUrl": true,
  "maxTickets": 100
}
```

Email-only setup (no credentials needed):

```json
{ "destination": "email", "helpdeskEmail": "helpdesk@acme.com" }
```

Policy can set the destination and credentials, but it cannot grant host permissions. The first time a ticket is sent,
the browser asks the user once to allow access to that one site.

## Permissions

`storage`, `unlimitedStorage` (tickets and screenshots stay local), `activeTab` + `scripting` (capture and read
diagnostics from the tab you capture, only when you ask), `alarms` (optional hourly shared-data sync).
Host access is optional and only requested for the help desk you configure.

## Known limitations

- Only the visible part of the page is captured, not the full scrolling page.
- Browser pages (settings, new tab, extension stores) cannot be captured or read. Attach an image instead.
- Some help desks reject requests that come from a browser extension origin. If **Test connection** shows a
  CORS/XSRF style error, use the webhook destination with a small relay (Zapier, Make, Power Automate) instead.
- `mailto:` cannot attach files, so the screenshot is downloaded for you to attach by hand. Long ticket texts are shortened in the email.

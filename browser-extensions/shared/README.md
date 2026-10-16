# shared/

Everything the five extensions have in common. The build copies this folder into every
extension as `/shared/`, so extension pages import it with absolute paths
(`import { h } from '/shared/ui.js'`) and the background script with `./shared/...`.

There is no bundler and no npm dependencies. Pages, popups and the background script are ES modules.
Content scripts are classic scripts and cannot import anything. They ask the background for what they need.

| File | What it gives you |
| --- | --- |
| `api.js` | `api` (the `browser` or `chrome` global), `url(path)`, `send(message)`, `uid()` |
| `settings.js` | `createSettings(DEFAULTS)` builds the policy-aware settings object. `createCollection(key)` gives you a list of records in `storage.local`. `readManaged()` reads policy. |
| `brand.js` | Loads the brand kit (bundled `brand.json` < user override < policy), `applyBrand()`, `productName()`, `logoSrc()`, `contrastText()` |
| `connections.js` | Optional shared backend (none, webhook, REST or Supabase): `push(source, collection, records)`, `pull(collection)` |
| `background-kit.js` | `startBackground({ glyph, settings, onSync, welcome })` and `handleMessages({ type: fn })` |
| `app-shell.js` | `mountApp()` builds the Settings app with the shared Branding, Shared data, Backup & policy and About panels. `mountPopup()` builds the popup frame. `brandPage()` brands any other page. `field()` gives you form controls bound to settings. |
| `ui.js` | `h()` element builder, `add()`, `clear()`, `toast()`, `modal()`, `confirmDialog()`, `download()`, `pickFile()`, `copyText()`, `toggle()`, `formatDate()`, `timeAgo()`, `debounce()` |
| `ui.css` | Design tokens and components: `.card`, `.btn(.primary/.danger/.ghost/.sm)`, `.table`, `.badge(.ok/.warn/.danger/.primary)`, `.field`, `.switch`, `.notice`, `.grid`, `.row`, `.stack`, `.tabs`, `.empty`, `.stat`, popup classes. Light and dark mode are included. |
| `icon.js` | Toolbar icon rasterizer used by the build (PNG) and at runtime (re-colours the icon to the brand) |

## Local-first

Every extension works by itself with no server and no account. Data lives in `storage.local`
(each extension has the `unlimitedStorage` permission). A backend only enters the picture when the user or IT
saves a connection under **Settings → Shared data**. Until then `push()` returns `{ ok: true, skipped: true }`
and `pull()` returns `null`.

## Anatomy of an extension

```
my-extension/
├── manifest.json      MV3. "name" is the base name (the build adds the brand prefix). "wx": { "glyph": "..." }
├── defaults.js        export default { ...every setting with its default... }  (+ optional export const DESCRIPTIONS)
├── settings.js        import DEFAULTS from './defaults.js'; export const settings = createSettings(DEFAULTS)
├── background.js      module; calls startBackground()
├── options/options.html + options.js   mountApp({ baseName, tagline, settings, panels, syncCollections, welcomeSteps })
├── popup/popup.html + popup.js         mountPopup(baseName)
├── content/…          classic scripts (optional)
└── README.md
```

The build generates `schema.json` (the Chrome/Edge managed-storage schema) from `defaults.js`,
plus the icons and the per-browser manifest. Don't write those by hand.

## Policy

`storage.managed` keys:

- `defaults`: suggested values. The user can still change them.
- `brand`: enforced brand fields.
- `connection`: enforced shared-data backend.
- any key from `defaults.js`: enforced. The control is disabled and shows a **Managed** badge.

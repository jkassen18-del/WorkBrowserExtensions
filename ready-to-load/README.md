# Ready to load

Pre-built extensions you can install straight from this folder. No Node, no build step.

## Edge or Chrome

1. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome).
2. Turn on **Developer mode** (left sidebar in Edge, top right in Chrome).
3. Click **Load unpacked** and select a folder inside `edge-chrome/`, for example `edge-chrome/shift-clock`.
   Select the folder that contains `manifest.json`, not `edge-chrome/` itself.
4. Click the puzzle-piece icon in the toolbar and pin the extension so its button is always visible.

## Firefox

`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `firefox/<extension>/manifest.json`.

## Notes

- Do **not** load the folders under `browser-extensions/` (for example `browser-extensions/shift-clock`). Those are the source,
  without the shared code, and show only a "this is the source folder" message.
- These builds use the default brand kit. Change the name, logo and colours in each extension under **Settings → Branding**,
  or rebuild with your own kit: `cd browser-extensions && npm run ready -- --brand path/to/brand.json`.
- After changing the source, run `npm run ready` (in `browser-extensions/`) to refresh this folder. `npm run check` fails if you forget.

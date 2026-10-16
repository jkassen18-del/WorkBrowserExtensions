# Installing on every browser (optional)

For one person, loading the unpacked build is enough (see the main README).

**Chrome / Edge.** Publish to the Chrome Web Store / Edge Add-ons (unlisted is fine), or self-host the CRX,
then set `ExtensionSettings` (or `ExtensionInstallForcelist`) to `force_installed`. See `linux-chrome.json`
for the shape. The same keys exist under `HKLM\SOFTWARE\Policies\Google\Chrome` / `...\Microsoft\Edge` on Windows
and in the `com.google.Chrome` / `com.microsoft.Edge` preference domains on macOS.

**Firefox.** Sign the zip from `dist/firefox/` as an unlisted add-on on addons.mozilla.org, host the
`.xpi`, and add it to `ExtensionSettings` in `policies.json` (see `firefox-policies.json`).

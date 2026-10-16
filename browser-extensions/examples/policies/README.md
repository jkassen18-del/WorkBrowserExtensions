# Enterprise policy examples (optional)

The extensions work without any policy. Use these files only when IT wants to
pre-configure, lock or force-install them.

Every extension reads its policy from `storage.managed`:

- `defaults`: suggested values. Users can still change them.
- `brand`: brand kit fields (locked in **Settings → Branding**).
- `connection`: shared-data backend (`type`: `none` | `webhook` | `rest` | `supabase`, plus `url`, `token`, `tablePrefix`, `autoSync`).
- any other setting key: enforced and shown as **Managed** (locked).

In each extension, **Settings → Backup & policy → Generate policy** turns a configured browser
into the JSON for that extension. The keys of every extension are listed in `<extension>/schema.json`.

Replace `EXTENSION_ID` with the ID the store (or your self-hosted CRX) assigns to the extension.
On Firefox the ID is `<extension>@<extensionIdDomain>` from the brand kit, for example `go-links@acme.example`.

| File | Platform |
| --- | --- |
| `windows-chrome.reg` | Chrome on Windows (GPO / Intune can push the same keys) |
| `windows-edge.reg` | Microsoft Edge on Windows |
| `macos-chrome.mobileconfig` | Chrome on macOS (Jamf / Kandji / Intune profile) |
| `linux-chrome.json` | Chrome/Chromium on Linux: copy to `/etc/opt/chrome/policies/managed/` (Chromium: `/etc/chromium/policies/managed/`) |
| `firefox-policies.json` | Firefox on all platforms: `distribution/policies.json` next to the Firefox binary, or the matching GPO/plist |
| `force-install.md` | Installing the extensions on every browser |

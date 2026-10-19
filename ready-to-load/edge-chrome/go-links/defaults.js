// Every Go-Links setting with its default. Policy can suggest ("defaults") or enforce any of these keys.
export default {
  captureAddressBar: true,
  openInNewTab: false,
  caseInsensitive: true,
  refreshHours: 6,
  sharePersonalLinks: false,
  sourceUrls: [],
};

export const DESCRIPTIONS = {
  captureAddressBar: 'Catch go/name typed in the address bar (and searches for exactly "go/name") and open the link.',
  openInNewTab: 'Open links from the popup and the directory in a new tab instead of the current one.',
  caseInsensitive: 'Match link names regardless of upper/lower case (go/Payroll = go/payroll).',
  refreshHours: 'How often shared link lists are re-downloaded, in hours.',
  sharePersonalLinks: 'When a shared backend is linked, also upload this person\'s own links.',
  sourceUrls: 'Link-list URLs (JSON) added for everyone. They appear under Sources and cannot be removed by the user.',
};

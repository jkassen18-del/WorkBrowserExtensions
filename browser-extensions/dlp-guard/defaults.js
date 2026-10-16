// Every Data Leak Guard setting with its default. Works with no policy and no backend.
// Modes: "off" (not checked) | "monitor" (log only) | "warn" (dialog with override) | "block" (no override).
// Detector modes: "site" (use the site's mode) | "warn" (at least warn) | "block" (always block).
export default {
  enabled: true,

  categoryModes: {
    ai: 'warn',
    email: 'warn',
    files: 'warn',
    social: 'warn',
    other: 'monitor',
  },

  aiSites: [
    'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'aistudio.google.com',
    'notebooklm.google.com', 'copilot.microsoft.com', 'perplexity.ai', 'poe.com', 'character.ai',
    'deepseek.com', 'chat.mistral.ai', 'huggingface.co/chat', 'you.com', 'meta.ai', 'grok.com',
    'x.com/i/grok', 'pi.ai', 'chat.qwen.ai', 'kimi.com', 'phind.com',
  ],
  emailSites: [
    'mail.google.com', 'outlook.live.com', 'mail.yahoo.com', 'proton.me', 'mail.proton.me',
    'icloud.com/mail', 'gmx.com', 'gmx.net', 'gmx.de', 'mail.aol.com', 'app.tuta.com', 'mail.yandex.com',
  ],
  fileSites: [
    'wetransfer.com', 'dropbox.com', 'drive.google.com', 'onedrive.live.com', 'box.com', 'mega.nz', 'mega.io',
    'sendspace.com', 'mediafire.com', 'pastebin.com', 'gist.github.com', 'file.io', 'filebin.net',
    'justpaste.it', '4shared.com',
  ],
  socialSites: [
    'web.whatsapp.com', 'web.telegram.org', 'discord.com', 'facebook.com', 'messenger.com', 'instagram.com',
    'x.com', 'twitter.com', 'linkedin.com/messaging', 'reddit.com',
  ],
  approvedSites: [],

  detectors: {
    card: { enabled: true, mode: 'site' },
    ssn: { enabled: true, mode: 'site' },
    nino: { enabled: true, mode: 'site' },
    sin: { enabled: true, mode: 'site' },
    iban: { enabled: true, mode: 'site' },
    secrets: { enabled: true, mode: 'block' },
    markers: { enabled: true, mode: 'site' },
    emails: { enabled: true, mode: 'site' },
  },
  markers: ['Confidential', 'Internal only', 'Internal use only', 'Strictly private', 'Do not distribute'],
  emailThreshold: 10,
  customPatterns: [
    {
      id: 'example-codename',
      name: 'Project codename (example)',
      pattern: '\\bproject[ -]?orion\\b',
      flags: 'i',
      mode: 'warn',
      enabled: false,
    },
  ],

  checkPaste: true,
  checkDrop: true,
  checkUploads: true,
  checkSubmit: true,
  checkTyped: true,
  scanFileContents: true,
  maxFileSizeMB: 2,

  requireJustification: false,
  dialogMessage: '',
  allowPause: true,
  maxIncidents: 500,
  reportIncidents: false,
};

export const DESCRIPTIONS = {
  enabled: 'Turns Data Leak Guard on or off.',
  categoryModes: 'Mode per site category (ai, email, files, social, other): off, monitor, warn or block.',
  aiSites: 'AI chatbot sites. Entries match the host and its subdomains; "host/path" also matches a path prefix.',
  emailSites: 'Personal email sites.',
  fileSites: 'File sharing and paste sites.',
  socialSites: 'Social and messaging sites.',
  approvedSites: 'Approved sites (for example your company domains). They are never checked.',
  detectors: 'Per detector: enabled (true/false) and mode: site (use the site mode), warn (at least warn) or block (always block).',
  markers: 'Confidentiality phrases to look for (case-insensitive).',
  emailThreshold: 'Flag text that contains at least this many different email addresses.',
  customPatterns: 'Custom patterns: [{ id, name, pattern (regex), flags, mode (site|warn|block), enabled }].',
  checkPaste: 'Check text and files that are pasted.',
  checkDrop: 'Check text and files that are dragged and dropped.',
  checkUploads: 'Check files chosen in upload fields.',
  checkSubmit: 'Check forms when they are submitted.',
  checkTyped: 'Check chat boxes when a message is sent with Enter or the send button.',
  scanFileContents: 'Read text-like files (txt, csv, json, env, pem...) and scan their content.',
  maxFileSizeMB: 'Largest file whose content is scanned, in MB.',
  requireJustification: 'Require a reason before the user can continue past a warning.',
  dialogMessage: 'Extra text shown in the warning dialog (for example a link to the data policy).',
  allowPause: 'Allow users to pause protection for 15 minutes from the toolbar popup.',
  maxIncidents: 'How many incidents to keep in this browser.',
  reportIncidents: 'Send incident metadata (never the content) to the linked shared-data backend.',
};

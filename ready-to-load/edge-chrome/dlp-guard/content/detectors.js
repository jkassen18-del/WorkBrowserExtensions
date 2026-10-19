// Sensitive-data detectors for Data Leak Guard.
// Classic script: runs as a content script (before guard.js) and is imported for its side
// effect by the options page (Test tool, custom pattern tester). Everything is synchronous,
// runs locally, and never sends text anywhere. Matched values are only kept in memory so the
// page can mask them in the dialog; incidents store detector names and counts only.
(function () {
  'use strict';
  if (globalThis.WxDetectors) return;

  const MAX_TEXT = 200 * 1024; // characters scanned per check
  const MAX_VALUES = 50; // raw values remembered per finding (in memory only)
  const MAX_MATCHES = 2000; // safety cap per regex
  const DOT = '•';

  // ---------- helpers ----------
  function luhn(digits) {
    let sum = 0;
    let dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (d < 0 || d > 9) return false;
      if (dbl) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  function* matchAll(re, text) {
    re.lastIndex = 0;
    let m;
    let n = 0;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === '') re.lastIndex++;
      yield m;
      if (++n >= MAX_MATCHES) return;
    }
  }

  function maskMiddle(v, keepStart = 4, keepEnd = 4) {
    const s = String(v);
    if (s.length <= keepStart + keepEnd + 2) return s.length > 4 ? s.slice(0, 2) + DOT.repeat(4) : DOT.repeat(4);
    return `${s.slice(0, keepStart)}${DOT.repeat(4)}${s.slice(-keepEnd)}`;
  }

  function maskEmail(e) {
    const at = e.indexOf('@');
    if (at < 1) return maskMiddle(e, 1, 4);
    return `${e[0]}${DOT.repeat(3)}${e.slice(at)}`;
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ---------- payment cards ----------
  function cardBrand(d) {
    const L = d.length;
    const n2 = +d.slice(0, 2);
    const n3 = +d.slice(0, 3);
    const n4 = +d.slice(0, 4);
    const n6 = +d.slice(0, 6);
    if (d[0] === '4' && (L === 13 || L === 16 || L === 19)) return 'Visa';
    if (((n2 >= 51 && n2 <= 55) || (n4 >= 2221 && n4 <= 2720)) && L === 16) return 'Mastercard';
    if ((n2 === 34 || n2 === 37) && L === 15) return 'American Express';
    if ((n4 === 6011 || (n3 >= 644 && n3 <= 649) || n2 === 65 || (n6 >= 622126 && n6 <= 622925)) && L >= 16 && L <= 19) return 'Discover';
    if (n4 >= 3528 && n4 <= 3589 && L >= 16 && L <= 19) return 'JCB';
    if (((n3 >= 300 && n3 <= 305) || n2 === 36 || n2 === 38 || n2 === 39) && L >= 14 && L <= 19) return 'Diners Club';
    if (n4 >= 2200 && n4 <= 2204 && L >= 16 && L <= 19) return 'Mir';
    if (n2 === 62 && L >= 16 && L <= 19) return 'UnionPay';
    if ((n2 === 50 || (n2 >= 56 && n2 <= 69)) && L >= 13 && L <= 19) return 'Maestro';
    return null;
  }
  const CARD_RE = /(?<![\w.,/-])\d(?:[ -]?\d){12,18}(?![\w-]|[.,/]\d)/g;
  function scanCards(text, add) {
    for (const m of matchAll(CARD_RE, text)) {
      const raw = m[0];
      const d = raw.replace(/[ -]/g, '');
      if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d)) continue;
      // Separators, when used, must be consistent (avoid joining unrelated numbers).
      const seps = raw.match(/[ -]/g);
      if (seps && new Set(seps).size > 1) continue;
      if (/ {2,}|-{2,}/.test(raw)) continue;
      const brand = cardBrand(d);
      if (!brand || !luhn(d)) continue;
      add(d, `${d.slice(0, 4)} ${DOT.repeat(4)} ${DOT.repeat(4)} ${d.slice(-4)}`, brand);
    }
  }

  // ---------- US SSN ----------
  const SSN_RE = /(?<![\w-])(\d{3})([- ])(\d{2})\2(\d{4})(?![\w-])/g;
  const SSN_KW_RE = /\b(?:ssn|social\s+security(?:\s+(?:number|no\.?|#))?)\s*[:#=]?\s*(\d{3})-?(\d{2})-?(\d{4})\b/gi;
  const SSN_BLOCKED = new Set(['078051120', '219099999', '457555462']);
  function validSsn(a, g, s) {
    if (a === '000' || a === '666' || a[0] === '9') return false;
    if (g === '00' || s === '0000') return false;
    return !SSN_BLOCKED.has(a + g + s);
  }
  function scanSsn(text, add) {
    for (const m of matchAll(SSN_RE, text)) {
      if (validSsn(m[1], m[3], m[4])) add(m[1] + m[3] + m[4], `${DOT.repeat(3)}-${DOT.repeat(2)}-${m[4]}`);
    }
    for (const m of matchAll(SSN_KW_RE, text)) {
      if (validSsn(m[1], m[2], m[3])) add(m[1] + m[2] + m[3], `${DOT.repeat(3)}-${DOT.repeat(2)}-${m[3]}`);
    }
  }

  // ---------- UK National Insurance number ----------
  const NINO_RE = /\b(?!BG|GB|NK|KN|TN|NT|ZZ)([A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]) ?(\d{2}) ?(\d{2}) ?(\d{2}) ?([A-D])\b/g;
  function scanNino(text, add) {
    for (const m of matchAll(NINO_RE, text)) {
      add(m[1] + m[2] + m[3] + m[4] + m[5], `${m[1]} ${DOT.repeat(2)} ${DOT.repeat(2)} ${DOT.repeat(2)} ${m[5]}`);
    }
  }

  // ---------- Canadian SIN ----------
  const SIN_RE = /(?<![\w-])(\d{3})([- ])(\d{3})\2(\d{3})(?![\w-])/g;
  const SIN_KW_RE = /(?:\bSIN\b|\bsocial\s+insurance(?:\s+(?:number|no\.?|#))?)\s*[:#=]?\s*(\d{9})\b/gi;
  function sinOk(d) {
    return d.length === 9 && d[0] !== '0' && d[0] !== '8' && !/^(\d)\1+$/.test(d) && luhn(d);
  }
  function scanSin(text, add) {
    for (const m of matchAll(SIN_RE, text)) {
      const d = m[1] + m[3] + m[4];
      if (sinOk(d)) add(d, `${DOT.repeat(3)} ${DOT.repeat(3)} ${m[4]}`);
    }
    for (const m of matchAll(SIN_KW_RE, text)) {
      if (sinOk(m[1])) add(m[1], `${DOT.repeat(3)} ${DOT.repeat(3)} ${m[1].slice(-3)}`);
    }
  }

  // ---------- IBAN ----------
  const IBAN_LEN = {
    AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22,
    CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22,
    GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30,
    KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31,
    MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24,
    SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
  };
  const IBAN_RE = /\b([A-Z]{2})(\d{2})((?: ?[A-Z0-9]){11,30})\b/g;
  function ibanOk(iban) {
    const len = IBAN_LEN[iban.slice(0, 2)];
    if (!len || iban.length !== len) return false;
    const r = iban.slice(4) + iban.slice(0, 4);
    let mod = 0;
    for (const ch of r) {
      const code = ch.charCodeAt(0);
      const v = code >= 65 ? String(code - 55) : ch;
      for (const c of v) mod = (mod * 10 + (c.charCodeAt(0) - 48)) % 97;
    }
    return mod === 1;
  }
  function scanIban(text, add) {
    for (const m of matchAll(IBAN_RE, text)) {
      const full = (m[1] + m[2] + m[3]).replace(/ /g, '');
      // The greedy match may run into a following word; try trimming to the country length.
      const len = IBAN_LEN[m[1]];
      const cand = len && full.length >= len ? full.slice(0, len) : full;
      if (ibanOk(cand)) add(cand, `${cand.slice(0, 4)} ${DOT.repeat(4)} ${DOT.repeat(4)} ${cand.slice(-4)}`);
    }
  }

  // ---------- secrets / API keys ----------
  const SECRET_RULES = [
    { kind: 'Private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g, mask: () => '-----BEGIN … PRIVATE KEY-----' },
    { kind: 'AWS access key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
    { kind: 'AWS secret key', re: /(?:aws|secret)[\w ."'-]{0,30}?[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi, group: 1,
      test: (v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v) },
    { kind: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
    { kind: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,250}/g },
    { kind: 'Stripe secret key', re: /\b[sr]k_live_[A-Za-z0-9]{16,247}\b/g },
    { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
    { kind: 'OpenAI-style API key', re: /\bsk-(?:proj-|svcacct-|admin-|ant-(?:api\d\d-)?)?[A-Za-z0-9_-]{20,250}/g },
    { kind: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
    { kind: 'Password or key assignment',
      re: /\b(?:password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|db[_-]?pass(?:word)?)\b["']?\s*[:=]\s*["']?([^\s"'`,;<>]{6,200})/gi,
      group: 1,
      test: (v) => !/^(?:\*+|x+|•+|\.+|<.*>|\$\{.*\}|\{\{.*\}\}|%.*%|null|none|undefined|true|false|changeme|password|secret|example|redacted|your[_-].*|\$[A-Z_]+|process\.env.*|os\.environ.*)$/i.test(v) },
  ];
  function scanSecrets(text, add) {
    for (const rule of SECRET_RULES) {
      for (const m of matchAll(rule.re, text)) {
        const v = rule.group ? m[rule.group] : m[0];
        if (!v || (rule.test && !rule.test(v))) continue;
        add(v, rule.mask ? rule.mask(v) : maskMiddle(v, 4, 4), rule.kind);
      }
    }
  }

  // ---------- email addresses (bulk) ----------
  const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;

  // ---------- registry ----------
  const BUILTIN = [
    { id: 'card', label: 'Payment card number', scan: scanCards,
      description: 'Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay, Maestro. 13 to 19 digits, Luhn-checked.',
      example: '4111 1111 1111 1111' },
    { id: 'ssn', label: 'US Social Security number', scan: scanSsn,
      description: 'Written as 123-45-6789, or after "SSN". Impossible ranges (000, 666, 9xx) are ignored.',
      example: '536-22-8726' },
    { id: 'nino', label: 'UK National Insurance number', scan: scanNino,
      description: 'Two letters, six digits and a letter A to D, e.g. AB 12 34 56 C.',
      example: 'AB 12 34 56 C' },
    { id: 'sin', label: 'Canadian Social Insurance number', scan: scanSin,
      description: 'Nine digits in groups of three, or after "SIN". Luhn-checked.',
      example: '130 692 544' },
    { id: 'iban', label: 'IBAN bank account', scan: scanIban,
      description: 'International bank account numbers with a valid country length and mod-97 checksum.',
      example: 'DE89 3704 0044 0532 0130 00' },
    { id: 'secrets', label: 'Secret or API key', scan: scanSecrets,
      description: 'AWS keys, GitHub, Slack, Stripe, Google and OpenAI-style keys, private keys (PEM), JWTs, and password= / api_key= assignments.',
      example: 'ghp_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R' },
    { id: 'markers', label: 'Confidentiality marker', scan: null,
      description: 'Phrases such as "Confidential" or "Do not distribute". Edit the list below.',
      example: 'CONFIDENTIAL - do not distribute' },
    { id: 'emails', label: 'Bulk email addresses', scan: null,
      description: 'Lists of many different email addresses (customer or employee lists).',
      example: '' },
  ];
  const BY_ID = Object.fromEntries(BUILTIN.map((d) => [d.id, d]));

  // ---------- compile config (cached per config object) ----------
  const compiled = new WeakMap();
  function compile(cfg) {
    if (cfg && compiled.has(cfg)) return compiled.get(cfg);
    const c = { markersRe: null, custom: [] };
    const markers = (cfg?.markers || []).map((s) => String(s).trim()).filter(Boolean);
    if (markers.length) {
      const alt = markers.map((p) => escapeRe(p).replace(/\s+/g, '[\\s_-]+')).join('|');
      try { c.markersRe = new RegExp(`(?<![\\w])(?:${alt})(?![\\w])`, 'gi'); } catch (e) { c.markersRe = null; }
    }
    for (const p of cfg?.customPatterns || []) {
      if (!p || p.enabled === false || !p.pattern) continue;
      const r = compilePattern(p.pattern, p.flags);
      if (r.re) c.custom.push({ p, re: r.re });
    }
    if (cfg) compiled.set(cfg, c);
    return c;
  }

  function compilePattern(pattern, flags) {
    const f = Array.from(new Set(`${String(flags || '').replace(/[^imsu]/g, '')}g`)).join('');
    try {
      return { re: new RegExp(pattern, f) };
    } catch (e) {
      return { error: e.message };
    }
  }

  function detectorConf(cfg, id) {
    const d = cfg?.detectors?.[id];
    return { enabled: d ? d.enabled !== false : true, mode: d?.mode || (id === 'secrets' ? 'block' : 'site') };
  }

  /**
   * Scans text. Returns findings:
   * [{ id, label, kinds:[], count, samples:[masked], values:[raw, in memory only], mode }]
   */
  function scanText(text, cfg) {
    const out = [];
    if (!text || typeof text !== 'string') return out;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    const c = compile(cfg);

    const collector = (id, label, mode) => {
      const f = { id, label, kinds: [], count: 0, samples: [], values: [], mode };
      const seen = new Set();
      f.add = (raw, masked, kind) => {
        if (seen.has(raw)) return;
        seen.add(raw);
        f.count++;
        if (f.samples.length < 3) f.samples.push(masked);
        if (f.values.length < MAX_VALUES) f.values.push(raw);
        if (kind && !f.kinds.includes(kind)) f.kinds.push(kind);
      };
      return f;
    };
    const finish = (f) => {
      if (f.count) {
        delete f.add;
        out.push(f);
      }
    };

    for (const d of BUILTIN) {
      const conf = detectorConf(cfg, d.id);
      if (!conf.enabled) continue;
      const f = collector(d.id, d.label, conf.mode);
      if (d.scan) {
        d.scan(text, f.add);
      } else if (d.id === 'markers' && c.markersRe) {
        for (const m of matchAll(c.markersRe, text)) {
          // Remember the phrase with its surroundings so allowing one document does not allow every marker.
          const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).toLowerCase();
          f.add(`marker:${around}`, `"${m[0]}"`);
        }
      } else if (d.id === 'emails') {
        const threshold = Math.max(1, Number(cfg?.emailThreshold) || 10);
        const emails = new Set();
        for (const m of matchAll(EMAIL_RE, text)) emails.add(m[0].toLowerCase());
        if (emails.size >= threshold) for (const e of emails) f.add(e, maskEmail(e));
      }
      finish(f);
    }

    for (const { p, re } of c.custom) {
      const f = collector(`custom:${p.id || p.name}`, p.name || 'Custom pattern', p.mode || 'site');
      for (const m of matchAll(re, text)) if (m[0]) f.add(m[0], maskMiddle(m[0], 2, 2));
      finish(f);
    }
    return out;
  }

  // ---------- files ----------
  const TEXT_EXT = new Set(('txt text csv tsv json jsonl ndjson md markdown log env pem key crt cer csr pub asc gpg ' +
    'yml yaml xml ini cfg conf config properties toml sql sh bash zsh ps1 bat cmd py js mjs cjs ts tsx jsx java ' +
    'kt cs go rb php pl rs swift c h cpp hpp html htm tf tfvars tfstate npmrc pypirc netrc pgpass htpasswd rtf vcf ics eml')
    .split(' '));
  const KEY_FILE_RE = /(?:^|[\\/])(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.?env(?:\.[\w-]+)?|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.htpasswd|credentials(?:\.json)?|[^\\/]*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|ovpn|tfstate))$/i;

  function extOf(name) {
    const n = String(name || '').toLowerCase();
    const base = n.split(/[\\/]/).pop();
    if (base.startsWith('.') && base.indexOf('.', 1) < 0) return base.slice(1); // ".env" -> "env"
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(i + 1) : '';
  }

  function isTextFile(name, type) {
    if (type && (/^text\//.test(type) || /(json|xml|yaml|x-sh|javascript|x-pem|csv|sql|toml)/.test(type))) return true;
    const ext = extOf(name);
    if (TEXT_EXT.has(ext)) return true;
    return /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.?env(?:\.[\w-]+)?|credentials|dockerfile|makefile)$/i.test(String(name || '').split(/[\\/]/).pop());
  }

  /** Scans a file name: confidentiality markers, custom patterns and key/credential file names. */
  function scanFileName(name, cfg) {
    const base = String(name || '').split(/[\\/]/).pop();
    if (!base) return [];
    // Treat _ . - as spaces so "Q3_CONFIDENTIAL_plan.pdf" matches the marker.
    const findings = scanText(base.replace(/[_.]+/g, ' '), {
      ...(cfg || {}),
      detectors: Object.fromEntries(BUILTIN.map((d) => [d.id, { ...detectorConf(cfg, d.id), enabled: d.id === 'markers' && detectorConf(cfg, 'markers').enabled }])),
    });
    const sec = detectorConf(cfg, 'secrets');
    if (sec.enabled && KEY_FILE_RE.test(base)) {
      findings.push({ id: 'secrets', label: BY_ID.secrets.label, kinds: ['Key or credentials file'], count: 1, samples: [base], values: [`file:${base}`], mode: sec.mode });
    }
    return findings;
  }

  /** Merges findings lists (same id -> counts added). */
  function merge(...lists) {
    const map = new Map();
    for (const list of lists) {
      for (const f of list || []) {
        const cur = map.get(f.id);
        if (!cur) {
          map.set(f.id, { ...f, kinds: [...f.kinds], samples: [...f.samples], values: [...f.values] });
          continue;
        }
        cur.count += f.count;
        for (const k of f.kinds) if (!cur.kinds.includes(k)) cur.kinds.push(k);
        for (const s of f.samples) if (cur.samples.length < 3 && !cur.samples.includes(s)) cur.samples.push(s);
        for (const v of f.values) if (cur.values.length < MAX_VALUES) cur.values.push(v);
      }
    }
    return [...map.values()];
  }

  /** Tests a custom pattern against sample text (options page). */
  function testPattern(pattern, flags, text) {
    const r = compilePattern(pattern, flags);
    if (r.error) return { error: r.error, matches: [] };
    const matches = [];
    for (const m of matchAll(r.re, String(text || '').slice(0, MAX_TEXT))) {
      if (m[0]) matches.push({ index: m.index, text: m[0] });
      if (matches.length >= 200) break;
    }
    return { matches };
  }

  globalThis.WxDetectors = {
    BUILTIN: BUILTIN.map(({ scan, ...meta }) => meta),
    MAX_TEXT,
    scanText,
    scanFileName,
    isTextFile,
    merge,
    compilePattern,
    testPattern,
    luhn,
    ibanOk,
    maskMiddle,
  };
})();

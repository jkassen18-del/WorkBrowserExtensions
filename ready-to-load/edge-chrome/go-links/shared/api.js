// Cross-browser extension API. Chrome/Edge expose `chrome` (promise-based in MV3),
// Firefox exposes `browser`. Everything in this codebase goes through `api`.
export const api = globalThis.browser ?? globalThis.chrome;

export const isFirefox = typeof globalThis.browser !== 'undefined' && !!globalThis.browser.runtime?.getBrowserInfo;

/** Extension-relative URL. */
export const url = (path) => api.runtime.getURL(path);

/** Sends a message and swallows "no receiver" errors. */
export async function send(message) {
  try {
    return await api.runtime.sendMessage(message);
  } catch (e) {
    return undefined;
  }
}

/** Short random id (not cryptographic identity, just unique keys). */
export function uid(prefix = '') {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

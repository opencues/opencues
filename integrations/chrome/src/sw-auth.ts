// Service-worker authentication + fetch-origin allow-list (INFOSEC F6).
//
// Pulled out of background.ts so manifest-security drift tests can
// import the constants without triggering the SW's addListener side-
// effects (which require a `chrome` global).

/**
 * Every onMessage listener in background.ts must call this before
 * acting on the message. Today the manifest declares no
 * `externally_connectable`, so onMessage only receives messages from
 * the extension's own content scripts/popup — the assertion is
 * belt-and-braces defence in depth. If `externally_connectable`
 * ever lands (or a content-script bug exposes the relay), these
 * checks keep the F3 exec/write-file/fetch primitives off the page
 * surface.
 *
 * The drift test in `manifest-security.test.ts` asserts the manifest
 * has no `externally_connectable` so this assumption can't silently
 * regress.
 */
export function isInternalSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  // `sender.id` is the extension ID. For our own content scripts /
  // popup it equals chrome.runtime.id; for any externally-connectable
  // page it would be undefined or a different ID.
  return sender?.id === chrome.runtime.id;
}

/**
 * Manifest's host_permissions origins. The `opencues:fetch` relay
 * refuses anything else. Drift test asserts this list matches the
 * manifest exactly.
 */
export const FETCH_ALLOWED_ORIGINS: readonly string[] = [
  'https://api.groq.com',
  'https://api.cerebras.ai',
  'https://api.openai.com',
  'https://api.anthropic.com',
  'https://openrouter.ai',
  'https://generativelanguage.googleapis.com',
  'https://finnhub.io',
  'https://hnrss.org',
  'https://geocoding-api.open-meteo.com',
  'https://api.open-meteo.com',
  'https://hacker-news.firebaseio.com',
  'https://api.coingecko.com',
  'https://api.dictionaryapi.dev',
  'https://status.claude.com',
  'https://api.github.com',
  'https://www.gov.uk',
  'https://api.tfl.gov.uk',
  'https://photon.komoot.io',
];

export function isFetchOriginAllowed(url: string): boolean {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return false; }
  return FETCH_ALLOWED_ORIGINS.includes(origin);
}

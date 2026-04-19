/**
 * Background service worker. Currently just a single install-log so the
 * extension has the MV3 background entry it needs. The legacy
 * `api-request` CORS-proxy listener was removed once all hoisted runtime
 * controls switched to direct globalThis.fetch (HN/Finnhub/Open-Meteo
 * all allow CORS, the LLM endpoints are POST + bearer-auth which don't
 * trigger preflight gates from extension contexts).
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log('OpenCues extension installed');
});

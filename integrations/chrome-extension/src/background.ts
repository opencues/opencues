/**
 * Background service worker.
 * Handles API requests that need to bypass CORS.
 * Manages extension lifecycle.
 */

// Forward API requests from content script if CORS blocks direct fetch
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'api-request') {
    fetch(message.url, {
      method: message.method || 'POST',
      headers: message.headers || {},
      body: message.body,
    })
      .then(r => r.text())
      .then(text => sendResponse({ ok: true, text }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async response
  }
});

// Log extension activation
chrome.runtime.onInstalled.addListener(() => {
  console.log('OpenCues extension installed');
});

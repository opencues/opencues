import type { BrowserControl } from './types';

/**
 * Hacker News control using hnrss.org RSS feed.
 * Read-only: fetches frontpage titles as a scrollable list.
 *
 * CORS-safe: hnrss.org allows browser requests.
 * Caches for 5 minutes.
 */

let cachedTitles: string[] = [];
let cacheTs = 0;
const CACHE_TTL = 300_000; // 5 minutes

export class HackerNewsControl implements BrowserControl {
  readonly name = 'hackernews';
  readonly readOnly = true;

  async get(): Promise<string> {
    if (cachedTitles.length > 0 && Date.now() - cacheTs < CACHE_TTL) {
      return cachedTitles.join('\n');
    }

    try {
      // Fetch top story IDs from official HN API (CORS-friendly)
      const idsResp = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
      const ids: number[] = await idsResp.json();

      // Fetch first 20 story titles
      const titles: string[] = [];
      const batch = ids.slice(0, 20);
      const stories = await Promise.all(
        batch.map(id => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json()))
      );
      for (const story of stories) {
        if (story?.title) titles.push(story.title);
      }

      if (titles.length > 0) {
        cachedTitles = titles;
        cacheTs = Date.now();
      }

      return titles.join('\n') || 'No stories found';
    } catch {
      return cachedTitles.length > 0
        ? cachedTitles.join('\n') // serve stale cache on error
        : 'HN: fetch error';
    }
  }

  private async fetchWithFallback(url: string): Promise<string> {
    try {
      const resp = await fetch(url);
      if (resp.ok) return resp.text();
    } catch { /* CORS blocked, try service worker */ }

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'api-request', url, method: 'GET' },
        (response) => {
          if (response?.ok) resolve(response.text);
          else reject(new Error(response?.error || 'proxy failed'));
        },
      );
    });
  }
}

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
      const resp = await fetch('https://hnrss.org/frontpage?count=20');
      const xml = await resp.text();

      // Parse RSS XML using DOMParser (replaces python/grep in bash version)
      const parser = new DOMParser();
      const doc = parser.parseFromString(xml, 'text/xml');
      const items = doc.querySelectorAll('item > title');

      const titles: string[] = [];
      items.forEach(item => {
        const text = item.textContent?.trim();
        if (text) titles.push(text);
      });

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
}

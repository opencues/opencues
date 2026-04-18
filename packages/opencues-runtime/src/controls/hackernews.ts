// HackerNewsControl — fetches the current frontpage story titles via
// the official HN Firebase API. Read-only, returns one title per line so
// BlankFill's consume-list path can register the result as a cycleable
// span (`hackernews _` → first title; Up/Down rotates through the rest).
//
// Cached for 5 minutes per process. Cache is shared across all hosts
// using this class instance — pass a fresh instance per host if you
// want host-isolated caches.

import type { Control } from './types';

const CACHE_TTL_MS = 300_000;
const TOPSTORIES_URL = 'https://hacker-news.firebaseio.com/v0/topstories.json';
const ITEM_URL = (id: number): string => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const HOW_MANY = 20;

export interface HackerNewsControlOptions {
  /** Override fetch — useful for tests + hosts that need to proxy via
   *  a service worker (chrome content scripts can hit
   *  hacker-news.firebaseio.com directly though). Defaults to globalThis.fetch. */
  readonly fetchFn?: typeof fetch;
}

export class HackerNewsControl implements Control {
  readonly name = 'hackernews';
  readonly readOnly = true;
  private _cachedTitles: string[] = [];
  private _cacheTs = 0;
  private readonly _fetch: typeof fetch;

  constructor(opts: HackerNewsControlOptions = {}) {
    // Bind to globalThis when capturing the default. Browsers throw
    // "Illegal invocation" on bare `fetch.call(undefined, ...)` because
    // window.fetch needs window as its `this`. Tests can pass any
    // function; bind is a no-op for vi.fn() spies.
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async get(): Promise<string> {
    if (this._cachedTitles.length > 0 && Date.now() - this._cacheTs < CACHE_TTL_MS) {
      return this._cachedTitles.join('\n');
    }

    try {
      const idsResp = await this._fetch(TOPSTORIES_URL);
      const ids = (await idsResp.json()) as number[];

      const batch = ids.slice(0, HOW_MANY);
      const stories = await Promise.all(
        batch.map(id => this._fetch(ITEM_URL(id)).then(r => r.json() as Promise<{ title?: string }>)),
      );
      const titles: string[] = [];
      for (const story of stories) {
        if (story?.title) titles.push(story.title);
      }

      if (titles.length > 0) {
        this._cachedTitles = titles;
        this._cacheTs = Date.now();
      }
      return titles.join('\n') || 'No stories found';
    } catch {
      // Serve stale cache on transient network/CORS errors.
      return this._cachedTitles.length > 0
        ? this._cachedTitles.join('\n')
        : 'HN: fetch error';
    }
  }
}

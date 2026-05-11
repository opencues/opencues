/// <reference path="../../user-blank.d.ts" />
/**
 * @type {import('../../user-blank').UserBlankModule}
 *
 * hackernews — fetches the current HN front-page titles via the
 * official Firebase API. 5-min cache. Returns titles separated by
 * newlines so BlankFill can register them as a cycleable span.
 *
 * Migrated from packages/opencues-runtime/src/blanks/hackernews.ts
 * (May 2026).
 */

const TOPSTORIES_URL = 'https://hacker-news.firebaseio.com/v0/topstories.json';
const ITEM_URL = (id) => 'https://hacker-news.firebaseio.com/v0/item/' + id + '.json';
const CACHE_TTL_MS = 5 * 60 * 1000;
const HOW_MANY = 20;

export default {
  async get(ctx, args) {
    const cached = await ctx.storage.get('titles');
    const tsStr = await ctx.storage.get('ts');
    const ts = tsStr ? parseInt(tsStr, 10) : 0;
    if (cached && ctx.now() - ts < CACHE_TTL_MS) return cached;

    try {
      const idsResp = await ctx.fetch(TOPSTORIES_URL);
      if (!idsResp.ok) throw new Error('topstories http ' + idsResp.status);
      const ids = await idsResp.json();
      const batch = ids.slice(0, HOW_MANY);

      const stories = await Promise.all(
        batch.map(id => ctx.fetch(ITEM_URL(id)).then(r => r.json())),
      );
      const titles = [];
      for (const s of stories) {
        if (s && s.title) titles.push(s.title);
      }
      const result = titles.length > 0 ? titles.join('\n') : 'No stories found';
      if (titles.length > 0) {
        await ctx.storage.set('titles', result);
        await ctx.storage.set('ts', String(ctx.now()));
      }
      return result;
    } catch (e) {
      // Stale cache > nothing on transient errors.
      return cached || 'HN: fetch error';
    }
  },
};

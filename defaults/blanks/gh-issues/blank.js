/// <reference path="../../user-blank.d.ts" />
/**
 * @type {import('../../user-blank').UserBlankModule}
 *
 * gh-issues — open issue count for a github repo.
 *
 * Usage: type `gh-issues owner/repo _` (e.g. `gh-issues opencues/opencues _`).
 *
 * args[0] is the keyword ('gh-issues'), args[1+] are the words
 * between keyword and `_`. We take args[1] as the repo path.
 *
 * Caches the count for 5 minutes per repo to avoid GitHub API
 * rate-limiting on repeated invocations.
 */
export default {
  async get(ctx, args) {
    const repo = (args[1] ?? 'opencues/opencues').trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return 'invalid repo (expected owner/repo)';
    }

    const cacheKey = 'count:' + repo;
    const tsKey = 'ts:' + repo;
    const cached = await ctx.storage.get(cacheKey);
    const cacheTsStr = await ctx.storage.get(tsKey);
    const cacheTs = cacheTsStr ? parseInt(cacheTsStr, 10) : 0;
    const fiveMinutes = 5 * 60 * 1000;

    if (cached && ctx.now() - cacheTs < fiveMinutes) {
      return cached + ' open (cached)';
    }

    let json;
    try {
      const r = await ctx.fetch('https://api.github.com/repos/' + repo);
      if (!r.ok) return 'github http ' + r.status;
      json = await r.json();
    } catch (e) {
      return 'fetch failed: ' + e.message;
    }

    if (typeof json.open_issues_count !== 'number') {
      return 'no issue count';
    }
    const count = String(json.open_issues_count);
    await ctx.storage.set(cacheKey, count);
    await ctx.storage.set(tsKey, String(ctx.now()));
    return count + ' open';
  },
};

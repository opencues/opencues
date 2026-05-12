/// <reference path="../../user-blank.d.ts" />
/**
 * @type {import('../../user-blank').UserBlankModule}
 *
 * dictionary — definition lookup via dictionaryapi.dev (no auth).
 * 24h cache per word. Migrated from
 * packages/opencues-runtime/src/blanks/dictionary.ts (May 2026).
 */

const ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TRIGGER_WORDS = new Set(['define', 'definition', 'meaning', 'means', 'word']);

function pickWord(keyword, context) {
  const all = [keyword, ...(context || [])]
    .filter(Boolean)
    .flatMap(s => s.toLowerCase().split(/\s+/))
    .filter(w => w && !TRIGGER_WORDS.has(w) && !/^(of|the|a|an|is|_)$/.test(w));
  return all.sort((a, b) => b.length - a.length)[0] || '';
}

export default {
  async get(ctx, args) {
    const keyword = args[0];
    const context = args.slice(1);
    const word = pickWord(keyword, context);
    if (!word) return '';

    const cacheKey = `def:${word}`;
    const tsKey = `ts:${word}`;
    const cached = await ctx.storage.get(cacheKey);
    const cacheTsStr = await ctx.storage.get(tsKey);
    const cacheTs = cacheTsStr ? parseInt(cacheTsStr, 10) : 0;
    if (cached && ctx.now() - cacheTs < CACHE_TTL_MS) return cached;

    try {
      const resp = await ctx.fetch(`${ENDPOINT}/${encodeURIComponent(word)}`);
      if (!resp.ok) {
        return resp.status === 404 ? `${word}: not found` : `${word}: HTTP ${resp.status}`;
      }
      const data = await resp.json();
      const def = (data && data[0] && data[0].meanings && data[0].meanings[0]
        && data[0].meanings[0].definitions && data[0].meanings[0].definitions[0]
        && data[0].meanings[0].definitions[0].definition) || '';
      const value = def.length > 100 ? def.slice(0, 97).trim() + '...' : def;
      // Embed word in the answer so `blankReplace: auto` produces
      // self-contained output when the trigger is wiped
      // ("define ephemeral _" → "ephemeral: Something which...").
      const out = value ? `${word}: ${value}` : `${word}: no definition`;
      await ctx.storage.set(cacheKey, out);
      await ctx.storage.set(tsKey, String(ctx.now()));
      return out;
    } catch (e) {
      return `${word}: error`;
    }
  },
};

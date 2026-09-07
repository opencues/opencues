/**
 * tips-catalog.ts — the tips packs rendered as a WATCHLIST for the semantic
 * tips matcher (docs/architecture/semantic-tips.md).
 *
 * One line per situation: a stable id (`t<N>`), the entry's name, its
 * `when:` line (the situation the tip is for) and its tip. Entries without a
 * `when:` have no situation to match and are left out (a pack with none
 * keeps every entry). The tip text is DATA: the runtime renders the pack's
 * own line for a cited id, never the model's paraphrase.
 *
 * Budget, not a count cap: the session watchlist caps at 24 entries because
 * prose decisions are long; a pack line is ~25 tokens and rides a prefix-
 * cached system message, so the cap here is a rendered-size budget (chars,
 * ~4 per token). Entries beyond it are dropped in pack order and logged.
 */
import type { LocalCueData } from './types';

export interface TipsCatalogEntry {
  /** stable id inside this catalogue: t1, t2, ... */
  readonly id: string;
  /** the pack section (e.g. context-management) */
  readonly section: string;
  /** the trigger token(s) — a word key, or a synonym group's synonyms joined */
  readonly trigger: string;
  /** the pack's tip line, verbatim */
  readonly tip: string;
  /** the situation the tip is for, from the pack's `when:` field */
  readonly when?: string;
  /** the note's emoji, from the pack's `emoji:` field (💡 when absent) */
  readonly emoji?: string;
  /** the advice line the note says on a semantic match (`say:`); the tip when absent */
  readonly say?: string;
  /** cycle targets from the pack (rendered as related words) */
  readonly alts: readonly string[];
}

export interface TipsCatalog {
  readonly entries: readonly TipsCatalogEntry[];
  /** the rendered catalogue block for the matcher's SYSTEM message (every entry) */
  readonly text: string;
  /**
   * The catalogue as SHARDS: each a rendered block (header + lines) of at
   * most `shardSize` entries, cut on section boundaries so a family
   * (undo / revert / rollback) stays in one call. One call per shard, in
   * parallel, each a stable prefix-cached string. A small model abstains
   * as the list grows (qwen-3.8-27b: 34 lines 19/20, 55 lines 16/20 —
   * docs/architecture/semantic-tips.md § Sharding); sharding holds each
   * call at the size it handles however many packs stack up. One shard
   * (`text` itself) when no size is set or the catalogue fits.
   */
  readonly shards: readonly string[];
  /** entries that fell off the budget, by trigger */
  readonly dropped: readonly string[];
}

/** Default ceiling per matcher call. Every shipped pack (≤ 44) stays ONE
 *  call — at that size a single call beats two balanced halves on qwen
 *  (18/20 vs 17/20) and a lone call sees every entry when judging a trap.
 *  Sharding starts where the single call breaks down (qwen: 55 lines
 *  16/20, 122 lines 15/20), i.e. once a project pack stacks on a shipped one. */
export const TIPS_SHARD_SIZE_DEFAULT = 50;

/** ~8k tokens at ~4 chars/token. */
export const TIPS_CATALOG_BUDGET_CHARS = 32000;

export const TIPS_CATALOG_HEADER =
  '\n\nTIPS — things users of this editor often do not know. Each is a situation and the one line that helps in it. Flag a sentence of the DRAFT ONLY when it shows the situation a tip is for; merely naming the topic is not the situation.\n';

function renderLine(e: TipsCatalogEntry): string {
  const when = e.when ? ` — when: ${e.when}` : '';
  return `- ${e.id} [${e.section}] ${e.trigger}${when} — tip: ${e.tip}`;
}

/**
 * Flatten a pack (or several merged packs) into catalogue entries, then
 * render within the budget. Order is the pack's own; a caller that merges
 * project packs ahead of user packs gets project-first by construction.
 */
export function buildTipsCatalog(
  data: LocalCueData | undefined,
  opts: { budgetChars?: number; shardSize?: number } = {},
): TipsCatalog {
  const budget = opts.budgetChars ?? TIPS_CATALOG_BUDGET_CHARS;
  const all: TipsCatalogEntry[] = [];
  let n = 0;
  for (const section of data ?? []) {
    const sec = section.id || 'tips';
    for (const g of section.groups ?? []) {
      if (!g || !g.tip || !Array.isArray(g.synonyms) || g.synonyms.length === 0) continue;
      n += 1;
      all.push({ id: `t${n}`, section: sec, trigger: g.synonyms.join(' / '), tip: g.tip, when: g.when?.trim() || undefined, emoji: g.emoji?.trim() || undefined, say: g.say?.trim() || undefined, alts: g.alts ?? [] });
    }
    for (const [word, entry] of Object.entries(section.words ?? {})) {
      if (!entry || !entry.tip) continue;
      n += 1;
      all.push({ id: `t${n}`, section: sec, trigger: word, tip: entry.tip, when: entry.when?.trim() || undefined, emoji: entry.emoji?.trim() || undefined, say: entry.say?.trim() || undefined, alts: entry.alts ?? [] });
    }
  }
  // The catalogue is a WATCHLIST OF SITUATIONS: an entry without a `when:`
  // line has no situation to match, only a definition, so it is left out —
  // 131 lines of definitions around 33 situations was a third of the
  // recall on qwen (2026-09-07: six misses, every one a `when:` the model
  // never reached). A pack with no `when:` lines at all (gemini-cli, shell
  // today) keeps every entry, the tip standing in for the situation, so the
  // matcher is not inert on that host. Ids are assigned AFTER the filter
  // so t1..tN is dense.
  const situations = all.filter((e) => e.when);
  const chosen = (situations.length > 0 ? situations : all).map((e, i) => ({ ...e, id: `t${i + 1}` }));
  const kept: TipsCatalogEntry[] = [];
  const dropped: string[] = [];
  let size = TIPS_CATALOG_HEADER.length;
  for (const e of chosen) {
    const line = renderLine(e);
    if (size + line.length + 1 > budget) { dropped.push(e.trigger); continue; }
    size += line.length + 1;
    kept.push(e);
  }
  const text = kept.length > 0 ? `${TIPS_CATALOG_HEADER}${kept.map(renderLine).join('\n')}` : '';
  return { entries: kept, text, shards: shardCatalog(kept, opts.shardSize), dropped };
}

/**
 * Cut the kept entries into shards of at most `shardSize`, on SECTION
 * boundaries: a section is added whole while it fits; a section larger than
 * a shard on its own is split by lines. Ids were assigned before the cut, so
 * a flag from any shard names one entry of the whole catalogue.
 */
export function shardCatalog(entries: readonly TipsCatalogEntry[], shardSize: number | undefined): string[] {
  if (entries.length === 0) return [];
  // BALANCED: `shardSize` is a ceiling, not a fill line. 37 entries at 35
  // must not become 35 + 2 — the number of shards is fixed first
  // (ceil(N / size)) and the entries spread evenly across them, so every
  // call is about the same size and none is a two-line afterthought.
  const cap = shardSize && shardSize > 0 ? Math.floor(shardSize) : Infinity;
  const size = cap === Infinity ? Infinity : Math.ceil(entries.length / Math.ceil(entries.length / cap));
  const sections: TipsCatalogEntry[][] = [];
  for (const e of entries) {
    const last = sections[sections.length - 1];
    if (last && last[0].section === e.section) last.push(e); else sections.push([e]);
  }
  const shards: TipsCatalogEntry[][] = [];
  let cur: TipsCatalogEntry[] = [];
  for (const sec of sections) {
    if (sec.length > size) {
      if (cur.length) { shards.push(cur); cur = []; }
      for (let i = 0; i < sec.length; i += size) shards.push(sec.slice(i, i + size));
      continue;
    }
    if (cur.length + sec.length > size && cur.length) { shards.push(cur); cur = []; }
    cur.push(...sec);
  }
  if (cur.length) shards.push(cur);
  return shards.map((sh) => `${TIPS_CATALOG_HEADER}${sh.map(renderLine).join('\n')}`);
}

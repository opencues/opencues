/**
 * RedditRulesProvider (Tier 5d) — per-subreddit community rules from Reddit's
 * public JSON API (`<reddit origin>/r/<sub>/about/rules.json`), keyed off the
 * CURRENT page location.
 *
 * Chrome-only in practice: build-sources constructs the provider only when the
 * host supplies a `pageLocation` getter (native hosts have no page → the tier
 * stays silent). The fetch deliberately defaults to GLOBAL fetch, not the
 * SW-routed `worldDataFetch` the other tiers use — in a content script on a
 * reddit page this is a SAME-ORIGIN request riding the page's own session
 * (allowed by reddit's `connect-src 'self'` CSP, indistinguishable from the
 * site's own client traffic), so it needs no SW hop, no extra host permission,
 * and works for subreddits the logged-in user can see.
 *
 * Same contract as the other world-data providers: `refresh()` fire-and-forget
 * off the hot path (TTL-gated per subreddit), `current()` returns the last-good
 * rules snapshot for the CURRENT location's subreddit synchronously (null when
 * off-reddit or before the first fetch lands).
 *
 * Security (security-audit rows #28–#29 discipline):
 * - The egress URL is a hardcoded template. Both variable parts are validated
 *   DATA, never LLM output: the origin against a reddit-host allowlist regex,
 *   the subreddit against `[A-Za-z0-9_]{2,30}` parsed from the URL path.
 * - Rule text is community-controlled (untrusted). It is sanitized at parse
 *   time (control chars stripped, name/description length-capped, rule count
 *   capped) and only ever becomes user-visible tip text + judge-call DATA —
 *   there is no side-effect channel for it to reach.
 */

import type { FetchLike } from './journey';

export interface PageLocation {
  readonly origin: string;
  readonly pathname: string;
}

export interface CommunityRule {
  /** 1-based display position — the number a moderator/user would cite. */
  readonly index: number;
  readonly name: string;
  readonly description: string;
}

export interface CommunityRulesSnapshot {
  /** Human label for the community, e.g. "r/ClaudeAI". */
  readonly community: string;
  readonly rules: ReadonlyArray<CommunityRule>;
}

export interface RedditRulesProviderOptions {
  /** Live page-location getter (chrome passes `location` — a getter, not a
   *  snapshot, so SPA navigation between subreddits is seen without reload). */
  readonly getLocation?: () => PageLocation | null;
  readonly fetchImpl?: FetchLike;
  /** Refresh interval per subreddit — rules change rarely; 6 h default. */
  readonly ttlMs?: number;
  /** Retry-after on a failed fetch — 10 min default (don't hammer on errors). */
  readonly errorTtlMs?: number;
  readonly log?: (msg: string) => void;
}

/** Reddit web origins the provider will fetch from. Anything else → not reddit,
 *  tier silent. (Hostname allowlist, not a suffix check — "evilreddit.com" or
 *  "reddit.com.evil.example" never match.) */
const REDDIT_ORIGIN = /^https:\/\/(?:www\.|old\.|new\.|sh\.)?reddit\.com$/i;
/** Subreddit names are `[A-Za-z0-9_]` (2–21 chars per reddit, 30 for slack). */
const SUBREDDIT_PATH = /^\/r\/([A-Za-z0-9_]{2,30})(?=\/|$)/;

const MAX_RULES = 25;
const RULE_NAME_MAX = 80;
const RULE_DESC_MAX = 300;

/** Flatten untrusted community text to one sanitized line: control chars and
 *  newlines → space, whitespace collapsed, length-capped. */
export function sanitizeRuleText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Parse the subreddit name out of a validated reddit location; null otherwise. */
export function subredditFromLocation(loc: PageLocation | null | undefined): string | null {
  if (!loc || !REDDIT_ORIGIN.test(loc.origin)) return null;
  const m = SUBREDDIT_PATH.exec(loc.pathname);
  return m ? m[1] : null;
}

interface CacheEntry {
  /** null = negative cache (fetch failed) — retried on the shorter error TTL. */
  readonly snapshot: CommunityRulesSnapshot | null;
  readonly fetchedAt: number;
}

export class RedditRulesProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly getLocation: (() => PageLocation | null) | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly log: (msg: string) => void;

  constructor(opts: RedditRulesProviderOptions = {}) {
    this.getLocation = opts.getLocation;
    this.fetchImpl = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : undefined);
    this.ttlMs = opts.ttlMs ?? 6 * 60 * 60 * 1000;
    this.errorTtlMs = opts.errorTtlMs ?? 10 * 60 * 1000;
    this.log = opts.log ?? (() => {});
  }

  /** Rules for the CURRENT page's subreddit — read synchronously in the
   *  keystroke path; null when off-reddit or before the first fetch lands. */
  current(): CommunityRulesSnapshot | null {
    const sub = subredditFromLocation(this.getLocation?.() ?? null);
    if (!sub) return null;
    return this.cache.get(sub.toLowerCase())?.snapshot ?? null;
  }

  async refresh(nowMs: number = Date.now()): Promise<void> {
    const loc = this.getLocation?.() ?? null;
    const sub = subredditFromLocation(loc);
    if (!sub || !loc || !this.fetchImpl) return;
    const key = sub.toLowerCase();
    const entry = this.cache.get(key);
    if (entry && nowMs - entry.fetchedAt < (entry.snapshot ? this.ttlMs : this.errorTtlMs)) return;
    const running = this.inflight.get(key);
    if (running) return running;
    // Hardcoded URL template over validated parts (allowlisted reddit origin +
    // regex-validated subreddit from the PATH) — never model-chosen.
    const url = `${loc.origin}/r/${sub}/about/rules.json`;
    const job = (async () => {
      try {
        const res = await this.fetchImpl!(url);
        if (!res.ok) {
          this.cache.set(key, { snapshot: null, fetchedAt: nowMs });
          this.log(`RedditRulesProvider: r/${sub} rules fetch not ok (keeping silent)`);
          return;
        }
        const body = (await res.json()) as { rules?: unknown };
        const rawRules = Array.isArray(body?.rules) ? body.rules : [];
        const rules: CommunityRule[] = [];
        for (const r of rawRules.slice(0, MAX_RULES) as Array<Record<string, unknown>>) {
          const name = sanitizeRuleText(r?.short_name, RULE_NAME_MAX);
          if (!name) continue;   // a rule without a name can't be cited — skip
          rules.push({
            index: rules.length + 1,
            name,
            description: sanitizeRuleText(r?.description, RULE_DESC_MAX),
          });
        }
        this.cache.set(key, { snapshot: { community: `r/${sub}`, rules }, fetchedAt: nowMs });
        this.log(`RedditRulesProvider: r/${sub} — ${rules.length} rule(s) cached`);
      } catch (e) {
        this.cache.set(key, { snapshot: null, fetchedAt: nowMs });
        this.log(`RedditRulesProvider: r/${sub} refresh failed (keeping silent) — ${(e as Error).message}`);
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, job);
    return job;
  }
}

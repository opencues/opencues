/**
 * Deterministic unit tests for the Tier-5d reddit community-rules provider.
 * No network — fetch is a stub; the clock is passed explicitly to refresh().
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { RedditRulesProvider, sanitizeRuleText, subredditFromLocation } from './reddit-rules';

const loc = (origin: string, pathname: string) => ({ origin, pathname });

const RULES_BODY = {
  rules: [
    { short_name: 'Be respectful', description: 'No personal attacks.' },
    { short_name: 'Be relevant', description: 'Stay relevant to the Claude and Claude Code technology and users.' },
  ],
};

/** fetch stub returning `body` for every URL; records calls. */
function stubFetch(body: unknown, ok = true) {
  const calls: string[] = [];
  const fn = async (url: string) => { calls.push(url); return { ok, json: async () => body }; };
  return { fn, calls };
}

describe('subredditFromLocation', () => {
  it('parses the subreddit from a post URL on www.reddit.com', () => {
    assert.equal(subredditFromLocation(loc('https://www.reddit.com', '/r/ClaudeAI/comments/1vg6d9li/uplink_inspired_hacking_game/')), 'ClaudeAI');
  });

  it('parses the subreddit landing page and old./sh. origins', () => {
    assert.equal(subredditFromLocation(loc('https://www.reddit.com', '/r/ClaudeAI/')), 'ClaudeAI');
    assert.equal(subredditFromLocation(loc('https://old.reddit.com', '/r/ClaudeAI')), 'ClaudeAI');
    assert.equal(subredditFromLocation(loc('https://sh.reddit.com', '/r/ClaudeAI/submit')), 'ClaudeAI');
  });

  it('SECURITY: refuses lookalike origins (suffix / prefix spoofs) and non-reddit hosts', () => {
    assert.equal(subredditFromLocation(loc('https://evilreddit.com', '/r/ClaudeAI/')), null);
    assert.equal(subredditFromLocation(loc('https://reddit.com.evil.example', '/r/ClaudeAI/')), null);
    assert.equal(subredditFromLocation(loc('http://www.reddit.com', '/r/ClaudeAI/')), null);   // https only
    assert.equal(subredditFromLocation(loc('https://www.google.com', '/r/ClaudeAI/')), null);
  });

  it('refuses non-subreddit paths and malformed names', () => {
    assert.equal(subredditFromLocation(loc('https://www.reddit.com', '/user/someone')), null);
    assert.equal(subredditFromLocation(loc('https://www.reddit.com', '/')), null);
    assert.equal(subredditFromLocation(loc('https://www.reddit.com', '/r/bad-name/')), null);   // hyphen not valid
    assert.equal(subredditFromLocation(loc('https://www.reddit.com', '/r/a/')), null);          // too short
    assert.equal(subredditFromLocation(loc('https://www.reddit.com', '/r/ClaudeAIextra/x')), 'ClaudeAIextra');
  });
});

describe('sanitizeRuleText', () => {
  it('flattens newlines + control chars and collapses whitespace', () => {
    assert.equal(sanitizeRuleText('Stay\n\nrelevant\tto Claude', 100), 'Stay relevant to Claude');
  });

  it('caps length with an ellipsis and refuses non-strings', () => {
    assert.equal(sanitizeRuleText('x'.repeat(100), 10).length, 10);
    assert.ok(sanitizeRuleText('x'.repeat(100), 10).endsWith('…'));
    assert.equal(sanitizeRuleText(42, 10), '');
    assert.equal(sanitizeRuleText(undefined, 10), '');
  });
});

describe('RedditRulesProvider', () => {
  const onClaudeAI = () => loc('https://www.reddit.com', '/r/ClaudeAI/comments/abc/post/');

  it('fetches rules.json for the current subreddit and exposes a numbered snapshot', async () => {
    const { fn, calls } = stubFetch(RULES_BODY);
    const p = new RedditRulesProvider({ getLocation: onClaudeAI, fetchImpl: fn });
    await p.refresh(1_000);
    assert.deepEqual(calls, ['https://www.reddit.com/r/ClaudeAI/about/rules.json']);
    const snap = p.current();
    assert.ok(snap);
    assert.equal(snap!.community, 'r/ClaudeAI');
    assert.equal(snap!.rules.length, 2);
    assert.deepEqual(snap!.rules[1], {
      index: 2,
      name: 'Be relevant',
      description: 'Stay relevant to the Claude and Claude Code technology and users.',
    });
  });

  it('is a no-op off-reddit: no fetch, current() null', async () => {
    const { fn, calls } = stubFetch(RULES_BODY);
    const p = new RedditRulesProvider({ getLocation: () => loc('https://www.google.com', '/search'), fetchImpl: fn });
    await p.refresh(1_000);
    assert.deepEqual(calls, []);
    assert.equal(p.current(), null);
  });

  it('TTL-gates refresh per subreddit (no refetch inside the TTL)', async () => {
    const { fn, calls } = stubFetch(RULES_BODY);
    const p = new RedditRulesProvider({ getLocation: onClaudeAI, fetchImpl: fn, ttlMs: 1000 });
    await p.refresh(1_000);
    await p.refresh(1_500);   // inside TTL → no fetch
    assert.equal(calls.length, 1);
    await p.refresh(2_100);   // past TTL → refetch
    assert.equal(calls.length, 2);
  });

  it('caches per-subreddit: navigating to another sub fetches that sub', async () => {
    const { fn, calls } = stubFetch(RULES_BODY);
    let current = onClaudeAI();
    const p = new RedditRulesProvider({ getLocation: () => current, fetchImpl: fn });
    await p.refresh(1_000);
    current = loc('https://www.reddit.com', '/r/ProgrammerHumor/');
    await p.refresh(1_100);
    assert.deepEqual(calls, [
      'https://www.reddit.com/r/ClaudeAI/about/rules.json',
      'https://www.reddit.com/r/ProgrammerHumor/about/rules.json',
    ]);
    assert.equal(p.current()!.community, 'r/ProgrammerHumor');
    current = onClaudeAI();
    assert.equal(p.current()!.community, 'r/ClaudeAI');   // first sub still cached
    await p.refresh(1_200);
    assert.equal(calls.length, 2);   // no refetch — cache warm
  });

  it('a failed fetch negative-caches (short retry TTL) and current() stays null', async () => {
    const { fn, calls } = stubFetch({}, /* ok */ false);
    const p = new RedditRulesProvider({ getLocation: onClaudeAI, fetchImpl: fn, errorTtlMs: 1000 });
    await p.refresh(1_000);
    assert.equal(p.current(), null);
    await p.refresh(1_500);   // inside error TTL → no hammering
    assert.equal(calls.length, 1);
    await p.refresh(2_100);   // past error TTL → retry
    assert.equal(calls.length, 2);
  });

  it('parses defensively: non-array rules, nameless rules, oversized text', async () => {
    const { fn } = stubFetch({
      rules: [
        { description: 'no name — skipped' },
        { short_name: 'ok\nrule', description: 'x'.repeat(500) },
        'not-an-object',
      ],
    });
    const p = new RedditRulesProvider({ getLocation: onClaudeAI, fetchImpl: fn });
    await p.refresh(1_000);
    const snap = p.current();
    assert.equal(snap!.rules.length, 1);
    assert.equal(snap!.rules[0].name, 'ok rule');
    assert.equal(snap!.rules[0].index, 1);
    assert.equal(snap!.rules[0].description.length, 300);   // capped
  });

  it('tolerates a malformed body (rules missing) as an empty snapshot', async () => {
    const { fn } = stubFetch({ kind: 'Listing' });
    const p = new RedditRulesProvider({ getLocation: onClaudeAI, fetchImpl: fn });
    await p.refresh(1_000);
    assert.deepEqual(p.current()!.rules, []);
  });
});

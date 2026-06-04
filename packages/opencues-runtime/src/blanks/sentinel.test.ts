// Tests for SentinelBlank.
//
// The runtime class is the single chokepoint every host (chrome, CC,
// OC, gemini, shell) routes through. These tests pin:
//   - keyword dispatch (`set sentinel` vs `remove sentinel` vs unknown)
//   - SUCCESS path returns the visible `[TOKEN] = value` pair
//   - FAILURE paths return `[err] <detail>` (never silent, never throws)
//   - validator integration: collision / cap / control-char / etc.
//   - frontmatter serialisation preserves the file body (docstring)
//   - SECURITY: pure-keyword args from a "hostile" buffer can't escape
//     the validator's regex (no path traversal, no command injection)

import { describe, expect, it } from 'vitest';
import { SentinelBlank } from './sentinel';
import { DEFAULT_SENTINEL_CAPS } from '@opencues/core';

function makeIO(initial = '') {
  let content = initial;
  return {
    readFile: async () => content,
    writeFile: async (next: string) => { content = next; },
    get text() { return content; },
  };
}

const empty = '---\n---\n';

describe('SentinelBlank — keyword dispatch', () => {
  it('routes `set sentinel` to set', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const out = await b.get('set sentinel', ['jobTitle', 'Founder']);
    expect(out).toBe('[JOB TITLE] = Founder');
    expect(io.text).toMatch(/jobTitle:\s+Founder/);
  });

  it('routes `remove sentinel` to remove', async () => {
    const io = makeIO('---\njobTitle: Founder\n---\n');
    const b = new SentinelBlank(io);
    const out = await b.get('remove sentinel', ['jobTitle']);
    expect(out).toBe('[removed jobTitle]');
    expect(io.text).not.toMatch(/jobTitle:/);
  });

  it('case-insensitive keyword match', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const out = await b.get('SET SENTINEL', ['jobTitle', 'Founder']);
    expect(out).toBe('[JOB TITLE] = Founder');
  });

  it('refuses unknown keyword (defence-in-depth — BlankFill should never route here)', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const out = await b.get('foo bar', ['x', 'y']);
    expect(out).toMatch(/^\[err\] unknown keyword/);
    expect(io.text).toBe(empty);
  });
});

describe('SentinelBlank — set: success paths', () => {
  it('multi-word value (Founder = "Staff Engineer")', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const out = await b.get('set sentinel', ['jobTitle', 'Staff', 'Engineer']);
    expect(out).toBe('[JOB TITLE] = Staff Engineer');
    expect(io.text).toMatch(/jobTitle:\s+Staff Engineer/);
  });

  it('updates an existing key in place', async () => {
    const io = makeIO('---\njobTitle: Founder\n---\n');
    const b = new SentinelBlank(io);
    const out = await b.get('set sentinel', ['jobTitle', 'CEO']);
    expect(out).toBe('[JOB TITLE] = CEO');
    expect(io.text).toMatch(/jobTitle:\s+CEO/);
    expect(io.text).not.toMatch(/Founder/);
  });

  it('noop returns the same display without writing', async () => {
    const io = makeIO('---\njobTitle: Founder\n---\n');
    const b = new SentinelBlank(io);
    let writes = 0;
    const trackingIO = {
      readFile: io.readFile,
      writeFile: async (s: string) => { writes++; return io.writeFile(s); },
    };
    const tracker = new SentinelBlank(trackingIO);
    const out = await tracker.get('set sentinel', ['jobTitle', 'Founder']);
    expect(out).toBe('jobTitle = Founder');
    expect(writes).toBe(0);
  });

  it('preserves the file body (docstring) on write', async () => {
    const body = '\n# IDENTITY.md\n\nMy notes.\n';
    const io = makeIO(`---\nfirstName: Wilfred\n---${body}`);
    const b = new SentinelBlank(io);
    await b.get('set sentinel', ['jobTitle', 'Founder']);
    expect(io.text).toContain('My notes.');
  });
});

describe('SentinelBlank — error surface (visible, not silent)', () => {
  it('missing key', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const out = await b.get('set sentinel', []);
    expect(out).toMatch(/^\[err\] set sentinel: usage/);
    expect(io.text).toBe(empty);
  });

  it('missing value', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const out = await b.get('set sentinel', ['jobTitle']);
    expect(out).toMatch(/^\[err\] set sentinel: missing value/);
  });

  it('invalid key shape — refuses path traversal', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const out = await b.get('set sentinel', ['../../etc/passwd', 'x']);
    expect(out).toMatch(/^\[err\] key/);
    expect(out).toMatch(/must match/);
    expect(io.text).toBe(empty);
  });

  it('invalid key shape — refuses shell metacharacters', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    for (const bad of ['foo;rm', 'foo|cat', 'foo$x', 'foo`x`', 'foo&y', 'foo*', 'foo<x']) {
      const out = await b.get('set sentinel', [bad, 'x']);
      expect(out).toMatch(/^\[err\] key/);
    }
    expect(io.text).toBe(empty);
  });

  it('control characters in value rejected (defence-in-depth — prompt smuggling)', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const out = await b.get('set sentinel', ['note', `foo\x1bbar`]);
    expect(out).toMatch(/^\[err\] value for "note" contains forbidden control characters/);
    expect(io.text).toBe(empty);
  });

  it('value too long', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const huge = 'x'.repeat(DEFAULT_SENTINEL_CAPS.maxValueLength + 1);
    const out = await b.get('set sentinel', ['bio', huge]);
    expect(out).toMatch(/^\[err\] value for "bio" exceeds/);
    expect(io.text).toBe(empty);
  });

  it('capacity exceeded', async () => {
    const lines = Array.from({ length: DEFAULT_SENTINEL_CAPS.maxFields }, (_, i) => `k${i}: v${i}`).join('\n');
    const io = makeIO(`---\n${lines}\n---\n`);
    const b = new SentinelBlank(io);
    const before = io.text;
    const out = await b.get('set sentinel', ['overflow', 'x']);
    expect(out).toMatch(/^\[err\] IDENTITY\.md is full/);
    expect(out).toMatch(/remove unused/i);
    expect(io.text).toBe(before);  // no write
  });

  it('token collision (firstName / first_name both → [FIRST NAME])', async () => {
    const io = makeIO('---\nfirstName: Wilfred\n---\n');
    const b = new SentinelBlank(io);
    const out = await b.get('set sentinel', ['first_name', 'Other']);
    expect(out).toMatch(/derives to \[FIRST NAME\]/);
    expect(io.text).toMatch(/firstName: Wilfred/);
    expect(io.text).not.toMatch(/first_name/);
  });

  it('remove: missing key', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const out = await b.get('remove sentinel', []);
    expect(out).toMatch(/^\[err\] remove sentinel: usage/);
  });

  it('remove: not-found surfaces clearly', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const out = await b.get('remove sentinel', ['nope']);
    expect(out).toMatch(/^\[err\] no sentinel with key "nope"/);
  });
});

describe('SentinelBlank — security: validator is the only write path', () => {
  it('any successful write produces a frontmatter that round-trips through the parser', async () => {
    // If a future change accidentally emits non-YAML or mangles
    // quoting, the parser would fail to round-trip. Pin the
    // contract: writes always survive a reload.
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    await b.get('set sentinel', ['firstName', 'Wilfred']);
    await b.get('set sentinel', ['twitter', '@inventor']);  // needs quoting
    await b.get('set sentinel', ['greeting', 'yes']);        // YAML reserved word
    // Re-parse and check the catalog is intact.
    const { parseIdentityMd } = await import('@opencues/core');
    const ctx = parseIdentityMd(io.text);
    const map = new Map(ctx.fields.map(f => [f.key, f.value]));
    expect(map.get('firstName')).toBe('Wilfred');
    expect(map.get('twitter')).toBe('@inventor');
    expect(map.get('greeting')).toBe('yes');
  });

  it('per-call caps override default for testing', async () => {
    const io = makeIO(empty);
    const b = new SentinelBlank({
      ...io,
      caps: { maxFields: 2, maxValueLength: 10 },
    });
    await b.get('set sentinel', ['a', '1']);
    await b.get('set sentinel', ['b', '2']);
    const out = await b.get('set sentinel', ['c', '3']);
    expect(out).toMatch(/^\[err\] IDENTITY\.md is full/);
  });

  it('refuses keyword "set sentinel" if BlankFill misroutes it (defence-in-depth)', async () => {
    // BlankFill's match logic guards against false positives, but if a
    // user pack accidentally bound a different name to "set sentinel"
    // and our keyword matcher fired weirdly, the blank should still
    // refuse cleanly. (Keyword-bound trigger surface restriction.)
    const io = makeIO(empty);
    const b = new SentinelBlank(io);
    const out = await b.get('settings change', ['voice', 'on']);
    expect(out).toMatch(/^\[err\] unknown keyword/);
  });
});

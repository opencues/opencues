// Unit tests for the merge helpers inside seed-configs.cjs:
//
//   mergeOpencuesMd — OPENCUES.md merge (defaults skeleton + user scalar overlay)
//   mergeShippedMd  — shipped BLANK.md / CUE.md / AUDITOR.md merge
//                     (defaults skeleton + non-contract user overlay)
//
// The e2e seed-configs.test.ts already covers the happy paths. These
// tests pin the edge cases of the merge contracts — user-only fields,
// stale contract drift, body preservation, idempotency.

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const seedConfigs = require(path.resolve(__dirname, '../../opencues-cli/src/commands/seed-configs.cjs'));
const { mergeOpencuesMd, mergeShippedMd } = seedConfigs._test as {
  mergeOpencuesMd: (def: string, user: string) => string;
  mergeShippedMd: (def: string, user: string) => string;
};

describe('mergeOpencuesMd', () => {
  it('preserves user scalar VALUES; adds defaults-only scalars; replaces settings: block', () => {
    const defaults = `---
voice-mode: active
debug-mode: off
max-concurrent-auditors: 0

settings:
  voice-mode:
    tip: TTS
    values:
      active: on
      inactive: off
  max-concurrent-auditors:
    tip: cap
    values:
      "0": uncapped
---

# defaults body
`;
    const user = `---
voice-mode: inactive

settings:
  voice-mode:
    tip: STALE
    values:
      active: x
---

# user body
`;
    const merged = mergeOpencuesMd(defaults, user);

    // User's cycled scalar value wins.
    expect(merged).toMatch(/^voice-mode: inactive$/m);
    // Defaults-only scalar added.
    expect(merged).toMatch(/^max-concurrent-auditors: 0$/m);
    expect(merged).toMatch(/^debug-mode: off$/m);
    // Settings: block from defaults (stale "STALE" tip is gone, new
    // max-concurrent-auditors schema is present).
    expect(merged).not.toContain('STALE');
    expect(merged).toContain('max-concurrent-auditors:\n    tip: cap');
    // User's body wins.
    expect(merged).toContain('# user body');
    expect(merged).not.toContain('# defaults body');
  });

  it('appends user-only scalars above the settings: line so they survive', () => {
    const defaults = `---
voice-mode: active
settings:
  voice-mode:
    tip: x
    values:
      active: x
---
`;
    const user = `---
voice-mode: inactive
custom-tts-pitch: 1.4
my-personal-flag: yes
---
`;
    const merged = mergeOpencuesMd(defaults, user);
    expect(merged).toContain('custom-tts-pitch: 1.4');
    expect(merged).toContain('my-personal-flag: yes');
    // Section divider for clarity.
    expect(merged).toMatch(/User-only scalars/);
    // User-only scalars sit above the settings: line.
    const customIdx = merged.indexOf('custom-tts-pitch:');
    const settingsIdx = merged.indexOf('settings:');
    expect(customIdx).toBeLessThan(settingsIdx);
  });

  it('falls back to defaults body when user has no body', () => {
    const defaults = `---
voice-mode: active
---

# defaults body
`;
    const user = `---
voice-mode: inactive
---
`;
    const merged = mergeOpencuesMd(defaults, user);
    expect(merged).toContain('# defaults body');
  });

  it('is idempotent — running twice produces the same output', () => {
    const defaults = `---
voice-mode: active
max-concurrent-auditors: 0

settings:
  voice-mode:
    tip: x
    values:
      active: x
---

# body
`;
    const user = `---
voice-mode: inactive
---

# body
`;
    const once = mergeOpencuesMd(defaults, user);
    const twice = mergeOpencuesMd(defaults, once);
    expect(twice).toBe(once);
  });

  it('handles file without frontmatter — returns defaults unchanged', () => {
    const defaults = `---
voice-mode: active
---

# body
`;
    const user = `just text, no fences`;
    const merged = mergeOpencuesMd(defaults, user);
    // User has no frontmatter → no scalars to overlay → defaults shape
    // wins. Body is user's content (since it's non-empty), so the
    // defaults body is replaced by user's.
    expect(merged).toMatch(/^voice-mode: active$/m);
    expect(merged).toContain('just text, no fences');
  });
});

describe('mergeShippedMd', () => {
  it('always refreshes contract fields from defaults (drops stale user values)', () => {
    // The drift bug that prompted the SHIPPED-MD REFRESH phase: user file
    // has `on-host: codex, claude-code` from before codex was retired.
    // Defaults now lists `chrome, claude-code, gemini-cli, opencode`.
    // Stale codex value must be dropped.
    const defaults = `---
name: opencues
type: blank
blankKeywords: opencues settings, config
sandbox: off
on-host: chrome, claude-code, gemini-cli, opencode
---
`;
    const user = `---
name: opencues
type: blank
blankKeywords: opencues settings, config
on-host: chrome, claude-code, codex, opencode
---
`;
    const merged = mergeShippedMd(defaults, user);
    expect(merged).not.toContain('codex');
    expect(merged).toMatch(/^on-host: chrome, claude-code, gemini-cli, opencode$/m);
    expect(merged).toMatch(/^sandbox: off$/m);
  });

  it('drops user-only contract fields when defaults omits them (runtime auto-detect wins)', () => {
    // Real case: shipped brightness has no `on-host:` (auto-detected as
    // native-only via `.sh` extension). A user upgrading from a pre-
    // security-push install where on-host was hand-set carries a stale
    // value that must NOT be preserved as a user-only field.
    const defaults = `---
name: brightness
type: blank
tip: screen brightness
blankScript: ./brightness-blank.sh
---
`;
    const user = `---
name: brightness
type: blank
tip: my custom tip
on-host: codex, claude-code
blankScript: ./brightness-blank.sh
---
`;
    const merged = mergeShippedMd(defaults, user);
    expect(merged).not.toContain('codex');
    expect(merged).not.toContain('on-host');
    // User's non-contract custom value preserved.
    expect(merged).toContain('tip: my custom tip');
  });

  it('drops a stale blankMultilineIsAnswer when defaults dropped it (claude-status un-pinning)', () => {
    // Real case: claude-status left the joined-card set 2026-09-03 so its
    // four alts cycle again. The seeded user copy still declares the flag,
    // and the frontmatter flag BEATS the runtime's code-side set — so unless
    // the refresh drops it, the fix never reaches an existing install.
    const defaults = `---
name: claude-status
type: blank
blankKeywords: is claude down, claude status
tip: Claude / Anthropic service status
---
`;
    const user = `---
name: claude-status
type: blank
blankKeywords: is claude down, claude status
tip: Claude / Anthropic service status
# ── User-only fields (preserved by shipped-md refresh) ──
blankMultilineIsAnswer: true
---
`;
    const merged = mergeShippedMd(defaults, user);
    expect(merged).not.toContain('blankMultilineIsAnswer');
  });

  it('keeps blankMultilineIsAnswer where defaults still declare it (location card)', () => {
    const defaults = `---
name: location
type: blank
blankMultilineIsAnswer: true
tip: where am I
---
`;
    const user = `---
name: location
type: blank
blankMultilineIsAnswer: false
tip: my tip
---
`;
    const merged = mergeShippedMd(defaults, user);
    // contract field: always the product's value, user drift corrected
    expect(merged).toContain('blankMultilineIsAnswer: true');
    expect(merged).toContain('tip: my tip');
  });

  it('preserves non-contract user fields (priority, keywords, blankStep, tip)', () => {
    const defaults = `---
name: foo
type: blank
blankKeywords: foo
blankStep: 10
priority: 50
sandbox: off
---
`;
    const user = `---
name: foo
type: blank
blankKeywords: foo, bar, baz
blankStep: 5
priority: 70
---
`;
    const merged = mergeShippedMd(defaults, user);
    expect(merged).toMatch(/^blankKeywords: foo, bar, baz$/m);
    expect(merged).toMatch(/^blankStep: 5$/m);
    expect(merged).toMatch(/^priority: 70$/m);
    // Contract field still landed.
    expect(merged).toMatch(/^sandbox: off$/m);
  });

  it('appends user-only non-contract fields under a divider', () => {
    const defaults = `---
name: foo
type: blank
---
`;
    const user = `---
name: foo
type: blank
my-custom-field: hello
priority: 99
---
`;
    const merged = mergeShippedMd(defaults, user);
    expect(merged).toContain('my-custom-field: hello');
    expect(merged).toContain('priority: 99');
    expect(merged).toMatch(/User-only fields/);
  });

  it('preserves user body when non-empty', () => {
    const defaults = `---
name: foo
type: blank
---

# defaults body
`;
    const user = `---
name: foo
type: blank
---

# user body
custom prose
`;
    const merged = mergeShippedMd(defaults, user);
    expect(merged).toContain('# user body');
    expect(merged).toContain('custom prose');
    expect(merged).not.toContain('# defaults body');
  });

  it('falls back to defaults body when user body is empty', () => {
    const defaults = `---
name: foo
type: blank
---

# defaults body
`;
    const user = `---
name: foo
type: blank
---
`;
    const merged = mergeShippedMd(defaults, user);
    expect(merged).toContain('# defaults body');
  });

  it('is idempotent — running twice produces the same output', () => {
    const defaults = `---
name: opencues
type: blank
sandbox: off
on-host: chrome, claude-code, gemini-cli, opencode
---
`;
    const user = `---
name: opencues
type: blank
blankKeywords: my, custom, set
on-host: codex
---
`;
    const once = mergeShippedMd(defaults, user);
    const twice = mergeShippedMd(defaults, once);
    expect(twice).toBe(once);
  });
});

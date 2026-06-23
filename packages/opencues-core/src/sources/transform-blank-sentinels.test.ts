/**
 * Tests for TransformBlankSource — IDENTITY.md sentinel integration.
 *
 * Phase-2 wiring (May 2026) extends the sentinel-mode personal-data
 * feature from FluidBlank-only to TransformBlank. TransformBlank now
 * runs a SINGLE fused LLM call; three integration points pinned here:
 *
 *   1. CATALOG INJECTION — when CueContext.identityContext is populated,
 *      the TransformBlank-flavoured catalog block is appended to the
 *      single fused call's SYSTEM message (cerebras prefix-cache
 *      optimisation, June 2026). Off mode = no catalog reaches the LLM
 *      (structural no-op).
 *
 *   2. SENTINEL RESOLUTION — when the LLM emits a token from the
 *      catalog (`[FULL NAME]`, `[COMPANY]`), the post-processor
 *      substitutes the real value into the FULL_REWRITE before it lands
 *      in the runtime.
 *
 *   3. preserveUnknown — TransformBlank passes preserveUnknown:true so
 *      LLM-emitted placeholders for non-sender entities
 *      (`[RECIPIENT NAME]`, `[SIGNATURE]`) survive untouched. FluidBlank
 *      keeps the default strip behaviour (its catalog is EXHAUSTIVE by
 *      contract); TransformBlank explicitly does NOT.
 *
 * No live LLM — HttpAdapter is mocked. Recorded calls are inspected to
 * assert the prompt body shape; the source's parsed output is asserted
 * for sentinel resolution + bracket survival.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TransformBlankSource } from './transform-blank-source';
import { getProvider } from '../llm-provider';
import { parseIdentityMd } from '../identity-context';
import type { HttpAdapter, CueContext } from '../types';

interface RecordedCall {
  body: string;
  userMessage: string;
  systemMessage: string;
}

function makeRecordingAdapter(
  responses: readonly string[],
  recorded: RecordedCall[],
): HttpAdapter {
  let i = 0;
  return {
    post: async (_url, body) => {
      let userMessage = '';
      let systemMessage = '';
      try {
        const parsed = JSON.parse(body);
        const msgs = parsed.messages as Array<{ role: string; content: string }>;
        userMessage = msgs.find(m => m.role === 'user')?.content ?? '';
        systemMessage = msgs.find(m => m.role === 'system')?.content ?? '';
      } catch { /* unparseable — leave blank */ }
      recorded.push({ body, userMessage, systemMessage });
      const next = responses[i++ % responses.length];
      return JSON.stringify({ choices: [{ message: { content: next } }] });
    },
  };
}

function makeFusedSource(httpAdapter: HttpAdapter): TransformBlankSource {
  return new TransformBlankSource({
    httpAdapter,
    // cerebras → fused single-call route (the only route now).
    provider: getProvider('cerebras')!,
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  });
}

// IDENTITY.md frontmatter samples — mix shipped sentinels with user-defined
// ones (signOff, jobTitle, favoriteEditor) to verify the catalog is
// open-ended (any YAML key becomes a sentinel).
const USER_MD = `---
firstName: Wilfred
fullName: Wilfred Kasekende
company: Command Stick
jobTitle: Founder
email: wilfred@example.com
signOff: Best from sunny London
favoriteEditor: vim
---`;

function ctxWithUser(text: string, mode: 'safe' | 'raw' = 'safe'): CueContext {
  const uc = parseIdentityMd(USER_MD);
  return {
    text,
    words: text.split(/\s+/).filter(Boolean),
    blankIndices: text.split(/\s+/).filter(Boolean)
      .map((w, i) => (w === '_' ? i : -1))
      .filter(i => i >= 0),
    identityContext: { fields: uc.fields, catalog: uc.catalog, mode },
  };
}

function ctxNoUser(text: string): CueContext {
  return {
    text,
    words: text.split(/\s+/).filter(Boolean),
    blankIndices: text.split(/\s+/).filter(Boolean)
      .map((w, i) => (w === '_' ? i : -1))
      .filter(i => i >= 0),
    // identityContext omitted — runtime gate didn't populate it (identity-context-mode: off)
  };
}

const fused = (instruction: string, target: string, rewrite: string, verdict = 'TRANSFORM') =>
  `VERDICT: ${verdict}\nINSTRUCTION: ${instruction}\nTARGET: ${target}\nFULL_REWRITE: ${rewrite}`;

// ────────────────────────────────────────────────────────────────────────────
// 1. CATALOG INJECTION — catalog block lands in the fused SYSTEM message
// ────────────────────────────────────────────────────────────────────────────

describe('TransformBlankSource — IDENTITY.md catalog injection (FUSED)', () => {
  it('appends catalog block to the fused SYSTEM message when identityContext is present', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([fused('uppercase', 'hello world', 'HELLO WORLD')], recorded));
    await src.getCues(ctxWithUser('uppercase _ hello world'));
    assert.strictEqual(recorded.length, 1, 'exactly one fused call');
    const sys = recorded[0].systemMessage;
    assert.ok(sys.includes('USER CONTEXT'),
      `fused SYSTEM message should carry the catalog block. Got: ${sys.slice(0, 400)}`);
    assert.ok(sys.includes('[FULL NAME]'), 'catalog should list [FULL NAME] token');
    assert.ok(sys.includes('[SIGN OFF]'), 'catalog should list user-defined [SIGN OFF] token');
  });

  it('safe mode: catalog has tokens + descriptions but no VALUES', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([fused('uppercase', 'hi', 'HI')], recorded));
    await src.getCues(ctxWithUser('uppercase _ hi', 'safe'));
    const sys = recorded[0].systemMessage;
    assert.ok(sys.includes('USER CONTEXT'), 'expected a fused call carrying the catalog');
    assert.ok(!sys.includes('Wilfred Kasekende'),
      `safe mode must NOT leak real value to LLM. Got: ${sys}`);
    assert.ok(!sys.includes('wilfred@example.com'),
      'safe mode must NOT leak email to LLM');
  });

  it('raw mode: catalog includes (value: ...) inline', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([fused('uppercase', 'hi', 'HI')], recorded));
    await src.getCues(ctxWithUser('uppercase _ hi', 'raw'));
    const sys = recorded[0].systemMessage;
    assert.ok(sys.includes('value: Wilfred Kasekende'),
      `raw mode should inline values. Got snippet: ${sys.slice(0, 400)}`);
  });

  it('omits catalog entirely when identityContext is undefined (mode: off path)', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([fused('uppercase', 'hi', 'HI')], recorded));
    await src.getCues(ctxNoUser('uppercase _ hi'));
    for (const c of recorded) {
      assert.ok(!c.userMessage.includes('USER CONTEXT') && !c.systemMessage.includes('USER CONTEXT'),
        `off mode must produce NO catalog block. Got system: ${c.systemMessage}`);
      assert.ok(!c.systemMessage.includes('[FULL NAME]'));
    }
  });

  it('GENERATIVE (empty TARGET) still carries the catalog in the fused SYSTEM message', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([
      fused('draft email asking for a meeting', '',
        'Subject: ...\n\nHi [Recipient Name],\n\nBest,\n[FULL NAME]'),
    ], recorded));
    await src.getCues(ctxWithUser('draft email asking for a meeting _'));
    const sys = recorded[0].systemMessage;
    assert.ok(sys.includes('USER CONTEXT'),
      `generative fused SYSTEM message should carry catalog block. Got: ${sys.slice(0, 400)}`);
    assert.ok(sys.includes('SENDER'),
      'catalog rules should scope to SENDER');
  });

  it('omits the catalog on a generative input when identityContext is absent', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([
      fused('write a haiku', '',
        'Crisp leaves whisper low\namber light fades into dusk\nautumn sighs softly'),
    ], recorded));
    await src.getCues(ctxNoUser('write a haiku _'));
    assert.ok(!recorded[0].systemMessage.includes('USER CONTEXT'));
  });

  it('lists user-defined tokens like [JOB TITLE] in the fused SYSTEM message', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([
      fused('write a short bio', '', 'Wilfred Kasekende is a Founder at Command Stick.'),
    ], recorded));
    await src.getCues(ctxWithUser('write a short bio _'));
    const sys = recorded[0].systemMessage;
    assert.ok(sys.includes('USER CONTEXT'),
      `fused SYSTEM message should carry catalog block. Got: ${sys.slice(0, 400)}`);
    assert.ok(sys.includes('[JOB TITLE]'),
      'catalog should list user-defined [JOB TITLE] token');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. SENTINEL RESOLUTION — post-processor substitutes catalog values
// ────────────────────────────────────────────────────────────────────────────

describe('TransformBlankSource — sentinel resolution in FULL_REWRITE output', () => {
  it('resolves [FULL NAME] → "Wilfred Kasekende" in the fused rewrite', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([
      // LLM emits sentinels using the catalog tokens.
      fused('sign this', 'Hi team', 'Hi team\n\n[FULL NAME]'),
    ], recorded));
    const result = await src.getCues(ctxWithUser('Hi team sign this _'));
    assert.ok(result.results.length >= 1, 'expected at least one result');
    const rewrite = result.results[0].alternatives[1];
    assert.ok(rewrite.includes('Wilfred Kasekende'),
      `[FULL NAME] should be resolved. Got: ${rewrite}`);
    assert.ok(!rewrite.includes('[FULL NAME]'),
      'sentinel should be replaced, not left in output');
  });

  it('resolves user-defined sentinels (open-ended catalog)', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([
      fused('sign off this note', '',
        'Looking forward.\n\n[SIGN OFF]\n[FULL NAME]\n[JOB TITLE] at [COMPANY]'),
    ], recorded));
    const result = await src.getCues(ctxWithUser('sign off this note _'));
    const rewrite = result.results[0].alternatives[1];
    assert.ok(rewrite.includes('Best from sunny London'),
      `user-defined [SIGN OFF] should resolve. Got: ${rewrite}`);
    assert.ok(rewrite.includes('Founder'),
      'user-defined [JOB TITLE] should resolve');
    assert.ok(rewrite.includes('Command Stick'),
      '[COMPANY] should resolve');
  });

  it('does NOT resolve sentinels when identityContext is absent', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([
      fused('sign this', 'Hi team', 'Hi team\n\n[FULL NAME]'),
    ], recorded));
    const result = await src.getCues(ctxNoUser('Hi team sign this _'));
    const rewrite = result.results[0].alternatives[1];
    // Off mode: post-processor is a no-op; LLM's `[FULL NAME]` survives
    // verbatim (preserveUnknown:true is moot when catalog is empty).
    assert.ok(rewrite.includes('[FULL NAME]'),
      `off mode should leave sentinels untouched. Got: ${rewrite}`);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. preserveUnknown — non-sender placeholders survive
// ────────────────────────────────────────────────────────────────────────────

describe('TransformBlankSource — preserveUnknown placeholder survival', () => {
  it('keeps LLM-emitted [RECIPIENT NAME] in the rewrite (not in catalog)', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([
      fused('draft email', '',
        'Hi [RECIPIENT NAME],\n\nFrom [FULL NAME] at [COMPANY].\n\n[SIGN OFF]'),
    ], recorded));
    const result = await src.getCues(ctxWithUser('draft email _'));
    const rewrite = result.results[0].alternatives[1];
    assert.ok(rewrite.includes('[RECIPIENT NAME]'),
      `non-sender placeholder must survive (preserveUnknown). Got: ${rewrite}`);
    // Catalog hits still resolved:
    assert.ok(rewrite.includes('Wilfred Kasekende'), 'sender token still resolves');
    assert.ok(rewrite.includes('Best from sunny London'), 'signOff still resolves');
  });

  it('keeps mixed-case placeholders untouched (TOKEN_RE only matches uppercase)', async () => {
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([
      fused('draft note', '', 'Hi [Recipient Name],\n\nFrom [FULL NAME].'),
    ], recorded));
    const result = await src.getCues(ctxWithUser('draft note _'));
    const rewrite = result.results[0].alternatives[1];
    // Mixed-case bracket never matches the regex, so it survives even
    // without preserveUnknown. Documented here to lock the behaviour.
    assert.ok(rewrite.includes('[Recipient Name]'));
    assert.ok(rewrite.includes('Wilfred Kasekende'));
  });

  it('does NOT pull catalog values into pure-text transforms (no sender context)', async () => {
    // Haiku has no SENDER reference — catalog should not be invoked.
    // We script the LLM to emit a clean rewrite with no sentinels;
    // the test pins that the source doesn't ADD anything from the
    // catalog post-hoc.
    const recorded: RecordedCall[] = [];
    const src = makeFusedSource(makeRecordingAdapter([
      fused('write a haiku about autumn', '',
        'Crisp leaves whisper low\namber light fades into dusk\nautumn sighs softly'),
    ], recorded));
    const result = await src.getCues(ctxWithUser('write a haiku about autumn _'));
    const rewrite = result.results[0].alternatives[1];
    assert.ok(!rewrite.includes('Wilfred'),
      'haiku should not contain user name');
    assert.ok(!rewrite.includes('Command Stick'),
      'haiku should not contain user company');
  });
});

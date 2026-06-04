/**
 * Tests for TransformBlankSource — SENTINELS.md sentinel integration.
 *
 * Phase-2 wiring (May 2026) extends the sentinel-mode personal-data
 * feature from FluidBlank-only to TransformBlank. Three integration
 * points pinned here:
 *
 *   1. CATALOG INJECTION — when CueContext.sentinels is populated,
 *      the TransformBlank-flavoured catalog block is appended to the
 *      APPLY user message (and the GENERATIVE / FUSED equivalents).
 *      Off mode = no catalog reaches the LLM (structural no-op).
 *
 *   2. SENTINEL RESOLUTION — when the LLM emits a token from the
 *      catalog (`[FULL NAME]`, `[COMPANY]`), the post-processor
 *      substitutes the real value into the rewrite before it lands
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

function make3PassSource(httpAdapter: HttpAdapter): TransformBlankSource {
  return new TransformBlankSource({
    httpAdapter,
    // groq → 3-pass auto-route. EXTRACT → APPLY → VERIFY.
    provider: getProvider('groq')!,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
  });
}

function makeFusedSource(httpAdapter: HttpAdapter): TransformBlankSource {
  return new TransformBlankSource({
    httpAdapter,
    // cerebras → fused single-call route.
    provider: getProvider('cerebras')!,
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    mode: 'fused',
  });
}

// SENTINELS.md frontmatter samples — mix shipped sentinels with user-defined
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
    // sentinels omitted — runtime gate didn't populate it (sentinels-mode: off)
  };
}

const extract = (instruction: string, target: string) =>
  `VERDICT: TRANSFORM\nINSTRUCTION: ${instruction}\nTARGET: ${target}`;
const apply = (rewrite: string) => `REWRITE: ${rewrite}`;
const verify = (verdict: 'OK' | 'REPAIR', rewrite = '') =>
  `VERDICT: ${verdict}\nREWRITE: ${rewrite}`;
const fused = (instruction: string, target: string, rewrite: string, verdict = 'TRANSFORM') =>
  `VERDICT: ${verdict}\nINSTRUCTION: ${instruction}\nTARGET: ${target}\nFULL_REWRITE: ${rewrite}`;

// P1.5 RESOLVE is a conditional pass triggered by deictic words ("it",
// "this", "those", etc.) in the instruction. Tests intentionally choose
// non-deictic instructions to keep the call count stable, but findApplyCall
// is robust either way: it scans for the user message that contains both
// the APPLY shape (INSTRUCTION: + TARGET: lines) and (optionally) the
// catalog block.
function findCallContaining(recorded: readonly RecordedCall[], needle: string): RecordedCall | undefined {
  return recorded.find(c => c.userMessage.includes(needle));
}

// ────────────────────────────────────────────────────────────────────────────
// 1. CATALOG INJECTION — prompt body shape per pipeline branch
// ────────────────────────────────────────────────────────────────────────────

describe('TransformBlankSource — SENTINELS.md catalog injection (3-pass APPLY)', () => {
  it('appends catalog block to APPLY user message when sentinels is present', async () => {
    const recorded: RecordedCall[] = [];
    // "uppercase" — non-deictic instruction, no P1.5 RESOLVE call.
    const responses = [
      extract('uppercase', 'hello world'),
      apply('HELLO WORLD'),
      verify('OK'),
    ];
    const src = make3PassSource(makeRecordingAdapter(responses, recorded));
    await src.getCues(ctxWithUser('uppercase _ hello world'));
    const applyCall = findCallContaining(recorded, 'USER CONTEXT');
    assert.ok(applyCall, `expected a call with USER CONTEXT block. Calls: ${recorded.map(c => c.userMessage.slice(0, 60)).join(' | ')}`);
    assert.ok(applyCall.userMessage.includes('[FULL NAME]'), 'catalog should list [FULL NAME] token');
    assert.ok(applyCall.userMessage.includes('[SIGN OFF]'), 'catalog should list user-defined [SIGN OFF] token');
  });

  it('safe mode: catalog has tokens + descriptions but no VALUES', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [extract('uppercase', 'hi'), apply('HI'), verify('OK')];
    const src = make3PassSource(makeRecordingAdapter(responses, recorded));
    await src.getCues(ctxWithUser('uppercase _ hi', 'safe'));
    const applyCall = findCallContaining(recorded, 'USER CONTEXT');
    assert.ok(applyCall, 'expected an APPLY call carrying the catalog');
    assert.ok(!applyCall.userMessage.includes('Wilfred Kasekende'),
      `safe mode must NOT leak real value to LLM. Got: ${applyCall.userMessage}`);
    assert.ok(!applyCall.userMessage.includes('wilfred@example.com'),
      'safe mode must NOT leak email to LLM');
  });

  it('raw mode: catalog includes (value: ...) inline', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [extract('uppercase', 'hi'), apply('HI'), verify('OK')];
    const src = make3PassSource(makeRecordingAdapter(responses, recorded));
    await src.getCues(ctxWithUser('uppercase _ hi', 'raw'));
    const applyCall = findCallContaining(recorded, 'USER CONTEXT');
    assert.ok(applyCall, 'expected an APPLY call carrying the catalog');
    assert.ok(applyCall.userMessage.includes('value: Wilfred Kasekende'),
      `raw mode should inline values. Got snippet: ${applyCall.userMessage.slice(0, 400)}`);
  });

  it('omits catalog entirely when sentinels is undefined (mode: off path)', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [extract('uppercase', 'hi'), apply('HI'), verify('OK')];
    const src = make3PassSource(makeRecordingAdapter(responses, recorded));
    await src.getCues(ctxNoUser('uppercase _ hi'));
    for (const c of recorded) {
      assert.ok(!c.userMessage.includes('USER CONTEXT'),
        `off mode must produce NO catalog block. Got: ${c.userMessage}`);
      assert.ok(!c.userMessage.includes('[FULL NAME]'));
    }
  });
});

describe('TransformBlankSource — SENTINELS.md catalog injection (3-pass GENERATIVE)', () => {
  it('appends catalog block to GENERATIVE user message', async () => {
    const recorded: RecordedCall[] = [];
    // GENERATIVE = TRANSFORM verdict + empty TARGET. Single APPLY call,
    // no VERIFY downstream.
    const responses = [
      extract('draft email asking for a meeting', ''),
      apply('Subject: ...\n\nHi [Recipient Name],\n\nBest,\n[FULL NAME]'),
    ];
    const src = make3PassSource(makeRecordingAdapter(responses, recorded));
    await src.getCues(ctxWithUser('draft email asking for a meeting _'));
    const genMsg = recorded[1].userMessage;
    assert.ok(genMsg.includes('USER CONTEXT'),
      `GENERATIVE user-message should carry catalog block. Got: ${genMsg.slice(0, 400)}`);
    assert.ok(genMsg.includes('SENDER'),
      'GENERATIVE catalog rules should scope to SENDER');
  });

  it('omits catalog from GENERATIVE when sentinels is absent', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      extract('write a haiku', ''),
      apply('Crisp leaves whisper low\namber light fades into dusk\nautumn sighs softly'),
    ];
    const src = make3PassSource(makeRecordingAdapter(responses, recorded));
    await src.getCues(ctxNoUser('write a haiku _'));
    assert.ok(!recorded[1].userMessage.includes('USER CONTEXT'));
  });
});

describe('TransformBlankSource — SENTINELS.md catalog injection (FUSED)', () => {
  it('appends catalog block to FUSED user message', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      fused('write a short bio', '', 'Wilfred Kasekende is a Founder at Command Stick.'),
    ];
    const src = makeFusedSource(makeRecordingAdapter(responses, recorded));
    await src.getCues(ctxWithUser('write a short bio _'));
    const fusedMsg = recorded[0].userMessage;
    assert.ok(fusedMsg.includes('USER CONTEXT'),
      `FUSED user-message should carry catalog block. Got: ${fusedMsg.slice(0, 400)}`);
    assert.ok(fusedMsg.includes('[JOB TITLE]'),
      'FUSED catalog should list user-defined [JOB TITLE] token');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. SENTINEL RESOLUTION — post-processor substitutes catalog values
// ────────────────────────────────────────────────────────────────────────────

describe('TransformBlankSource — sentinel resolution in output', () => {
  it('resolves [FULL NAME] → "Wilfred Kasekende" in the 3-pass APPLY rewrite', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      extract('sign this', 'Hi team'),
      // LLM emits sentinels using the catalog tokens.
      apply('Hi team\n\n[FULL NAME]'),
      verify('OK', 'Hi team\n\n[FULL NAME]'),
    ];
    const src = make3PassSource(makeRecordingAdapter(responses, recorded));
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
    const responses = [
      fused('sign off this note', '',
        'Looking forward.\n\n[SIGN OFF]\n[FULL NAME]\n[JOB TITLE] at [COMPANY]'),
    ];
    const src = makeFusedSource(makeRecordingAdapter(responses, recorded));
    const result = await src.getCues(ctxWithUser('sign off this note _'));
    const rewrite = result.results[0].alternatives[1];
    assert.ok(rewrite.includes('Best from sunny London'),
      `user-defined [SIGN OFF] should resolve. Got: ${rewrite}`);
    assert.ok(rewrite.includes('Founder'),
      'user-defined [JOB TITLE] should resolve');
    assert.ok(rewrite.includes('Command Stick'),
      '[COMPANY] should resolve');
  });

  it('does NOT resolve sentinels when sentinels is absent', async () => {
    const recorded: RecordedCall[] = [];
    const responses = [
      fused('sign this', 'Hi team', 'Hi team\n\n[FULL NAME]'),
    ];
    const src = makeFusedSource(makeRecordingAdapter(responses, recorded));
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
    const responses = [
      fused('draft email', '',
        'Hi [RECIPIENT NAME],\n\nFrom [FULL NAME] at [COMPANY].\n\n[SIGN OFF]'),
    ];
    const src = makeFusedSource(makeRecordingAdapter(responses, recorded));
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
    const responses = [
      fused('draft note', '', 'Hi [Recipient Name],\n\nFrom [FULL NAME].'),
    ];
    const src = makeFusedSource(makeRecordingAdapter(responses, recorded));
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
    const responses = [
      fused('write a haiku about autumn', '',
        'Crisp leaves whisper low\namber light fades into dusk\nautumn sighs softly'),
    ];
    const src = makeFusedSource(makeRecordingAdapter(responses, recorded));
    const result = await src.getCues(ctxWithUser('write a haiku about autumn _'));
    const rewrite = result.results[0].alternatives[1];
    assert.ok(!rewrite.includes('Wilfred'),
      'haiku should not contain user name');
    assert.ok(!rewrite.includes('Command Stick'),
      'haiku should not contain user company');
  });
});

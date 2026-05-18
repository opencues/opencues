// Drift-prevention for the "label steering" contract:
//   - FUSED_SYSTEM_PROMPT contains the few-shot examples that
//     demonstrate typed-hint → URL/value construction.
//   - user-context.ts rule #10 declares typed hints take precedence
//     over USER.md catalog sentinels.
//
// These are PROMPT-LEVEL invariants. The live behaviour is validated
// against real LLMs by
// `tests/benchmarks/fluid-blank-ambient/label-steering-bench.ts`
// (7 hint-bearing cases × providers); these tests just lock the
// prompt structure so someone can't silently delete the examples
// or the rule and regress the bench.
//
// Full design + worked examples: docs/architecture/user-context.md
// § "Steering — typed hint vs catalog token".

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { FUSED_SYSTEM_PROMPT } from './fluid-blank-source';
import { renderUserCatalog, type UserContext } from '../user-context';

describe('label-steering prompt invariants', () => {
  describe('FUSED_SYSTEM_PROMPT few-shot examples', () => {
    it('includes the danielsunderland LinkedIn typed-hint example', () => {
      assert.match(FUSED_SYSTEM_PROMPT, /SPAN: danielsunderland _/);
      assert.match(FUSED_SYSTEM_PROMPT, /ANSWER: https:\/\/www\.linkedin\.com\/in\/danielsunderland/);
    });

    it('includes the devvaa GitHub typed-hint example', () => {
      assert.match(FUSED_SYSTEM_PROMPT, /SPAN: devvaa _/);
      assert.match(FUSED_SYSTEM_PROMPT, /ANSWER: https:\/\/github\.com\/devvaa/);
    });

    it('includes the UK Country abbreviation example', () => {
      assert.match(FUSED_SYSTEM_PROMPT, /SPAN: UK _/);
      assert.match(FUSED_SYSTEM_PROMPT, /ANSWER: United Kingdom/);
    });

    it('still includes the bare-`_` fallback examples for LinkedIn/GitHub', () => {
      // The catalog-token fallback (rule #6) still applies when no
      // hint is typed. These examples must coexist with the typed-hint
      // ones — typed-hint cases override the bare-_ case at runtime.
      assert.match(FUSED_SYSTEM_PROMPT, /ANSWER: https:\/\/www\.linkedin\.com\/in\/yourname/);
      assert.match(FUSED_SYSTEM_PROMPT, /ANSWER: https:\/\/github\.com\/yourname/);
    });
  });

  describe('user-context catalog rule #10 (typed hint precedence)', () => {
    const sampleCtx: UserContext = {
      fields: [{ key: 'github', token: '[GITHUB]', description: "user's github URL", value: 'https://github.com/me' }],
      catalog: new Map([['[GITHUB]', 'https://github.com/me']]),
    };

    it('rule #10 appears in the catalog when mode is safe', () => {
      const block = renderUserCatalog(sampleCtx, 'safe');
      assert.match(block, /USER-TYPED HINT TAKES PRECEDENCE/);
      assert.match(block, /Do NOT substitute a catalog token in this case/);
    });

    it('rule #10 includes concrete handle + URL examples', () => {
      const block = renderUserCatalog(sampleCtx, 'safe');
      assert.match(block, /danielsunderland.*linkedin\.com\/in\/danielsunderland/);
      assert.match(block, /wkasekende.*github\.com\/wkasekende/);
    });

    it('rule #10 explains the catalog-fallback condition', () => {
      const block = renderUserCatalog(sampleCtx, 'safe');
      // Rule 10 closes by saying the catalog tokens (rule 6) apply
      // ONLY when no user-typed hint is present in the buffer.
      assert.match(block, /catalog tokens \(rule 6\) apply only when the buffer has NO user-typed hint/);
    });

    it('rule #6 (the catalog-emit rule) is still present alongside rule #10', () => {
      // Rule 10 OVERRIDES rule 6 in the typed-hint case but doesn't
      // remove it. Bare-`_` cases still need rule 6 to emit the
      // catalog token rather than a generic placeholder URL.
      const block = renderUserCatalog(sampleCtx, 'safe');
      assert.match(block, /when an UNTRUSTED_FIELD_CONTEXT block ALSO appears/);
      assert.match(block, /EMIT THE TOKEN/);
    });
  });
});

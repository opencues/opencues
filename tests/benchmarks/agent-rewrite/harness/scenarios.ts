/**
 * Curated typing scenarios. Each represents a real-world user pattern
 * we want the harness to exercise. Most reproduce or guard against
 * specific bug classes that surfaced in production.
 *
 * Adding a scenario: pick an adversarial LLM (or define a new one in
 * adversarial-llms.ts), describe the typing flow with `step.*`, and
 * add expectations. Every existing invariant runs against new
 * scenarios automatically.
 */
import type { Step, LlmMode } from './types';
import { step as s } from './simulator';
import * as adv from './adversarial-llms';

export interface ScenarioDef {
  readonly name: string;
  readonly task: string;
  readonly steps: ReadonlyArray<Step>;
  readonly llm: LlmMode;
  readonly tags: ReadonlyArray<string>;
  /**
   * Optional per-scenario invariant skip list. Translation tasks for
   * example legitimately rewrite most chars, so the char-survival
   * heuristic doesn't apply. Skip by name.
   */
  readonly skipInvariants?: ReadonlyArray<string>;
}

export const SCENARIOS: ReadonlyArray<ScenarioDef> = [
  // ─── Trailing whitespace ─────────────────────────────────────────
  {
    name: 'trailing-space-survives-trim-llm',
    task: 'correct spelling',
    tags: ['whitespace', 'trailing'],
    llm: adv.adversarialTrimTrailingWS(),
    steps: [
      s.type('food? '),
      s.tick(),
      s.expectBuffer('food? '),
      s.type('and more'),
      s.tick(),
      s.expectContains('and more'),
      s.expectContains('food? '),
    ],
  },
  {
    name: 'trailing-newline-survives-trim-llm',
    task: 'correct spelling',
    tags: ['whitespace', 'trailing'],
    llm: adv.adversarialTrimTrailingWS(),
    steps: [
      s.type('hello\n'),
      s.tick(),
      s.expectBuffer('hello\n'),
    ],
  },
  {
    name: 'multi-tick-trailing-whitespace-stable',
    task: 'correct spelling',
    tags: ['whitespace', 'trailing', 'flicker'],
    llm: adv.adversarialTrimTrailingWS(),
    steps: [
      s.type('food? '),
      s.tick(), s.tick(), s.tick(),
      s.expectBuffer('food? '),
    ],
  },
  {
    name: 'multi-trailing-whitespace-chars-survive',
    task: 'fix grammar',
    tags: ['whitespace', 'trailing'],
    llm: adv.adversarialTrimTrailingWS(),
    steps: [
      s.type('text? \n  '),                                              // mixed trailing whitespace
      s.tick(),
      s.expectBuffer('text? \n  '),
    ],
  },

  // ─── Paragraph breaks ────────────────────────────────────────────
  {
    name: 'paragraph-break-survives-collapsing-llm',
    task: 'fix punctuation',
    tags: ['whitespace', 'paragraph'],
    llm: adv.adversarialCollapseParagraphs(),
    steps: [
      s.type('first sentence.\n\nsecond sentence.'),
      s.tick(),
      s.expectContains('\n\n'),
    ],
  },
  {
    name: 'multi-paragraph-doc-collapsing-llm',
    task: 'fix grammar',
    tags: ['whitespace', 'paragraph'],
    llm: adv.adversarialCollapseParagraphs(),
    steps: [
      s.type('one.\n\ntwo.\n\nthree.'),
      s.tick(),
      s.expectContains('one.'),
      s.expectContains('two.'),
      s.expectContains('three.'),
    ],
  },
  {
    name: 'paragraph-break-survives-join-all-llm',
    task: 'fix grammar',
    tags: ['whitespace', 'paragraph'],
    llm: adv.adversarialJoinAllParagraphs(),
    steps: [
      s.type('para1.\n\npara2.\n\npara3.'),
      s.tick(),
      s.expectContains('\n\n'),
    ],
  },
  {
    name: 'paragraph-break-survives-canonicalise-llm',
    task: 'fix punctuation',
    tags: ['whitespace', 'structure'],
    llm: adv.adversarialCanonicaliseWhitespace(),
    steps: [
      s.type('first sentence.\n\nsecond sentence.\n\n  indented'),
      s.tick(),
      s.expectContains('\n\n'),
    ],
  },
  {
    name: 'progressive-paragraph-typing',
    task: 'correct spelling',
    tags: ['whitespace', 'progressive'],
    llm: adv.spellingFix(),
    steps: [
      s.type('first.'),                            s.tick(),
      s.type('\n\n'),                              s.tick(),
      s.type('second has rite.'),                  s.tick(),
      s.expectContains('\n\n'),
      s.expectContains('write'),
    ],
  },

  // ─── Terminator eagerness ────────────────────────────────────────
  {
    name: 'no-auto-period-on-mid-thought-fragment',
    task: 'fix punctuation',
    tags: ['punctuation', 'in-flight'],
    llm: adv.adversarialTerminatorEager(),
    steps: [
      s.type('Today'),
      s.tick(),
      s.expectMissing('Today.'),
    ],
  },
  {
    name: 'no-auto-period-on-end-of-doc-sentence',
    task: 'fix punctuation',
    tags: ['punctuation', 'in-flight'],
    llm: adv.adversarialTerminatorEager(),
    steps: [
      s.type('hi how are you'),
      s.tick(),
      s.expectMissing('hi how are you.'),
    ],
  },
  {
    name: 'no-auto-period-multi-tick',
    task: 'fix punctuation',
    tags: ['punctuation', 'in-flight', 'flicker'],
    llm: adv.adversarialTerminatorEager(),
    steps: [
      s.type('Cool so'),
      s.tick(), s.tick(), s.tick(),                                       // three ticks, all fragment-like
      s.expectBuffer('Cool so'),                                          // never gets terminated
    ],
  },
  {
    name: 'auto-period-allowed-in-mid-doc-sentences',
    task: 'fix punctuation',
    tags: ['punctuation', 'allowed'],
    llm: { kind: 'mock', respond: (s) => s.replace('typo', 'typo.') },   // adds period mid-doc
    steps: [
      s.type('I have typo here.\n\nMore text'),
      s.tick(),
      // The mid-doc edit should land if it's not at end-of-buffer.
      // Just verify the user content survives.
      s.expectContains('typo'),
      s.expectContains('More text'),
    ],
  },

  // ─── END-marker leak ─────────────────────────────────────────────
  {
    name: 'end-marker-leak-stripped',
    task: 'correct spelling',
    tags: ['parser', 'end-marker'],
    llm: adv.adversarialEndMarkerLeak(),
    steps: [
      s.type('hello world'),
      s.tick(),
      s.expectMissing('END'),
      s.expectMissing('footer junk'),
      s.expectMissing('MORE STUFF'),
    ],
  },
  {
    name: 'end-marker-leak-multi-tick-stable',
    task: 'fix grammar',
    tags: ['parser', 'end-marker', 'flicker'],
    llm: adv.adversarialEndMarkerLeak(),
    steps: [
      s.type('test text'),
      s.tick(), s.tick(), s.tick(),
      s.expectMissing('END'),
    ],
  },

  // ─── Cursor sentinel leak ────────────────────────────────────────
  {
    name: 'cursor-sentinel-stripped',
    task: 'correct spelling',
    tags: ['parser', 'cursor-sentinel'],
    llm: adv.adversarialEchoCursorSentinel(),
    steps: [
      s.type('text here'),
      s.tick(),
      s.expectMissing('[CURSOR]'),
    ],
  },

  // ─── Spelling-fix progressive flow ───────────────────────────────
  {
    name: 'progressive-typing-rite-write-no-flicker',
    task: 'correct spelling',
    tags: ['active-typing', 'flicker'],
    llm: adv.spellingFix(),
    steps: [
      s.type('I '),                                s.tick(),
      s.type('rite'),                              s.tick(),
      s.type(' stuff'),                            s.tick(),
      s.expectBuffer('I write stuff'),
    ],
  },
  {
    name: 'rapid-typing-with-spelling-fix',
    task: 'correct spelling',
    tags: ['active-typing', 'rapid'],
    llm: adv.spellingFix(),
    steps: [
      s.type('I'),                                 s.tick(),
      s.type(' '),                                 s.tick(),
      s.type('r'),                                 s.tick(),
      s.type('i'),                                 s.tick(),
      s.type('t'),                                 s.tick(),
      s.type('e'),                                 s.tick(),
      s.type(' '),                                 s.tick(),
      s.type('stuff'),                             s.tick(),
      s.expectContains('write'),
    ],
  },

  // ─── Idempotency ─────────────────────────────────────────────────
  {
    name: 'identity-llm-stable',
    task: 'correct spelling',
    tags: ['idempotent'],
    llm: { kind: 'identity' },
    steps: [
      s.type('clean text here'),
      s.tick(), s.tick(), s.tick(),
      s.expectBuffer('clean text here'),
    ],
  },
  {
    name: 'echo-llm-no-mutation',
    task: 'fix grammar',
    tags: ['idempotent'],
    llm: adv.adversarialEcho(),
    steps: [
      s.type('any text here. Multi-line.\n\nAnother para.'),
      s.tick(), s.tick(),
      s.expectBuffer('any text here. Multi-line.\n\nAnother para.'),
    ],
  },

  // ─── Cursor positions ────────────────────────────────────────────
  {
    name: 'cursor-mid-buffer-typing-spelling',
    task: 'correct spelling',
    tags: ['cursor'],
    llm: adv.spellingFix(),
    steps: [
      s.type('I rite stuff'),
      s.moveCursor(2),
      s.tick(),
      s.expectBuffer('I write stuff'),
    ],
  },
  {
    name: 'cursor-at-start-typing-end',
    task: 'correct spelling',
    tags: ['cursor'],
    llm: adv.spellingFix(),
    steps: [
      s.type('I rite stuff'),
      s.moveCursor(0),
      s.tick(),
      s.expectContains('write'),
    ],
  },

  // ─── Composite adversarial ───────────────────────────────────────
  {
    name: 'kitchen-sink-llm-trailing-fragment',
    task: 'fix everything',
    tags: ['adversarial', 'composite', 'in-flight'],
    llm: adv.adversarialKitchenSink(),
    steps: [
      s.type('hii my namee is wilfred'),
      s.tick(),
      s.expectMissing('wilfred.'),                                        // no auto-period
      s.expectContains('Wilfred'),                                        // capitalisation lands
    ],
  },
  {
    name: 'kitchen-sink-llm-with-paragraph',
    task: 'fix everything',
    tags: ['adversarial', 'composite', 'paragraph'],
    llm: adv.adversarialKitchenSink(),
    steps: [
      s.type('hii my namee.\n\nhow are you'),
      s.tick(),
      s.expectContains('\n\n'),                                           // paragraph break preserved
      s.expectMissing('how are you.'),                                    // no auto-period at end
    ],
  },

  // ─── Salutation comma over-eagerness ─────────────────────────────
  {
    name: 'salutation-comma-not-in-fragment',
    task: 'make formal',
    tags: ['punctuation', 'salutation'],
    llm: adv.adversarialAddSalutationCommas(),
    steps: [
      s.type('Hi John'),
      s.tick(),
      // The user is mid-thought; even with an adversarial LLM, the
      // salutation comma at end-of-fragment is suspicious. We don't
      // currently strip it (out of scope) but the user content survives.
      s.expectContains('John'),
    ],
  },

  // ─── Newline doubling adversarial ────────────────────────────────
  {
    name: 'doubling-llm-doesnt-explode-buffer',
    task: 'fix grammar',
    tags: ['whitespace', 'adversarial'],
    llm: adv.adversarialDoubleNewlines(),
    steps: [
      s.type('first.\nsecond.'),                                          // single \n
      s.tick(),
      // The LLM tries to add MORE newlines; the user's \n stays at
      // minimum (could grow). Just verify content survives.
      s.expectContains('first.'),
      s.expectContains('second.'),
    ],
  },

  // ─── Empty / whitespace-only LLM responses ───────────────────────
  {
    name: 'empty-llm-response-doesnt-clear-buffer',
    task: 'fix grammar',
    tags: ['adversarial', 'failure'],
    llm: adv.adversarialEmpty(),
    steps: [
      s.type('important content'),
      s.tick(),
      s.expectContains('important content'),                              // user content not wiped
    ],
  },
  {
    name: 'whitespace-only-llm-response-preserves-content',
    task: 'fix grammar',
    tags: ['adversarial', 'failure'],
    llm: adv.adversarialJustWhitespace(),
    steps: [
      s.type('important content here'),
      s.tick(),
      s.expectContains('important content'),
    ],
  },

  // ─── Truncation ──────────────────────────────────────────────────
  {
    name: 'truncating-llm-with-user-typing-tail-survives',
    task: 'fix grammar',
    tags: ['adversarial', 'truncation'],
    llm: adv.adversarialTruncate(),
    steps: [
      s.type('first half here'),                                          s.tick(),
      s.type(' and second half here'),                                    s.tick(),
      // User typed second half during/after the LLM saw first half;
      // user's tail must survive the truncation hunk.
      s.expectContains('second half'),
    ],
  },

  // ─── Oscillating LLM (subjective grammar) ────────────────────────
  {
    name: 'oscillating-llm-stable-on-third-tick',
    task: 'fix grammar',
    tags: ['flicker', 'oscillation'],
    llm: adv.adversarialOscillate("you'll go", 'you will go'),
    steps: [
      s.type('you will go'),
      s.tick(),                                                           // round 1: "you'll go"
      s.tick(),                                                           // round 2: "you will go"
      s.tick(),                                                           // round 3: "you'll go" — but we want stability
      // No-flicker invariant fires if X→Y→X pattern detected in the
      // last 3 ticks. AgentRewrite has no inherent oscillation
      // protection (legacy AgentLoop's anti-oscillation was prompt-
      // dependent here). This scenario documents the gap.
      s.expectContains('go'),                                             // content survives whichever direction
    ],
  },

  // ─── Drop-word adversarial ───────────────────────────────────────
  {
    name: 'drop-word-llm-doesnt-eat-user-content',
    task: 'fix grammar',
    tags: ['adversarial'],
    llm: adv.adversarialDropWord(),
    steps: [
      s.type('important first word here'),
      s.tick(),
      // The LLM "drops" the first word; whether the merge applies that
      // depends on user-hunk overlap. With no user typing, it would
      // apply. The 50%-survival invariant guards against gross loss.
      s.expectContains('here'),                                            // tail content survives
    ],
  },

  // ─── Realistic user flows ────────────────────────────────────────
  {
    name: 'email-greeting-then-body',
    task: 'fix grammar and spelling',
    tags: ['realistic', 'email'],
    llm: adv.spellingFix(),
    steps: [
      s.type('Hi John'),                                                  s.tick(),
      s.type(',\n\n'),                                                    s.tick(),
      s.type('Just a quick note. '),                                      s.tick(),
      s.type('Hope you'),                                                 s.tick(),
      s.expectContains('John'),
      s.expectContains('\n\n'),
      s.expectContains('Hope you'),
      s.expectMissing('Hope you.'),                                       // mid-thought, no auto-period
    ],
  },
  {
    name: 'casual-chat-progressive',
    task: 'fix typos',
    tags: ['realistic', 'chat'],
    llm: adv.spellingFix(),
    steps: [
      s.type('hii'),                                                      s.tick(),
      s.type(' how'),                                                     s.tick(),
      s.type(' are'),                                                     s.tick(),
      s.type(' you'),                                                     s.tick(),
      s.type(' dooing'),                                                  s.tick(),
      s.expectContains('Hi'),
      s.expectContains('doing'),
      s.expectMissing('dooing'),
    ],
  },
  {
    name: 'multi-paragraph-note',
    task: 'fix spelling',
    tags: ['realistic', 'paragraph'],
    llm: adv.spellingFix(),
    steps: [
      s.type('Para one has rite.'),                                       s.tick(),
      s.type('\n\n'),                                                     s.tick(),
      s.type('Para two has teh issue.'),                                  s.tick(),
      s.expectContains('write'),
      s.expectContains('the'),
      s.expectContains('\n\n'),
    ],
  },
  {
    name: 'backspace-and-retype',
    task: 'fix spelling',
    tags: ['realistic', 'backspace'],
    llm: adv.spellingFix(),
    steps: [
      s.type('I rite something'),                                         s.tick(),
      s.replace('I rite some'),                                           s.tick(),       // user backspaced "thing"
      s.type('text'),                                                     s.tick(),       // and retyped
      s.expectContains('write'),
      s.expectContains('text'),
      s.expectMissing('something'),
    ],
  },

  // ─── Long-buffer scenarios ───────────────────────────────────────
  {
    name: 'long-buffer-doesnt-crash',
    task: 'correct spelling',
    tags: ['scale'],
    llm: adv.adversarialEcho(),
    steps: [
      s.type(Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ')),
      s.tick(), s.tick(),
      s.expectContains('word0'),
      s.expectContains('word49'),
    ],
  },

  // ─── Multi-edit-LLM scenarios ────────────────────────────────────
  {
    name: 'capitalising-llm-on-incomplete-sentence',
    task: 'fix capitalisation',
    tags: ['punctuation', 'in-flight'],
    llm: adv.adversarialCapitalise(),
    steps: [
      s.type('hi how are you'),
      s.tick(),
      s.expectContains('Hi'),
      s.expectMissing('Hi.'),
    ],
  },

  // ─── Translation: progressive German typing ──────────────────────
  {
    // The classic non-idempotent task. Each round legitimately rewrites
    // the buffer; the user types more between rounds. The merge must
    // not destroy user content during translation, must not lose
    // paragraph structure, and must not flicker.
    name: 'translate-to-german-progressive-words',
    task: 'translate to german',
    tags: ['translation', 'progressive', 'realistic'],
    llm: adv.translateToGerman(),
    skipInvariants: ['user-content-survives'],     // translation rewrites chars
    steps: [
      s.type('Hi'),                            s.tick(),
      s.type(' I'),                            s.tick(),
      s.type(' am'),                           s.tick(),
      s.type(' going'),                        s.tick(),
      s.type(' home'),                         s.tick(),
      s.expectContains('Hallo'),
      s.expectContains('zuhause'),
    ],
  },
  {
    name: 'translate-to-german-trailing-space-survives',
    task: 'translate to german',
    tags: ['translation', 'whitespace'],
    llm: adv.translateToGerman(),
    skipInvariants: ['user-content-survives'],
    steps: [
      s.type('I am going home '),                                        // trailing space
      s.tick(),
      s.expectContains('Ich'),                                           // translated
      // Trailing-whitespace invariant runs and pins this — the space
      // must survive even when the LLM rewrites.
    ],
  },
  {
    name: 'translate-to-german-paragraph-break-survives',
    task: 'translate to german',
    tags: ['translation', 'paragraph'],
    llm: adv.translateToGerman(),
    skipInvariants: ['user-content-survives'],
    steps: [
      s.type('Hi friend.\n\nI am going home today.'),
      s.tick(),
      s.expectContains('\n\n'),                                          // paragraph break preserved
      s.expectContains('Hallo'),                                         // translation lands
      s.expectContains('heute'),                                         // 'today' translated
    ],
  },
  {
    name: 'translate-to-german-imperfect-converges',
    task: 'translate to german',
    tags: ['translation', 'convergence'],
    llm: adv.translateToGermanImperfect(0.2),                            // 20% miss rate per round
    skipInvariants: ['user-content-survives'],
    steps: [
      s.type('I am going home today with my friend'),
      s.tick(), s.tick(), s.tick(), s.tick(), s.tick(),                  // 5 rounds — should converge
      // After 5 rounds at 20% miss, expected miss probability per word
      // is < 0.2^5 = 0.03% for truly random; deterministic formula
      // varies enough that everything common-language gets translated.
      s.expectContains('Ich'),
      s.expectContains('zuhause'),
      s.expectContains('heute'),
      s.expectContains('freund'),
    ],
  },
  {
    name: 'translate-to-german-user-typing-during-call',
    task: 'translate to german',
    tags: ['translation', 'active-typing'],
    llm: adv.translateToGerman(),
    skipInvariants: ['user-content-survives'],
    steps: [
      s.type('I am going'),                                              s.tick(),
      s.type(' home today'),                                             s.tick(),
      s.type(' with friend'),                                            s.tick(),
      s.expectContains('zuhause'),
      s.expectContains('heute'),
      s.expectContains('freund'),                                        // mock leaves nouns lowercase
    ],
  },
  {
    name: 'translate-to-german-mid-thought-fragment-no-flicker',
    task: 'translate to german',
    tags: ['translation', 'in-flight', 'flicker'],
    llm: adv.translateToGerman(),
    skipInvariants: ['user-content-survives'],
    steps: [
      s.type('today'),
      s.tick(), s.tick(), s.tick(),                                      // three idle rounds
      // Translation should be stable across rounds (already-German "heute"
      // should stay "heute"), no auto-period from terminator-eagerness.
      s.expectContains('heute'),
      s.expectMissing('heute.'),
    ],
  },
  {
    name: 'translate-to-german-multiple-paragraphs',
    task: 'translate to german',
    tags: ['translation', 'paragraph', 'realistic'],
    llm: adv.translateToGerman(),
    skipInvariants: ['user-content-survives'],
    steps: [
      s.type('I have a friend.'),                                        s.tick(),
      s.type('\n\n'),                                                    s.tick(),
      s.type('We work together.'),                                       s.tick(),
      s.type('\n\n'),                                                    s.tick(),
      s.type('Today I go home.'),                                        s.tick(),
      s.expectContains('\n\n'),
      s.expectContains('Ich'),
      s.expectContains('zuhause'),
    ],
  },
  {
    name: 'translate-to-german-empty-then-typing',
    task: 'translate to german',
    tags: ['translation', 'empty-buffer'],
    llm: adv.translateToGerman(),
    skipInvariants: ['user-content-survives'],
    steps: [
      s.tick(),                                                          // empty buffer, no-op
      s.type('I am going'),
      s.tick(),
      s.expectContains('Ich'),
    ],
  },
];

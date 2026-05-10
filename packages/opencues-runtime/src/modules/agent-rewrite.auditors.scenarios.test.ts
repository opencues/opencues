/**
 * AgentRewrite isolated-mode (Isolation B) scenario tests.
 *
 * Per spec/auditor-spec.md § Composition: when N auditors are active,
 * AgentRewrite fires N parallel LLM calls (one per auditor), each with
 * the same buffer + only that auditor's body. Results are diff-merged
 * by `priority:` — lower priority applied first; higher priority resolves
 * overlapping spans last (its rewrite wins). Alphabetical-by-name on
 * ties: alphabetically-earlier wins.
 *
 * These scenarios cover the multi-step user journey, not unit-level
 * behaviour of the merge function. For pure merge unit tests see
 * `mergeAuditorRewrites` tests below.
 */
import { describe, expect, it } from 'vitest';
import { AgentRewrite, mergeAuditorRewrites } from './agent-rewrite';
import { AgentTaskState } from '../state/agent-task';
import { DynDefs } from '../state/dyn-defs';
import { MockAdapter } from '../../testing/mock-adapter';

function llmResponse(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

/**
 * Inspect the LLM request body for the auditor section. Returns the
 * auditor name when the system prompt carries `(<name>)` from the
 * isolated-mode system prompt format, or null when this is a baseline
 * (no-auditor) call.
 */
function detectAuditor(body: string): string | null {
  let parsed: { messages?: Array<{ role: string; content: string }> };
  try { parsed = JSON.parse(body); } catch { return null; }
  const sys = parsed.messages?.find(m => m.role === 'system')?.content ?? '';
  const m = sys.match(/Additionally, apply this concern \(([^)]+)\):/);
  return m ? m[1] : null;
}

interface AuditorScenarioOpts {
  initialText: string;
  task?: string;
  auditors: Array<{ name: string; promptText: string; priority: number }>;
  /** Map auditor name → rewrite. Use `null` to simulate a per-auditor failure. */
  rewrites: Record<string, string | null>;
  /** Optional baseline rewrite (when auditors.length === 0). */
  baselineRewrite?: string;
  maxConcurrentAuditors?: number;
}

function setupAuditorScenario(opts: AuditorScenarioOpts) {
  const adapter = new MockAdapter({});
  adapter.pushText(opts.initialText, opts.initialText.length);
  const state = new AgentTaskState();
  state.arm(opts.task ?? 'rewrite');
  const dynDefs = new DynDefs();
  const callsByAuditor: Record<string, number> = {};
  let baselineCalls = 0;
  const httpAdapter = {
    post: async (_url: string, body: string) => {
      const auditorName = detectAuditor(body);
      if (auditorName === null) {
        baselineCalls += 1;
        const out = opts.baselineRewrite ?? opts.initialText;
        return llmResponse(`REWRITTEN:\n${out}\nEND`);
      }
      callsByAuditor[auditorName] = (callsByAuditor[auditorName] ?? 0) + 1;
      const rewrite = opts.rewrites[auditorName];
      if (rewrite === undefined) {
        throw new Error(`test: no rewrite stub for auditor "${auditorName}"`);
      }
      if (rewrite === null) {
        // Simulate provider returning malformed body.
        return 'not json';
      }
      return llmResponse(`REWRITTEN:\n${rewrite}\nEND`);
    },
  };
  const rewrite = new AgentRewrite(adapter, dynDefs, state, {
    endpoint: 'http://test',
    apiKey: 'x',
    defaultModel: 'm',
    cadenceMs: 1500,
    httpAdapter,
    auditorPrompts: () => opts.auditors,
    maxConcurrentAuditors: opts.maxConcurrentAuditors !== undefined
      ? () => opts.maxConcurrentAuditors!
      : undefined,
  });
  return { adapter, rewrite, getCallsByAuditor: () => callsByAuditor, getBaselineCalls: () => baselineCalls };
}

describe('AgentRewrite — isolated-mode auditor dispatch', () => {
  it('fires one LLM call per auditor in parallel', async () => {
    const scenario = setupAuditorScenario({
      initialText: 'helo wrld',
      auditors: [
        { name: 'grammar', promptText: 'fix grammar', priority: 50 },
        { name: 'spelling', promptText: 'fix spelling', priority: 50 },
      ],
      rewrites: {
        grammar: 'helo wrld',     // grammar auditor: no change
        spelling: 'hello world',  // spelling auditor: fixes typos
      },
    });
    await scenario.rewrite.tick();
    const calls = scenario.getCallsByAuditor();
    expect(calls.grammar).toBe(1);
    expect(calls.spelling).toBe(1);
    expect(scenario.getBaselineCalls()).toBe(0); // no baseline call when auditors are present
    expect(scenario.adapter.getText()).toBe('hello world');
  });

  it('zero auditors → one baseline call, no auditor calls', async () => {
    const scenario = setupAuditorScenario({
      initialText: 'helo',
      auditors: [],
      rewrites: {},
      baselineRewrite: 'hello',
    });
    await scenario.rewrite.tick();
    expect(scenario.getBaselineCalls()).toBe(1);
    expect(Object.keys(scenario.getCallsByAuditor())).toHaveLength(0);
    expect(scenario.adapter.getText()).toBe('hello');
  });

  it('one auditor → one LLM call carrying that auditor\'s body, no merge', async () => {
    const scenario = setupAuditorScenario({
      initialText: 'helo',
      auditors: [
        { name: 'spelling', promptText: 'fix spelling', priority: 50 },
      ],
      rewrites: { spelling: 'hello' },
    });
    await scenario.rewrite.tick();
    expect(scenario.getCallsByAuditor().spelling).toBe(1);
    expect(scenario.getBaselineCalls()).toBe(0);
    expect(scenario.adapter.getText()).toBe('hello');
  });

  it('non-overlapping diffs from two auditors → both applied', async () => {
    // Input has TWO problems in different spans: "helo" (front) + "wrld" (back).
    // Each auditor fixes one of them. The diffs don't overlap; both should land.
    const scenario = setupAuditorScenario({
      initialText: 'helo there wrld',
      auditors: [
        { name: 'spelling-a', promptText: 'fix front-of-buffer typos', priority: 50 },
        { name: 'spelling-b', promptText: 'fix back-of-buffer typos', priority: 50 },
      ],
      rewrites: {
        'spelling-a': 'hello there wrld',
        'spelling-b': 'helo there world',
      },
    });
    await scenario.rewrite.tick();
    expect(scenario.adapter.getText()).toBe('hello there world');
  });

  it('overlapping diffs → higher-priority wins', async () => {
    // Both auditors rewrite the SAME word. The higher-priority one's
    // version should land in the buffer.
    const scenario = setupAuditorScenario({
      initialText: 'gonna ship',
      auditors: [
        { name: 'tone-formal', promptText: 'expand contractions', priority: 70 },
        { name: 'tone-casual', promptText: 'preserve casual register', priority: 30 },
      ],
      rewrites: {
        'tone-formal': 'going to ship',
        'tone-casual': 'gonna ship',
      },
    });
    await scenario.rewrite.tick();
    expect(scenario.adapter.getText()).toBe('going to ship');
  });

  it('equal-priority overlap → alphabetically-earlier name wins', async () => {
    // british-english and grammar both at priority 50; both rewrite the same span.
    // british-english should win on alphabetical tiebreak.
    const scenario = setupAuditorScenario({
      initialText: 'organize the team',
      auditors: [
        { name: 'british-english', promptText: 'use -ise', priority: 50 },
        { name: 'grammar', promptText: 'general grammar', priority: 50 },
      ],
      rewrites: {
        'british-english': 'organise the team',
        'grammar': 'organized the team', // disagrees on the span — past tense
      },
    });
    await scenario.rewrite.tick();
    expect(scenario.adapter.getText()).toBe('organise the team');
  });

  it('one auditor fails → other auditor\'s rewrite still applied', async () => {
    const scenario = setupAuditorScenario({
      initialText: 'helo',
      auditors: [
        { name: 'broken', promptText: 'broken auditor', priority: 50 },
        { name: 'spelling', promptText: 'fix spelling', priority: 50 },
      ],
      rewrites: {
        broken: null,        // simulated provider failure
        spelling: 'hello',
      },
    });
    await scenario.rewrite.tick();
    expect(scenario.adapter.getText()).toBe('hello');
  });

  it('all auditors fail → buffer unchanged, no rewrite applied', async () => {
    const scenario = setupAuditorScenario({
      initialText: 'helo',
      auditors: [
        { name: 'a', promptText: 'a', priority: 50 },
        { name: 'b', promptText: 'b', priority: 50 },
      ],
      rewrites: { a: null, b: null },
    });
    await scenario.rewrite.tick();
    expect(scenario.adapter.getText()).toBe('helo');
  });

  it('maxConcurrentAuditors caps the active list to top-N priority-desc', async () => {
    const scenario = setupAuditorScenario({
      initialText: 'helo wrld',
      auditors: [
        { name: 'a-priority-90', promptText: '...', priority: 90 },
        { name: 'b-priority-80', promptText: '...', priority: 80 },
        { name: 'c-priority-70', promptText: '...', priority: 70 },
        { name: 'd-priority-60', promptText: '...', priority: 60 },
      ],
      rewrites: {
        'a-priority-90': 'hello wrld',
        'b-priority-80': 'hello wrld',
        'c-priority-70': 'helo world',  // shouldn't fire
        'd-priority-60': 'helo world',  // shouldn't fire
      },
      maxConcurrentAuditors: 2,
    });
    await scenario.rewrite.tick();
    const calls = scenario.getCallsByAuditor();
    expect(calls['a-priority-90']).toBe(1);
    expect(calls['b-priority-80']).toBe(1);
    expect(calls['c-priority-70']).toBeUndefined();
    expect(calls['d-priority-60']).toBeUndefined();
    // Only the front-of-buffer rewrite (from a/b) lands; back-of-buffer "wrld"
    // stays unfixed because c/d never fired.
    expect(scenario.adapter.getText()).toBe('hello wrld');
  });

  it('toggling an auditor between ticks invalidates the cache', async () => {
    // Round 1: two auditors active. Round 2: one auditor disabled (signature
    // changes). The cache must NOT serve round 1's merged rewrite.
    const adapter = new MockAdapter({});
    adapter.pushText('helo wrld', 9);
    const state = new AgentTaskState();
    state.arm('rewrite');
    const dynDefs = new DynDefs();
    let activeAuditors = [
      { name: 'spelling-a', promptText: 'front', priority: 50 },
      { name: 'spelling-b', promptText: 'back', priority: 50 },
    ];
    const callsByAuditor: Record<string, number> = {};
    const httpAdapter = {
      post: async (_url: string, body: string) => {
        const name = detectAuditor(body);
        if (name === null) return llmResponse(`REWRITTEN:\nhelo wrld\nEND`);
        callsByAuditor[name] = (callsByAuditor[name] ?? 0) + 1;
        const rewrite = name === 'spelling-a' ? 'hello wrld'
                      : name === 'spelling-b' ? 'helo world'
                      : 'helo wrld';
        return llmResponse(`REWRITTEN:\n${rewrite}\nEND`);
      },
    };
    const rewrite = new AgentRewrite(adapter, dynDefs, state, {
      endpoint: 'http://test', apiKey: 'x', defaultModel: 'm',
      cadenceMs: 1500, httpAdapter,
      auditorPrompts: () => activeAuditors,
    });
    await rewrite.tick();
    expect(adapter.getText()).toBe('hello world');  // both auditors applied
    expect(callsByAuditor['spelling-a']).toBe(1);
    expect(callsByAuditor['spelling-b']).toBe(1);

    // Reset the buffer for round 2 (the agent applied the merged rewrite,
    // which would normally lead to a stable round; we want to test the
    // cache, so re-set to the original).
    adapter.pushText('helo wrld', 9);

    // Disable spelling-b → signature changes → cache miss expected on the
    // round 2 tick. We should see spelling-a fire AGAIN.
    activeAuditors = [
      { name: 'spelling-a', promptText: 'front', priority: 50 },
    ];
    await rewrite.tick();
    expect(adapter.getText()).toBe('hello wrld'); // only spelling-a applied
    expect(callsByAuditor['spelling-a']).toBe(2);  // fired again — no cache hit
  });
});

describe('mergeAuditorRewrites — pure function', () => {
  it('returns input snapshot when all auditors propose no-op rewrites', () => {
    const result = mergeAuditorRewrites('hello world', [
      { name: 'a', priority: 50, rewrite: 'hello world' },
      { name: 'b', priority: 50, rewrite: 'hello world' },
    ]);
    expect(result).toBe('hello world');
  });

  it('applies non-overlapping diffs from multiple auditors together', () => {
    // First word + last word changed by different auditors; spans don't overlap.
    const result = mergeAuditorRewrites('apple banana cherry', [
      { name: 'a', priority: 50, rewrite: 'APPLE banana cherry' },
      { name: 'b', priority: 50, rewrite: 'apple banana CHERRY' },
    ]);
    expect(result).toBe('APPLE banana CHERRY');
  });

  it('higher priority wins on overlapping spans', () => {
    const result = mergeAuditorRewrites('foo', [
      { name: 'low', priority: 10, rewrite: 'lowfoo' },
      { name: 'high', priority: 90, rewrite: 'highfoo' },
    ]);
    expect(result).toBe('highfoo');
  });

  it('alphabetically-earlier wins on equal-priority overlap', () => {
    const result = mergeAuditorRewrites('foo', [
      { name: 'zebra', priority: 50, rewrite: 'zebrafoo' },
      { name: 'apple', priority: 50, rewrite: 'applefoo' },
    ]);
    expect(result).toBe('applefoo');
  });

  it('empty rewrite list returns snapshot unchanged', () => {
    expect(mergeAuditorRewrites('hello', [])).toBe('hello');
  });
});

/**
 * Typing simulator. Runs a scenario step-by-step against a real
 * AgentRewrite instance with a configurable LLM (mock | identity |
 * groq) and records:
 *   - Buffer state after every step.
 *   - Invariant violations after every tick.
 *   - Expectation failures (expectBuffer / expectContains / expectMissing).
 *
 * Returns a ScenarioResult describing what happened. Tests + the
 * discovery script consume this.
 */
import { AgentRewrite } from '../../../../packages/opencues-runtime/src/modules/agent-rewrite';
import { AgentTaskState } from '../../../../packages/opencues-runtime/src/state/agent-task';
import { DynDefs } from '../../../../packages/opencues-runtime/src/state/dyn-defs';
import { MockAdapter } from '../../../../packages/opencues-runtime/testing/mock-adapter';
import { chat } from '../groq';
import { getInvariants, withCustomInvariants } from './invariants';
import type {
  Invariant,
  InvariantContext,
  InvariantViolation,
  LlmMode,
  ScenarioResult,
  ScenarioState,
  Step,
} from './types';

function llmEnvelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

function wrapAsRewriteOutput(text: string): string {
  return `REWRITTEN:\n${text}\nEND`;
}

const REWRITE_SYSTEM_PROMPT_FOR_GROQ = `You are an inline editor. The user is composing a document and has given you a TASK. Your job: return the rewritten document with the task applied.

The DOCUMENT contains a [CURSOR] marker showing where the user is currently typing. You MUST omit the [CURSOR] marker from your output. Use it to identify the IN-FLIGHT SENTENCE which the user is still composing and may extend at any moment.

Rules:
- Output the ENTIRE rewritten document. Strip the [CURSOR] marker.
- Apply baseline edits even if the TASK doesn't explicitly ask: capitalise sentence-starts and proper nouns, fix obvious typos, collapse duplicated stop-words.
- TERMINAL PUNCTUATION: add it ONLY when the sentence has a clear next-sentence after it. NEVER add to the IN-FLIGHT SENTENCE or to the document-final sentence.
- WHITESPACE STRUCTURE IS SACRED. Reproduce every newline EXACTLY. \\n\\n stays \\n\\n. Do NOT collapse paragraph breaks.
- Do NOT add stylistic punctuation. Do NOT add commentary or code fences.

Output format:

REWRITTEN:
<the entire rewritten document, with [CURSOR] stripped>
END`;

export interface SimulateOptions {
  readonly task: string;
  readonly llm: LlmMode;
  readonly extraInvariants?: Invariant[];
  /** Stop the run as soon as any invariant fires. Default true. */
  readonly stopOnViolation?: boolean;
  /** Invariants (by name) to skip — useful for translation/transform tasks. */
  readonly skipInvariants?: ReadonlyArray<string>;
}

export async function simulate(name: string, steps: ReadonlyArray<Step>, opts: SimulateOptions): Promise<ScenarioResult> {
  const adapter = new MockAdapter({});
  const state = new AgentTaskState();
  state.arm(opts.task);
  const dynDefs = new DynDefs();

  let tickIdx = 0;
  const httpAdapter = {
    post: async (_url: string, body: string): Promise<string> => {
      const parsed = JSON.parse(body);
      const userMsg: string = parsed.messages[1].content;
      const docStart = userMsg.indexOf('DOCUMENT:\n') + 'DOCUMENT:\n'.length;
      const snapshot = userMsg.slice(docStart).replace(/\[CURSOR\]/g, '');

      const text = await invokeLlm(opts.llm, snapshot, opts.task, tickIdx);
      tickIdx += 1;
      return llmEnvelope(wrapAsRewriteOutput(text));
    },
  };

  const rewrite = new AgentRewrite(adapter, dynDefs, state, {
    endpoint: 'http://test', apiKey: 'x', defaultModel: 'm', httpAdapter,
  });

  const trace: ScenarioState[] = [];
  const violations: InvariantViolation[] = [];
  const allInvariants = opts.extraInvariants
    ? withCustomInvariants(opts.extraInvariants)
    : getInvariants();
  const skipSet = new Set(opts.skipInvariants ?? []);
  const invariants = allInvariants.filter(inv => !skipSet.has(inv.name));
  const stopOnViolation = opts.stopOnViolation ?? true;
  const stopMarker = { stopped: false };
  let userTypedSoFar = '';
  let bufferBeforeLastTick = '';
  const history: string[] = [];
  let tickCount = 0;
  let passed = true;

  const recordViolations = () => {
    const ctx: InvariantContext = {
      userTypedSoFar,
      bufferNow: adapter.getText(),
      bufferBeforeLastTick,
      history: history.slice(),
      cursorNow: adapter.getCursorOffset(),
    };
    for (const inv of invariants) {
      const msg = inv.check(ctx);
      if (msg !== null) {
        violations.push({
          invariant: inv.name,
          tickCount,
          message: msg,
          bufferAtViolation: ctx.bufferNow,
        });
        passed = false;
        if (stopOnViolation) stopMarker.stopped = true;
      }
    }
  };

  for (const step of steps) {
    if (stopMarker.stopped) break;
    const bufferBefore = adapter.getText();

    switch (step.kind) {
      case 'type': {
        userTypedSoFar += step.text;
        const newText = adapter.getText() + step.text;
        adapter.pushText(newText, newText.length);
        break;
      }
      case 'replace': {
        userTypedSoFar = step.text;                                    // user replaced everything (paste)
        adapter.pushText(step.text, step.text.length);
        break;
      }
      case 'moveCursor': {
        const len = adapter.getText().length;
        adapter.pushText(adapter.getText(), Math.max(0, Math.min(step.pos, len)));
        break;
      }
      case 'tick': {
        bufferBeforeLastTick = adapter.getText();
        await rewrite.tick();
        history.push(adapter.getText());
        tickCount += 1;
        recordViolations();
        break;
      }
      case 'expectBuffer': {
        if (adapter.getText() !== step.expected) {
          violations.push({
            invariant: 'expect-buffer',
            tickCount,
            message: `expected ${JSON.stringify(step.expected)}, got ${JSON.stringify(adapter.getText())}`,
            bufferAtViolation: adapter.getText(),
          });
          passed = false;
        }
        break;
      }
      case 'expectContains': {
        if (!adapter.getText().includes(step.needle)) {
          violations.push({
            invariant: 'expect-contains',
            tickCount,
            message: `expected buffer to contain ${JSON.stringify(step.needle)}; buffer was ${JSON.stringify(adapter.getText())}`,
            bufferAtViolation: adapter.getText(),
          });
          passed = false;
        }
        break;
      }
      case 'expectMissing': {
        if (adapter.getText().includes(step.forbidden)) {
          violations.push({
            invariant: 'expect-missing',
            tickCount,
            message: `expected buffer to NOT contain ${JSON.stringify(step.forbidden)}; buffer was ${JSON.stringify(adapter.getText())}`,
            bufferAtViolation: adapter.getText(),
          });
          passed = false;
        }
        break;
      }
      case 'note':
        break;     // diagnostic only
    }

    trace.push({
      bufferBefore,
      bufferAfter: adapter.getText(),
      cursorAfter: adapter.getCursorOffset(),
      step,
      tickCount,
    });
  }

  return { name, trace, violations, passed };
}

async function invokeLlm(mode: LlmMode, snapshot: string, task: string, tickIdx: number): Promise<string> {
  switch (mode.kind) {
    case 'identity':
      return snapshot;
    case 'mock':
      return mode.respond(snapshot, task, tickIdx);
    case 'groq': {
      const res = await chat(
        [
          { role: 'system', content: REWRITE_SYSTEM_PROMPT_FOR_GROQ },
          { role: 'user', content: `TASK: ${mode.task ?? task}\nDOCUMENT:\n${snapshot}` },
        ],
        { temperature: 0, maxTokens: Math.max(1024, snapshot.length * 2 + 256), seed: 42 },
      );
      // Extract the text between REWRITTEN: and END (same as runtime parser).
      const m = res.text.match(/REWRITTEN:\s*\n([\s\S]*?)(?:\n\s*END\s*$|$)/i);
      return m ? m[1].trim() : res.text.trim();
    }
  }
}

/**
 * Pretty-print a scenario result for human consumption. Used by the
 * discovery runner and by failing tests.
 */
export function reportResult(r: ScenarioResult): string {
  const lines: string[] = [];
  lines.push(`\n=== ${r.name} — ${r.passed ? 'PASS' : 'FAIL'} ===`);
  for (const s of r.trace) {
    const stepLabel = stepDescription(s.step);
    lines.push(`  ${stepLabel.padEnd(40)} | tick ${s.tickCount} | buf=${JSON.stringify(s.bufferAfter.slice(0, 60))}`);
  }
  if (r.violations.length > 0) {
    lines.push('');
    lines.push('Violations:');
    for (const v of r.violations) {
      lines.push(`  [tick ${v.tickCount}] ${v.invariant}: ${v.message}`);
    }
  }
  return lines.join('\n');
}

function stepDescription(s: Step): string {
  switch (s.kind) {
    case 'type': return `type ${JSON.stringify(s.text.slice(0, 24))}`;
    case 'replace': return `replace ${JSON.stringify(s.text.slice(0, 24))}`;
    case 'moveCursor': return `moveCursor ${s.pos}`;
    case 'tick': return `tick`;
    case 'expectBuffer': return `expectBuffer ${JSON.stringify(s.expected.slice(0, 24))}`;
    case 'expectContains': return `expectContains ${JSON.stringify(s.needle.slice(0, 24))}`;
    case 'expectMissing': return `expectMissing ${JSON.stringify(s.forbidden.slice(0, 24))}`;
    case 'note': return `note "${s.label}"`;
  }
}

// Step factories — a fluent way to write scenarios.
export const step = {
  type: (text: string): Step => ({ kind: 'type', text }),
  replace: (text: string): Step => ({ kind: 'replace', text }),
  moveCursor: (pos: number): Step => ({ kind: 'moveCursor', pos }),
  tick: (): Step => ({ kind: 'tick' }),
  expectBuffer: (expected: string): Step => ({ kind: 'expectBuffer', expected }),
  expectContains: (needle: string): Step => ({ kind: 'expectContains', needle }),
  expectMissing: (forbidden: string): Step => ({ kind: 'expectMissing', forbidden }),
  note: (label: string): Step => ({ kind: 'note', label }),
};

/**
 * Property-based fuzzer.
 *
 * Generates random typing scripts (chunks + ticks + cursor moves) and
 * runs them through the simulator with each adversarial LLM. After
 * every tick, the standard invariant set runs. Any violation is a
 * deterministic bug repro (the (seed, script, llm) triple).
 *
 * Use this to surface bugs you didn't think of. Curated scenarios
 * encode KNOWN failure modes; the fuzzer surfaces UNKNOWN ones.
 */
import { simulate } from './simulator';
import * as adv from './adversarial-llms';
import type { LlmMode, ScenarioResult, Step } from './types';
import { step as s } from './simulator';

/** Deterministic PRNG so failures reproduce. */
class Rng {
  constructor(private state: number) {
    if (state === 0) this.state = 1;
  }
  next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x | 0;
    return ((this.state >>> 0) / 0xffffffff);
  }
  pick<T>(arr: ReadonlyArray<T>): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  intInRange(lo: number, hi: number): number {
    return Math.floor(lo + this.next() * (hi - lo));
  }
}

const WORD_CHOICES = [
  'hi', 'there', 'today', 'tomorrow', 'soon', 'I', 'we', 'you',
  'rite', 'write', 'thinking', 'going', 'maybe', 'cool', 'nice',
  'food', 'place', 'time', 'with', 'and', 'so', 'but', 'or',
  'really', 'very', 'much', 'good',
];

const PUNCT_CHOICES = ['.', '?', '!', ','];
const SEP_CHOICES = [' ', ' ', ' ', '\n', '\n\n', ' \n', '  '];

function randomTypeChunk(rng: Rng): string {
  const kind = rng.next();
  if (kind < 0.5) return rng.pick(WORD_CHOICES);
  if (kind < 0.75) return rng.pick(SEP_CHOICES);
  if (kind < 0.9) return rng.pick(WORD_CHOICES) + rng.pick(PUNCT_CHOICES);
  return rng.pick(WORD_CHOICES) + ' ' + rng.pick(WORD_CHOICES);
}

function generateScript(rng: Rng, length: number): Step[] {
  const out: Step[] = [];
  let typed = 0;
  for (let i = 0; i < length; i += 1) {
    const action = rng.next();
    if (action < 0.7) {
      const chunk = randomTypeChunk(rng);
      out.push(s.type(chunk));
      typed += chunk.length;
    } else if (action < 0.95) {
      out.push(s.tick());
    } else {
      out.push(s.moveCursor(rng.intInRange(0, typed + 1)));
    }
  }
  // Always end with a final tick so any pending invariants check at the end.
  out.push(s.tick());
  return out;
}

const ADVERSARIAL_LLMS: ReadonlyArray<{ name: string; llm: LlmMode }> = [
  { name: 'identity', llm: { kind: 'identity' } },
  { name: 'echo', llm: adv.adversarialEcho() },
  { name: 'spelling-fix', llm: adv.spellingFix() },
  { name: 'trim-trailing-ws', llm: adv.adversarialTrimTrailingWS() },
  { name: 'collapse-paragraphs', llm: adv.adversarialCollapseParagraphs() },
  { name: 'terminator-eager', llm: adv.adversarialTerminatorEager() },
  { name: 'canonicalise-ws', llm: adv.adversarialCanonicaliseWhitespace() },
  { name: 'capitalise', llm: adv.adversarialCapitalise() },
  { name: 'kitchen-sink', llm: adv.adversarialKitchenSink() },
  { name: 'end-marker-leak', llm: adv.adversarialEndMarkerLeak() },
];

export interface FuzzReport {
  readonly seedsRun: number;
  readonly violations: ReadonlyArray<{
    readonly seed: number;
    readonly llmName: string;
    readonly result: ScenarioResult;
  }>;
}

/**
 * Run `n` random scripts × every adversarial LLM. Returns a list of
 * any (seed, llm) combinations that produced invariant violations.
 *
 * Default: 30 seeds × 10 LLMs = 300 random combinations per call.
 * Each script is 12 steps long (chunks of typing + ticks +
 * occasional cursor moves).
 */
export async function fuzz(opts: {
  seeds?: number;
  scriptLength?: number;
  baseSeed?: number;
  task?: string;
  stopOnFirst?: boolean;
} = {}): Promise<FuzzReport> {
  const seeds = opts.seeds ?? 30;
  const scriptLength = opts.scriptLength ?? 12;
  const baseSeed = opts.baseSeed ?? 1;
  const task = opts.task ?? 'fix everything';
  const stopOnFirst = opts.stopOnFirst ?? false;

  const violations: FuzzReport['violations'] = [];
  for (let i = 0; i < seeds; i += 1) {
    const seed = baseSeed + i * 1000003;
    const rng = new Rng(seed);
    const script = generateScript(rng, scriptLength);
    for (const { name, llm } of ADVERSARIAL_LLMS) {
      const result = await simulate(`fuzz-seed-${seed}-${name}`, script, {
        task, llm, stopOnViolation: false,
      });
      if (!result.passed) {
        (violations as Array<typeof violations[number]>).push({ seed, llmName: name, result });
        if (stopOnFirst) return { seedsRun: i + 1, violations };
      }
    }
  }
  return { seedsRun: seeds, violations };
}

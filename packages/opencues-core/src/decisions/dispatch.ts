/**
 * dispatchDecision — the ONE chokepoint every decision leg calls.
 *
 * Mirrors what `dispatchChat` does for chat calls, for the same reasons:
 *   1. the outbound PII floor runs here, so no leg can bypass it
 *      (docs/architecture/hydration-dehydration.md — the decision channel
 *      is a row in the coverage table);
 *   2. usage is reported here, so `opencues usage` sees every decision call
 *      with no per-leg wiring;
 *   3. the request is validated here against the API's hard limits and the
 *      one authoring footgun we hit in the benches (array-index path
 *      references), so a bad question fails loudly at build time instead of
 *      silently answering about the neighbouring rule.
 *
 * The state is dehydrated by walking every string in it. Question text is
 * NOT dehydrated: questions are static catalogue text by construction (a
 * `when:` line, a rule statement) and rewriting them would turn an
 * instruction into a self-contradiction — the same reasoning that keeps the
 * chat floor off the SYSTEM message (llm-provider.ts, issue #279). A hit
 * inside question text is logged as a warning instead, because it means a
 * leg is composing user text into a question.
 */
import { getOutboundDehydrationGuard } from '../llm-provider';
import { reportUsage, hasUsageSinks } from '../usage-meter';
import {
  DecisionError,
  DECISION_LIMITS,
  type DecisionContext,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResult,
  type DecisionValue,
} from './types';

/** `rules[3]`, `items[0].text` — an index path inside backticks. The wire
 *  reads these one-off (measured: 11 of 27 flags cited the neighbouring
 *  rule). Key state objects by name and reference `rules.r4` instead. */
const INDEX_PATH = /`[^`]*\[\d+\][^`]*`/;

function walkStrings(v: DecisionValue, fn: (s: string) => void): void {
  if (typeof v === 'string') fn(v);
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, fn));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => walkStrings(x, fn));
}

function mapStrings(v: DecisionValue, fn: (s: string) => string): DecisionValue {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === 'object') {
    const out: Record<string, DecisionValue> = {};
    for (const [k, x] of Object.entries(v)) out[k] = mapStrings(x, fn);
    return out;
  }
  return v;
}

/** Throws a `shape` DecisionError on anything the wire would reject or misread. Exported for tests. */
export function validateDecisionRequest(req: DecisionRequest): void {
  const ids = Object.keys(req.questions);
  if (ids.length === 0) throw new DecisionError('shape', 'decision: a request needs at least one question');
  for (const id of ids) {
    const q: DecisionQuestion = req.questions[id];
    let refs = '';
    walkStrings(q.instructions, (s) => { if (INDEX_PATH.test(s)) refs = s; });
    if (refs) throw new DecisionError('shape', `decision: question ${id} references an array index (${refs.match(INDEX_PATH)?.[0]}); key the state by name and reference \`rules.r4\`-style paths instead`);
    if (q.type === 'choice') {
      const n = Object.keys(q.criteria).length;
      if (n < 1) throw new DecisionError('shape', `decision: choice ${id} has no options`);
      if (n > DECISION_LIMITS.maxChoiceOptions) throw new DecisionError('shape', `decision: choice ${id} has ${n} options; the limit is ${DECISION_LIMITS.maxChoiceOptions}`);
    } else if (q.type === 'score') {
      const n = q.criteria.length;
      if (n < DECISION_LIMITS.minScoreLevels || n > DECISION_LIMITS.maxScoreLevels) throw new DecisionError('shape', `decision: score ${id} has ${n} levels; allowed ${DECISION_LIMITS.minScoreLevels}–${DECISION_LIMITS.maxScoreLevels}`);
    } else if (q.type !== 'noul') {
      throw new DecisionError('shape', `decision: question ${id} has unknown type ${String((q as { type: unknown }).type)}`);
    }
  }
}

/** Apply the registered PII floor to the state; count hits inside question text without rewriting. Exported for tests. */
export function applyDecisionDehydrationFloor<Q extends Readonly<Record<string, DecisionQuestion>>>(
  req: DecisionRequest<Q>,
  warn: (msg: string) => void,
): DecisionRequest<Q> {
  let guard: ReturnType<NonNullable<ReturnType<typeof getOutboundDehydrationGuard>>> | null = null;
  try { guard = getOutboundDehydrationGuard()?.() ?? null; } catch { return req; }
  if (!guard || guard.size === 0) return req;
  let caught = 0;
  const state = mapStrings(req.state, (s) => {
    const d = guard!.dehydrate(s);
    if (!d.changed) return s;
    caught += d.spans.length;
    return d.text;
  });
  let questionHits = 0;
  for (const q of Object.values(req.questions)) {
    walkStrings(q.instructions, (s) => { if (guard!.dehydrate(s).changed) questionHits++; });
    walkStrings((q as { criteria?: DecisionValue }).criteria ?? null, (s) => { if (guard!.dehydrate(s).changed) questionHits++; });
  }
  if (questionHits > 0) warn(`[decision] outbound PII floor: ${questionHits} catalog value(s) matched inside QUESTION text — left untouched (a leg is composing user text into a question; move it into the state)`);
  if (caught === 0) return req;
  warn(`[decision] outbound PII floor caught ${caught} residual value(s) in the state — a leg is missing dehydration (scrubbed before dispatch)`);
  return { ...req, state };
}

export interface DispatchDecisionContext extends DecisionContext {
  /** Names the leg in log lines and lets the bench attribute usage. */
  readonly leg?: string;
}

/**
 * Validate → dehydrate → ask → report usage. Errors are DecisionError;
 * nothing here swallows one — a leg decides whether to fall through to its
 * chat path, and the log line is the only signal, so it is always written.
 */
export async function dispatchDecision<Q extends Readonly<Record<string, DecisionQuestion>>>(
  provider: DecisionProvider,
  req: DecisionRequest<Q>,
  ctx: DispatchDecisionContext = {},
): Promise<DecisionResult<Q>> {
  const log = (line: string): void => ctx.log?.(`[decision]${ctx.leg ? `[${ctx.leg}]` : ''} ${line}`);
  validateDecisionRequest(req);
  const safe = applyDecisionDehydrationFloor(req, (m) => log(m));
  try {
    const res = await provider.ask(safe, { signal: ctx.signal, log });
    if (hasUsageSinks()) {
      reportUsage({ providerId: provider.id, model: res.model, promptTokens: res.usage.inputTokens, cachedTokens: 0, completionTokens: res.usage.outputTokens });
    }
    log(`${provider.id}/${res.model} ${Object.keys(req.questions).length}q ${res.usage.inputTokens}in/${res.usage.outputTokens}out ${res.ms}ms`);
    return res;
  } catch (e) {
    const err = e instanceof DecisionError ? e : new DecisionError('transport', `decision: ${(e as Error)?.message ?? String(e)}`, e);
    log(`${provider.id} failed (${err.kind}): ${err.message}`);
    throw err;
  }
}

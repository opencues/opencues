/**
 * TypeSafe adapter — POST https://api.typesafe.ai/v1/systemone.
 *
 * Wire shape (docs.typesafe.ai/api): `{state, model, questions}` in,
 * `{model, answers, usage: {input_tokens, output_tokens}}` out. Errors are
 * `{detail: ...}` bodies: 401 auth, 400 `{error_type: "max_tokens_exceeded"}`
 * for the budget, 400 with a `detail` string for too many options/levels,
 * 429/529 `{error_type: "system_overloaded"}`. (The docs say 422 for the
 * budget; the wire says 400 — measured 2026-09-16.)
 *
 * The model is PINNED. `jev-latest` and `jev-preview` both resolved to
 * jev-1.13.0 on 2026-09-16 and `jev-1.12` was already gone, so an alias in
 * production would move under us between releases; a pin + bench-on-bump
 * does not. `opencues doctor` compares the pin to /v1/models.
 *
 * `HttpAdapter.post` resolves the body for every status (it carries no
 * status code), so errors are classified from the body. One retry on
 * overloaded, after a short backoff, matching the SDK's default policy in
 * spirit (their SDK retries 2×; we retry once because a pause-time caller
 * would rather fall through than wait).
 */
import {
  DecisionError,
  type DecisionContext,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResult,
  type AnswersFor,
} from './types';
import type { HttpAdapter } from '../types';

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_MODELS_ENDPOINT = 'https://api.typesafe.ai/v1/models';
export const TYPESAFE_ENV_KEY = 'TYPESAFE_API_KEY';
/** Bench-on-bump: every gate in tests/benchmarks/decisions/ was run against this version. */
export const TYPESAFE_PINNED_MODEL = 'jev-1.13.0';

export interface TypeSafeProviderConfig {
  readonly apiKey: string;
  readonly httpAdapter: Pick<HttpAdapter, 'post'>;
  readonly endpoint?: string;
  readonly model?: string;
  /** ms before the single overloaded retry. Default 800. */
  readonly retryDelayMs?: number;
  /** Test hook — replaces the backoff sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Build the exact JSON body the endpoint expects. Exported for tests and the bench runner. */
export function buildTypeSafeBody(req: DecisionRequest, model: string): string {
  return JSON.stringify({ state: req.state, model, questions: req.questions });
}

interface WireOk {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number };
}
interface WireErr { detail?: unknown }

/** Classify a response body. Exported so the fallback/bench can share the parser. */
export function parseTypeSafeBody(raw: string): { ok: true; body: WireOk } | { ok: false; error: DecisionError } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    return { ok: false, error: new DecisionError('malformed', `typesafe: non-JSON response (${raw.slice(0, 120)})`) };
  }
  const obj = parsed as Partial<WireOk> & WireErr;
  if (obj && typeof obj === 'object' && obj.answers && typeof obj.answers === 'object') {
    return { ok: true, body: obj as WireOk };
  }
  const detail = obj?.detail;
  const errorType = detail && typeof detail === 'object' ? (detail as { error_type?: string }).error_type : undefined;
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail ?? raw).slice(0, 200);
  if (errorType === 'max_tokens_exceeded') return { ok: false, error: new DecisionError('budget', `typesafe: request over the token budget (${text})`, detail) };
  if (errorType === 'system_overloaded') return { ok: false, error: new DecisionError('overloaded', `typesafe: overloaded (${text})`, detail) };
  if (/unauthori[sz]ed|invalid api key|authentication/i.test(text)) return { ok: false, error: new DecisionError('auth', `typesafe: ${text}`, detail) };
  if (/rate limit|too many requests/i.test(text)) return { ok: false, error: new DecisionError('overloaded', `typesafe: ${text}`, detail) };
  if (/too many (choices|score levels)|must have at (most|least)|unknown model|validation/i.test(text)) return { ok: false, error: new DecisionError('shape', `typesafe: ${text}`, detail) };
  return { ok: false, error: new DecisionError('malformed', `typesafe: unexpected response (${text})`, detail) };
}

/** Coerce a wire answer into the typed contract; throws `malformed` on a shape we don't recognise. */
export function normalizeAnswer(id: string, a: Record<string, unknown>): AnswersFor<Record<string, DecisionQuestion>>[string] {
  const num = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || Number.isNaN(v)) throw new DecisionError('malformed', `typesafe: answer ${id}.${what} is not a number`);
    return v;
  };
  const probs = (v: unknown): Record<string, number> => {
    if (!v || typeof v !== 'object') throw new DecisionError('malformed', `typesafe: answer ${id}.probabilities missing`);
    const out: Record<string, number> = {};
    for (const [k, p] of Object.entries(v as Record<string, unknown>)) out[k] = num(p, `probabilities.${k}`);
    return out;
  };
  switch (a.type) {
    case 'noul': return { type: 'noul', noul: num(a.noul, 'noul') };
    case 'choice': return { type: 'choice', choice: String(a.choice), probabilities: probs(a.probabilities), confidence: num(a.confidence, 'confidence') };
    case 'score': return { type: 'score', score: num(a.score, 'score'), probabilities: probs(a.probabilities), confidence: num(a.confidence, 'confidence') };
    default: throw new DecisionError('malformed', `typesafe: answer ${id} has unknown type ${String(a.type)}`);
  }
}

export class TypeSafeDecisionProvider implements DecisionProvider {
  readonly id = 'typesafe';
  readonly model: string;
  private readonly endpoint: string;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly cfg: TypeSafeProviderConfig) {
    this.model = cfg.model ?? TYPESAFE_PINNED_MODEL;
    this.endpoint = cfg.endpoint ?? TYPESAFE_ENDPOINT;
    this.retryDelayMs = cfg.retryDelayMs ?? 800;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async ask<Q extends Readonly<Record<string, DecisionQuestion>>>(req: DecisionRequest<Q>, ctx: DecisionContext = {}): Promise<DecisionResult<Q>> {
    const body = buildTypeSafeBody(req, this.model);
    const headers = { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' };
    const t0 = Date.now();
    let raw: string;
    try {
      raw = await this.cfg.httpAdapter.post(this.endpoint, body, headers, { signal: ctx.signal });
    } catch (e) {
      throw new DecisionError('transport', `typesafe: ${(e as Error)?.message ?? String(e)}`, e);
    }
    let parsed = parseTypeSafeBody(raw);
    if (!parsed.ok && parsed.error.kind === 'overloaded' && !ctx.signal?.aborted) {
      ctx.log?.(`typesafe overloaded — retrying once after ${this.retryDelayMs}ms`);
      await this.sleep(this.retryDelayMs);
      try {
        raw = await this.cfg.httpAdapter.post(this.endpoint, body, headers, { signal: ctx.signal });
      } catch (e) {
        throw new DecisionError('transport', `typesafe: ${(e as Error)?.message ?? String(e)}`, e);
      }
      parsed = parseTypeSafeBody(raw);
    }
    if (!parsed.ok) throw parsed.error;
    const ms = Date.now() - t0;
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(req.questions)) {
      const a = parsed.body.answers[id];
      if (!a) throw new DecisionError('malformed', `typesafe: no answer for question ${id}`);
      answers[id] = normalizeAnswer(id, a);
    }
    return {
      answers: answers as AnswersFor<Q>,
      model: parsed.body.model || this.model,
      usage: { inputTokens: parsed.body.usage?.input_tokens ?? 0, outputTokens: parsed.body.usage?.output_tokens ?? 0 },
      ms,
    };
  }
}

/**
 * Chat fallback — the same DecisionProvider contract served by a chat model.
 *
 * Exists so the decision layer (and the open standard's future `questions:`
 * block) never depends on one vendor. One chat call per request, a strict
 * JSON answer object, temperature 0. The probabilities it returns are the
 * model's SELF-REPORTED confidence, not a calibrated distribution: a chat
 * model has no distribution to give, so for a choice the top option gets the
 * reported confidence and the remainder is spread evenly. Treat its
 * `confidence` as ordinal at best. Benched against Jev in step 8 of the
 * integration plan; until then it is the emergency path when no decision key
 * is present, not a peer.
 *
 * The caller supplies the chat function (bound to whatever cues-bucket
 * provider is configured) so this file has no provider or HTTP dependency.
 */
import {
  DecisionError,
  type ChoiceQuestion,
  type DecisionContext,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResult,
  type AnswersFor,
  type ScoreQuestion,
} from './types';

export type ChatFn = (system: string, user: string, ctx: { signal?: AbortSignal }) => Promise<string>;

export const CHAT_FALLBACK_SYSTEM = `You answer typed questions about a STATE and reply with ONE JSON object and nothing else.
For each question id in QUESTIONS reply with:
- noul:   {"noul": <probability 0..1 that the answer is yes>}
- choice: {"choice": "<one option id exactly as given>", "confidence": <0..1>}
- score:  {"level": <integer index of the best-matching level, 0-based>, "confidence": <0..1>}
Judge each question independently. Do not explain. Do not add keys.`;

function clamp01(v: unknown, fallback = 0.5): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/** Pull the first {...} object out of a reply that may carry fences or prose. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

export class ChatFallbackDecisionProvider implements DecisionProvider {
  readonly id = 'chat-fallback';
  constructor(private readonly chat: ChatFn, readonly model: string) {}

  async ask<Q extends Readonly<Record<string, DecisionQuestion>>>(req: DecisionRequest<Q>, ctx: DecisionContext = {}): Promise<DecisionResult<Q>> {
    const user = `STATE:\n${JSON.stringify(req.state)}\n\nQUESTIONS:\n${JSON.stringify(req.questions)}`;
    const t0 = Date.now();
    let raw: string;
    try { raw = await this.chat(CHAT_FALLBACK_SYSTEM, user, { signal: ctx.signal }); }
    catch (e) { throw new DecisionError('transport', `chat-fallback: ${(e as Error)?.message ?? String(e)}`, e); }
    const obj = extractJsonObject(raw);
    if (!obj) throw new DecisionError('malformed', `chat-fallback: no JSON object in reply (${raw.slice(0, 120)})`);
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const a = (obj[id] ?? {}) as Record<string, unknown>;
      if (q.type === 'noul') { answers[id] = { type: 'noul', noul: clamp01(a.noul) }; continue; }
      if (q.type === 'choice') {
        const ids = Object.keys((q as ChoiceQuestion).criteria);
        const pick = ids.includes(String(a.choice)) ? String(a.choice) : ids[0];
        const c = clamp01(a.confidence);
        const rest = ids.length > 1 ? (1 - c) / (ids.length - 1) : 0;
        const probabilities: Record<string, number> = {};
        for (const o of ids) probabilities[o] = o === pick ? c : rest;
        answers[id] = { type: 'choice', choice: pick, probabilities, confidence: c };
        continue;
      }
      const levels = (q as ScoreQuestion).criteria.length;
      const lv = Math.max(0, Math.min(levels - 1, Math.round(Number(a.level)) || 0));
      const c = clamp01(a.confidence);
      const rest = levels > 1 ? (1 - c) / (levels - 1) : 0;
      const probabilities: Record<string, number> = {};
      let score = 0;
      for (let i = 0; i < levels; i++) { const p = i === lv ? c : rest; probabilities[String(i)] = p; score += i * p; }
      answers[id] = { type: 'score', score, probabilities, confidence: c };
    }
    return { answers: answers as AnswersFor<Q>, model: this.model, usage: { inputTokens: 0, outputTokens: 0 }, ms: Date.now() - t0 };
  }
}

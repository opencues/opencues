/**
 * Completeness judge — "has this draft reached a resting point?"
 *
 * Step 3 of the cost plan. The resolver fires on every pause, and three of
 * every four pauses land on text the person is still writing; every
 * sentence-scope source then runs on it for nothing. The judge is one tiny
 * call (about 130 prompt tokens, one output token, reasoning off) that the
 * per-sentence fan-out waits for: YES → the fan-out runs, NO → it is skipped
 * this pause. Whole-buffer sources (tips, the session rail) never wait for
 * it — an early tip is the best thing the system does.
 *
 * Language-agnostic by construction: the prompt names no language and reads
 * only the END of the text; the runtime never pre-filters with a regex.
 * Fails OPEN: an error or a timeout is a YES, so a broken judge costs money,
 * never a cue. Bench: `tests/benchmarks/judge/judge-bench.mjs`.
 */
import { dispatchChat, type ProviderAdapter } from './llm-provider';
import type { HttpAdapter } from './types';

export const COMPLETENESS_JUDGE_SYSTEM = `You judge whether a piece of text someone is typing has reached a resting point: a complete thought, request or sentence they could stop at, as opposed to text cut off mid-word, mid-phrase, or right after a word that promises more (a connector, an article, a preposition, an opening bracket or quote). Judge the END of the text only; grammar and spelling do not matter; any language. Reply with exactly one word: YES if it is at a resting point, NO if it is not.`;

export interface CompletenessJudgeConfig {
  readonly provider: ProviderAdapter;
  readonly httpAdapter: HttpAdapter;
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly model: string;
  readonly log?: (msg: string) => void;
  /** cache entries kept (LRU on the trimmed text). Default 256. */
  readonly cacheSize?: number;
}

export class CompletenessJudge {
  private readonly done = new Map<string, boolean>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  readonly stats = { calls: 0, hits: 0, yes: 0, no: 0, errors: 0 };
  constructor(private readonly cfg: CompletenessJudgeConfig) {}

  /** YES/NO for the draft; cached on the trimmed text; an error is a YES. */
  judge(text: string, signal?: AbortSignal): Promise<boolean> {
    const key = text.trimEnd();
    if (key.length === 0) return Promise.resolve(false);
    const cached = this.done.get(key);
    if (cached !== undefined) { this.done.delete(key); this.done.set(key, cached); this.stats.hits++; return Promise.resolve(cached); }
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.ask(key, signal)
      .then((v) => { this.done.set(key, v); while (this.done.size > (this.cfg.cacheSize ?? 256)) { const k = this.done.keys().next().value as string; this.done.delete(k); } return v; })
      .finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }

  private async ask(text: string, signal?: AbortSignal): Promise<boolean> {
    this.stats.calls++;
    const t0 = Date.now();
    try {
      const raw = await dispatchChat(this.cfg.provider, this.cfg.httpAdapter, {
        model: this.cfg.model,
        messages: [{ role: 'system', content: COMPLETENESS_JUDGE_SYSTEM }, { role: 'user', content: `TEXT: ${text}` }],
        maxTokens: 4, temperature: 0, seed: 42,
      }, { apiKey: this.cfg.apiKey, endpoint: this.cfg.endpoint, signal, maxThinking: false, noRateLimitRetry: true });
      const yes = /^\s*yes/i.test(raw);
      const no = /^\s*no/i.test(raw);
      const verdict = yes || !no;   // anything but a clear NO fails open
      if (verdict) this.stats.yes++; else this.stats.no++;
      this.cfg.log?.(`Judge: ${verdict ? 'YES' : 'NO'} (${Date.now() - t0}ms) ${JSON.stringify(text.slice(-40))}`);
      return verdict;
    } catch (e) {
      this.stats.errors++;
      this.cfg.log?.(`Judge: error → YES (fail open) — ${(e as Error).message}`);   // logged at warn by the runtime: a silent fail-open is a judge that is wired but inert
      return true;
    }
  }
}

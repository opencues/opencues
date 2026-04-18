// AnswerControl — factual answer / translation / definition lookup via
// an LLM. Returns 3 alternatives, one per line, so BlankFill's
// consume-list path can register them as a cycleable span.
//
//   `what is the word for _` + context "love in Japanese"
//     → "Ai\nAishiteru\nKoi"
//   `define _` + context "ephemeral"
//     → "lasting a very short time\nshort-lived\ntransient"
//
// System prompt + parsing pulled verbatim from the legacy
// answer-blank.sh so behaviour is preserved across the hoist.

import type { Control } from './types';

const SYSTEM_PROMPT = `You answer factual questions, translate words, and define terms.
Return ONLY the answer — no explanation, no quotes, no punctuation.
For translations, return the word/phrase in the target language.
For definitions, return a concise definition (under 8 words).
For factual questions, return the direct answer.
Return 3 alternatives, one per line. Best answer first.

Examples:
  Q: word for love in Japanese → Ai
Aishiteru
Koi
  Q: define ephemeral → lasting a very short time
short-lived
transient
  Q: what is the capital of Japan → Tokyo
Tōkyō
東京
  Q: translate hello to French → Bonjour
Salut
Coucou
  Q: how to say thank you in Korean → Gamsahamnida
Gomawo
감사합니다`;

export interface AnswerControlOptions {
  /** LLM API key. Required — empty key returns "" so BlankFill skips
   *  the fill quietly instead of yelling. */
  readonly apiKey?: string;
  /** Chat-completions endpoint. Defaults to Groq. */
  readonly apiUrl?: string;
  /** Model name. Defaults to openai/gpt-oss-120b. */
  readonly model?: string;
  /** Override fetch — defaults to globalThis.fetch.bind(globalThis). */
  readonly fetchFn?: typeof fetch;
}

export class AnswerControl implements Control {
  readonly name = 'answer';
  readonly readOnly = true;
  private readonly _apiKey: string;
  private readonly _apiUrl: string;
  private readonly _model: string;
  private readonly _fetch: typeof fetch;

  constructor(opts: AnswerControlOptions = {}) {
    this._apiKey = opts.apiKey ?? '';
    this._apiUrl = opts.apiUrl ?? 'https://api.groq.com/openai/v1/chat/completions';
    this._model = opts.model ?? 'openai/gpt-oss-120b';
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async get(keyword?: string, context?: string[]): Promise<string> {
    if (!this._apiKey) return '';
    const ctx = context?.join(' ').trim() ?? '';
    if (!ctx) return '';
    const query = `${keyword ?? ''} ${ctx}`.trim();

    try {
      const resp = await this._fetch(this._apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`,
        },
        body: JSON.stringify({
          model: this._model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Q: ${query}` },
          ],
          temperature: 0.3,
          max_tokens: 512,
        }),
      });
      if (!resp.ok) return '';
      const data = (await resp.json()) as {
        choices?: { message?: { content?: string; reasoning?: string } }[];
      };
      // Match the legacy bash: empty content falls through to reasoning
      // (jq used `if $c != "" then $c else $reasoning end`). `??`
      // wouldn't catch '' here, so check truthiness explicitly.
      const choice = data.choices?.[0]?.message;
      const content = (choice?.content && choice.content.trim().length > 0)
        ? choice.content
        : (choice?.reasoning ?? '');
      return content.trim();
    } catch {
      return '';
    }
  }
}

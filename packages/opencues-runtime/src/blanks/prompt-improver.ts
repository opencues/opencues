// PromptImproverBlank — two-step LLM pipeline for the
// `improve prompt _` consume-all flow.
//
// Step 1 (Extract): pull the user's actual prompt + any conditions
// out of the surrounding text, ignoring the activation keywords.
// Returns JSON: {prompt, conditions}.
//
// Step 2 (Transform): rewrite the extracted prompt into N improved
// versions (default 3, one per line). When the LLM call fails or
// returns < 2 lines, get() returns the original full context so
// BlankFill's consume-all replaces with no observable change instead
// of erasing the user's input.
//
// The prompts here mirror what blanks/prompt/cue.md
// declares in its `## Extract` and `## Transform` sections. A future
// improvement is to read those from the cue.md frontmatter so this
// class doesn't drift; for now they're inlined to match the chrome
// implementation that this hoist replaces.

import type { Blank } from './types';

const EXTRACT_SYSTEM = `You extract the user's prompt from a text that contains activation keywords mixed in.
The activation keywords are: improve prompt, enhance prompt, refine prompt
Everything else is either the user's PROMPT (what they want to do) or CONDITIONS (how to improve it).

Output ONLY valid JSON: {"prompt": "...", "conditions": "..."}
If there are no conditions, set conditions to empty string.
Do not include the activation keywords in the prompt or conditions.`;

const TRANSFORM_SYSTEM = `You are a prompt engineering expert. Improve the given prompt to be clearer, more specific, and more effective.
Output EXACTLY 3 lines. Each line is ONE complete improved prompt. No numbering, no bullets, no blank lines, no explanations.
IMPORTANT: Each line must be a COMPLETE improved version of the original prompt — do NOT execute the prompt, do NOT write the output the prompt asks for. Just rewrite the prompt itself to be better.
IMPORTANT: Preserve the original intent exactly. Do not change the topic, medium, or goal. Add specificity through dimensions like format, audience, tone, structure, scope, or constraints — without inventing details the user did not imply.
When the prompt is already specific, add only what is still missing (output format, tone, length, structure). Do not add constraints that were not implied.
When the user specifies conditions (tone, length, style), all 3 alternatives must honour them.
When no programming language is specified, do not invent one and do not turn the prompt into a question. Instead use a placeholder like [language] or [your language], or phrase it generically.`;

export interface PromptImproverBlankOptions {
  /** LLM API key. Required — without it, get() falls back to fullContext
   *  so consume-all looks like a no-op rather than an error. */
  readonly apiKey?: string;
  /** Chat-completions endpoint. Defaults to Groq. */
  readonly apiUrl?: string;
  /** Model name. Defaults to openai/gpt-oss-120b. */
  readonly model?: string;
  /** Number of improved-prompt alternatives to return. Default 3. */
  readonly altCount?: number;
  /** When true, the original prompt is appended to the alternatives so
   *  the user can cycle back to it. Default true. */
  readonly includeOriginal?: boolean;
  /** Override fetch — defaults to globalThis.fetch.bind(globalThis). */
  readonly fetchFn?: typeof fetch;
}

export class PromptImproverBlank implements Blank {
  readonly name = 'prompt';
  readonly readOnly = false;
  private readonly _apiKey: string;
  private readonly _apiUrl: string;
  private readonly _model: string;
  private readonly _altCount: number;
  private readonly _includeOriginal: boolean;
  private readonly _fetch: typeof fetch;

  constructor(opts: PromptImproverBlankOptions = {}) {
    this._apiKey = opts.apiKey ?? '';
    this._apiUrl = opts.apiUrl ?? 'https://api.groq.com/openai/v1/chat/completions';
    this._model = opts.model ?? 'openai/gpt-oss-120b';
    this._altCount = opts.altCount ?? 3;
    this._includeOriginal = opts.includeOriginal ?? true;
    this._fetch = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async get(_keyword?: string, context?: string[]): Promise<string> {
    const fullContext = context?.join(' ').trim() ?? '';
    if (!fullContext) return '';
    if (!this._apiKey) return fullContext;

    try {
      const { prompt, conditions } = await this.extract(fullContext);
      if (!prompt) return fullContext;

      const alts = await this.transform(prompt, conditions);
      if (alts.length < 2) return fullContext;

      const results = this._includeOriginal ? [...alts, prompt] : alts;
      return results.join('\n');
    } catch {
      return fullContext;
    }
  }

  /** No-op cycling — consume-all path stashes alts in SpanFillState
   *  and Cycling rotates them directly. */
  async up(): Promise<string> { return ''; }
  async down(): Promise<string> { return ''; }

  private async extract(context: string): Promise<{ prompt: string; conditions: string }> {
    const response = await this.llm(EXTRACT_SYSTEM, context);
    // Strip Claude-style ```json fences before parsing.
    const cleaned = response.replace(/^```[a-z]*\n?/gm, '').replace(/```$/gm, '').trim();
    try {
      const parsed = JSON.parse(cleaned) as { prompt?: string; conditions?: string };
      return { prompt: parsed.prompt ?? '', conditions: parsed.conditions ?? '' };
    } catch {
      // Fallback: strip activation keywords, treat the rest as the prompt.
      const stripped = context.replace(/\b(improve|enhance|refine)\s+prompt\b/gi, '').trim();
      return { prompt: stripped, conditions: '' };
    }
  }

  private async transform(prompt: string, conditions: string): Promise<string[]> {
    let input = `Prompt: ${prompt}`;
    if (conditions) input += `\nConditions: ${conditions}`;
    const response = await this.llm(TRANSFORM_SYSTEM, input);
    const lines = response
      .split('\n')
      .map(l => l.replace(/^\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim())
      .filter(l => l.length > 0);
    return lines.slice(0, this._altCount);
  }

  private async llm(systemPrompt: string, userMessage: string): Promise<string> {
    const resp = await this._fetch(this._apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this._apiKey}`,
      },
      body: JSON.stringify({
        model: this._model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 1024,
      }),
    });
    if (!resp.ok) throw new Error(`LLM ${resp.status}`);
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }
}

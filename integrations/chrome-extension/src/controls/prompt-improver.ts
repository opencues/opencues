import type { BrowserControl } from './types';

/**
 * Prompt improver control — two-step LLM pipeline.
 * Replaces controls/prompt/prompt-blank.sh.
 *
 * Step 1 (Extract): Separates user prompt from conditions/keywords.
 * Step 2 (Transform): Generates 3 improved versions.
 *
 * Uses the same LLM API as the main cue resolver.
 * blankConsumeAll: true — clears entire input, replaces with result.
 */

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

export interface PromptImproverConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  altCount?: number;
  includeOriginal?: boolean;
}

export class PromptImproverControl implements BrowserControl {
  readonly name = 'prompt';
  readonly readOnly = false;
  private config: PromptImproverConfig;

  constructor(config: PromptImproverConfig) {
    this.config = config;
  }

  updateConfig(config: PromptImproverConfig): void {
    this.config = config;
  }

  /**
   * Two-step LLM pipeline: Extract prompt/conditions, then Transform.
   * Returns alternatives as newline-separated string (for consume-all).
   */
  async get(keyword?: string, context?: string[]): Promise<string> {
    const fullContext = context?.join(' ') || '';
    if (!fullContext.trim()) return '';

    // Snapshot config to avoid mid-pipeline changes (issue #10)
    const cfg = { ...this.config };
    const altCount = cfg.altCount ?? 3;
    const includeOriginal = cfg.includeOriginal ?? true;

    try {
      // Step 1: Extract prompt and conditions from context
      const { prompt, conditions } = await this.extractWith(fullContext, cfg);
      if (!prompt) return fullContext; // fallback to original

      // Step 2: Transform into improved versions
      const alts = await this.transformWith(prompt, conditions, altCount, cfg);
      if (alts.length < 2) return fullContext; // fallback

      // Include original prompt if configured
      const results = includeOriginal ? [...alts, prompt] : alts;
      return results.join('\n');
    } catch {
      return fullContext; // fallback to original
    }
  }

  private async extractWith(context: string, cfg: PromptImproverConfig): Promise<{ prompt: string; conditions: string }> {
    const response = await this.llmCallWith(EXTRACT_SYSTEM, context, cfg);

    // Strip markdown code fences (Claude wraps JSON in ```json...```)
    const cleaned = response.replace(/^```[a-z]*\n?/gm, '').replace(/```$/gm, '').trim();

    try {
      const parsed = JSON.parse(cleaned);
      return {
        prompt: parsed.prompt || '',
        conditions: parsed.conditions || '',
      };
    } catch {
      // Fallback: remove keywords and use entire text as prompt
      const stripped = context
        .replace(/\b(improve|enhance|refine)\s+prompt\b/gi, '')
        .trim();
      return { prompt: stripped, conditions: '' };
    }
  }

  private async transformWith(prompt: string, conditions: string, altCount: number, cfg: PromptImproverConfig): Promise<string[]> {
    let input = `Prompt: ${prompt}`;
    if (conditions) input += `\nConditions: ${conditions}`;

    const response = await this.llmCallWith(TRANSFORM_SYSTEM, input, cfg);

    // Post-process: strip numbering/bullets, remove blank lines
    const lines = response
      .split('\n')
      .map(l => l.replace(/^\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim())
      .filter(l => l.length > 0);

    return lines.slice(0, altCount);
  }

  private async llmCallWith(systemPrompt: string, userMessage: string, cfg: PromptImproverConfig): Promise<string> {
    const body = JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.7,
      max_tokens: 1024,
    });

    const response = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body,
    });

    if (!response.ok) throw new Error(`LLM ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // No-op cycling (consume-all handles cycling via engine.consumeAllAlts)
  async up(): Promise<string> { return ''; }
  async down(): Promise<string> { return ''; }
}

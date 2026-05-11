/// <reference path="../../user-blank.d.ts" />
/**
 * @type {import('../../user-blank').UserBlankModule}
 *
 * prompt — two-step LLM pipeline for `improve prompt _`.
 *
 *   EXTRACT pass: pull the user's actual prompt + any conditions
 *     out of surrounding text (ignoring activation keywords).
 *   TRANSFORM pass: rewrite into N improved versions, one per line.
 *
 * Returns the full context unchanged on any failure, so consume-all
 * looks like a no-op rather than erasing the user's input.
 *
 * Migrated from packages/opencues-runtime/src/blanks/prompt-improver.ts
 * (May 2026).
 */

const ALT_COUNT = 3;
const INCLUDE_ORIGINAL = true;

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

async function extract(ctx, fullContext) {
  const reply = await ctx.llm({
    system: EXTRACT_SYSTEM,
    prompt: fullContext,
    temperature: 0.7,
    maxTokens: 1024,
  });
  // Strip ```json fences if present
  const cleaned = reply.replace(/^```[a-z]*\n?/gm, '').replace(/```$/gm, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return { prompt: parsed.prompt || '', conditions: parsed.conditions || '' };
  } catch {
    // Fallback: strip activation keywords, treat rest as the prompt
    const stripped = fullContext.replace(/\b(improve|enhance|refine)\s+prompt\b/gi, '').trim();
    return { prompt: stripped, conditions: '' };
  }
}

async function transform(ctx, prompt, conditions) {
  let input = 'Prompt: ' + prompt;
  if (conditions) input += '\nConditions: ' + conditions;
  const reply = await ctx.llm({
    system: TRANSFORM_SYSTEM,
    prompt: input,
    temperature: 0.7,
    maxTokens: 1024,
  });
  const lines = reply
    .split('\n')
    .map(l => l.replace(/^\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter(l => l.length > 0);
  return lines.slice(0, ALT_COUNT);
}

export default {
  async get(ctx, args) {
    const context = args.slice(1);
    const fullContext = context.join(' ').trim();
    if (!fullContext) return '';
    if (!ctx.llm) return fullContext;

    try {
      const { prompt, conditions } = await extract(ctx, fullContext);
      if (!prompt) return fullContext;
      const alts = await transform(ctx, prompt, conditions);
      if (alts.length < 2) return fullContext;
      const results = INCLUDE_ORIGINAL ? [...alts, prompt] : alts;
      return results.join('\n');
    } catch (e) {
      return fullContext;
    }
  },
  // No-op cycling — consume-all path stashes alts in SpanFillState
  // and Cycling rotates them directly.
  async up() { return ''; },
  async down() { return ''; },
};

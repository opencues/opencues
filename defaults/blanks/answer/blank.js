/// <reference path="../../user-blank.d.ts" />
/**
 * @type {import('../../user-blank').UserBlankModule}
 *
 * answer — factual answer / translation / definition lookup via LLM.
 * Returns 3 alternatives, one per line. Migrated from
 * packages/opencues-runtime/src/blanks/answer.ts (May 2026).
 */

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

export default {
  async get(ctx, args) {
    if (!ctx.llm) return '';
    const keyword = args[0] || '';
    const context = args.slice(1).join(' ').trim();
    if (!context) return '';
    const query = (keyword + ' ' + context).trim();

    try {
      const reply = await ctx.llm({
        system: SYSTEM_PROMPT,
        prompt: 'Q: ' + query,
        temperature: 0.3,
        maxTokens: 512,
      });
      return reply.trim();
    } catch (e) {
      return '';
    }
  },
};

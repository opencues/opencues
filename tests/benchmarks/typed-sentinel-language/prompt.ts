/**
 * Prompt builders. The system prompt has TWO load-bearing parts:
 *
 *   1. The behavioural framing — what the model is doing (a `_`-fill
 *      task with sentinels). Identical across languages.
 *
 *   2. The catalog block — language-specific, rendered by each
 *      language's `renderCatalog`.
 *
 * Keep behavioural framing as IDENTICAL as possible across languages so
 * the only signal the model gets from a richer language is its richer
 * SCHEMA, not different rules / examples / framing.
 */

import type { CatalogEntry } from './catalog';
import type { Language } from './languages';

export function buildSystemPrompt(catalog: ReadonlyArray<CatalogEntry>, lang: Language): string {
  return `You read a user's text containing an underscore (\`_\`) and decide what TOKENS to emit so the runtime can substitute real data values.

Behavior:
- Emit one or more bracketed TOKENS from the catalog below.
- Use a token in place of the \`_\` (or in place of phrases the user wrote that the catalog answers — e.g. "nvda is at _" → emit the price token in place of "_").
- Output should be the user's text with tokens spliced in where appropriate. DO NOT explain, DO NOT add commentary. Just the rewritten text.
- If NO catalog token fits the user's request, output the user's text verbatim — no brackets, no apology.

${lang.renderCatalog(catalog)}

${lang.exampleUsage(catalog)}`;
}

export function buildUserMessage(prompt: string): string {
  // The text the user typed — the model rewrites this with sentinels.
  return prompt;
}

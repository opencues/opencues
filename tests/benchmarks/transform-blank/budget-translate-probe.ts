/**
 * budget-translate-probe — measure how max_tokens affects FUSED output
 * completeness on long English→Japanese translations.
 *
 * Context (May 2026): production FUSED_FLOOR=2048 was calibrated on the
 * fused-full bench with English↔English cases (see EXPERIMENTS.md
 * Experiment 3). That budget assumes ~1 output token per input char.
 * Japanese (and other CJK / Arabic scripts) uses 2-3 BPE tokens per
 * char, so a 700-char input that "should" translate to 700 chars of
 * Japanese actually emits ~2200 tokens — past the 2048 cap → mid-
 * sentence truncation → three-way merge preserves the English tail
 * → user sees a Frankenstein bilingual buffer.
 *
 * This probe sweeps max_tokens across the production min (2048) up to
 * 8192 on one representative long-letter English→Japanese case and
 * measures:
 *   - did the LLM emit a `FULL_REWRITE:` label at all?
 *   - was the rewrite completion truncated mid-stream? (finish_reason
 *     == 'length' or trailing non-newline)
 *   - rewrite char count
 *   - rough Japanese ratio (CJK chars / total chars in rewrite)
 *   - latency
 *
 * The goal is to identify a budget that completes Japanese reliably
 * BEFORE bumping production's FLOOR — bumping blindly risks regressing
 * cost / latency on English↔English cases that don't need the room.
 *
 * Usage:
 *   CEREBRAS_API_KEY=... npx tsx tests/benchmarks/transform-blank/budget-translate-probe.ts
 *
 * The probe defaults to cerebras-gpt-oss-120b (the provider where the
 * production loop bug surfaced). Override with OPENCUES_BENCH_PROVIDER.
 */

import { chat, sysUser } from './groq';

const SYSTEM_PROMPT = `You read a sentence containing _ and decide whether it carries an IMPERATIVE INSTRUCTION the user wants applied to the surrounding text. If so, you both EXTRACT the instruction/target AND APPLY it in one shot — emitting the entire final buffer the user should see.

Output exactly four labelled lines (FULL_REWRITE may span multiple lines):
VERDICT: TRANSFORM | NONE
INSTRUCTION: <imperative phrase, _ removed; or empty when NONE>
TARGET: <rest of text after removing the instruction phrase + _; or empty when NONE>
FULL_REWRITE: <the ENTIRE final text after applying the instruction AND deleting the instruction phrase + _; empty when NONE>

LAYOUT — the imperative may appear in THREE positions:
  (a) BEFORE _ at the start:   "<INSTRUCTION> _ <TARGET>"
  (b) BEFORE _ at the end:     "<TARGET> <INSTRUCTION> _"
`;

// A representative long-letter case (mirrors the chrome Gmail buffer
// the user observed truncating). 700+ English chars → ~250 Japanese
// chars but ~2000-2500 output tokens with cerebras BPE.
// Plain-text variant (no markdown injection). Mirrors opencode / TUI
// hosts where the resolver's richText path doesn't fire.
const INPUT_PLAIN = `Dear Ms. Emily Carter,

Why did the employee bring a ladder to work? Because they were ready to step up and reach new heights!

I am writing to formally resign from my position as Senior Marketing Analyst at BrightFuture Solutions, effective September 15, 2024. I have greatly appreciated the opportunities to grow and the support I have received during my time here. I am committed to ensuring a smooth transition and will do everything I can to hand over my responsibilities before my departure.

Thank you for your guidance and for the valuable experiences I have gained while working with the team. I wish the company continued success in the future.

Sincerely,
Wilfred translate to japanese _`;

// Rich-text PROD variant — exact reconstruction of the actual chrome
// /tmp/opencues.log line at 17:27:25.768. The user's session had run
// `make appropriate bits bold _` earlier; MarkdownRender's cache had
// SEVEN bold ranges; the resolver's richText injection re-emitted
// every one on this transform's input. Plus emojis (🪜🙏🌟😊) which
// each cost ~4 BPE tokens. This is the input that truncated production
// at 2048 max_tokens — the probe needs to mirror it exactly to
// reproduce the partial output.
const INPUT_RICH = `**Dear Ms. Emily Carter,**

Why did the employee bring a ladder to work? Because they were ready to step up and reach new heights! 🪜

**I am writing to formally resign from my position as Senior Marketing Analyst at BrightFuture Solutions, effective September 15, 2024.** **I have greatly appreciated the opportunities to grow and the support I have received during my time here.** **I am committed to ensuring a smooth transition and will do everything I can to hand over my responsibilities before my departure.** 🙏

**Thank you for your guidance and for the valuable experiences I have gained while working with the team.** I wish the company continued success in the future. 🌟

**Sincerely,**
**Wilfred 😊**
translate to japanese _`;

const BUDGETS = [2048, 3072, 4096, 6144, 8192];

function countCJK(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Rough CJK + kana coverage. Not exhaustive (no extension blocks)
    // but sufficient to distinguish "mostly Japanese" from
    // "mostly English" rewrites.
    if ((c >= 0x3040 && c <= 0x30FF) ||   // hiragana + katakana
        (c >= 0x4E00 && c <= 0x9FFF) ||   // CJK unified
        (c >= 0xFF00 && c <= 0xFFEF)) n++; // fullwidth ASCII
  }
  return n;
}

function parseRewrite(text: string): string | null {
  const idx = text.indexOf('FULL_REWRITE:');
  if (idx < 0) return null;
  return text.slice(idx + 'FULL_REWRITE:'.length).replace(/^\s+/, '');
}

function looksTruncated(rewrite: string): boolean {
  // Heuristic: ends mid-sentence without a closing punctuation char.
  // A clean Japanese translation should end on `。` `、` `」` `！`
  // `？` or fullwidth space; an English-tail truncation often ends
  // mid-word.
  const tail = rewrite.trimEnd().slice(-3);
  if (!tail) return true;
  return !/[。！？\.\!\?」\)】]$/.test(tail);
}

async function probe(label: string, input: string, budget: number): Promise<void> {
  const t0 = Date.now();
  const res = await chat(sysUser(SYSTEM_PROMPT, `INPUT: ${input}`), { maxTokens: budget });
  const latency = Date.now() - t0;
  const rewrite = parseRewrite(res.text);
  if (!rewrite) {
    console.log(`[${label}] budget=${budget.toString().padStart(5)} | NO FULL_REWRITE label  | latency=${latency}ms | resp_len=${res.text.length}`);
    return;
  }
  const cjk = countCJK(rewrite);
  const total = rewrite.length;
  const cjkPct = total === 0 ? 0 : Math.round((cjk / total) * 100);
  const truncated = looksTruncated(rewrite);
  // Full-response size lets us spot when the model re-emits the
  // TARGET section verbatim (cerebras + reasoning=medium does this,
  // consuming much of the budget BEFORE FULL_REWRITE starts —
  // the structural cause of production truncation at 2048).
  console.log(
    `[${label}] budget=${budget.toString().padStart(5)} | ` +
    `total_resp=${res.text.length.toString().padStart(5)} chars | ` +
    `rewrite=${total.toString().padStart(4)} chars, ` +
    `${cjkPct.toString().padStart(3)}% CJK | ` +
    `truncated=${truncated ? 'YES' : 'no '} | ` +
    `latency=${latency.toString().padStart(5)}ms | ` +
    `tail="${rewrite.trimEnd().slice(-30).replace(/\n/g, '\\n')}"`,
  );
}

async function main(): Promise<void> {
  console.log(`Plain input: ${INPUT_PLAIN.length} chars | Rich input: ${INPUT_RICH.length} chars`);
  console.log(`Provider: ${process.env.OPENCUES_BENCH_PROVIDER ?? 'cerebras-gpt-oss (default)'}`);
  console.log(`Reasoning: ${process.env.OPENCUES_CEREBRAS_REASONING ?? 'low'} (production uses medium)`);
  console.log('');
  console.log('Sweep — translate-to-japanese on a 700-char letter:');
  console.log('─'.repeat(120));
  for (const b of BUDGETS) {
    await probe('plain', INPUT_PLAIN, b);
  }
  console.log('');
  for (const b of BUDGETS) {
    await probe('rich ', INPUT_RICH, b);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

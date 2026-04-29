/**
 * opencues-core/sources/spelling-source.ts
 *
 * Spelling — word-scope source that flags misspelled words in plain text
 * and offers the correct spelling as a cycling alternative.
 *
 * Runs alongside RoutedWordSourceGroup. Priority 80 (above the typical
 * domain max of ~75) so when the LLM flags a word as misspelled, the
 * correction wins over any synonym a domain source might have produced.
 *
 * One LLM call per resolve, listing only misspelled words. Correctly-
 * spelled words, proper nouns, acronyms, numbers and `_` placeholders
 * are skipped by the prompt (no result row → no cue for that word).
 *
 * Opt-in via opencues.md `spelling-mode: on`.
 */
import { CueSource, CueContext, CueSourceResult, CueResult, HttpAdapter } from '../types';

const SPELLING_PROMPT = `You are a spell-checker. Identify MISSPELLED words in the input and output their corrections.

Output format — one line per misspelling, nothing else:
INDEX:correct1[,correct2[,correct3]]

- INDEX is the 0-based word position from the input.
- Up to 3 corrections, most likely first. Single correction is fine.
- If NO misspellings, output nothing (empty response).

SKIP — do not flag:
- Correctly-spelled words.
- Proper nouns, place names, brand names, acronyms (assume intentional).
- Numbers, codes, hex, URLs, file paths.
- The literal underscore "_" (it's a placeholder, never a word).
- Single-letter words (a, I).

EXAMPLES:

INPUT: 0=the 1=boy 2=jumpved 3=over 4=the 5=dog
OUTPUT:
2:jumped

INPUT: 0=I 1=accomodate 2=many 3=guests
OUTPUT:
1:accommodate

INPUT: 0=this 1=is 2=spelt 3=correctly
OUTPUT:

INPUT: 0=definately 1=going 2=tommorrow
OUTPUT:
0:definitely
2:tomorrow

INPUT: 0=their 1=going 2=to 3=the 4=store
OUTPUT:
0:they're,there

INPUT: 0=recieve 1=the 2=package
OUTPUT:
0:receive

INPUT: 0=I 1=visited 2=Paris 3=last 4=summer
OUTPUT:

INPUT: 0=the 1=API 2=returned 3=200
OUTPUT:`;

export interface SpellingSourceConfig {
  httpAdapter: HttpAdapter;
  endpoint: string;
  apiKey: string;
  model: string;
  /** Default 80 — above typical domain max (~75) so the correction wins
   * over any synonym a domain source produced for the same word. */
  priority?: number;
}

export class SpellingSource implements CueSource {
  readonly id = 'spelling';
  readonly priority: number;

  private httpAdapter: HttpAdapter;
  private endpoint: string;
  private apiKey: string;
  private model: string;

  constructor(config: SpellingSourceConfig) {
    this.httpAdapter = config.httpAdapter;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.priority = config.priority ?? 80;
  }

  supports(context: CueContext): boolean {
    if (!context.words || context.words.length === 0) return false;
    // Need at least one real word (not all `_`/empty).
    return context.words.some(w => w !== '_' && w.length > 1);
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();
    try {
      const indexedWords = context.words
        .map((w, i) => `${i}=${w}`)
        .join(' ');
      const out = await this.callLLM(SPELLING_PROMPT, `INPUT: ${indexedWords}\nOUTPUT:`, 256);
      const corrections = parseCorrections(out);

      const results: CueResult[] = [];
      for (const { index, alts } of corrections) {
        if (index < 0 || index >= context.words.length) continue;
        const original = context.words[index];
        if (!original || original === '_') continue;
        // Skip if the LLM returned the original word as the only "correction".
        const filtered = alts.filter(a => a.toLowerCase() !== original.toLowerCase());
        if (filtered.length === 0) continue;
        results.push({
          wordIndex: index,
          word: original,
          alternatives: [original, ...filtered],
          source: this.id,
          priority: this.priority,
          metadata: { spelling: true },
        });
      }

      return { results, timing: Date.now() - startTime, model: this.model };
    } catch (error) {
      return {
        results: [],
        error: error instanceof Error ? error.message : String(error),
        timing: Date.now() - startTime,
      };
    }
  }

  private async callLLM(system: string, user: string, maxTokens: number): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      reasoning_effort: 'low',
      seed: 42,
    });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    const response = await this.httpAdapter.post(this.endpoint, body, headers);
    const data = JSON.parse(response);
    return data.choices?.[0]?.message?.content ?? '';
  }
}

interface Correction {
  index: number;
  alts: string[];
}

function parseCorrections(raw: string): Correction[] {
  const out: Correction[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+):\s*(.+)$/);
    if (!m) continue;
    const index = parseInt(m[1], 10);
    const alts = m[2].split(',').map(s => s.trim()).filter(Boolean);
    if (alts.length > 0) out.push({ index, alts });
  }
  return out;
}

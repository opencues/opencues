/**
 * ContradictionLlmSource — the robust contradiction-cue engine: an LLM PARSES
 * each sentence into a structured, grounded claim; deterministic verifiers
 * (checks.ts:verifyClaim) JUDGE it. The LLM handles all the phrasing fragility
 * ("$25 each" / "25 a head" / "twenty-five apiece"); the code guarantees the
 * fact is right (it never asks the model to do date/arithmetic) and — via
 * GROUNDING (every value must be a verbatim quote present in the sentence) —
 * the model cannot hallucinate a value into a false cue.
 *
 * One debounced LLM call per sentence (cues bucket), same cadence as the
 * calendar / more-formal sentence-cues. Emits passive `sentence-cue:*` results.
 */

import type { CueContext, CueResult, CueSource, CueSourceResult, HttpAdapter } from '../types';
import { dispatchChat, type ProviderAdapter } from '../llm-provider';
import { segmentSentences, mapWithConcurrency } from '../sources/sentence-cue-source';
import { verifyClaim, type Claim } from './checks';

export const CONTRADICTION_EXTRACT_SYSTEM = `You extract EXPLICITLY-STATED, checkable factual claims from ONE sentence so a separate program can verify them. You do NOT judge correctness and you do NOT compute anything. Output ONLY a JSON array (no prose, no markdown). Output [] when there is no explicit, fully-stated claim.

Extract a claim ONLY when the writer ASSERTS it as a fact or conclusion, and copy every value VERBATIM (an exact substring of the sentence) into a "quote".

Claim types:

1. weekday_date — the writer pairs a WEEKDAY with a specific CALENDAR DAY.
   {"type":"weekday_date","weekday":"Thursday","day":24,"month":null,"quote":"Thursday the 24th"}
   "month" = the month name if the sentence gives one, else null. Extract only when a weekday AND a day-of-month both appear and clearly refer to the same date.

2. bill_split — the writer states a TOTAL, a HEADCOUNT, and a PER-PERSON amount as the result of splitting the total.
   {"type":"bill_split","total":120,"count":4,"perPerson":25,"quotes":{"total":"$120","count":"four","perPerson":"$25 each"}}
   Extract only when all three are explicitly present AND the per-person amount is stated as the split RESULT ("so/that's/comes to $25 each"). Do NOT extract when a money amount is merely mentioned.

3. arithmetic — the writer states a CALCULATION and its RESULT.
   {"type":"arithmetic","expression":"100*1.08","statedResult":108,"quote":"$108"}
   "expression" uses only digits and + - * / % and parentheses.

4. workday_on_holiday — the writer schedules ORDINARY WORK on a specific upcoming date, treating it as a normal working day: an office day, a meeting, a call, a delivery, a deadline, "see you", "let's meet", "I'll be in", "back in the office".
   {"type":"workday_on_holiday","weekday":"Monday","day":null,"month":null,"quote":"in the office Monday"}
   {"type":"workday_on_holiday","weekday":"Monday","day":25,"month":"December","quote":"the meeting on Monday the 25th"}
   Give "weekday" and/or "day" (day-of-month) — whichever the sentence states; null the other. Extract ONLY when the date is treated as a working day. Do NOT extract when the writer ALREADY frames it as a holiday, day off, closure, or non-work ("enjoy the bank holiday Monday", "we're closed Monday", "off on the 25th").

5. outdoor_plan_weather — the writer plans a clearly OUTDOOR, weather-dependent activity on a specific upcoming date: patio/garden/park/beach/rooftop lunch or drinks, BBQ, picnic, hike, cycle, outdoor run, "outside", "al fresco", a walk.
   {"type":"outdoor_plan_weather","weekday":"Saturday","day":null,"month":null,"quote":"lunch on the patio Saturday"}
   Give "weekday" and/or "day". Extract ONLY when the activity is UNAMBIGUOUSLY outdoors AND weather-sensitive. Do NOT extract indoor plans (a meeting, dinner at a restaurant, a call) or activities where weather is irrelevant.

6. tube_line_plan — the writer plans to TRAVEL on a named LONDON transit line (a Tube/Underground line, DLR, Overground, or the Elizabeth line).
   {"type":"tube_line_plan","line":"Victoria","quote":"take the Victoria line"}
   "line" is the line NAME only, from: Bakerloo, Central, Circle, District, Hammersmith & City, Jubilee, Metropolitan, Northern, Piccadilly, Victoria, Waterloo & City, Elizabeth, DLR, Overground, Liberty, Lioness, Mildmay, Suffragette, Weaver, Windrush. Extract ONLY when a specific line is NAMED and the writer plans to USE it (take/get/catch/ride/change onto it). Do NOT extract a station name (e.g. "Oxford Circus"), a bus, a train that isn't a named line, or any sentence with no line named.

RULES (precision over recall — a wrong flag is worse than a missed one):
- ONLY explicit, fully-stated claims. If ANY part is missing, implied, or ambiguous, do NOT extract it.
- Every "quote" MUST be an exact substring of the SENTENCE, copied character-for-character.
- NEVER invent a value that is not written in the sentence.
- When unsure, output [].`;

export interface ContradictionLlmSourceConfig {
  readonly httpAdapter: HttpAdapter;
  readonly provider: ProviderAdapter;
  readonly model: string;
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly maxThinking?: boolean;
  readonly maxConcurrent?: number;
  readonly now?: () => Date;
  /** Tier 0.5 — bank-holiday cache. When present, its `refresh()` is kicked
   *  (fire-and-forget, TTL-gated) each getCues and `current()` feeds the
   *  workday_on_holiday verifier. Absent → that claim type stays silent. */
  readonly bankHolidays?: { refresh(): Promise<void>; current(): ReadonlyMap<string, string> };
  /** Tier 5 — precipitation-forecast cache. Same fire-and-forget refresh + sync
   *  read; feeds the outdoor_plan_weather verifier. Absent → that type stays silent. */
  readonly weather?: { refresh(): Promise<void>; current(): ReadonlyMap<string, number> };
  /** Tier 5b — TfL line-disruption cache. Same fire-and-forget refresh + sync
   *  read; feeds the tube_line_plan verifier. Absent → that type stays silent. */
  readonly tfl?: { refresh(): Promise<void>; current(): ReadonlyMap<string, string> };
  readonly log?: (msg: string) => void;
}

export class ContradictionLlmSource implements CueSource {
  readonly id = 'contradiction-cues';
  readonly priority = 87;   // above the formalizer (85); its passive cue evicts it on overlap
  readonly isCycleable = true;

  private readonly cfg: ContradictionLlmSourceConfig;
  private readonly nowFn: () => Date;
  private readonly log: (msg: string) => void;

  constructor(cfg: ContradictionLlmSourceConfig) {
    this.cfg = cfg;
    this.nowFn = cfg.now ?? (() => new Date());
    this.log = cfg.log ?? (() => {});
  }

  supports(context: CueContext): boolean {
    return context.words.length > 0 && !!context.text && context.text.trim().length > 0;
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const text = context.text ?? '';
    const sentences = segmentSentences(text, context.words);
    if (sentences.length === 0) return { results: [] };
    // Per-word char offsets → map a claim's char position to a word index.
    const charOffsets: Array<[number, number]> = [];
    { let pos = 0; for (const w of context.words) { const idx = text.indexOf(w, pos); if (idx < 0) { charOffsets.push([pos, pos]); continue; } charOffsets.push([idx, idx + w.length]); pos = idx + w.length; } }
    const wordIndexAt = (charPos: number): number => {
      for (let i = 0; i < charOffsets.length; i++) { if (charPos < charOffsets[i][1]) return i; }
      return Math.max(0, charOffsets.length - 1);
    };

    const now = this.nowFn();
    // Kick a background refresh (fire-and-forget, TTL-gated) and read the
    // last-good map synchronously — never a fetch in the keystroke path.
    this.cfg.bankHolidays?.refresh().catch(() => { /* keeps last-good */ });
    this.cfg.weather?.refresh().catch(() => { /* keeps last-good */ });
    this.cfg.tfl?.refresh().catch(() => { /* keeps last-good */ });
    const verifyCtx = {
      bankHolidays: this.cfg.bankHolidays?.current(),
      precipByDate: this.cfg.weather?.current(),
      disruptedLines: this.cfg.tfl?.current(),
    };
    const perSentence = await mapWithConcurrency(
      sentences,
      this.cfg.maxConcurrent ?? 4,
      async (sent): Promise<CueResult[]> => {
        let claims: Claim[];
        try { claims = await this.extract(sent.text, context.signal); }
        catch (e) { this.log(`ContradictionLlm: extract failed for "${sent.text.slice(0, 30)}…" — ${(e as Error).message}`); return []; }
        const out: CueResult[] = [];
        for (const claim of claims) {
          const v = verifyClaim(claim, sent.text, now, verifyCtx);   // grounding + deterministic judge
          if (!v) continue;
          const local = sent.text.indexOf(v.quote);        // second grounding: locate in the LIVE sentence
          if (local < 0) continue;
          const so = sent.start + local, eo = so + v.quote.length;
          if (text.slice(so, eo) !== v.quote) continue;    // exact-substring invariant (resolver race-guard needs it)
          out.push({
            wordIndex: wordIndexAt(so),
            word: context.words[wordIndexAt(so)] ?? '',
            alternatives: [v.quote, v.correction ?? v.quote],
            source: `sentence-cue:contradiction-${v.check}`,
            priority: this.priority,
            spanStart: so,
            spanEnd: eo,
            cueTip: `⚠ ${v.tip}`,
            metadata: { sentenceCue: { cueName: `contradiction-${v.check}` } },
          });
        }
        return out;
      },
    );

    const results = perSentence.flat();
    if (results.length > 0) this.log(`ContradictionLlm: ${results.length} flag(s): ${results.map((r) => r.cueTip).join(' · ')}`);
    return { results };
  }

  private async extract(sentence: string, signal?: AbortSignal): Promise<Claim[]> {
    const raw = await dispatchChat(
      this.cfg.provider,
      this.cfg.httpAdapter,
      {
        model: this.cfg.model,
        messages: [
          { role: 'system', content: CONTRADICTION_EXTRACT_SYSTEM },
          { role: 'user', content: `SENTENCE: ${sentence}` },
        ],
        maxTokens: 300,
        temperature: 0,
        seed: 42,
      },
      { apiKey: this.cfg.apiKey ?? '', endpoint: this.cfg.endpoint, signal, maxThinking: this.cfg.maxThinking },
    );
    return parseClaims(raw);
  }
}

/** Tolerant JSON-array parse: strip markdown fences / prose, accept an array. */
export function parseClaims(raw: string): Claim[] {
  if (!raw) return [];
  const m = raw.match(/\[[\s\S]*\]/);   // first bracketed array
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((c) => c && typeof c === 'object' && typeof c.type === 'string') as Claim[];
  } catch { return []; }
}

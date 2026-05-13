/**
 * JSON-mode consistency probe.
 *
 * For each of the 10 strict-mode schemas wired across the runtime
 * (TransformBlank EXTRACT/RESOLVE/APPLY/GENERATIVE/VERIFY, FluidBlank
 * SEGMENT/ANSWER, WordCues alts/raw, AgentRewrite), fire N calls and
 * measure:
 *   - % JSON.parse succeeds
 *   - % schema-conformant (required fields present, correct types)
 *   - % non-empty content (the field has a usable value)
 *   - latency p50, p95
 *
 * Run:
 *   GROQ_API_KEY=... npx tsx tests/benchmarks/transform-blank/json-consistency.ts
 */

const KEY = process.env.GROQ_API_KEY;
if (!KEY) throw new Error('GROQ_API_KEY not set');
const MODEL = 'openai/gpt-oss-120b';
const N = 10;   // calls per schema

interface Probe {
  name: string;
  schema: Record<string, unknown>;
  system: string;
  user: string;
  maxTokens?: number;
  /** Validate parsed object against required fields + non-empty check. */
  check: (obj: Record<string, unknown>) => { conformant: boolean; nonEmpty: boolean };
}

const PROBES: Probe[] = [
  // ─── TransformBlank EXTRACT ───────────────────────────────────────
  {
    name: 'transform_extract',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['TRANSFORM', 'NONE', 'TASK_ARM', 'TASK_ADD', 'TASK_STOP', 'TASK_SHOW'] },
        instruction: { type: 'string' },
        target: { type: 'string' },
      },
      required: ['verdict', 'instruction', 'target'],
      additionalProperties: false,
    },
    system: 'You classify input as TRANSFORM (imperative edit) or NONE. Return verdict, instruction, target.',
    user: 'INPUT: change boy to girl _ the boy ran fast',
    check: (o) => ({
      conformant: typeof o.verdict === 'string' && typeof o.instruction === 'string' && typeof o.target === 'string',
      nonEmpty: typeof o.verdict === 'string' && o.verdict.length > 0,
    }),
  },
  // ─── TransformBlank P1.5 RESOLVE ──────────────────────────────────
  {
    name: 'transform_resolve',
    schema: {
      type: 'object',
      properties: { resolved: { type: 'string' } },
      required: ['resolved'],
      additionalProperties: false,
    },
    system: 'Rewrite the instruction with deictic references resolved into explicit quoted spans using the cursor in TARGET.',
    user: 'INSTRUCTION: bold this word\nTARGET: hello wil[CURSOR]fred today',
    check: (o) => ({
      conformant: typeof o.resolved === 'string',
      nonEmpty: typeof o.resolved === 'string' && o.resolved.length > 0,
    }),
  },
  // ─── TransformBlank APPLY ─────────────────────────────────────────
  {
    name: 'transform_apply',
    schema: {
      type: 'object',
      properties: { rewrite: { type: 'string' } },
      required: ['rewrite'],
      additionalProperties: false,
    },
    system: 'Apply the INSTRUCTION to the TARGET. Return the rewritten TARGET.',
    user: 'INSTRUCTION: make past tense\nTARGET: I run to the store every day',
    check: (o) => ({
      conformant: typeof o.rewrite === 'string',
      nonEmpty: typeof o.rewrite === 'string' && o.rewrite.length > 0,
    }),
  },
  // ─── TransformBlank GENERATIVE (same schema as APPLY) ─────────────
  {
    name: 'transform_generative',
    schema: {
      type: 'object',
      properties: { rewrite: { type: 'string' } },
      required: ['rewrite'],
      additionalProperties: false,
    },
    system: 'Generate the content the INSTRUCTION asks for.',
    user: 'INSTRUCTION: write a haiku about autumn',
    check: (o) => ({
      conformant: typeof o.rewrite === 'string',
      nonEmpty: typeof o.rewrite === 'string' && o.rewrite.length > 5,
    }),
  },
  // ─── TransformBlank VERIFY ────────────────────────────────────────
  {
    name: 'transform_verify',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['OK', 'REPAIR'] },
        rewrite: { type: 'string' },
      },
      required: ['verdict', 'rewrite'],
      additionalProperties: false,
    },
    system: 'Check if the DRAFT correctly applies the INSTRUCTION to the TARGET. Return verdict (OK or REPAIR) and corrected rewrite if REPAIR.',
    user: 'INSTRUCTION: make past tense\nTARGET: I run to the store every day\nDRAFT: I ran to the store every day',
    check: (o) => ({
      conformant: typeof o.verdict === 'string' && typeof o.rewrite === 'string',
      nonEmpty: typeof o.verdict === 'string' && o.verdict.length > 0,
    }),
  },
  // ─── FluidBlank SEGMENT ───────────────────────────────────────────
  {
    name: 'fluid_segment',
    schema: {
      type: 'object',
      properties: { span: { type: 'string' }, context: { type: 'string' } },
      required: ['span', 'context'],
      additionalProperties: false,
    },
    system: 'Find the LOOKUP SPAN and CONTEXT in the input. Output JSON.',
    user: 'INPUT: capital of france _',
    check: (o) => ({
      conformant: typeof o.span === 'string' && typeof o.context === 'string',
      nonEmpty: typeof o.span === 'string' && o.span.length > 0,
    }),
  },
  // ─── FluidBlank ANSWER ────────────────────────────────────────────
  {
    name: 'fluid_answer',
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
    system: 'Given a SPAN, return the most likely answer.',
    user: 'SPAN: capital of france\nCONTEXT: none',
    check: (o) => ({
      conformant: typeof o.answer === 'string',
      nonEmpty: typeof o.answer === 'string' && o.answer.length > 0,
    }),
  },
  // ─── WordCues alternatives ────────────────────────────────────────
  {
    name: 'word_cues_alts',
    schema: {
      type: 'object',
      properties: {
        alternatives: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer' },
              alts: { type: 'array', items: { type: 'string' } },
            },
            required: ['index', 'alts'],
            additionalProperties: false,
          },
        },
      },
      required: ['alternatives'],
      additionalProperties: false,
    },
    system: 'Give 3 synonyms for each word.',
    user: '0=bold 1=deploy',
    check: (o) => {
      const arr = o.alternatives;
      const conformant = Array.isArray(arr)
        && arr.every((x: unknown) => typeof x === 'object' && x !== null
          && typeof (x as { index?: unknown }).index === 'number'
          && Array.isArray((x as { alts?: unknown }).alts));
      const nonEmpty = conformant && (arr as unknown[]).length > 0;
      return { conformant, nonEmpty };
    },
  },
  // ─── WordCues raw ─────────────────────────────────────────────────
  {
    name: 'word_cues_raw',
    schema: {
      type: 'object',
      properties: { alternatives: { type: 'array', items: { type: 'string' } } },
      required: ['alternatives'],
      additionalProperties: false,
    },
    system: 'Give 5 alternative completions for the BLANK token in the input.',
    user: 'The capital of France is BLANK.',
    check: (o) => {
      const arr = o.alternatives;
      const conformant = Array.isArray(arr) && arr.every((x: unknown) => typeof x === 'string');
      const nonEmpty = conformant && (arr as string[]).length > 0;
      return { conformant, nonEmpty };
    },
  },
  // ─── AgentRewrite ─────────────────────────────────────────────────
  {
    name: 'agent_rewrite',
    schema: {
      type: 'object',
      properties: { rewrite: { type: 'string' } },
      required: ['rewrite'],
      additionalProperties: false,
    },
    system: 'You are an inline editor. The DOCUMENT contains a [CURSOR] marker. Apply the TASK to the document and return the rewritten document.',
    user: 'TASK: fix typos\nDOCUMENT:\nhi my nam[CURSOR]e is wilfre',
    maxTokens: 1024,
    check: (o) => ({
      conformant: typeof o.rewrite === 'string',
      nonEmpty: typeof o.rewrite === 'string' && o.rewrite.length > 0,
    }),
  },
];

interface ProbeStats {
  total: number;
  parseable: number;
  conformant: number;
  nonEmpty: number;
  latencies: number[];
}

async function callStrict(probe: Probe): Promise<{ raw: string; latencyMs: number; httpError: boolean }> {
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: probe.system },
          { role: 'user', content: probe.user },
        ],
        max_tokens: probe.maxTokens ?? 1024,
        temperature: 0,
        reasoning_effort: 'low',
        seed: Math.floor(Math.random() * 1e9),  // vary seed to surface non-determinism
        response_format: { type: 'json_schema', json_schema: { name: probe.name, strict: true, schema: probe.schema } },
      }),
    });
    const data = await r.json();
    if (data.error) {
      return { raw: JSON.stringify(data.error), latencyMs: Date.now() - t0, httpError: true };
    }
    return { raw: data.choices?.[0]?.message?.content ?? '', latencyMs: Date.now() - t0, httpError: false };
  } catch (err) {
    return { raw: String(err), latencyMs: Date.now() - t0, httpError: true };
  }
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function main() {
  const results = new Map<string, ProbeStats>();
  for (const probe of PROBES) {
    const stats: ProbeStats = { total: 0, parseable: 0, conformant: 0, nonEmpty: 0, latencies: [] };
    process.stdout.write(`${probe.name.padEnd(22)} `);
    for (let i = 0; i < N; i++) {
      const { raw, latencyMs, httpError } = await callStrict(probe);
      stats.total++;
      stats.latencies.push(latencyMs);
      if (httpError) { process.stdout.write('E'); continue; }
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
        stats.parseable++;
      } catch {
        process.stdout.write('P'); continue;
      }
      if (!parsed || typeof parsed !== 'object') { process.stdout.write('x'); continue; }
      const { conformant, nonEmpty } = probe.check(parsed);
      if (conformant) stats.conformant++;
      if (nonEmpty) stats.nonEmpty++;
      process.stdout.write(conformant ? (nonEmpty ? '✓' : 'e') : 'X');
    }
    process.stdout.write('\n');
    results.set(probe.name, stats);
  }

  // Report
  console.log();
  console.log('Legend: ✓=conformant+nonempty  e=conformant+empty  X=parseable+nonconformant  P=parse-fail  E=HTTP-error  x=non-object');
  console.log();
  console.log('schema'.padEnd(22) + 'parse  conform  nonEmpty   latency p50/p95 (ms)');
  console.log('─'.repeat(80));
  let totalCalls = 0, totalParse = 0, totalConform = 0, totalNonEmpty = 0;
  const allLat: number[] = [];
  for (const probe of PROBES) {
    const s = results.get(probe.name)!;
    totalCalls += s.total;
    totalParse += s.parseable;
    totalConform += s.conformant;
    totalNonEmpty += s.nonEmpty;
    allLat.push(...s.latencies);
    const p50 = percentile(s.latencies, 0.5);
    const p95 = percentile(s.latencies, 0.95);
    console.log(
      probe.name.padEnd(22) +
      `${s.parseable}/${s.total}    `.padEnd(7) +
      `${s.conformant}/${s.total}    `.padEnd(9) +
      `${s.nonEmpty}/${s.total}    `.padEnd(11) +
      `${p50}/${p95}`,
    );
  }
  console.log('─'.repeat(80));
  console.log(
    'OVERALL'.padEnd(22) +
    `${totalParse}/${totalCalls}  `.padEnd(7) +
    `${totalConform}/${totalCalls}  `.padEnd(9) +
    `${totalNonEmpty}/${totalCalls}  `.padEnd(11) +
    `${percentile(allLat, 0.5)}/${percentile(allLat, 0.95)}`,
  );
}

main().catch(e => { console.error(e); process.exit(1); });

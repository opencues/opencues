/**
 * Variant of claude-cli-daemon-probe.ts that sweeps three latency
 * levers on top of the baseline daemon mode:
 *
 *   A. baseline       — exact flags from claude-cli-daemon-probe.ts
 *   B. -verbose       — drop --verbose, see if event metadata cost matters
 *   C. -dynamic-sys   — add --exclude-dynamic-system-prompt-sections
 *                       (moves cwd / env / git status out of cached
 *                        system prompt)
 *   D. B+C            — both at once
 *
 * `--output-format json` (single result) is incompatible with multi-
 * turn input — it processes the full stdin then returns ONE summary,
 * so we can't use it in daemon mode. Skipped.
 *
 * Usage:
 *   npx tsx tests/benchmarks/thinking-budget/claude-cli-daemon-tuned.ts
 *   N=8 npx ...
 */

import { spawn } from 'child_process';

const MODEL = process.env.MODEL ?? 'haiku';
const N = parseInt(process.env.N ?? '6', 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

const SYSTEM_PROMPT = 'You are a spell-checker. Output ONE line with the single corrected misspelled word, or nothing if no misspellings. No explanation.';

const PROMPTS = [
  'the brwon fox',
  'she recieved a letter',
  'good spelling here',
  'patient with tachicardia',
  'acomodation needed',
  'their are mispellings',
  'kubrenetes cluster',
  'auto scaleing enabled',
];

interface Sample {
  variant: string;
  promptIdx: number;
  elapsedMs: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

type Variant = 'BEST' | 'P' | 'Q' | 'R' | 'S';

interface VariantConfig {
  args: string[];
  env: Record<string, string>;
}

function buildArgs(_variant: Variant): VariantConfig {
  // BEST so far: excl-dyn + effort=low + disable-slash-commands +
  // --append-system-prompt + CLAUDE_CONFIG_DIR=/tmp/empty-claude
  const args = [
    '--bare', '-p',
    '--model', MODEL,
    '--no-session-persistence',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--exclude-dynamic-system-prompt-sections',
    '--effort', 'low',
    '--disable-slash-commands',
    '--append-system-prompt', SYSTEM_PROMPT,
  ];
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: '/tmp/empty-claude' };
  switch (_variant) {
    case 'BEST':
      break;
    case 'P':
      // Disable extended thinking via env var (research-suggested kill switch)
      env.CLAUDE_CODE_DISABLE_THINKING = '1';
      break;
    case 'Q':
      // Legacy thinking-budget kill switch
      env.MAX_THINKING_TOKENS = '0';
      break;
    case 'R':
      // Both env vars + drop --effort (best for Haiku; Sonnet regresses)
      env.CLAUDE_CODE_DISABLE_THINKING = '1';
      env.MAX_THINKING_TOKENS = '0';
      const i = args.indexOf('--effort');
      if (i >= 0) args.splice(i, 2);
      break;
    case 'S':
      // Both env vars KEEPING --effort low (better for Sonnet which
      // honors --effort meaningfully unlike Haiku)
      env.CLAUDE_CODE_DISABLE_THINKING = '1';
      env.MAX_THINKING_TOKENS = '0';
      break;
  }
  return { args, env };
}

async function probe(variant: Variant, label: string): Promise<Sample[]> {
  const cfg = buildArgs(variant);
  const t0 = Date.now();
  const child = spawn(CLAUDE_BIN, cfg.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...cfg.env },
  });

  const samples: Sample[] = [];
  let pendingResolve: ((j: any) => void) | null = null;
  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let j: any;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.type === 'result' && j.subtype === 'success' && pendingResolve) {
        const r = pendingResolve; pendingResolve = null; r(j);
      }
    }
  });
  child.stderr.on('data', () => { /* swallow */ });
  const closed = new Promise<void>((res) => child.on('close', () => res()));
  child.on('error', (e) => { console.error(`spawn err [${label}]:`, e); process.exit(2); });

  // Warm-up: throw away the first call so we measure stable per-call
  // (every variant pays the same cold prefill on call 1; we want the
  // per-turn steady-state).
  for (let i = 0; i < N + 1; i++) {
    const prompt = PROMPTS[i % PROMPTS.length];
    const sentAt = Date.now() - t0;
    const wait = new Promise<any>((res) => { pendingResolve = res; });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
    const j = await wait;
    const tResult = Date.now() - t0;
    if (i === 0) continue; // warm-up
    samples.push({
      variant: label,
      promptIdx: i - 1,
      elapsedMs: tResult - sentAt,
      cacheReadTokens: j.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: j.usage?.cache_creation_input_tokens ?? 0,
    });
  }
  child.stdin.end();
  await closed;
  return samples;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

async function main(): Promise<void> {
  console.log(`\nClaude CLI daemon — lever sweep (model=${MODEL}, N=${N} per variant, warm-up call discarded)\n`);
  const variants: Array<{ id: Variant; label: string }> = [
    { id: 'BEST', label: 'BEST baseline         ' },
    { id: 'P',    label: '+DISABLE_THINKING=1   ' },
    { id: 'Q',    label: '+MAX_THINKING_TOKENS=0' },
    { id: 'R',    label: 'both env + no --effort' },
    { id: 'S',    label: 'both env + --effort lo' },
  ];
  const all: Sample[] = [];
  for (const v of variants) {
    process.stdout.write(`  ${v.label} `);
    const s = await probe(v.id, v.label);
    all.push(...s);
    process.stdout.write(s.map(x => `${x.elapsedMs}ms`).join(' ') + '\n');
  }

  console.log(`\nAggregates (warm-up excluded)\n`);
  console.log(`variant              n   mean    p50     p95     cache_read(mean)`);
  console.log(`──────────────────────────────────────────────────────────────────`);
  for (const v of variants) {
    const cell = all.filter(s => s.variant === v.label);
    const e = cell.map(s => s.elapsedMs);
    const cr = cell.map(s => s.cacheReadTokens);
    console.log(`${v.label} ${String(cell.length).padStart(2)}   ${String(mean(e)).padStart(5)}ms ${String(pct(e, 0.5)).padStart(5)}ms ${String(pct(e, 0.95)).padStart(5)}ms     ${String(mean(cr)).padStart(5)}`);
  }
  console.log(`\nFor reference: baseline previously measured 1730ms mean / 1357ms p50 (with cold-call included).`);
}

main().catch(e => { console.error(e); process.exit(1); });

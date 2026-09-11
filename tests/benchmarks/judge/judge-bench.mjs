// Completeness judge bench — "is this draft at a resting point?" on small, fast models.
// The judge gates the per-sentence fan-out (step 3 of the cost plan): a wrong NO delays a
// cue until the next pause, a wrong YES costs a fan-out. Cases are prefixes of real drafts:
// COMPLETE = the draft as a person would leave it before a cue is welcome; INCOMPLETE = cut
// mid-word / mid-phrase / after a dangling connector. Language-agnostic: the prompt names no
// language, and the set carries Japanese + code-switched rows.
// Run: CEREBRAS_API_KEY=… node tests/benchmarks/judge/judge-bench.mjs [--model qwen-3.8-27b] [--provider cerebras] [--verbose]
import path from 'node:path'; import url from 'node:url';
const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));
const argv = process.argv.slice(2);
const PROVIDER = argv.includes('--provider') ? argv[argv.indexOf('--provider') + 1] : 'cerebras';
const MODEL = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'qwen-3.8-27b';
const VERBOSE = argv.includes('--verbose');
const KEY = process.env[`${PROVIDER.toUpperCase()}_API_KEY`]; if (!KEY) { console.error('key missing'); process.exit(2); }
const provider = core.getProvider(PROVIDER); const http = new NodeHttpAdapter({ maxSockets: 4, timeout: 20000 });
export const JUDGE_SYSTEM = core.COMPLETENESS_JUDGE_SYSTEM ?? `You judge whether a piece of text someone is typing has reached a resting point: a complete thought, request or sentence they could stop at, as opposed to text cut off mid-word, mid-phrase, or right after a word that promises more (a connector, an article, a preposition, an opening bracket or quote). Judge the END of the text only; grammar and spelling do not matter; any language. Reply with exactly one word: YES if it is at a resting point, NO if it is not.`;
const CASES = [
  // complete
  ["ok this is a mess, let's start over on the auth stuff", true],
  ["this session has got really long and it forgot what i said", true],
  ["can we use a cheaper faster model for this", true],
  ["the login form should validate the email before it hits the api", true],
  ["refactor the router so the auth middleware runs before the rate limiter", true],
  ["undo that", true],
  ["what does this project do?", true],
  ["Had the pleasure of attending the party!", true],
  ["add a created_at field to the user model", true],
  ["i keep having to approve every single tool call", true],
  ["make it shorter", true],
  ["これはテストです。", true],
  ["ログイン画面のバリデーションを直して", true],
  ["fix the typo in the readme", true],
  ["hmm let's try the other approach", true],
  ["run the tests again", true],
  // incomplete
  ["ok this is a mess, let's start over on the", false],
  ["this session has got really long and it forg", false],
  ["can we use a", false],
  ["the login form should validate the email before it hits the api, and", false],
  ["refactor the router so the", false],
  ["add a created_at field to the user model and a", false],
  ["i keep having to approve every single tool call because the", false],
  ["make it", false],
  ["これはテ", false],
  ["ログイン画面の", false],
  ["fix the typo in the", false],
  ["hmm let's try the other approach, but first", false],
  ["run the tests again with the", false],
  ["Had the pleasure of attending the party! Prior to the", false],
  ["please rename the function to (", false],
  ["set the timeout to \"", false],
];
let right = 0, totalMs = 0, prompt = 0, completion = 0; const rows = [];
core.registerUsageSink((u) => { prompt += u.promptTokens ?? 0; completion += u.completionTokens ?? 0; });
for (const [text, want] of CASES) {
  const t0 = Date.now();
  let raw = '';
  try {
    raw = await core.dispatchChat(provider, http, { model: MODEL, messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: `TEXT: ${text}` }], maxTokens: 4, temperature: 0, seed: 42 }, { apiKey: KEY, maxThinking: false });
  } catch (e) { raw = `ERR ${e.message}`; }
  const ms = Date.now() - t0; totalMs += ms;
  const got = /^\s*yes/i.test(raw) ? true : /^\s*no/i.test(raw) ? false : null;
  const ok = got === want; if (ok) right++;
  rows.push(`${ok ? 'ok  ' : 'MISS'} ${String(ms).padStart(5)}ms  want ${want ? 'YES' : 'NO '}  got ${JSON.stringify(raw.trim().slice(0, 12)).padEnd(14)} ${JSON.stringify(text)}`);
}
if (VERBOSE) console.log(rows.join('\n')); else console.log(rows.filter(r => r.startsWith('MISS')).join('\n'));
const price = core.priceFor(PROVIDER, MODEL);
console.log(`\njudge · ${PROVIDER}/${MODEL} · ${right}/${CASES.length} right · mean ${Math.round(totalMs / CASES.length)}ms · per call ${Math.round(prompt / CASES.length)} in / ${(completion / CASES.length).toFixed(1)} out` + (price ? ` · $${((prompt * price.input + completion * price.output) / 1e6 / CASES.length).toFixed(6)} per call` : ''));

// Semantic tips through the REAL SemanticTipsSource, against the shipped
// Claude Code pack (its `when:` lines are the catalogue the matcher sees).
//
// Modelled on session-contradiction/company-rules-bench.mjs: scoring is
// DETERMINISTIC, no judge. Every case is labelled with the trigger the tip
// should cite (a regex over the entry's trigger) or null, and the matcher's
// grounding invariant means a flag cites a catalogue id — so we score
// surfaced-when-should, silent-when-should, and CITED THE RIGHT ENTRY. The
// traps are topic-adjacent drafts that name a tip's subject without being in
// its situation; false alarms on those decide whether `tips-mode: semantic`
// can ever be a default. A tip that fires on every mention of the word
// "context" gets turned off in a week.
//
// Run: CEREBRAS_API_KEY=… node tests/benchmarks/tips/semantic-tips-bench.mjs [--pack claude-code|opencode|gemini-cli|shell] [--model qwen-3.8-27b] [--verbose]
//        [--shard <n>|off]   situations per call (default: the shipped 35)
//        [--stack a,b,...]   also load these packs into the catalogue (scale test: the case set stays --pack's)
//        [--probe "<phrase>"] (repeatable) run these phrases instead of the case set and print what fires — no gate; the way to check a phrasing before promising it in a test list
//        [--pack-file <path>] load the --pack's catalogue from this file instead of defaults/ — A/B a rewritten pack without touching the shipped one
//        [--provider <id>]   cerebras (default) | gemini | groq | … — key from <PROVIDER>_API_KEY; prints per-call tokens + list-price cost per run

import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
const R = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const core = await import(path.join(R, 'packages/opencues-core/dist/index.js'));
const { NodeHttpAdapter } = await import(path.join(R, 'packages/opencues-core/node-http-adapter.js'));

const argv = process.argv.slice(2);
const MODEL = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : (argv.includes('--provider') && argv[argv.indexOf('--provider') + 1] === 'gemini' ? 'gemini-3.5-flash-lite' : 'gpt-oss-120b');
const VERBOSE = argv.includes('--verbose');
const PACK = argv.includes('--pack') ? argv[argv.indexOf('--pack') + 1] : 'claude-code';
const SHARD = argv.includes('--shard') ? argv[argv.indexOf('--shard') + 1] : String(core.TIPS_SHARD_SIZE_DEFAULT);
const STACK = argv.includes('--stack') ? argv[argv.indexOf('--stack') + 1].split(',').filter(Boolean) : [];
const PROVIDER = argv.includes('--provider') ? argv[argv.indexOf('--provider') + 1] : 'cerebras';
const KEY_ENV = `${PROVIDER.toUpperCase().replace(/-/g, '_')}_API_KEY`;
const API_KEY = process.env[KEY_ENV];
if (!API_KEY) { console.error(`${KEY_ENV} is required`); process.exit(2); }
// per-run usage: every dispatchChat reports through the process-global sink
const usage = { calls: 0, prompt: 0, completion: 0, cached: 0 };
core.registerUsageSink((u) => { usage.calls++; usage.prompt += u.promptTokens ?? 0; usage.completion += u.completionTokens ?? 0; usage.cached += u.cachedTokens ?? 0; });
function usageLine() {
  const price = core.priceFor(PROVIDER, MODEL);
  const cost = price ? usage.prompt * price.input / 1e6 + usage.completion * price.output / 1e6 : null;
  const per = usage.calls ? ` · per call ${Math.round(usage.prompt / usage.calls)} in / ${Math.round(usage.completion / usage.calls)} out` : '';
  return `usage: ${usage.calls} calls, ${usage.prompt} prompt (${usage.prompt ? Math.round(100 * usage.cached / usage.prompt) : 0}% cached), ${usage.completion} completion${per}` +
    (cost === null ? ' · no list price' : ` · $${cost.toFixed(4)} (${price.approx ? 'approx ' : ''}$${price.input}/$${price.output} per M)` + (usage.calls ? ` · $${(cost / usage.calls).toFixed(5)} per call` : ''));
}

const PACK_FILE = argv.includes('--pack-file') ? path.resolve(argv[argv.indexOf('--pack-file') + 1]) : null;
const loadPack = (h) => JSON.parse(fs.readFileSync(h === PACK && PACK_FILE ? PACK_FILE : path.join(R, `defaults/cues/tips-${h}/CUE.md`), 'utf8').match(/```json\s*([\s\S]*?)```/)[1]);
// the case set's pack first (project-first order), then whatever is stacked on it
const pack = [...loadPack(PACK), ...STACK.flatMap((h) => loadPack(h).map((sec) => ({ ...sec, id: `${h}:${sec.id}` })))];
const catalog = core.buildTipsCatalog(pack, { shardSize: SHARD === 'off' ? undefined : Number.parseInt(SHARD, 10) });
const src = new core.SemanticTipsSource({
  httpAdapter: new NodeHttpAdapter({ maxSockets: 4, timeout: 30000 }),
  provider: core.getProvider(PROVIDER), model: MODEL, apiKey: API_KEY,
  log: (m) => { if (VERBOSE) console.log('   ', m); },
});

// ── cases: [draft, trigger regex | null, note, solution regex | null, 'borderline'?] ──
// A 'borderline' trap is reported but does not fail the gate: gpt-oss-120b's verdict on it
// flips between runs hours apart with the pack byte-identical (seen 2026-09-08 on the two
// gemini traps below), and no wording of the entry's when: line moved it either way.
// The 4th field scores the SOLUTION `_` swaps in (alternatives[1]) — the
// whole point is a semantic COMMAND suggestion, and a right entry with the
// wrong stop (Wilfred's live test: the tip's sentence in the buffer) is a
// miss. null = a prose tip, whose rewrite is the model's (printed, not gated).────────────────────────────
// Recall set: the research's "phrases beginners use" and "stuck moments"
// (internal/research/claude-code-cues/, 2026-09-06), none containing the
// trigger word. Trap set: the subject named, the situation absent.
const CASES_BY_PACK = {};
CASES_BY_PACK['claude-code'] = [
  // fresh start / context
  ["ok this is a mess, let's start over on the auth stuff", /^\/clear$/, 'start over', /^\/clear\b/],
  ["let's start fresh, this conversation is polluted", /^\/clear$/, 'polluted conversation', /^\/clear\b/],
  ["we're going in circles, wipe this and begin again", /^\/clear$/, 'circling', /^\/clear\b/],
  ["it forgot the plan we agreed on and is wandering", /^\/compact$/, 'forgot the plan', /^\/compact\b/],
  ["it forgot what i told it ten minutes ago", /^\/compact$|^context$/, 'forgot', /^\/(compact|context)\b/],
  ["this session has got really long, how do i keep it from filling up", /^\/compact$|^context$/, 'session long', /^\/(compact|context)\b/],
  // undo / rewind
  ["how do i undo what it just did to the router", /^\/rewind$|^undo$/, 'undo', /^\/rewind\b/],
  ["that broke everything, go back to before the refactor", /^\/rewind$|^undo$|^revert$|^rollback$/, 'go back', /^\/rewind\b/],
  // cost / limits / model
  ["why is this burning through my budget so fast", /^\/cost$|^\/model$|^\/usage$|^tokens$|^limit$/, 'budget', /^\/(cost|model|usage|clear)\b/],
  ["i hit my limit again, when does it reset", /^\/usage$|^limit$/, 'limit reset', /^\/usage\b/],
  ["can we use a cheaper model for this, it's a trivial change", /^\/model$/, 'cheaper model', /^\/model\b/],
  // sessions
  ["i closed the terminal by accident, can i get yesterday's session back", /^resume$|^\/resume$/, 'closed terminal', null],   // a launch flag is advice, not a swap
  ["name this chat something i can find later", /^\/rename$/, 'name session', /^\/rename\b/],
  // permissions / planning
  ["it keeps asking me to approve every single git command", /^permission$|^\/permissions$|^shift\+tab$/, 'approve every command', /^\/permissions\b/],
  ["make it plan before it touches any files", /^shift\+tab$|^plan$/, 'plan first', null],
  ["can you run three of these in parallel without them stepping on each other", /^worktree$|^agents$|^subagent/, 'parallel', null],   // a launch flag is advice, not a swap
  ["think really hard about this before you answer", /^ultrathink$|^think harder$|^deep thinking$/, 'think hard', null],   // a keyword tip, not a command: gpt-oss appends "ultrathink" to the sentence, qwen hands back the tip text (rejected → advisory)
  ["something auto-formats every edit would be nice", /^hooks?$/, 'auto-format', /^\/hooks\b/],
  ["this is an ugly layout on mobile", /^screenshot$|^ctrl\+v$/, 'ui without screenshot (pack gap: no screenshot entry yet)', null],
  ["why is it so slow on a one line change", /^slow$|^\/model$/, 'slow', /^\/(effort|model)\b/],
  // traps — the subject named, the situation absent
  ["the context of this function is the request object", null, 'context, the word'],
  ["compact the JSON before you send it over the wire", null, 'compact, the verb'],
  ["run /compact before we continue", null, 'trigger typed → static path'],
  ["add a delete button to the ProjectCard component", null, 'plain feature ask'],
  ["the model in models/user.ts needs a created_at field", null, 'model, the noun'],
  ["clear the cache directory before the build", null, 'clear, the verb'],
  ["undo the last migration in the db folder", null, 'undo, a code action'],
  ["resume the paused upload when the network is back", null, 'resume, a code action'],
  ["the cost field on the invoice should be a decimal", null, 'cost, a field'],
  ["what does this project do?", null, 'the quickstart first prompt'],
];
CASES_BY_PACK['opencode'] = [
  ["ok this went wrong, put back what you just changed to the router", /^\/undo$/, 'take back', /^\/undo\b/],
  ["it forgot the plan and this conversation has got really long", /^\/compact$/, 'session long', /^\/compact\b/],
  ["i closed the terminal by accident, can i get yesterday's session back", /^--continue$|^\/sessions$/, 'closed terminal', null],
  ["this conversation is done, wipe it and start fresh on the billing work", /^\/new$/, 'start fresh', /^\/new\b/],
  ["can we use a cheaper model for this, it's a trivial change", /^\/models$|^ctrl\+t$/, 'cheaper model', /^\/models\b|^ctrl/],
  ["make it stop, this answer is going nowhere", /^esc$/, 'stop', null],
  ["what is this costing me so far", /^cost$/, 'cost', null],
  ["let me share this conversation with a teammate", /^\/share$/, 'share', /^\/share\b/],
  ["i keep having to approve every single tool call", /^permission$/, 'approve every call', null],
  ["save this chat as markdown so i can keep it", /^\/export$/, 'export', /^\/export\b/],
  ["which commands even exist here", /^\/help$/, 'which commands', /^\/help\b/],
  ["i can only see the answer, not how it reasoned", /^\/thinking$/, 'show reasoning', /^\/thinking\b/],
  ["name this chat something i can find later", /^rename$/, 'name session', null],
  ["it should remember our coding rules every session", /^agents\.md$|^\/init$/, 'rules every session', /^\/init\b/],
  ["compact the JSON before you send it over the wire", null, 'compact, the verb'],
  ["undo the last migration in the db folder", null, 'undo, a code action'],
  ["the model in models/user.ts needs a created_at field", null, 'model, the noun'],
  ["share the load between the two worker processes", null, 'share, the verb'],
  ["add a delete button to the ProjectCard component", null, 'plain feature ask'],
  ["export the users table to csv from the admin page", null, 'export, a feature'],
];
CASES_BY_PACK['gemini-cli'] = [
  ["this session has got really long and it forgot what i said", /^\/compress$/, 'session long', /^\/compress\b/],
  ["ok this is a mess, let's start over on the auth stuff", /^\/clear$/, 'start over', /^\/clear\b/],
  ["take back what you just did to the router", /^\/restore$/, 'take back', /^\/restore\b/],
  ["i want you to plan before you touch any files, this is risky", /^\/plan$/, 'plan first', /^\/plan\b/],
  ["it keeps asking me to approve every single command", /^--approval-mode$/, 'approve every command', null],
  ["it forgets my coding rules every time i open a new session", /^gemini\.md$/, 'rules every session', /^\/init\b/],
  ["can we use a cheaper faster model for this", /^\/model$/, 'cheaper model', /^\/model\b/],
  ["run this in a pipeline with no one watching", /^-p$/, 'pipeline', null],
  ["this layout looks ugly on mobile", /^screenshot$/, 'ui without screenshot', null],
  ["how do i save this chat so i can find it later", /^\/chat$/, 'save session', /^\/chat\b/],
  ["i hit a bug in the cli itself, where do i report it", /^\/bug$|^--debug$/, 'cli bug', /^\/bug\b|^--debug/],
  ["connect it to my postgres tool", /^\/mcp$/, 'connect a tool', /^\/mcp\b/],
  ["what tools does it actually have", /^\/tools$/, 'which tools', /^\/tools\b/],
  ["i lost track of what's left on the todo list", /^ctrl\+t$/, 'todo list', null],
  // 2026-09-08 review pass: phrasings that held on both models (probe set in the PR that added them)
  ["jump back to where we were discussing the schema", /^\/rewind$/, 'back in the conversation', /^\/rewind\b/],
  ["how do i sign in with my api key", /^\/auth$/, 'sign in', /^\/auth\b/],
  ["every time i press enter it sends the message instead of adding a new line", /^\/terminal-setup$/, 'enter sends', /^\/terminal-setup\b/],
  ["it keeps asking whether i trust this folder", /^\/permissions$/, 'trust prompt', /^\/permissions\b/],
  ["how many tokens have we burned so far", /^\/stats$/, 'tokens used', /^\/stats\b/],
  ["can i use this inside vs code", /^\/ide$/, 'vs code', /^\/ide\b/],
  ["i wish i could use vim keys in this input", /^\/vim$/, 'vim keys', /^\/vim\b/],
  ["how do i exit this thing cleanly", /^\/quit$/, 'quit', /^\/quit\b/],
  ["does google collect my code when i use this", /^\/privacy$/, 'data collection', /^\/privacy\b/],
  ["just run git status for me real quick", /^!$/, 'quick shell command', null],
  ["clear the cache directory before the build", null, 'clear, the verb'],
  ["restore the backup from last night into staging", null, 'restore, a code action', null, 'borderline'],   // gpt-oss flips on this across hours with the pack unchanged
  ["the plan field on the invoice should be nullable", null, 'plan, a field'],
  ["add a compress option to the image upload", null, 'compress, a feature'],
  ["what does this project do?", null, 'the quickstart first prompt'],
  ["the model in models/user.ts needs a created_at field", null, 'model, the noun'],
  ["which tools are in the toolbar component", null, 'tools, a component', null, 'borderline'],
  ["wipe the test database before each run", null, 'wipe, a code action'],
  ["add a resume upload field to the job application form", null, 'resume, the noun'],
  ["the auth middleware rejects expired tokens", null, 'auth, the middleware'],
  ["restore scroll position after navigation", null, 'restore, a ui action'],
  ["the chat component scrolls to the bottom on every message", null, 'chat, a component'],
];
CASES_BY_PACK['shell'] = [
  ["this draft is a mess, can you tidy it up before i send it", /^improve prompt$/, 'rough draft', null],
  ["put this paragraph into french", /^translate$/, 'another language', null],
  ["turn this into a bullet list", /^format$/, 'as a list', null],
  ["make this shorter", /^summarize$/, 'shorter', null],
  ["how do i open the input box thing", /^input box$/, 'input box', null],
  ["turn the volume down a bit", /^volume$/, 'volume', null],
  ["what's the weather like in london today", /^weather$/, 'weather', null],
  ["how do i quit this shell wrapper", /^exit$/, 'quit', null],
  ["does this mess with my existing tmux", /^oc-shell$/, 'tmux', null],
  ["i typed half a command and the box did not pick it up", /^shell-integration$/, 'line not captured', null],
  ["ls -la | grep foo", null, 'a shell line'],
  ["git commit -m 'translate strings for the checkout'", null, 'translate, in a commit message'],
  ["format the new disk with mkfs before mounting it", null, 'format, the disk'],
  ["echo weather > notes.txt", null, 'weather, a filename'],
  ["cd ~/projects && npm test", null, 'a shell line'],
];
const PROBES = argv.flatMap((a, i) => (a === '--probe' ? [argv[i + 1]] : [])).filter(Boolean);
if (PROBES.length > 0) {
  console.log(`\nsemantic tips probe · ${PACK} · ${PROVIDER}/${MODEL} · catalogue ${catalog.entries.length} entries · ${catalog.shards.length} shard(s)\n`);
  for (const text of PROBES) {
    const t0 = Date.now();
    const r = await src.getCues({ text, words: text.split(/\s+/).filter(Boolean), tipsCatalog: catalog });
    const g = r.results[0];
    console.log(`${String(Date.now() - t0).padStart(5)}ms  ${JSON.stringify(text).padEnd(60)} → ${g ? `${g.metadata.tip.trigger.split(' / ')[0].padEnd(14)} ${g.alternatives[1] ?? '(advisory)'}` : '(silent)'}`);
  }
  console.log('\n' + usageLine());
  process.exit(0);
}
const CASES = CASES_BY_PACK[PACK];
if (!CASES) { console.error(`no case set for pack ${PACK}`); process.exit(2); }

let surfaced = 0, silentOk = 0, cited = 0, falseAlarms = 0, misses = 0, wrong = 0, solved = 0, badSolution = 0, totalMs = 0;
const rows = [];
let borderlineAlarms = 0;
for (const [text, want, note, wantSol, flag] of CASES) {
  const t0 = Date.now();
  const r = await src.getCues({ text, words: text.split(/\s+/).filter(Boolean), tipsCatalog: catalog });
  const ms = Date.now() - t0; totalMs += ms;
  const got = r.results[0];
  const trig = got ? got.metadata.tip.trigger.split(' / ')[0].toLowerCase() : null;
  let verdict;
  if (want === null) {
    if (!got) { silentOk++; verdict = 'ok'; }
    else if (flag === 'borderline') { borderlineAlarms++; verdict = 'ALARM (borderline)'; }
    else { falseAlarms++; verdict = 'FALSE ALARM'; }
  }
  else if (!got) { misses++; verdict = 'MISS'; }
  else if (want.test(trig)) {
    surfaced++; cited++;
    const sol = got.alternatives[1] ?? '';
    if (wantSol === null || wantSol === undefined) { verdict = 'ok'; }
    else if (wantSol.test(sol)) { solved++; verdict = 'ok'; }
    else { badSolution++; verdict = 'BAD SOLUTION'; }
  }
  else { surfaced++; wrong++; verdict = 'WRONG ENTRY'; }
  rows.push([verdict, ms, note, trig ?? '(silent)', got ? got.alternatives[1] ?? '(advisory)' : '']);
}
const recallN = CASES.filter(c => c[1] !== null).length, trapN = CASES.length - recallN;
console.log(`\nsemantic tips bench · ${PACK}${STACK.length ? ' + ' + STACK.join(',') : ''} · ${PROVIDER}/${MODEL} · catalogue ${catalog.entries.length} entries (${catalog.text.length} chars) · ${catalog.shards.length} shard(s) of ≤${SHARD}\n`);
for (const [v, ms, note, trig, alt] of rows) console.log(`${v.padEnd(19)} ${String(ms).padStart(5)}ms  ${note.padEnd(30)} → ${trig.padEnd(14)} ${alt}`);
const cmdN = CASES.filter(c => c[1] !== null && c[3]).length;
console.log(`\nrecall set (${recallN}): surfaced ${surfaced}, cited the right entry ${cited}, wrong entry ${wrong}, missed ${misses}`);
console.log(`solutions  (${cmdN} command cases): right ${solved}, wrong stop ${badSolution}`);
console.log(`trap set   (${trapN}): silent ${silentOk}, false alarms ${falseAlarms}${borderlineAlarms ? `, borderline alarms ${borderlineAlarms} (reported, not gated)` : ''}`);
console.log(`mean latency ${Math.round(totalMs / CASES.length)}ms`);
console.log(usageLine());
const gate = falseAlarms === 0 && cited / recallN >= 0.9 && badSolution === 0;
console.log(`\nship gate (0 false alarms, ≥90% cited right, every command case lands its command): ${gate ? 'PASS' : 'FAIL'}`);
process.exit(gate ? 0 : 1);

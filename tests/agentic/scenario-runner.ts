/**
 * Agentic scenario runner — executes JSON scenario files against a
 * running OpenCues host (CC / OC / Gemini CLI) and reports pass/fail.
 *
 * A scenario is a sequence of steps the runner walks linearly:
 *   - inject text / cursor / key
 *   - wait for a state predicate to become true (with timeout)
 *   - assert state matches expected values
 *
 * The runner reads/writes the same /tmp/opencues-*.json files that
 * agentic-mode exposes; nothing in the runtime needs to know about
 * scenarios — the runner just sequences the same primitives a human
 * would.
 *
 * Usage:
 *   npx tsx tests/agentic/scenario-runner.ts --pid <pid> --scenario <path.json>
 *   npx tsx tests/agentic/scenario-runner.ts --pid <pid> --dir tests/agentic/scenarios
 *
 * Scenario format (see tests/agentic/scenarios/*.json for examples):
 *
 *   {
 *     "name": "cycle the lawyer to attorney",
 *     "host": "claude-code",          // optional — recorded in the report
 *     "steps": [
 *       {"action": "clear"},
 *       {"action": "inject", "text": "the lawyer filed today"},
 *       {"action": "waitFor", "path": "highlightedWord", "equals": "lawyer", "timeoutMs": 5000},
 *       {"action": "key", "key": "up", "modifiers": ["ctrl", "alt"]},
 *       {"action": "waitFor", "path": "currentAltIndex", "equals": 1, "timeoutMs": 2000},
 *       {"action": "expect", "path": "alts.1", "equals": "attorney"},
 *       {"action": "expect", "path": "active", "equals": true}
 *     ]
 *   }
 *
 * Exit codes:
 *   0  all scenarios passed
 *   1  one or more scenarios failed
 *   2  bad usage / missing files / etc.
 *
 * The runner pulls state from /tmp/opencues-status-<pid>.json (Statusline
 * snapshot — has highlightedWord, alts, currentAltIndex, agentTask, etc.)
 * and from /tmp/opencues-agentic-dump-<pid>.json (richer, on-demand).
 * `path` is dot-notation (`alts.1`, `dynDefs.defs.0.word`, `agentTask`).
 *
 * `expect` is synchronous — reads state once, asserts. `waitFor` polls
 * every 100ms until the predicate is true or `timeoutMs` elapses.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

type StepAction = 'clear' | 'inject' | 'cursor' | 'key' | 'dump' | 'sleep'
  | 'waitFor' | 'expect' | 'waitForEvent' | 'expectEvent';

interface BaseStep { action: StepAction }
interface ClearStep extends BaseStep { action: 'clear' }
interface InjectStep extends BaseStep { action: 'inject'; text: string; keepHighlight?: boolean }
interface CursorStep extends BaseStep { action: 'cursor'; offset: number }
interface KeyStep extends BaseStep { action: 'key'; key: string; modifiers?: string[] }
interface DumpStep extends BaseStep { action: 'dump' }
interface SleepStep extends BaseStep { action: 'sleep'; ms: number }
interface WaitForStep extends BaseStep {
  action: 'waitFor';
  path: string;
  equals?: unknown;
  matches?: string;        // regex (string source)
  timeoutMs?: number;
  source?: 'status' | 'dump';   // default: status
}
interface ExpectStep extends BaseStep {
  action: 'expect';
  path: string;
  equals?: unknown;
  matches?: string;
  source?: 'status' | 'dump';
}
/** Wait for an event matching the given filter to appear in the
 *  events stream. More precise than waitFor on derived state — events
 *  are point-in-time facts the runtime emitted. */
interface WaitForEventStep extends BaseStep {
  action: 'waitForEvent';
  /** body.type to match. */
  type: string;
  /** Optional dot-path inside body to match against. */
  path?: string;
  equals?: unknown;
  matches?: string;
  timeoutMs?: number;
  /** Only consider events with ts >= this. Set to "now" to ignore
   *  events emitted before this step ran. Default: "now". */
  since?: 'now' | number;
}
/** Assert that an event matching the filter has ALREADY been emitted. */
interface ExpectEventStep extends BaseStep {
  action: 'expectEvent';
  type: string;
  path?: string;
  equals?: unknown;
  matches?: string;
  /** Default "now-30s" to allow recent events; set "all" to scan the
   *  whole file. */
  since?: 'now' | 'all' | number;
}
type Step = ClearStep | InjectStep | CursorStep | KeyStep | DumpStep | SleepStep
  | WaitForStep | ExpectStep | WaitForEventStep | ExpectEventStep;

interface Scenario {
  name: string;
  host?: string;
  steps: Step[];
}

interface StepResult {
  step: Step;
  pass: boolean;
  reason?: string;
  durationMs: number;
}

interface ScenarioResult {
  scenario: Scenario;
  steps: StepResult[];
  pass: boolean;
  durationMs: number;
}

// ─── Args ──────────────────────────────────────────────────────────────

interface Args {
  pid: number;
  scenarios: string[];
  verbose: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { pid: 0, scenarios: [], verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pid') out.pid = parseInt(argv[++i] ?? '', 10);
    else if (a === '--scenario') out.scenarios.push(argv[++i] ?? '');
    else if (a === '--dir') {
      const dir = argv[++i] ?? '';
      // Recurse one level only — _flaky/ subfolders are deliberately
      // skipped (they're environment-dependent; see _flaky/README.md).
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json')) out.scenarios.push(path.join(dir, f));
      }
    }
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!out.pid || out.scenarios.length === 0) {
    printHelp();
    process.exit(2);
  }
  return out;
}

function printHelp(): void {
  console.log(`Usage: scenario-runner --pid <pid> {--scenario <file> | --dir <dir>}... [-v]

Drives a running OPENCUES_AGENTIC=1 host through a sequence of JSON
scenarios. Reads/writes /tmp/opencues-*-<pid>.{txt,json}.

Options:
  --pid <n>          PID of the host process (find via tests/agentic/oc-pid)
  --scenario <path>  Run one scenario file (.json). Repeatable.
  --dir <path>       Run all .json files in this directory.
  --verbose          Print each step's progress + state snapshots on assert.
  --help             Show this message.
`);
}

// ─── IPC ───────────────────────────────────────────────────────────────

const SLEEP = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

function injectFilePath(pid: number): string { return `/tmp/opencues-inject-${pid}.txt`; }
function statusFilePath(pid: number): string { return `/tmp/opencues-status-${pid}.json`; }
function dumpFilePath(pid: number): string   { return `/tmp/opencues-agentic-dump-${pid}.json`; }
function eventsFilePath(pid: number): string { return `/tmp/opencues-events-${pid}.jsonl`; }

/** Read the events file as an array of event envelopes (ts, v, pid, body). */
function readEvents(pid: number): Array<{ ts: number; v: number; pid: number; body: { type: string; [k: string]: unknown } }> {
  const path = eventsFilePath(pid);
  if (!fs.existsSync(path)) return [];
  return fs.readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter((e): e is { ts: number; v: number; pid: number; body: { type: string } } => e != null);
}

/** Find the most recent event matching the filter, with ts >= sinceTs. */
function findEvent(
  pid: number,
  type: string,
  sinceTs: number,
  predicate?: (body: Record<string, unknown>) => boolean,
): { ts: number; body: Record<string, unknown> } | null {
  const events = readEvents(pid);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.ts < sinceTs) break;       // events file is monotonic by ts
    if (e.body.type !== type) continue;
    if (predicate && !predicate(e.body as Record<string, unknown>)) continue;
    return { ts: e.ts, body: e.body as Record<string, unknown> };
  }
  return null;
}

async function inject(pid: number, lines: string[]): Promise<void> {
  fs.writeFileSync(injectFilePath(pid), lines.join('\n'));
  // Wait for the harness to consume — file disappears within ~200ms
  // (poll cadence is 100ms). Cap at 500ms to surface a stuck harness.
  for (let i = 0; i < 50; i++) {
    if (!fs.existsSync(injectFilePath(pid))) return;
    await SLEEP(10);
  }
  throw new Error(`harness did not consume ${injectFilePath(pid)} within 500ms — is OPENCUES_AGENTIC=1 set?`);
}

function readStatus(pid: number): unknown {
  const p = statusFilePath(pid);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readDump(pid: number): unknown {
  const p = dumpFilePath(pid);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ─── State path navigation ─────────────────────────────────────────────

/** `alts.1.foo.bar` → walk obj.alts[1].foo.bar. Numeric path segments
 *  index arrays. Missing keys yield undefined. */
function getPath(obj: unknown, dotPath: string): unknown {
  if (obj == null) return undefined;
  let cur: any = obj;
  for (const seg of dotPath.split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else cur = cur[seg];
  }
  return cur;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return false;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

// ─── Step execution ────────────────────────────────────────────────────

async function runStep(pid: number, step: Step, verbose: boolean): Promise<StepResult> {
  const t0 = Date.now();
  const result: StepResult = { step, pass: true, durationMs: 0 };
  try {
    switch (step.action) {
      case 'clear':
        await inject(pid, ['clear']);
        break;
      case 'inject':
        await inject(pid, [`${step.keepHighlight ? 'text-keep-hl' : 'text'}:${step.text}`]);
        break;
      case 'cursor':
        await inject(pid, [`cursor:${step.offset}`]);
        break;
      case 'key': {
        const mods = (step.modifiers ?? []).join('+');
        await inject(pid, [`key:${step.key}:${mods}`]);
        break;
      }
      case 'dump':
        await inject(pid, ['dump']);
        await SLEEP(150);
        break;
      case 'sleep':
        await SLEEP(step.ms);
        break;
      case 'waitFor': {
        const timeout = step.timeoutMs ?? 5000;
        const source = step.source ?? 'status';
        const start = Date.now();
        let lastSeen: unknown;
        // Touch the dump source if needed, so the first read isn't stale.
        if (source === 'dump') await inject(pid, ['dump']);
        while (Date.now() - start < timeout) {
          const state = source === 'dump' ? readDump(pid) : readStatus(pid);
          lastSeen = getPath(state, step.path);
          if (matches(lastSeen, step)) {
            result.durationMs = Date.now() - t0;
            return result;
          }
          await SLEEP(100);
          if (source === 'dump') await inject(pid, ['dump']);
        }
        result.pass = false;
        result.reason = `waitFor timed out after ${timeout}ms — ${step.path}=${JSON.stringify(lastSeen)} did not match ${describePredicate(step)}`;
        break;
      }
      case 'expect': {
        const source = step.source ?? 'status';
        if (source === 'dump') {
          await inject(pid, ['dump']);
          await SLEEP(150);
        }
        const state = source === 'dump' ? readDump(pid) : readStatus(pid);
        const value = getPath(state, step.path);
        if (!matches(value, step)) {
          result.pass = false;
          result.reason = `${step.path}=${JSON.stringify(value)} did not match ${describePredicate(step)}`;
          if (verbose) {
            result.reason += `\n    full state: ${JSON.stringify(state, null, 2).slice(0, 600)}`;
          }
        }
        break;
      }
      case 'waitForEvent': {
        const timeout = step.timeoutMs ?? 5000;
        // Default `since` includes a ~2s lookback so we don't race events
        // emitted by the immediately-preceding step. Keys dispatch
        // synchronously and emit text.changed in the same tick — by the
        // time waitForEvent starts polling, those events already exist
        // in the file. Set `since: 'now'` explicitly to require strict
        // post-step events; set `since: 'all'` to scan the whole file.
        const sinceTs = step.since === 'now' ? Date.now()
          : step.since === undefined ? Date.now() - 2000
          : step.since;
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const found = findEvent(pid, step.type, sinceTs, (body) => {
            if (!step.path) return matchesEventBody(body, step);
            return matchesEventField(body, step.path, step);
          });
          if (found) {
            result.durationMs = Date.now() - t0;
            return result;
          }
          await SLEEP(50);
        }
        result.pass = false;
        result.reason = `waitForEvent timed out after ${timeout}ms — no event type=${step.type}${describeEventPredicate(step)}`;
        break;
      }
      case 'expectEvent': {
        const sinceTs = step.since === 'now' ? Date.now()
          : step.since === 'all' || step.since === undefined ? 0
          : step.since;
        const found = findEvent(pid, step.type, sinceTs, (body) => {
          if (!step.path) return matchesEventBody(body, step);
          return matchesEventField(body, step.path, step);
        });
        if (!found) {
          result.pass = false;
          result.reason = `expectEvent: no event type=${step.type}${describeEventPredicate(step)}`;
        }
        break;
      }
      default:
        result.pass = false;
        result.reason = `unknown action: ${(step as { action: string }).action}`;
    }
  } catch (err) {
    result.pass = false;
    result.reason = `step threw: ${(err as Error).message}`;
  }
  result.durationMs = Date.now() - t0;
  return result;
}

function matches(value: unknown, step: WaitForStep | ExpectStep): boolean {
  if ('equals' in step && step.equals !== undefined) {
    return valuesEqual(value, step.equals);
  }
  if ('matches' in step && step.matches !== undefined) {
    return new RegExp(step.matches).test(String(value ?? ''));
  }
  // Predicate-less waits/expects: pass if the path resolves to a truthy value.
  return value !== undefined && value !== null && value !== '';
}

function describePredicate(step: WaitForStep | ExpectStep): string {
  if ('equals' in step && step.equals !== undefined) return `equals ${JSON.stringify(step.equals)}`;
  if ('matches' in step && step.matches !== undefined) return `matches /${step.matches}/`;
  return 'truthy';
}

/** Event-body matcher when no `path` is given — pass if equals/matches
 *  match the body itself (rare; usually you want `path`). */
function matchesEventBody(body: Record<string, unknown>, step: WaitForEventStep | ExpectEventStep): boolean {
  if (step.equals !== undefined) return valuesEqual(body, step.equals);
  if (step.matches !== undefined) return new RegExp(step.matches).test(JSON.stringify(body));
  return true;  // type match alone suffices
}

/** Event-body matcher with a dot-path inside body. */
function matchesEventField(body: Record<string, unknown>, path: string, step: WaitForEventStep | ExpectEventStep): boolean {
  const value = getPath(body, path);
  if (step.equals !== undefined) return valuesEqual(value, step.equals);
  if (step.matches !== undefined) return new RegExp(step.matches).test(String(value ?? ''));
  return value !== undefined && value !== null && value !== '';
}

function describeEventPredicate(step: WaitForEventStep | ExpectEventStep): string {
  if (!step.path && step.equals === undefined && step.matches === undefined) return '';
  const where = step.path ? ` ${step.path}` : '';
  if (step.equals !== undefined) return `${where} equals ${JSON.stringify(step.equals)}`;
  if (step.matches !== undefined) return `${where} matches /${step.matches}/`;
  return where;
}

// ─── Scenario runner ───────────────────────────────────────────────────

async function runScenario(pid: number, file: string, verbose: boolean): Promise<ScenarioResult> {
  const t0 = Date.now();
  let scenario: Scenario;
  try {
    scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return {
      scenario: { name: path.basename(file), steps: [] },
      steps: [],
      pass: false,
      durationMs: 0,
    };
  }

  const stepResults: StepResult[] = [];
  let allPass = true;
  for (const step of scenario.steps) {
    const r = await runStep(pid, step, verbose);
    stepResults.push(r);
    if (verbose) {
      const mark = r.pass ? '✓' : '✗';
      const desc = describeStep(step);
      console.log(`    ${mark} ${desc} (${r.durationMs}ms)${r.reason ? ' — ' + r.reason : ''}`);
    }
    if (!r.pass) {
      allPass = false;
      break;     // bail on first failure (matches vitest .only-failed semantics)
    }
  }

  return { scenario, steps: stepResults, pass: allPass, durationMs: Date.now() - t0 };
}

function describeStep(step: Step): string {
  switch (step.action) {
    case 'inject': return `inject "${step.text.slice(0, 40)}${step.text.length > 40 ? '…' : ''}"`;
    case 'cursor': return `cursor ${step.offset}`;
    case 'key': return `key ${step.key}${step.modifiers?.length ? '+' + step.modifiers.join('+') : ''}`;
    case 'waitFor': return `waitFor ${step.path} ${describePredicate(step)}`;
    case 'expect': return `expect ${step.path} ${describePredicate(step)}`;
    case 'waitForEvent': return `waitForEvent type=${step.type}${describeEventPredicate(step)}`;
    case 'expectEvent': return `expectEvent type=${step.type}${describeEventPredicate(step)}`;
    case 'sleep': return `sleep ${step.ms}ms`;
    case 'clear': return 'clear';
    case 'dump': return 'dump';
  }
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  if (!fs.existsSync(`/proc/${args.pid}`)) {
    console.error(`pid ${args.pid} not running`);
    process.exit(2);
  }

  console.log(`Driving pid ${args.pid} through ${args.scenarios.length} scenario(s)\n`);

  const results: ScenarioResult[] = [];
  for (const file of args.scenarios) {
    if (!fs.existsSync(file)) {
      console.error(`✗ ${file} — file not found`);
      results.push({
        scenario: { name: path.basename(file), steps: [] },
        steps: [],
        pass: false,
        durationMs: 0,
      });
      continue;
    }
    const r = await runScenario(args.pid, file, args.verbose);
    results.push(r);
    const mark = r.pass ? '✓' : '✗';
    const stepsRun = r.steps.length;
    const totalSteps = r.scenario.steps.length;
    console.log(`${mark} ${r.scenario.name.padEnd(40)} (${stepsRun}/${totalSteps} steps, ${r.durationMs}ms)`);
    if (!r.pass) {
      const failed = r.steps[r.steps.length - 1];
      console.log(`    failure at: ${describeStep(failed.step)}`);
      console.log(`    reason:     ${failed.reason}`);
    }
  }

  const pass = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`${pass}/${total} scenarios passed`);
  process.exit(pass === total ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});

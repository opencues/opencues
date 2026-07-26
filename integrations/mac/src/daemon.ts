// OpenCues mac daemon — the universal macOS host.
//
// Hosts the OpenCues runtime against WHATEVER text element currently
// has keyboard focus, in any app, via the Accessibility API. No
// polling, no app-specific automation. The Swift bridge
// (../ax-bridge.swift) pushes focus/change/cursor events as JSON lines
// and applies ~1ms in-place range replacements; this file is thin glue
// between those events and the runtime's universal (no-cycling) boot.
//
// The buffer IS the focused element's value and the cursor IS the real
// caret, so the host is nearly stateless. What remains: a small echo
// ring (our own AX writes come back as change events) and a focus
// baseline (an `_` already sitting in a field must not arm on focus).
//
// Spike evidence for every capability: ../AX-SPIKE.md.

import { boot, type BootResult } from '@opencues/runtime/dist/adapters/universal/v1/boot';
import { DaemonCore } from './daemon-core';
import { buildBlanks, makeSpawnProcess } from './host-support';
import type { LogLevel } from '@opencues/runtime/dist/src/adapter';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';

const LOG_PATH = process.env['OPENCUES_LOG'] ?? '/tmp/opencues.log';

function log(level: LogLevel, msg: string, data?: unknown): void {
  const line = `[mac][${level}] ${new Date().toISOString()} ${msg}${data !== undefined ? ' ' + safeJson(data) : ''}\n`;
  try { appendFileSync(LOG_PATH, line); } catch { /* log path unwritable */ }
  if (level === 'error' || process.env['DEBUG_OPENCUES']) process.stderr.write(line);
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Terminals host their own OpenCues integration (oc-shell) and their
// scrollback is not a document — never treat them as the buffer.
const DEFAULT_DENY = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp',
  'com.mitchellh.ghostty',
]);
const deniedBundles = (): Set<string> => {
  const extra = (process.env['OPENCUES_AX_DENY'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return new Set([...DEFAULT_DENY, ...extra]);
};

// Single-instance lock (same rationale as every other daemon host).
const LOCK_PATH = '/tmp/opencues-mac.lock';

function acquireLockOrExit(): void {
  const fsSync = require('node:fs') as typeof import('node:fs');
  try {
    fsSync.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
  } catch {
    let pid = NaN;
    try { pid = parseInt(fsSync.readFileSync(LOCK_PATH, 'utf8'), 10); } catch { /* unreadable */ }
    let alive = false;
    if (Number.isFinite(pid)) {
      try { process.kill(pid, 0); alive = true; }
      catch (err) { alive = (err as NodeJS.ErrnoException)?.code === 'EPERM'; }
    }
    if (alive) {
      console.error(`opencues mac daemon already running (pid ${pid}).`);
      process.exit(1);
    }
    try { fsSync.unlinkSync(LOCK_PATH); } catch { /* raced */ }
    fsSync.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
  }
  const release = (): void => {
    try {
      if (fsSync.readFileSync(LOCK_PATH, 'utf8') === String(process.pid)) fsSync.unlinkSync(LOCK_PATH);
    } catch { /* already gone */ }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { release(); process.exit(130); });
  }
}

export async function main(): Promise<void> {
  acquireLockOrExit();
  const bridgePath = path.join(__dirname, 'ax-bridge');
  const bridge = spawn(bridgePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  bridge.on('exit', code => {
    log(code === 0 ? 'info' : 'error', `ax-bridge exited (${code}) — daemon stopping`);
    process.exit(code ?? 1);
  });
  bridge.stderr.on('data', (d: Buffer) => log('warn', 'ax-bridge stderr', d.toString().trim()));

  // All event/state logic lives in the platform-free DaemonCore (fully
  // unit-tested on any OS — see daemon-core.test.ts); this function is
  // only the process glue around it.
  const core = new DaemonCore({
    send: obj => { bridge.stdin.write(JSON.stringify(obj) + '\n'); },
    log,
    deniedBundles,
    charBudgetEnv: () => process.env['OPENCUES_AX_CHAR_BUDGET'],
    replaceQueryEnv: () => process.env['OPENCUES_AX_REPLACE_QUERY'],
    cyclingEnv: () => process.env['OPENCUES_AX_CYCLING'],
    onUntrusted: () => process.exit(1),
  });

  const { registry, blankInvoke } = buildBlanks();

  const bootResult: BootResult = boot({
    hostName: 'mac',
    hostVersion: require('../package.json').version as string,
    cwd: process.cwd(),
    getText: () => core.getText(),
    getCursorOffset: () => core.getCursorOffset(),
    setText: text => core.requestWrite(text),
    pushText: text => core.requestWrite(text),
    setCursorOffset: () => { /* caret follows the AX replace */ },
    forceRender: () => { /* host app renders itself */ },
    // Narrow fields (Spotlight ~37 visible chars) get a soft "keep it
    // short" instruction in the LLM prompt — see charBudgetForBundle.
    getAnswerCharBudget: () => core.getAnswerCharBudget(),
    // …and in a query box that narrow, the answer REPLACES the typed
    // question rather than trailing after it — see replaceQueryForBundle.
    getAnswerReplacesQuery: () => core.getAnswerReplacesQuery(),
    // Names the focused app so fluid-blank can shape the answer as valid
    // input for THAT app (Finder search box → `*.pdf`). Inert until
    // `ambient-context-mode: on` — the resolver doesn't ask otherwise.
    getAmbientContext: () => core.getAmbientContext(),
    // Cycling is live only where the bridge's chord tap is armed (attachable,
    // non-denied field). OPENCUES_AX_CYCLING=off restores the old profile.
    supportsCycling: () => core.supportsCycling(),
    readFile: async (p: string) => {
      try { return await fs.readFile(p, 'utf8'); } catch { return null; }
    },
    readDir: async (p: string) => {
      try {
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
      } catch { return null; }
    },
    writeFile: async (p: string, c: string) => { await fs.writeFile(p, c); },
    spawnProcess: makeSpawnProcess(),
    blankInvoke,
    blanks: registry,
    // Real keystroke events on this host, but the arm fires on the `_`
    // itself (typing has already stopped); keep the snappy 150ms the
    // polled host validated rather than the 500ms typing debounce.
    llmDebounceMs: 150,
    log,
    statusFilePath: `/tmp/opencues-status-${process.pid}.json`,
    llmApiKey: process.env['GROQ_API_KEY'],
    llmEndpoint: process.env['OPENCUES_LLM_ENDPOINT'],
    llmDefaultModel: process.env['OPENCUES_LLM_MODEL'],
    llmApiKeys: {
      GROQ_API_KEY: process.env['GROQ_API_KEY'],
      OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'],
      GEMINI_API_KEY: process.env['GEMINI_API_KEY'],
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
      ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
      CEREBRAS_API_KEY: process.env['CEREBRAS_API_KEY'],
    },
  });
  core.attachRuntime(bootResult);

  const rl = readline.createInterface({ input: bridge.stdout });
  rl.on('line', (line: string) => core.handleLine(line));

  log('info', 'daemon started — universal AX host (focused text element, any app)');
}

/* istanbul ignore next -- entrypoint */
if (require.main === module) {
  main().catch(err => {
    log('error', 'daemon crashed', String(err?.stack ?? err));
    process.exit(1);
  });
}

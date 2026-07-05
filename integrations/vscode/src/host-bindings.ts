// Node-side host bindings for the OpenCues VS Code extension: blanks
// registry, sandboxed spawnProcess, config paths, and the LLM key bag.
//
// Ported from integrations/shell/src/bootstrap.ts (the other self-owned
// Node host) minus its oc-editd daemon snapshot cache. Everything here
// is plain Node — no `vscode` imports — so it can be exercised outside
// an extension host.

import {
  existsSync as fsExistsSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  createBlankInvoke,
  createDefaultBlanksRegistry,
  type Blank,
} from '@opencues/runtime/dist/src/blanks';
import {
  validateScriptPath,
  appendAuditLog,
} from '@opencues/runtime/dist/src/security/spawn-sandbox';
import { wrapWithBwrap } from '@opencues/runtime/dist/src/security/sandbox-runner';
import {
  buildUserBlankRegistry,
  createNativeLlmAdapter,
  type BlankConfigLike,
} from '@opencues/runtime/dist/src/user-blanks/registry';
import type { ProcessSpec, ProcessHandle, BlankInvokeSpec, LogLevel } from '@opencues/runtime/dist/src/adapter';
import { parseSingleCueMd } from '@opencues/core';
import { parseDotEnv } from './pure';

type LogFn = (level: LogLevel, msg: string, data?: unknown) => void;

export function getCuesRoots(workspaceRoot: string | null): string[] {
  const roots: string[] = [];
  if (process.env['OPENCUES_HOME']) roots.push(process.env['OPENCUES_HOME']);
  if (workspaceRoot) roots.push(path.join(workspaceRoot, '.cues'));
  roots.push(path.join(os.homedir(), '.cues'));
  return roots;
}

function opencuesHomeRoot(): string {
  return process.env['OPENCUES_HOME'] ?? path.join(os.homedir(), '.cues');
}

export function findOpenCuesMdPath(): string {
  return path.join(opencuesHomeRoot(), 'OPENCUES.md');
}

export function findIdentityMdPath(): string {
  return path.join(opencuesHomeRoot(), 'IDENTITY.md');
}

export function resolveTtsScript(): string | undefined {
  const p = path.join(opencuesHomeRoot(), 'scripts', 'speak.sh');
  return fsExistsSync(p) ? p : undefined;
}

/** Multi-provider key bag: process env wins over ~/.cues/.env (the
 *  `opencues set-key` store). VS Code is rarely launched from a shell
 *  that exported the keys, so the .env fallback is what makes set-key
 *  "just work" here. */
export function loadApiKeys(): Record<string, string | undefined> {
  const KEY_NAMES = [
    'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY',
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CEREBRAS_API_KEY',
  ] as const;
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseDotEnv(fsReadFileSync(path.join(opencuesHomeRoot(), '.env'), 'utf8'));
  } catch { /* no .env — env-only */ }
  const bag: Record<string, string | undefined> = {};
  for (const k of KEY_NAMES) bag[k] = process.env[k] ?? fromFile[k];
  return bag;
}

function discoverUserBlankConfigs(workspaceRoot: string | null): BlankConfigLike[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const r of getCuesRoots(workspaceRoot)) {
    const abs = path.resolve(r);
    if (seen.has(abs)) continue;
    seen.add(abs);
    roots.push(abs);
  }
  const out: BlankConfigLike[] = [];
  for (const root of roots) {
    const blanksDir = path.join(root, 'blanks');
    if (!fsExistsSync(blanksDir)) continue;
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = fsReaddirSync(blanksDir, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const blankMdPath = path.join(blanksDir, entry.name, 'BLANK.md');
      let content: string;
      try { content = fsReadFileSync(blankMdPath, 'utf8'); } catch { continue; }
      try {
        const parsed = parseSingleCueMd(content, path.dirname(blankMdPath));
        const blk = parsed.blanks?.[entry.name];
        if (blk?.impl) out.push(blk as BlankConfigLike);
      } catch { /* skip on parse error */ }
    }
  }
  return out;
}

export interface BlanksBundle {
  registry: Map<string, Blank>;
  blankInvoke: (spec: BlankInvokeSpec) => ProcessHandle | null;
}

export function buildBlanksBundle(workspaceRoot: string | null, log: LogFn): BlanksBundle {
  const registry: Map<string, Blank> = createDefaultBlanksRegistry({
    finnhubApiKey: process.env['FINNHUB_API_KEY'],
    opencuesMdIO: {
      readFile: async () => {
        try { return await fs.readFile(findOpenCuesMdPath(), 'utf8'); } catch { return null; }
      },
      writeFile: async (content) => {
        await fs.writeFile(findOpenCuesMdPath(), content, 'utf8');
      },
    },
    // Sentinel-write blank — see security-audit.md row #24.
    identityMdIO: {
      readFile: async () => {
        try { return await fs.readFile(findIdentityMdPath(), 'utf8'); } catch { return null; }
      },
      writeFile: async (content) => {
        await fs.writeFile(findIdentityMdPath(), content, 'utf8');
      },
    },
  });

  const userBlanks = buildUserBlankRegistry(discoverUserBlankConfigs(workspaceRoot), {
    storageRoot: opencuesHomeRoot(),
    secrets: process.env as Readonly<Record<string, string>>,
    llm: createNativeLlmAdapter(process.env as Record<string, string>),
    log: (lvl, msg) => log(lvl === 'warn' || lvl === 'error' ? lvl : 'debug', `user-blank: ${msg}`),
  });
  for (const [n, b] of userBlanks) registry.set(n, b);

  return { registry, blankInvoke: createBlankInvoke(registry) };
}

/** Sandboxed subprocess spawn — same validation chain as shell:
 *  script paths confined to CUES roots, bwrap wrapping when available,
 *  audit log on every invocation. */
export function makeSpawnProcess(workspaceRoot: string | null): (spec: ProcessSpec) => ProcessHandle {
  return (spec: ProcessSpec): ProcessHandle => {
    const cuesRoots = getCuesRoots(workspaceRoot);
    const anySpec = spec as ProcessSpec & { input?: string; timeoutMs?: number; detached?: boolean };
    const rawArgs: string[] = Array.isArray(spec.args) ? spec.args.map(String) : [];
    const safeArgs: string[] = [];
    for (const a of rawArgs) {
      const r = validateScriptPath(a, cuesRoots);
      if (!r.ok) {
        appendAuditLog('vscode', spec, { exitCode: 126 }, cuesRoots);
        return {
          result: Promise.resolve({ exitCode: 126, stdout: '', stderr: r.reason ?? 'path outside CUES roots', timedOut: false }),
          kill: () => {},
        } as ProcessHandle;
      }
      safeArgs.push(r.resolved ?? a);
    }
    const wrapped = wrapWithBwrap(spec.command, safeArgs, spec.sandbox, cuesRoots);
    const finalCommand = wrapped?.command ?? spec.command;
    const finalArgs = wrapped?.args ?? safeArgs;

    const startedAt = Date.now();
    const wantStdin = typeof anySpec.input === 'string' && anySpec.input.length > 0;
    const stdio: 'ignore' | Array<'pipe' | 'ignore'> = anySpec.detached
      ? 'ignore'
      : [wantStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'];
    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = nodeSpawn(finalCommand, finalArgs, {
        env: spec.env as NodeJS.ProcessEnv | undefined,
        cwd: spec.cwd,
        detached: !!anySpec.detached,
        stdio,
      });
    } catch (err) {
      appendAuditLog('vscode', spec, { exitCode: 127 }, cuesRoots);
      return {
        result: Promise.resolve({ exitCode: 127, stdout: '', stderr: String((err as Error)?.message ?? err), timedOut: false }),
        kill: () => {},
      } as ProcessHandle;
    }
    if (wantStdin && child.stdin) {
      try { child.stdin.write(anySpec.input); child.stdin.end(); } catch { /* stream closed */ }
    }
    let stdout = '', stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const result = new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      let timedOut = false;
      let killer: NodeJS.Timeout | null = null;
      const timer = anySpec.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch { /* gone */ }
            killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1000);
          }, anySpec.timeoutMs)
        : null;
      const finish = (code: number | null): void => {
        if (timer) clearTimeout(timer);
        if (killer) clearTimeout(killer);
        const exit = code ?? 0;
        appendAuditLog('vscode', spec, { exitCode: exit, timedOut }, cuesRoots, Date.now() - startedAt);
        resolve({ exitCode: exit, stdout, stderr, timedOut });
      };
      child.on('exit', finish);
      child.on('error', (err) => {
        stderr += String((err as Error)?.message ?? err);
        finish(127);
      });
    });
    if (anySpec.detached) child.unref();
    return {
      result,
      kill: (sig?: string) => { try { child.kill((sig as NodeJS.Signals) || 'SIGTERM'); } catch { /* gone */ } },
    } as ProcessHandle;
  };
}

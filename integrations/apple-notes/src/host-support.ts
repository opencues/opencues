// Node-side host plumbing shared by daemon.ts: cues roots, the blanks
// registry (default + user blanks), and the sandboxed spawnProcess
// implementation. Adapted from integrations/shell/src/bootstrap.ts
// (minus the oc-editd snapshot cache — this daemon reads disk directly).

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
import { parseSingleCueMd } from '@opencues/core';
import {
  existsSync as fsExistsSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
} from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';

export function getCuesRoots(): string[] {
  const roots: string[] = [];
  if (process.env['OPENCUES_HOME']) roots.push(process.env['OPENCUES_HOME']);
  roots.push(path.join(process.cwd(), '.cues'));
  roots.push(path.join(os.homedir(), '.cues'));
  return roots;
}

function findOpenCuesMdPath(): string {
  if (process.env['OPENCUES_HOME']) {
    return path.join(process.env['OPENCUES_HOME'], 'OPENCUES.md');
  }
  return path.join(process.env['HOME'] ?? os.homedir(), '.cues', 'OPENCUES.md');
}

function findIdentityMdPath(): string {
  if (process.env['OPENCUES_HOME']) {
    return path.join(process.env['OPENCUES_HOME'], 'IDENTITY.md');
  }
  return path.join(process.env['HOME'] ?? os.homedir(), '.cues', 'IDENTITY.md');
}

function discoverUserBlankConfigs(): BlankConfigLike[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const r of getCuesRoots()) {
    const abs = path.resolve(r);
    if (!seen.has(abs)) { seen.add(abs); roots.push(abs); }
  }
  const out: BlankConfigLike[] = [];
  for (const root of roots) {
    const blanksDir = path.join(root, 'blanks');
    if (!fsExistsSync(blanksDir)) continue;
    let entries;
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

export function buildBlanks(): { registry: Map<string, Blank>; blankInvoke: ReturnType<typeof createBlankInvoke> } {
  const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
  const registry: Map<string, Blank> = createDefaultBlanksRegistry({
    finnhubApiKey: process.env['FINNHUB_API_KEY'],
    opencuesMdIO: {
      readFile: async () => {
        try { return await fsp.readFile(findOpenCuesMdPath(), 'utf8'); } catch { return null; }
      },
      writeFile: async (content: string) => {
        await fsp.writeFile(findOpenCuesMdPath(), content, 'utf8');
      },
    },
    identityMdIO: {
      readFile: async () => {
        try { return await fsp.readFile(findIdentityMdPath(), 'utf8'); } catch { return null; }
      },
      writeFile: async (content: string) => {
        await fsp.writeFile(findIdentityMdPath(), content, 'utf8');
      },
    },
  });
  const userBlanks = buildUserBlankRegistry(discoverUserBlankConfigs(), {
    storageRoot: process.env['OPENCUES_HOME'] ?? path.join(process.env['HOME'] ?? os.homedir(), '.cues'),
    secrets: process.env as Readonly<Record<string, string>>,
    llm: createNativeLlmAdapter(process.env as Record<string, string>),
    log: (lvl: string, msg: string) => {
      if (lvl === 'warn' || lvl === 'error') console.warn(`[apple-notes] user-blank ${lvl}: ${msg}`);
      else if (process.env['DEBUG_OPENCUES']) console.log(`[apple-notes] user-blank ${lvl}: ${msg}`);
    },
  });
  for (const [n, b] of userBlanks) registry.set(n, b);
  return { registry, blankInvoke: createBlankInvoke(registry) };
}

// Sandboxed script-blank spawn — same audit + path-validation + bwrap
// wrapping as the shell integration (see security-audit.md).
export function makeSpawnProcess() {
  return (spec: any) => {
    const cuesRoots = getCuesRoots();
    const rawArgs: string[] = Array.isArray(spec.args) ? spec.args.map(String) : [];
    const safeArgs: string[] = [];
    for (const a of rawArgs) {
      const r = validateScriptPath(a, cuesRoots);
      if (!r.ok) {
        appendAuditLog('apple-notes', spec, { exitCode: 126 }, cuesRoots);
        return {
          result: Promise.resolve({ exitCode: 126, stdout: '', stderr: r.reason ?? 'path outside CUES roots', timedOut: false }),
          kill: () => {},
        };
      }
      safeArgs.push(r.resolved ?? a);
    }
    const wrapped = wrapWithBwrap(spec.command, safeArgs, spec.sandbox, cuesRoots);
    const finalCommand = wrapped?.command ?? spec.command;
    const finalArgs = wrapped?.args ?? safeArgs;

    const startedAt = Date.now();
    const wantStdin = typeof spec.input === 'string' && spec.input.length > 0;
    const stdio: any = spec.detached
      ? 'ignore'
      : [wantStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'];
    let child: any;
    try {
      child = nodeSpawn(finalCommand, finalArgs, {
        env: spec.env,
        cwd: spec.cwd,
        detached: !!spec.detached,
        stdio,
      });
    } catch (err: any) {
      appendAuditLog('apple-notes', spec, { exitCode: 127 }, cuesRoots);
      return {
        result: Promise.resolve({ exitCode: 127, stdout: '', stderr: String(err?.message ?? err), timedOut: false }),
        kill: () => {},
      };
    }
    if (wantStdin && child.stdin) {
      try { child.stdin.write(spec.input); child.stdin.end(); } catch { /* closed */ }
    }
    let stdout = '', stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const result = new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      let timedOut = false;
      let killer: NodeJS.Timeout | null = null;
      const timer = spec.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch { /* gone */ }
            killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1000);
          }, spec.timeoutMs)
        : null;
      const finish = (code: number | null): void => {
        if (timer) clearTimeout(timer);
        if (killer) clearTimeout(killer);
        const exit = code ?? 0;
        appendAuditLog('apple-notes', spec, { exitCode: exit, timedOut }, cuesRoots, Date.now() - startedAt);
        resolve({ exitCode: exit, stdout, stderr, timedOut });
      };
      child.on('exit', finish);
      child.on('error', (err: any) => {
        stderr += String(err?.message ?? err);
        finish(127);
      });
    });
    if (spec.detached) child.unref();
    return { result, kill: (sig?: string) => { try { child.kill((sig as any) || 'SIGTERM'); } catch { /* gone */ } } };
  };
}

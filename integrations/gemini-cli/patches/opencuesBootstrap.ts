// OpenCues bootstrap for Gemini CLI v0.41 — Phase G.1.
//
// What gets injected into the fork:
//
//   • THIS FILE — copied to packages/cli/src/ui/opencues.ts
//   • Two import + call additions in AppContainer.tsx (mount the bootstrap
//     once on TUI start; subscribe to the KeypressContext priority bus).
//   • Three additions in components/InputPrompt.tsx (publish the buffer
//     access + watch buffer.text/cursor; decorateLine the per-visual-line
//     rendering so dim/highlight ANSI lands).
//   • One addition in components/Footer.tsx (render the active tip).
//
// Everything else lives in opencues-runtime — this file is just the glue.

import { useEffect, useState } from 'react';
// .js suffix on every import is required by Gemini's tsconfig
// (`module: NodeNext` + `verbatimModuleSyntax: true`). The compiled
// runtime files in node_modules/@opencues/runtime/dist/ are emitted
// as .js, so the extension here is correct AND mandatory under
// nodenext module resolution.
import { boot, type BootResult } from '@opencues/runtime/dist/adapters/gemini/v0.41/boot.js';
import type { KeyEvent, LogLevel } from '@opencues/runtime/dist/src/adapter.js';
import { createSourceReclassifier } from '@opencues/runtime/dist/src/boot-common.js';
import {
  createBlankInvoke,
  createDefaultBlanksRegistry,
  type Blank,
} from '@opencues/runtime/dist/src/blanks/index.js';
import { validateScriptPath, appendAuditLog } from '@opencues/runtime/dist/src/security/spawn-sandbox.js';
import { wrapWithBwrap } from '@opencues/runtime/dist/src/security/sandbox-runner.js';
import { buildUserBlankRegistry, createNativeLlmAdapter, type BlankConfigLike } from '@opencues/runtime/dist/src/user-blanks/registry.js';
import { parseSingleCueMd } from '@opencues/core';
import { existsSync as fsExistsSync, readdirSync as fsReaddirSync, readFileSync as fsReadFileSync } from 'node:fs';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';

// CUES roots for the spawn-process path sandbox + audit log. Order:
// $OPENCUES_HOME (if set), <cwd>/.cues (project), ~/.cues (user). First
// entry is where the audit log lands.
function getCuesRoots(): string[] {
  const roots: string[] = [];
  // Bracket access for process.env — gemini-cli's tsconfig enables
  // noPropertyAccessFromIndexSignature (TS4111) which rejects dot
  // notation on the env's index-signature type.
  if (process.env['OPENCUES_HOME']) roots.push(process.env['OPENCUES_HOME']);
  roots.push(path.join(process.cwd(), '.cues'));
  roots.push(path.join(os.homedir(), '.cues'));
  return roots;
}

// ─── Tip plumbing — React hook surface for the patched Footer ────────────

// Tiny pub-sub the runtime's statusSnapshotHook writes to. The patched
// Footer.tsx subscribes via useOpenCuesTip() and re-renders only when the
// tip string actually changes (deduped — collapse-on-equal at the setter).
let _ocTip: string | null = null;
const _ocTipListeners = new Set<(t: string | null) => void>();
function setOpenCuesTip(t: string | null): void {
  if (t === _ocTip) return;
  _ocTip = t;
  for (const l of _ocTipListeners) {
    try { l(t); } catch { /* swallow */ }
  }
}
export function useOpenCuesTip(): string | null {
  const [tip, setTip] = useState<string | null>(_ocTip);
  useEffect(() => {
    _ocTipListeners.add(setTip);
    return () => { _ocTipListeners.delete(setTip); };
  }, []);
  return tip;
}

// ─── Prompt access holder ────────────────────────────────────────────────

export interface PromptInputAccess {
  /** Reads the current text from the TextBuffer (lines joined by \n). */
  read(): string;
  /** Updates the TextBuffer in place via buffer.setText. */
  write(text: string): void;
  /** Reads the textarea's cursor offset — IN CODE POINTS (Gemini's
   *  text-buffer uses cpLen-based offsets). */
  cursor(): number;
  /** Sets the textarea's cursor offset — IN CODE POINTS (Gemini's
   *  buffer.setText expects logicalPosToOffset coordinates). */
  setCursor(offset: number): void;
}

// ─── Code-unit ↔ code-point conversion ──────────────────────────────────
//
// The runtime tracks cursor offsets in UTF-16 code units (each emoji
// surrogate pair = 2 units). Gemini's text-buffer tracks them in
// code points (each emoji = 1 point). Without conversion, every emoji
// in the buffer drifts the cursor 1 unit to the right per emoji,
// breaking highlight ranges, navigation, and the cursor's visual
// column. See textUtils.ts → cpLen / cpIndexToOffset.
//
// Fast path: pure ASCII strings have units === points, skip the walk.

function isAsciiFast(s: string): boolean {
  // Inline-checking is faster than a regex on long buffers.
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
}

/** Convert a UTF-16 code-unit offset to a Gemini-buffer code-point index. */
function codeUnitsToCodePoints(text: string, units: number): number {
  if (isAsciiFast(text)) return units;
  const clamped = Math.max(0, Math.min(units, text.length));
  // [...slice] iterates by code point. Length is the code-point count.
  return [...text.slice(0, clamped)].length;
}

/** Convert a Gemini-buffer code-point index to a UTF-16 code-unit offset. */
function codePointsToCodeUnits(text: string, points: number): number {
  if (isAsciiFast(text)) return points;
  const cps = [...text];
  const clamped = Math.max(0, Math.min(points, cps.length));
  // Re-join the first `clamped` code points and measure code units.
  // cps[i] is itself a 1- or 2-unit string per the code point.
  let units = 0;
  for (let i = 0; i < clamped; i++) units += cps[i].length;
  return units;
}

const __gcPromptHolder: { current: PromptInputAccess | null } = { current: null };
(globalThis as any).__gcPromptHolder = __gcPromptHolder;

/** Called by the patched InputPrompt component on mount. */
export function publishPromptAccess(access: PromptInputAccess | null): void {
  __gcPromptHolder.current = access;
}

// ─── Render kick ─────────────────────────────────────────────────────────
//
// React/Ink only re-renders when component state changes. The runtime's
// forceRender() needs to translate into a React re-render so the
// pull-model useEffect fires and applies new directives. InputPrompt
// registers a useState bumper as the kick; host.forceRender invokes it.

let _renderKick: (() => void) | null = null;
export function registerRenderKick(fn: (() => void) | null): void {
  _renderKick = fn;
}
export function useOpenCuesRenderTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    registerRenderKick(() => setTick(n => (n + 1) | 0));
    return () => registerRenderKick(null);
  }, []);
  return tick;
}

/** Lazy promptAccess that reads from the holder. Safe before InputPrompt mounts. */
export function holderBackedPromptAccess(): PromptInputAccess {
  return {
    read: () => __gcPromptHolder.current?.read() ?? '',
    write: (t) => __gcPromptHolder.current?.write(t),
    cursor: () => __gcPromptHolder.current?.cursor() ?? 0,
    setCursor: (c) => __gcPromptHolder.current?.setCursor(c),
  };
}

let bootResult: BootResult | undefined;
const sourceReclassifier = createSourceReclassifier();

// ─── Blanks registry — same TS classes other native hosts use ────────────

function findOpenCuesMdPath(): string {
  if (process.env['OPENCUES_HOME']) {
    return path.join(process.env['OPENCUES_HOME'], 'OPENCUES.md');
  }
  return path.join(process.env['HOME'] ?? '~', '.cues', 'OPENCUES.md');
}

function resolveTtsScript(): string {
  const root = process.env['OPENCUES_HOME'] ?? path.join(process.env['HOME'] ?? '~', '.cues');
  return path.join(root, 'scripts/speak.sh');
}

// All built-in blanks come from @opencues/runtime's BUILTIN_BLANKS
// registry — single source of truth. Adding a new built-in is one
// entry there; this file picks it up automatically. Previously this
// list was missing `claude-status` (silent feature gap on this host).
const groqApiKey = process.env['GROQ_API_KEY'];
const blanksRegistry: Map<string, Blank> = createDefaultBlanksRegistry({
  llmConfig: groqApiKey ? { apiKey: groqApiKey } : undefined,
  finnhubApiKey: process.env['FINNHUB_API_KEY'],
  opencuesMdIO: {
    readFile: async () => { try { return await fs.readFile(findOpenCuesMdPath(), 'utf8'); } catch { return null; } },
    writeFile: async (content: string) => { await fs.writeFile(findOpenCuesMdPath(), content, 'utf8'); },
  },
});
// Discover user-shipped JS blanks (`impl: ./blank.js` in BLANK.md)
// and register them alongside the built-in TS classes. Each runs in
// a fresh vm.Context with only the capabilities declared in
// frontmatter — see packages/opencues-runtime/src/user-blanks/.
function _discoverUserBlankConfigs(): BlankConfigLike[] {
  // Dedupe by resolved absolute path — when cwd equals $HOME (a
  // common launch case for non-fork-cwd hosts like gemini-cli),
  // `<cwd>/.cues` and `~/.cues` resolve to the same directory.
  // Without dedup, the loader walks the dir twice and every
  // user-blank registration fires a "name collision" warning.
  const rawRoots: string[] = [];
  if (process.env['OPENCUES_HOME']) rawRoots.push(process.env['OPENCUES_HOME']);
  rawRoots.push(path.join(process.cwd(), '.cues'));
  rawRoots.push(path.join(process.env['HOME'] ?? require('node:os').homedir(), '.cues'));
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const r of rawRoots) {
    const abs = path.resolve(r);
    if (seen.has(abs)) continue;
    seen.add(abs);
    roots.push(abs);
  }
  const out: BlankConfigLike[] = [];
  for (const root of roots) {
    const blanksDir = path.join(root, 'blanks');
    if (!fsExistsSync(blanksDir)) continue;
    for (const entry of fsReaddirSync(blanksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const blankMdPath = path.join(blanksDir, entry.name, 'BLANK.md');
      if (!fsExistsSync(blankMdPath)) continue;
      try {
        const content = fsReadFileSync(blankMdPath, 'utf8');
        const parsed = parseSingleCueMd(content, path.dirname(blankMdPath));
        const blk = parsed.blanks?.[entry.name];
        if (blk?.impl) out.push(blk as BlankConfigLike);
      } catch { /* skip on parse error */ }
    }
  }
  return out;
}
const _userBlanks = buildUserBlankRegistry(_discoverUserBlankConfigs(), {
  storageRoot: process.env['OPENCUES_HOME'] ?? path.join(process.env['HOME'] ?? require('node:os').homedir(), '.cues'),
  secrets: process.env as Readonly<Record<string, string>>,
  llm: createNativeLlmAdapter(process.env as Record<string, string>),
  // Silence 'info' (one line per registered blank — 10+ on a typical
  // install, clutters the launch screen). Surface 'warn' / 'error'
  // loudly because those signal load failures the user should see.
  // Debug-level chatter is gated behind DEBUG_OPENCUES=1 to match the
  // adapter's own debug flag.
  log: (lvl, msg) => {
    if (lvl === 'warn' || lvl === 'error') console.warn(`[opencues] user-blank ${lvl}: ${msg}`);
    else if (process.env['DEBUG_OPENCUES']) console.log(`[opencues] user-blank ${lvl}: ${msg}`);
  },
});
for (const [n, b] of _userBlanks) blanksRegistry.set(n, b);
const blankInvoke = createBlankInvoke(blanksRegistry);

// ─── Bootstrap entry — called once from AppContainer on mount ────────────

export function startOpenCues(opts: {
  cwd: string;
  hostVersion: string;
}): BootResult {
  if (bootResult) return bootResult;

  const log = (level: LogLevel, msg: string, data?: unknown): void => {
    const ts = new Date().toISOString().slice(11, 23);
    // Per-host prefix so a shared /tmp/opencues.log (multiple hosts
    // running side-by-side) is filterable by `tail | grep '\[gemini\]'`.
    const line = `[${ts}][gemini][${level}] ${msg} ${data ? JSON.stringify(data).slice(0, 400) : ''}\n`;
    // Async append — keystroke path must not block on disk I/O.
    // O_APPEND is atomic for line-sized writes on Linux.
    //
    // Note: esbuild bundles this file as ESM (per Gemini's
    // esbuild.config.js: format: 'esm'). `require('fs')` is
    // undefined in ESM context — every call would throw and a try/
    // catch would silently swallow ALL logs. Use the top-level
    // fs/promises import so logging actually reaches disk.
    fs.appendFile('/tmp/opencues.log', line).catch(() => {
      // Swallow — TUI swallows stderr anyway.
    });
  };

  bootResult = boot({
    hostVersion: opts.hostVersion,
    cwd: opts.cwd || process.cwd(),
    getText: () => __gcPromptHolder.current?.read() ?? '',
    getCursorOffset: () => {
      // Gemini's buffer returns code-point offset; runtime expects
      // UTF-16 code units. Convert against the current text.
      const access = __gcPromptHolder.current;
      if (!access) return 0;
      const text = access.read();
      const cp = access.cursor();
      return codePointsToCodeUnits(text, cp);
    },
    setText: (text: string) => {
      sourceReclassifier.markRuntimeWrite(text);
      __gcPromptHolder.current?.write(text);
    },
    setCursorOffset: (offset: number) => {
      // Runtime sends UTF-16 code units; Gemini's buffer.setCursor
      // expects code points.
      const access = __gcPromptHolder.current;
      if (!access) return;
      access.setCursor(codeUnitsToCodePoints(access.read(), offset));
    },
    pushText: (text: string, cursor?: number) => {
      sourceReclassifier.markRuntimeWrite(text);
      __gcPromptHolder.current?.write(text);
      // pushText sets text + cursor as a pair. We just wrote `text`,
      // so the conversion uses that string directly (cheaper +
      // guaranteed-consistent compared to a re-read).
      if (cursor !== undefined) {
        __gcPromptHolder.current?.setCursor(codeUnitsToCodePoints(text, cursor));
      }
    },
    // Ink is reactive — the buffer change re-renders on its own. Nothing
    // No-op for now. ZWS toggle for forced re-render needs the
    // pull-model that CC uses (pendingRender flag + consumePending in
    // host render path), not a push-style write here. Pushing causes
    // races with the runtime's own setText path. Leaving as no-op
    // preserves headless correctness; visual stale state in interactive
    // (after Cycling rotates same-length alts) needs the proper
    // pull-model wired through gemini's render path.
    forceRender: () => { _renderKick?.(); },
    readFile: async (p: string) => {
      try { return await fs.readFile(p, 'utf8'); } catch { return null; }
    },
    readDir: async (p: string) => {
      try {
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
      } catch { return null; }
    },
    writeFile: async (p: string, c: string) => {
      await fs.writeFile(p, c);
    },
    spawnProcess: (spec: any) => {
      // Synchronous nodeSpawn errors (bad command, ENOENT) need to
      // resolve the result Promise so callers (TTS, BlankFill scripts)
      // don't hang. Same for spec.input piped to stdin (was silently
      // dropped). Timeout uses SIGTERM then SIGKILL after 1s.
      //
      // Path sandbox: absolute args (typically the resolved blank
      // script) must stay inside one of the CUES roots, even after
      // realpath. A malicious cue pack with `blankScript: /etc/passwd`
      // gets refused here before spawn. See
      // packages/opencues-runtime/src/security/spawn-sandbox.ts.
      const cuesRoots = getCuesRoots();
      const rawArgs: string[] = Array.isArray(spec.args) ? spec.args.map(String) : [];
      const safeArgs: string[] = [];
      for (const a of rawArgs) {
        const r = validateScriptPath(a, cuesRoots);
        if (!r.ok) {
          appendAuditLog('gemini-cli', spec, { exitCode: 126 }, cuesRoots);
          return {
            result: Promise.resolve({
              exitCode: 126,
              stdout: '',
              stderr: r.reason ?? 'path outside CUES roots',
              timedOut: false,
            }),
            kill: () => {},
          };
        }
        safeArgs.push(r.resolved ?? a);
      }
      // OS-level sandbox: wrap with bwrap when blank declared
      // `sandbox: strict` AND bwrap is available. See OC equivalent.
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
        appendAuditLog('gemini-cli', spec, { exitCode: 127 }, cuesRoots);
        return {
          result: Promise.resolve({
            exitCode: 127,
            stdout: '',
            stderr: String(err?.message ?? err),
            timedOut: false,
          }),
          kill: () => {},
        };
      }
      if (wantStdin && child.stdin) {
        try { child.stdin.write(spec.input); child.stdin.end(); } catch {}
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
              try { child.kill('SIGTERM'); } catch {}
              killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
            }, spec.timeoutMs)
          : null;
        const finish = (code: number | null): void => {
          if (timer) clearTimeout(timer);
          if (killer) clearTimeout(killer);
          const exit = code ?? 0;
          appendAuditLog('gemini-cli', spec, { exitCode: exit, timedOut }, cuesRoots, Date.now() - startedAt);
          resolve({ exitCode: exit, stdout, stderr, timedOut });
        };
        child.on('exit', finish);
        child.on('error', (err: any) => {
          stderr += String(err?.message ?? err);
          finish(127);
        });
      });
      if (spec.detached) child.unref();
      return { result, kill: (sig?: string) => { try { child.kill(sig as any || 'SIGTERM'); } catch {} } };
    },
    log,
    blankInvoke,
    // Path matches the agentic harness's readStatus convention
    // (`/tmp/opencues-status-<pid>.json`) so scenario-runner expect
    // steps with `source: 'status'` find the file. CC and OC both
    // use the same path; gemini was using `opencues-gemini-status-…`
    // which the harness couldn't find, leaving every status-based
    // assertion with `value=undefined`.
    statusFilePath: `/tmp/opencues-status-${process.pid}.json`,
    cursorStatePath: `/tmp/opencues-cursor-state-${process.pid}.json`,
    // Statusline format mirrors Claude Code + OpenCode.
    statusSnapshotHook: (payload: any) => {
      const agentTask = payload?.agentTask as string | null | undefined;
      const agentBadge = agentTask ? `[task: ${agentTask}]` : null;

      let wordPart: string | null = null;
      if (payload?.active) {
        const tip = payload?.cueTip as string | null | undefined;
        const word = payload?.highlightedWord as string | undefined;
        const alts = payload?.alts as readonly string[] | undefined;
        const cueBlank = !!payload?.cueBlank;
        if (cueBlank) {
          wordPart = tip ?? null;
        } else if (alts && alts.length > 1 && word) {
          const idx = (payload?.currentAltIndex ?? 0) + 1;
          const head = `${word} (${idx}/${alts.length})`;
          wordPart = tip ? `${head} - ${tip}` : head;
        } else {
          wordPart = tip ?? null;
        }
      }

      const combined = wordPart && agentBadge
        ? `${wordPart} | ${agentBadge}`
        : (agentBadge ?? wordPart ?? null);
      setOpenCuesTip(combined);
    },
    ttsScriptPath: resolveTtsScript(),
    ttsRate: 2,
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

  return bootResult;
}

// ─── Key dispatch — called from a useKeypress(Critical) subscriber ───────

/** Forwards a Gemini KeypressContext key event into the runtime.
 *  Returns true if consumed (subscriber should return true to stop the bus). */
export function dispatchOpenCuesKey(key: any): boolean {
  if (!bootResult) return false;
  const text = __gcPromptHolder.current?.read() ?? '';
  // Gemini buffer cursor → runtime code-unit offset.
  const cpCursor = __gcPromptHolder.current?.cursor() ?? 0;
  const cursor = codePointsToCodeUnits(text, cpCursor);
  // Gemini's Key has `name`, `shift`, `alt`, `ctrl`, `cmd`, `sequence`.
  const e: KeyEvent = {
    key: normaliseKeyName(key),
    modifiers: {
      ctrl: !!key.ctrl,
      alt: !!key.alt,
      shift: !!key.shift,
      meta: !!key.cmd,
    },
    text,
    cursorOffset: cursor,
  };
  return bootResult.dispatchKey(e);
}

function normaliseKeyName(key: any): string {
  if (key?.name) return String(key.name).toLowerCase();
  if (key?.sequence) return String(key.sequence);
  return '';
}

// ─── Buffer change observers — called from InputPrompt useEffect ─────────

/** Notify runtime of text changes from the InputPrompt buffer watcher.
 *  `cursor` arrives in Gemini's CODE-POINT space (logicalPosToOffset);
 *  the runtime works in code units. Convert at the seam. */
export function notifyOpenCuesTextChange(
  text: string,
  cursor: number,
  source: 'user' | 'runtime' = 'user',
): void {
  const actualSource = sourceReclassifier.reclassify(text, source);
  bootResult?.notifyTextChange(text, codePointsToCodeUnits(text, cursor), actualSource);
}

/** Notify runtime of cursor-only moves (no text change). Drives
 *  cursor-navigate auto-highlight when the user clicks / arrow-keys.
 *  Same code-point → code-unit conversion as notifyTextChange. */
export function notifyOpenCuesCursorChange(
  text: string,
  cursor: number,
  source: 'user' | 'runtime' = 'user',
): void {
  bootResult?.notifyCursorChange(text, codePointsToCodeUnits(text, cursor), source);
}

// ─── Per-visual-line decorator — called from InputPrompt renderItem ──────

/**
 * Returns the visual line decorated with dim/highlight ANSI escapes when
 * OpenCues has directives intersecting the line, or the unchanged
 * `lineText` otherwise. Cheap pass-through when no runtime is mounted
 * or no directives apply.
 *
 * The InputPrompt patch swaps its per-segment `<Text>` rendering for a
 * single `<Text>{decorated}</Text>` only when the return differs from
 * `lineText` — non-cued lines keep Gemini's syntax highlighting +
 * cursor inverse intact.
 *
 * `lineStart` / `lineEnd` are absolute offsets inside the full buffer
 * text (computed from buffer.visualToLogicalMap). They define the range
 * of buffer offsets this visual line covers, so dim/highlight ranges
 * that span multiple visual lines are clipped + shifted appropriately.
 */
/**
 * Pull-model render gate. Mirrors CC's pattern: the runtime queues
 * setText/setCursorOffset/forceRender as pending flags; the host's
 * render path calls this each render to pull the new state and write
 * it back to the buffer (which triggers another render → another
 * consume → until stable). When only forceRender was queued,
 * the returned text is a ZWS-toggled current text — same content
 * visually but a different string, so React's useEffect on
 * buffer.text fires and the InputPrompt re-renders.
 *
 * Returns null when nothing is pending (the common case — caller
 * should no-op).
 */
export function consumePendingOpenCues(
  currentText: string,
  currentCursor: number,
): { text: string; cursor: number } | null {
  if (!bootResult) return null;
  // Inputs arrive in Gemini's code-point space; runtime works in code
  // units. Convert in, convert back out for InputPrompt's
  // buffer.setText(text, cursor) call which expects code points.
  const cuCursor = codePointsToCodeUnits(currentText, currentCursor);
  const pending = bootResult.consumePendingRender(currentText, cuCursor);
  if (!pending) return null;
  if (pending.text !== currentText) {
    // The pull-model write goes through buffer.setText DIRECTLY (the
    // InputPrompt useEffect calls it), bypassing the wrapped setText
    // that normally marks runtime writes. Without this mark, the
    // subsequent notifyOpenCuesTextChange fires with source='user',
    // which Navigation interprets as the user typing and deactivates
    // the highlight — the "flash and release" symptom on every
    // ctrl+alt+arrow press.
    sourceReclassifier.markRuntimeWrite(pending.text);
  }
  return {
    text: pending.text,
    cursor: codeUnitsToCodePoints(pending.text, pending.cursor),
  };
}

export function decorateOpenCuesLine(
  lineText: string,
  fullText: string,
  cursor: number,
  lineStart: number,
  lineEnd: number,
): string {
  if (!bootResult) return lineText;
  // All four offsets arrive in Gemini's code-point space. The runtime's
  // decorateLine slices fullText[lineStart..lineEnd] and applies ranges
  // in those coordinates — so we convert all four to code units before
  // calling. The returned string is the visible line decorated with
  // ANSI escapes; no further offset conversion needed on the way back.
  const cuCursor    = codePointsToCodeUnits(fullText, cursor);
  const cuLineStart = codePointsToCodeUnits(fullText, lineStart);
  const cuLineEnd   = codePointsToCodeUnits(fullText, lineEnd);
  // Pass through the runtime's decoration as-is. OpenCues only owns
  // dim ranges (\x1b[2m...\x1b[22m) and active-selection inverse
  // (\x1b[7m...\x1b[27m) — the surrounding plain text keeps whatever
  // colour the terminal / Gemini's per-segment <Text> would give it.
  return bootResult.decorateLine(lineText, fullText, cuCursor, cuLineStart, cuLineEnd);
}

/**
 * Return the dim/highlight ranges that intersect a visual line, in
 * line-relative coordinates. Used by the InputPrompt segment loop to
 * apply Ink's dimColor / inverse props per-segment without replacing
 * the React structure.
 */
export function getOpenCuesDirectiveRanges(
  fullText: string,
  cursor: number,
  lineStart: number,
  lineEnd: number,
): { dimRanges: { start: number; end: number }[]; highlight: { start: number; end: number } | null } {
  if (!bootResult) return { dimRanges: [], highlight: null };
  return bootResult.getDirectiveRangesForLine(fullText, cursor, lineStart, lineEnd);
}

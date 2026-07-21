// OpenCues bootstrap for the standalone terminal app.
//
// Mirrors integrations/opencode/patches/opencuesBootstrap.ts but
// targets a self-owned OpenTUI app (no fork, no patch, no holder/
// publish dance). The textarea + renderer refs are passed directly
// in by src/app.tsx on mount.

import type { CliRenderer, TextareaRenderable } from '@opentui/core';
import { RGBA, SyntaxStyle } from '@opentui/core';
import { boot, type BootResult } from '@opencues/runtime/dist/adapters/shell/v1/boot';
import type { KeyEvent, LogLevel } from '@opencues/runtime/dist/src/adapter';
import { buildOpenTuiModifiers } from '@opencues/runtime/dist/src/modules/mac-keyboard';
import { createSourceReclassifier } from '@opencues/runtime/dist/src/boot-common';
import { codeUnitsToCells } from '@opencues/runtime/dist/src/util/cell-width';
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
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';
import { fetchSnapshot, SnapshotCache } from './daemon-client';

// ─── Daemon snapshot (oc-editd) ────────────────────────────────────────
// If $OPENCUES_OCEDITD_SOCK is set, fetch the pre-built config snapshot
// from the daemon at module-load time. Subsequent readFile/readDir calls
// consult this cache before falling through to the real filesystem.
// See integrations/shell/DAEMON-PLAN.md for the architecture; this is
// "Option B" — saves file-I/O + warm parsing, NOT the @opentui module
// load. Silent fallback to direct fs on any failure.

let _daemonCache: SnapshotCache | null = null;
const _ocSock = process.env['OPENCUES_OCEDITD_SOCK'];
if (_ocSock) {
  try {
    const snap = await fetchSnapshot(_ocSock);
    if (snap) {
      _daemonCache = new SnapshotCache(snap);
    }
  } catch { /* fall through to direct fs */ }
}

export function userCwd(): string {
  // `oc-edit` cd's into integrations/shell/ to find bunfig.toml
  // before launching bun, so process.cwd() is the integration dir,
  // not where the user actually invoked oc-edit. The shim captures
  // the calling cwd in OPENCUES_USER_CWD; honour that.
  return process.env['OPENCUES_USER_CWD'] || process.cwd();
}

export function getCuesRoots(): string[] {
  const roots: string[] = [];
  if (process.env['OPENCUES_HOME']) roots.push(process.env['OPENCUES_HOME']);
  roots.push(path.join(userCwd(), '.cues'));
  roots.push(path.join(os.homedir(), '.cues'));
  return roots;
}

export function findOpenCuesMdPath(): string {
  if (process.env['OPENCUES_HOME']) {
    return path.join(process.env['OPENCUES_HOME'], 'OPENCUES.md');
  }
  return path.join(process.env['HOME'] ?? os.homedir(), '.cues', 'OPENCUES.md');
}

export function findIdentityMdPath(): string {
  if (process.env['OPENCUES_HOME']) {
    return path.join(process.env['OPENCUES_HOME'], 'IDENTITY.md');
  }
  return path.join(process.env['HOME'] ?? os.homedir(), '.cues', 'IDENTITY.md');
}

export function findNotesMdPath(): string {
  if (process.env['OPENCUES_HOME']) {
    return path.join(process.env['OPENCUES_HOME'], 'NOTES.md');
  }
  return path.join(process.env['HOME'] ?? os.homedir(), '.cues', 'NOTES.md');
}

export function resolveTtsScript(): string {
  const root = process.env['OPENCUES_HOME'] ?? path.join(process.env['HOME'] ?? os.homedir(), '.cues');
  return path.join(root, 'scripts/speak.sh');
}

const blanksRegistry: Map<string, Blank> = createDefaultBlanksRegistry({
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

  // Note collection blank (`note add/.../delete _`) — validateNoteWrite
  // runs INSIDE NoteBlank before writeFile is called; never bypass.
  notesMdIO: {
    readFile: async () => {
      try { return await fs.readFile(findNotesMdPath(), 'utf8'); } catch { return null; }
    },
    writeFile: async (content) => {
      await fs.writeFile(findNotesMdPath(), content, 'utf8');
    },
  },
});

export function _discoverUserBlankConfigs(): BlankConfigLike[] {
  const rawRoots: string[] = [];
  if (process.env['OPENCUES_HOME']) rawRoots.push(process.env['OPENCUES_HOME']);
  rawRoots.push(path.join(userCwd(), '.cues'));
  rawRoots.push(path.join(process.env['HOME'] ?? os.homedir(), '.cues'));
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const r of rawRoots) {
    const abs = path.resolve(r);
    if (seen.has(abs)) continue;
    seen.add(abs);
    roots.push(abs);
  }

  // Sync helpers that prefer the daemon snapshot when available;
  // fall through to disk on a miss. Match the read shape the real fs
  // calls returned: existsSync (boolean), readdirSync (Dirent-like),
  // readFileSync (string).
  const cache = _daemonCache;
  const dirEntries = (p: string): ReadonlyArray<{ name: string; isDirectory: boolean }> | null => {
    if (cache) {
      const hit = cache.readDir(p);
      if (hit.hit) return hit.entries;
    }
    try {
      return fsReaddirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch { return null; }
  };
  const fileContent = (p: string): string | null => {
    if (cache) {
      const hit = cache.readFile(p);
      if (hit.hit) return hit.content;
    }
    try { return fsReadFileSync(p, 'utf8'); } catch { return null; }
  };
  const fileExists = (p: string): boolean => {
    if (cache) {
      // A snapshot hit with non-null content (or any dir entry) implies
      // existence; missing entry means the daemon checked and didn't see it.
      const fileHit = cache.readFile(p);
      if (fileHit.hit) return fileHit.content !== null;
      const dirHit = cache.readDir(p);
      if (dirHit.hit) return dirHit.entries !== null;
    }
    return fsExistsSync(p);
  };

  const out: BlankConfigLike[] = [];
  for (const root of roots) {
    const blanksDir = path.join(root, 'blanks');
    if (!fileExists(blanksDir)) continue;
    const entries = dirEntries(blanksDir);
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const blankMdPath = path.join(blanksDir, entry.name, 'BLANK.md');
      const content = fileContent(blankMdPath);
      if (content === null) continue;
      try {
        const parsed = parseSingleCueMd(content, path.dirname(blankMdPath));
        const blk = parsed.blanks?.[entry.name];
        if (blk?.impl) out.push(blk as BlankConfigLike);
      } catch { /* skip on parse error */ }
    }
  }
  return out;
}

const _userBlanks = buildUserBlankRegistry(_discoverUserBlankConfigs(), {
  storageRoot: process.env['OPENCUES_HOME'] ?? path.join(process.env['HOME'] ?? os.homedir(), '.cues'),
  secrets: process.env as Readonly<Record<string, string>>,
  llm: createNativeLlmAdapter(process.env as Record<string, string>),
  log: (lvl, msg) => {
    if (lvl === 'warn' || lvl === 'error') console.warn(`[opencues] user-blank ${lvl}: ${msg}`);
    else if (process.env['DEBUG_OPENCUES']) console.log(`[opencues] user-blank ${lvl}: ${msg}`);
  },
});
for (const [n, b] of _userBlanks) blanksRegistry.set(n, b);
const blankInvoke = createBlankInvoke(blanksRegistry);

export interface TerminalBootOpts {
  renderer: CliRenderer;
  textarea: TextareaRenderable;
  /** SyntaxStyle attached to the textarea (created by app.tsx on mount). */
  syntax: SyntaxStyle;
  cwd: string;
  /** Live tip subscriber — the footer reads from this. */
  onTipChange?: (tip: string | null) => void;
}

const sourceReclassifier = createSourceReclassifier();
let bootResult: BootResult | undefined;

export function startOpenCues(opts: TerminalBootOpts): BootResult {
  if (bootResult) return bootResult;

  const log = (level: LogLevel, msg: string, data?: unknown): void => {
    try {
      const ts = new Date().toISOString().slice(11, 23);
      let dataStr = '';
      if (data !== undefined && data !== null) {
        if (data instanceof Error) {
          dataStr = `${data.name}: ${data.message}${data.stack ? '\n' + data.stack : ''}`;
        } else if (typeof data === 'string') {
          dataStr = data;
        } else {
          dataStr = JSON.stringify(data).slice(0, 400);
        }
      }
      const line = `[${ts}][term][${level}] ${msg} ${dataStr}\n`;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('fs').appendFile('/tmp/opencues.log', line, () => {});
    } catch { /* swallow */ }
  };

  const getText = (): string => opts.textarea.plainText;
  const getCursor = (): number => opts.textarea.cursorOffset;

  bootResult = boot({
    hostVersion: '0.1.0',
    cwd: opts.cwd || process.cwd(),
    getText,
    getCursorOffset: getCursor,
    setText: (text) => {
      sourceReclassifier.markRuntimeWrite(text);
      opts.textarea.setText(text);
      // OpenTUI's editBuffer.setText clears every extmark — see comment
      // by ocOwnedExtmarks in opencode's bootstrap. Drop our owned map
      // so the next render rebuilds.
      ownedExtmarks = new Map();
    },
    setCursorOffset: (offset) => {
      opts.textarea.cursorOffset = offset;
    },
    pushText: (text, cursor) => {
      sourceReclassifier.markRuntimeWrite(text);
      opts.textarea.setText(text);
      if (cursor !== undefined) opts.textarea.cursorOffset = cursor;
      ownedExtmarks = new Map();
    },
    forceRender: () => {
      try { triggerOpenCuesRender(getText(), getCursor()); } catch { /* swallow */ }
      opts.renderer.requestRender();
    },
    readFile: async (p) => {
      if (_daemonCache) {
        const hit = _daemonCache.readFile(p);
        if (hit.hit) return hit.content;
      }
      try { return await fs.readFile(p, 'utf8'); } catch { return null; }
    },
    readDir: async (p) => {
      if (_daemonCache) {
        const hit = _daemonCache.readDir(p);
        if (hit.hit) return hit.entries;
      }
      try {
        const entries = await fs.readdir(p, { withFileTypes: true });
        return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
      } catch { return null; }
    },
    writeFile: async (p, c) => { await fs.writeFile(p, c); },
    spawnProcess: (spec: any) => {
      const cuesRoots = getCuesRoots();
      const rawArgs: string[] = Array.isArray(spec.args) ? spec.args.map(String) : [];
      const safeArgs: string[] = [];
      for (const a of rawArgs) {
        const r = validateScriptPath(a, cuesRoots);
        if (!r.ok) {
          appendAuditLog('shell', spec, { exitCode: 126 }, cuesRoots);
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
        appendAuditLog('shell', spec, { exitCode: 127 }, cuesRoots);
        return {
          result: Promise.resolve({ exitCode: 127, stdout: '', stderr: String(err?.message ?? err), timedOut: false }),
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
          appendAuditLog('shell', spec, { exitCode: exit, timedOut }, cuesRoots, Date.now() - startedAt);
          resolve({ exitCode: exit, stdout, stderr, timedOut });
        };
        child.on('exit', finish);
        child.on('error', (err: any) => {
          stderr += String(err?.message ?? err);
          finish(127);
        });
      });
      if (spec.detached) child.unref();
      return { result, kill: (sig?: string) => { try { child.kill((sig as any) || 'SIGTERM'); } catch {} } };
    },
    log,
    blankInvoke,
    blanks: blanksRegistry,
    statusFilePath: `/tmp/opencues-status-${process.pid}.json`,
    cursorStatePath: `/tmp/opencues-cursor-state-${process.pid}.json`,
    statusSnapshotHook: (payload: any) => {
      if (!opts.onTipChange) return;
      // Kata block is dominant while active — one plain-text line
      // (C_ brand + step counter + coach). Segment colouring needs an
      // app.tsx renderer; plain text first so the coach is VISIBLE.
      const tut = payload?.kata as {
        step: number; stepCount: number; coach: string | null; stepTitle: string;
        coachSegments: Array<{ text: string; command: boolean; bold?: boolean }> | null;
      } | null | undefined;
      if (tut) {
        const head = tut.stepCount > 0 ? `C_ Kata ${tut.step}/${tut.stepCount}:` : 'C_ Kata:';
        // Re-emit the inline markup (backtick commands, **bold**) so the
        // app's tip renderer can style spans; plain fallback otherwise.
        const marked = tut.coachSegments
          ? tut.coachSegments.map(seg => seg.command ? '\u0060' + seg.text + '\u0060' : (seg.bold ? '**' + seg.text + '**' : (seg.dim ? '~' + seg.text + '~' : seg.text))).join('')
          : (tut.coach ?? tut.stepTitle);
        opts.onTipChange(`${head} ${marked}`);
        return;
      }
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
      // Undo/redo confirmation is a transient notification the user just
      // triggered — dominant over the word/tip + agent badge for its TTL
      // (universal feedback for invisible reverts: scalar / OS value).
      const undoConf = payload?.undoConfirmation as string | null | undefined;
      const combined = undoConf
        ? undoConf
        : (wordPart && agentBadge ? `${wordPart} | ${agentBadge}` : (agentBadge ?? wordPart ?? null));
      opts.onTipChange(combined);
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

  // Wire OpenTUI's content-change → notify runtime + repaint extmarks.
  opts.textarea.onContentChange = () => {
    const text = getText();
    const cursor = getCursor();
    const actualSource = sourceReclassifier.reclassify(text, 'user');
    bootResult!.notifyTextChange(text, cursor, actualSource);
    triggerOpenCuesRender(text, cursor);
  };
  opts.textarea.onCursorChange = () => {
    bootResult!.notifyCursorChange(getText(), getCursor(), 'user');
  };

  // Stash refs for the renderer helper.
  _textareaRef = opts.textarea;
  _syntaxRef = opts.syntax;

  return bootResult;
}

export function dispatchOpenCuesKey(evt: any): boolean {
  if (!bootResult) return false;
  const text = _textareaRef?.plainText ?? '';
  const cursor = _textareaRef?.cursorOffset ?? 0;
  const keyName = normaliseKeyName(evt);
  // OpenTUI-shape → runtime Modifiers + Mac double-ESC Ctrl synth, all
  // pinned in `@opencues/runtime/src/modules/mac-keyboard.test.ts`.
  const e: KeyEvent = {
    key: keyName,
    modifiers: buildOpenTuiModifiers({
      ctrl: !!evt.ctrl,
      alt: !!evt.alt,
      option: !!evt.option,
      meta: !!evt.meta,
      shift: !!evt.shift,
      sequence: typeof evt.sequence === 'string' ? evt.sequence : undefined,
      name: keyName,
    }),
    text,
    cursorOffset: cursor,
  };
  const consumed = bootResult.dispatchKey(e);
  if (consumed) triggerOpenCuesRender(_textareaRef?.plainText ?? text, _textareaRef?.cursorOffset ?? cursor);
  return consumed;
}

function normaliseKeyName(evt: any): string {
  if (evt.name) return String(evt.name).toLowerCase();
  if (evt.sequence) return String(evt.sequence);
  return '';
}

// ─── Extmark applier ────────────────────────────────────────────────────
// Lifted from integrations/opencode/patches/opencuesBootstrap.ts. The
// diff-based approach (keep / delete-stale / create-new) avoids the
// 100-300ms input-lag from clearing-and-recreating ~30 dim extmarks
// per keystroke. See the OpenTUI extmark-contract comment in that
// file for the ADJUSTS vs CLEARS table — same trap applies here.

type ExtmarkKey = string;
let ownedExtmarks = new Map<ExtmarkKey, number>();
let styleIds: {
  dim?: number; highlight?: number; typeId?: number;
  bold?: number; italic?: number; code?: number; strike?: number; heading?: number; list?: number;
} = {};
let loadingColorIds = new Map<string, number>();
let _textareaRef: TextareaRenderable | null = null;
let _syntaxRef: SyntaxStyle | null = null;

/**
 * Wipe every per-buffer runtime state object — DynDefs, HighlightState,
 * SpanFill, SelectorSatellite. Called from app.tsx's `finish()` (submit
 * + cancel) so the next time the slide-pane opens in this keep-alive
 * bun process, OpenCues starts from a clean slate. Without this, a
 * prompt-improver rewrite committed in session N stays in DynDefs at
 * its old word index — session N+1's first keystroke can hit that
 * stale def's `blankName` and silently no-op the new blank.
 *
 * Idempotent: no-op when boot hasn't happened or has been disposed.
 */
export function resetOpenCuesBufferState(): void {
  bootResult?.resetBufferState?.();
}

export function triggerOpenCuesRender(text: string, cursor: number): void {
  if (!bootResult || !_textareaRef || !_syntaxRef) return;
  const syntax = _syntaxRef;
  const textarea = _textareaRef;
  if (textarea.isDestroyed) return;

  if (styleIds.dim === undefined) {
    styleIds.dim = syntax.getStyleId('opencues-dim') ?? syntax.registerStyle('opencues-dim', { dim: true });
  }
  if (styleIds.highlight === undefined) {
    styleIds.highlight = syntax.getStyleId('opencues-highlight')
      ?? syntax.registerStyle('opencues-highlight', {
        fg: RGBA.fromValues(1, 1, 1, 1),
        bg: RGBA.fromValues(0, 0, 0, 1),
      });
  }
  if (styleIds.bold === undefined) {
    styleIds.bold = syntax.getStyleId('opencues-bold') ?? syntax.registerStyle('opencues-bold', { bold: true });
  }
  if (styleIds.italic === undefined) {
    styleIds.italic = syntax.getStyleId('opencues-italic') ?? syntax.registerStyle('opencues-italic', { italic: true });
  }
  if (styleIds.code === undefined) {
    styleIds.code = syntax.getStyleId('opencues-code')
      ?? syntax.registerStyle('opencues-code', { fg: RGBA.fromValues(0.9, 0.7, 0.4, 1) });
  }
  if (styleIds.strike === undefined) {
    try {
      styleIds.strike = syntax.getStyleId('opencues-strike')
        ?? syntax.registerStyle('opencues-strike', { strikethrough: true } as any);
    } catch {
      styleIds.strike = syntax.getStyleId('opencues-strike-dim')
        ?? syntax.registerStyle('opencues-strike-dim', { dim: true });
    }
  }
  if (styleIds.heading === undefined) {
    styleIds.heading = syntax.getStyleId('opencues-heading')
      ?? syntax.registerStyle('opencues-heading', { bold: true, underline: true } as any);
  }
  if (styleIds.list === undefined) {
    styleIds.list = syntax.getStyleId('opencues-list')
      ?? syntax.registerStyle('opencues-list', { fg: RGBA.fromValues(0.7, 0.7, 0.7, 1) });
  }
  if (styleIds.typeId === undefined) {
    styleIds.typeId = textarea.extmarks.registerType('opencues');
  }

  type Kind = 'd' | 'h' | 'b' | 'i' | 'c' | 's' | 'H' | 'L';
  type Spec = { kind: Kind; start: number; end: number };
  const desired = new Map<ExtmarkKey, Spec>();
  const addRanges = (ranges: ReadonlyArray<{ start: number; end: number }> | undefined, kind: Kind): void => {
    if (!ranges) return;
    for (const r of ranges) {
      desired.set(`${kind}:${r.start}:${r.end}`, { kind, start: r.start, end: r.end });
    }
  };
  const desiredColored = new Map<ExtmarkKey, { hex: string; start: number; end: number }>();
  const directiveSets = bootResult.collectRenderDirectives(text, cursor);
  for (const directives of directiveSets) {
    addRanges(directives.dimRanges, 'd');
    if (directives.highlight) {
      const h = directives.highlight;
      desired.set(`h:${h.start}:${h.end}`, { kind: 'h', start: h.start, end: h.end });
    }
    addRanges(directives.boldRanges, 'b');
    addRanges(directives.italicRanges, 'i');
    addRanges(directives.codeRanges, 'c');
    addRanges(directives.strikeRanges, 's');
    addRanges(directives.headingRanges, 'H');
    addRanges(directives.listRanges, 'L');
    const cr = (directives as { coloredRanges?: ReadonlyArray<{ start: number; end: number; rgb?: string }> }).coloredRanges;
    if (cr) {
      for (const r of cr) {
        if (!r.rgb) continue;
        const hex = r.rgb.toLowerCase();
        desiredColored.set(`load:${hex}:${r.start}:${r.end}`, { hex, start: r.start, end: r.end });
      }
    }
  }

  for (const [key, id] of ownedExtmarks) {
    if (desired.has(key) || desiredColored.has(key)) continue;
    try { (textarea.extmarks as any).delete?.(id); } catch {}
    ownedExtmarks.delete(key);
  }

  const styleFor = (kind: Kind): number | undefined => {
    switch (kind) {
      case 'd': return styleIds.dim;
      case 'h': return styleIds.highlight;
      case 'b': return styleIds.bold;
      case 'i': return styleIds.italic;
      case 'c': return styleIds.code;
      case 's': return styleIds.strike;
      case 'H': return styleIds.heading;
      case 'L': return styleIds.list;
    }
  };
  // OpenTUI's extmark layer takes `start`/`end` as terminal CELL
  // positions, not JS string code-unit offsets. For ASCII those are
  // equal so the runtime can keep emitting code-unit offsets and we
  // translate at the host boundary. For CJK (Japanese, Chinese,
  // Korean, fullwidth ASCII) each glyph occupies 2 cells, so a span
  // covering "日本語に翻訳" (6 code units) needs end=12 to cover the
  // 12 cells the glyphs actually paint to.
  const toCell = (offset: number): number => codeUnitsToCells(text, offset);
  for (const [key, spec] of desired) {
    if (ownedExtmarks.has(key)) continue;
    const styleId = styleFor(spec.kind);
    if (styleId === undefined) continue;
    const id = textarea.extmarks.create({
      start: toCell(spec.start),
      end: toCell(spec.end),
      styleId,
      typeId: styleIds.typeId,
    });
    ownedExtmarks.set(key, id);
  }
  for (const [key, spec] of desiredColored) {
    if (ownedExtmarks.has(key)) continue;
    let styleId = loadingColorIds.get(spec.hex);
    if (styleId === undefined) {
      const styleName = `opencues-load-${spec.hex.slice(1)}`;
      try {
        styleId = syntax.getStyleId(styleName) ?? syntax.registerStyle(styleName, { fg: RGBA.fromHex(spec.hex) });
      } catch { continue; }
      loadingColorIds.set(spec.hex, styleId);
    }
    const id = textarea.extmarks.create({
      start: toCell(spec.start),
      end: toCell(spec.end),
      styleId,
      typeId: styleIds.typeId,
    });
    ownedExtmarks.set(key, id);
  }
}

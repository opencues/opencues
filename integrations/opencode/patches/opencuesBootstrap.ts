// OpenCues bootstrap for OpenCode (band substituted at install time).
//
// What gets injected into the fork:
//
//   • THIS FILE — copied to packages/opencode/src/cli/cmd/tui/opencues.ts
//     with __OPENCUES_BAND__ replaced by the major.minor from pin.json
//     (e.g. "v1.4" or "v1.14"). setup.sh's patch_fork_bootstrap step
//     owns the substitution.
//   • Two import + call additions in app.tsx (mount the bootstrap
//     once on TUI start; forward useKeyboard events).
//   • Two onInput hooks in component/prompt/index.tsx (forward text
//     changes; allow runtime to read/write input value).
//
// Everything else lives in opencues-runtime — this file is just the
// glue.

import type { CliRenderer, TextareaRenderable } from "@opentui/core"
import { RGBA } from "@opentui/core"
import { boot, type BootResult } from "@opencues/runtime/dist/adapters/oc/__OPENCUES_BAND__/boot"
import type { KeyEvent, LogLevel, RenderDirectives } from "@opencues/runtime/dist/src/adapter"
import { createSourceReclassifier } from "@opencues/runtime/dist/src/boot-common"
import { createBlankInvoke, AnswerBlank, ClaudeStatusBlank, CountriesBlank, CryptoBlank, DictionaryBlank, HackerNewsBlank, OpenCuesSettingsBlank, PromptImproverBlank, StocksBlank, WeatherBlank, type Blank } from "@opencues/runtime/dist/src/blanks"
import { validateScriptPath, appendAuditLog } from "@opencues/runtime/dist/src/security/spawn-sandbox"
import { createSignal } from "solid-js"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import { spawn as nodeSpawn } from "node:child_process"

// CUES roots for the spawn-process path sandbox + audit log. Order:
// $OPENCUES_HOME (if set), <cwd>/.cues (project), ~/.cues (user). First
// existing root in the list is where the audit log lands.
function getCuesRoots(): string[] {
  const roots: string[] = []
  if (process.env.OPENCUES_HOME) roots.push(process.env.OPENCUES_HOME)
  roots.push(path.join(process.cwd(), ".cues"))
  roots.push(path.join(os.homedir(), ".cues"))
  return roots
}

// SolidJS signal carrying the active highlight's tip text. The patched
// home footer subscribes via opencuesTip() — set on every Statusline
// payload (deduped, so footer renders only flip when tip actually changes).
const [opencuesTip, setOpencuesTip] = createSignal<string | null>(null)
export { opencuesTip }

export interface PromptInputAccess {
  /** Reads the current text from the SolidJS store. */
  read(): string
  /** Updates the SolidJS store + the textarea ref. */
  write(text: string): void
  /** Reads the textarea's cursor position. */
  cursor(): number
  /** Sets the textarea's cursor position. */
  setCursor(offset: number): void
  /** Direct ref to the textarea (for extmarks API). O.4. */
  textarea?: TextareaRenderable
  /**
   * SyntaxStyle instance from useTheme().syntax — needed to register
   * "opencues-dim" + "opencues-highlight" styleIds. O.4.
   */
  syntax?: { registerStyle(name: string, def: any): number; getStyleId(name: string): number | null }
}

/**
 * Singleton holder. The Prompt component publishes its TextareaRenderable
 * ref + setStore-bound writer here on mount. The bootstrap reads through
 * this — that way we don't need to wait for Prompt to mount before
 * starting the runtime.
 */
const __ocPromptHolder: { current: PromptInputAccess | null } = { current: null }
;(globalThis as any).__ocPromptHolder = __ocPromptHolder

/** Called by the patched Prompt component on textarea mount. */
export function publishPromptAccess(access: PromptInputAccess | null): void {
  __ocPromptHolder.current = access
}

/** Lazy promptAccess that reads from the holder. Safe before Prompt mounts. */
export function holderBackedPromptAccess(): PromptInputAccess {
  return {
    read: () => __ocPromptHolder.current?.read() ?? "",
    write: (t) => __ocPromptHolder.current?.write(t),
    cursor: () => __ocPromptHolder.current?.cursor() ?? 0,
    setCursor: (c) => __ocPromptHolder.current?.setCursor(c),
  }
}

let bootResult: BootResult | undefined
// Shared helper from boot-common — keeps source-reclassification
// behaviour identical across hosts. See boot-common.ts:createSourceReclassifier.
const sourceReclassifier = createSourceReclassifier()

// Blanks registry — same TS implementations chrome uses, dispatched
// via the shared createBlankInvoke. Lets us drop the per-blank
// shell scripts (blanks/<name>/*.sh) once every host has parity.
// OS-level blanks (volume, brightness) stay shell-bound on Node hosts
// because the runtime classes don't ship them.
// OPENCUES.md holds system-wide settings (voice-mode, tips-mode, …)
// whose schema is owned by the OpenCues runtime. User-level only;
// projects cannot override.
function findOpenCuesMdPath(): string {
  // Explicit env override (CI / container deploys / tests).
  if (process.env.OPENCUES_HOME) {
    return path.join(process.env.OPENCUES_HOME, "OPENCUES.md")
  }
  return path.join(process.env.HOME ?? "~", ".cues", "OPENCUES.md")
}

// TTS script lives at user-level (~/.cues/scripts/speak.sh), seeded
// + kept current by `opencues seed-configs` (which all host installers
// invoke). One canonical path, no walking, no integration coupling —
// works whether CC is installed or not.
function resolveTtsScript(): string {
  const root = process.env.OPENCUES_HOME ?? path.join(process.env.HOME ?? "~", ".cues")
  return path.join(root, "scripts/speak.sh")
}

const blanksRegistry = new Map<string, Blank>([
  ['hackernews', new HackerNewsBlank()],
  ['stocks', new StocksBlank({ apiKey: process.env.FINNHUB_API_KEY })],
  ['weather', new WeatherBlank()],
  ['claude-status', new ClaudeStatusBlank()],
  ['dictionary', new DictionaryBlank()],
  ['crypto', new CryptoBlank()],
  ['countries', new CountriesBlank()],
  ['answer', new AnswerBlank({ apiKey: process.env.GROQ_API_KEY })],
  ['prompt', new PromptImproverBlank({ apiKey: process.env.GROQ_API_KEY })],
  ['opencues', new OpenCuesSettingsBlank({
    readFile: async () => { try { return await fs.readFile(findOpenCuesMdPath(), "utf8") } catch { return null } },
    writeFile: async (content) => { await fs.writeFile(findOpenCuesMdPath(), content, "utf8") },
  })],
])
const blankInvoke = createBlankInvoke(blanksRegistry)

export function startOpenCues(opts: {
  renderer: CliRenderer
  promptAccess: PromptInputAccess
  cwd: string
  hostVersion: string
}): BootResult {
  if (bootResult) return bootResult

  const log = (level: LogLevel, msg: string, data?: unknown): void => {
    try {
      const ts = new Date().toISOString().slice(11, 23)
      const line = `[${ts}][${level}] ${msg} ${data ? JSON.stringify(data).slice(0, 400) : ""}\n`
      // Async append — keystroke path must not block on disk I/O.
      // O_APPEND is atomic for line-sized writes on Linux, so concurrent
      // appenders can't tear lines (ordering across writers may wobble,
      // which is fine for a debug log).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("fs").appendFile("/tmp/opencues.log", line, () => {})
    } catch {
      // Swallow — TUI swallows stderr anyway.
    }
  }
  // Cursor tracer — diagnostic instrumentation for the cursor-jumps
  // class of bugs. Writes one line per cursor/text touchpoint so we
  // can reconstruct the full sequence when something goes wrong.
  // Disable by setting OPENCUES_TRACE_CURSOR=0; default on for now.
  const TRACE_FILE = "/tmp/opencues-cursor-trace.log"
  const traceEnabled = process.env.OPENCUES_TRACE_CURSOR !== "0"
  const trace = (event: string, info: Record<string, unknown> = {}): void => {
    if (!traceEnabled) return
    try {
      const ts = new Date().toISOString().slice(11, 23)
      const line = `[${ts}] ${event} ${JSON.stringify(info).slice(0, 400)}\n`
      require("fs").appendFile(TRACE_FILE, line, () => {})
    } catch { /* swallow */ }
  }
  // Mark a clear session boundary in the trace so a fresh repro is
  // easy to find at the tail.
  trace("--- runtime boot ---", { hostVersion: opts.hostVersion })

  bootResult = boot({
    hostVersion: opts.hostVersion,
    cwd: opts.cwd || process.cwd(),
    getText: () => opts.promptAccess.read(),
    getCursorOffset: () => {
      const c = opts.promptAccess.cursor()
      trace("getCursorOffset", { cursor: c })
      return c
    },
    setText: (text) => {
      const before = opts.promptAccess.cursor()
      trace("setText:in", { len: text.length, cursorBefore: before, preview: text.slice(0, 40) })
      sourceReclassifier.markRuntimeWrite(text)
      opts.promptAccess.write(text)
      // editBuffer.setText nukes extmarks (see comment in pushText).
      ocOwnedExtmarks = new Map()
      const after = opts.promptAccess.cursor()
      trace("setText:out", { len: text.length, cursorAfter: after, delta: after - before })
    },
    setCursorOffset: (offset) => {
      const before = opts.promptAccess.cursor()
      trace("setCursorOffset:in", { request: offset, cursorBefore: before })
      opts.promptAccess.setCursor(offset)
      const after = opts.promptAccess.cursor()
      trace("setCursorOffset:out", { cursorAfter: after, accepted: after === offset })
    },
    // BlankFill needs pushText to deposit async script results back into
    // the prompt. Same plumbing as setText + cursor reposition.
    pushText: (text: string, cursor?: number) => {
      const before = opts.promptAccess.cursor()
      trace("pushText:in", { len: text.length, requestedCursor: cursor ?? null, cursorBefore: before, preview: text.slice(0, 40) })
      sourceReclassifier.markRuntimeWrite(text)
      opts.promptAccess.write(text)
      if (cursor !== undefined) opts.promptAccess.setCursor(cursor)
      // OpenTUI's ExtmarksController wraps `editBuffer.setText` with a
      // `this.clear()` call that nukes every extmark before applying the
      // new content. Our `ocOwnedExtmarks` map still has the IDs but
      // they point at extmarks that no longer exist — without this
      // reset, the next triggerOpenCuesRender's diff would say "we
      // already own d:4:7, skip create" and the dim wouldn't repaint.
      // Symptom: dims survive same-line typing (insertChar shifts
      // extmarks) but die on any agent edit or Enter (setText clears
      // them). Clear the owned map here so the next render rebuilds.
      ocOwnedExtmarks = new Map()
      const after = opts.promptAccess.cursor()
      trace("pushText:out", { cursorAfter: after, delta: after - before })
    },
    // forceRender on OpenCode means: re-fire OpenCues render handlers
    // (DimRender, Statusline) so async state changes (Resolver alts,
    // BlankFill auto-populate, etc.) paint without waiting for the
    // next user keystroke. The OpenTUI request is layered on top so the
    // visual buffer also refreshes.
    forceRender: () => {
      const access = __ocPromptHolder.current
      if (access) {
        try { triggerOpenCuesRender(access.read(), access.cursor()) }
        catch { /* swallow */ }
      }
      opts.renderer.requestRender()
    },
    readFile: async (p: string) => {
      try { return await fs.readFile(p, "utf8") } catch { return null }
    },
    readDir: async (p: string) => {
      try {
        const entries = await fs.readdir(p, { withFileTypes: true })
        return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }))
      } catch { return null }
    },
    writeFile: async (p: string, c: string) => {
      await fs.writeFile(p, c)
    },
    spawnProcess: (spec: any) => {
      // Synchronous nodeSpawn errors (bad command, ENOENT) need to
      // resolve the result Promise so callers (TTS, BlankFill scripts)
      // don't hang. Same for spec.input piped to stdin (was silently
      // dropped). Timeout uses SIGTERM then SIGKILL after 1s.
      //
      // Path sandbox: validate that any absolute path in args (the
      // script the runtime asked us to bash) stays inside one of the
      // CUES roots. realpath-based so a symlink can't escape. Cue
      // packs trying to `blankScript: /etc/passwd` get refused here
      // before spawn fires. See packages/opencues-runtime/src/security
      // /spawn-sandbox.ts.
      const cuesRoots = getCuesRoots()
      const rawArgs: string[] = Array.isArray(spec.args) ? spec.args.map(String) : []
      const safeArgs: string[] = []
      for (const a of rawArgs) {
        const r = validateScriptPath(a, cuesRoots)
        if (!r.ok) {
          appendAuditLog("opencode", spec, { exitCode: 126 }, cuesRoots)
          return {
            result: Promise.resolve({
              exitCode: 126,
              stdout: "",
              stderr: r.reason ?? "path outside CUES roots",
              timedOut: false,
            }),
            kill: () => {},
          }
        }
        safeArgs.push(r.resolved ?? a)
      }
      const startedAt = Date.now()
      const wantStdin = typeof spec.input === "string" && spec.input.length > 0
      const stdio: any = spec.detached
        ? "ignore"
        : [wantStdin ? "pipe" : "ignore", "pipe", "pipe"]
      let child: any
      try {
        child = nodeSpawn(spec.command, safeArgs, {
          env: spec.env,
          cwd: spec.cwd,
          detached: !!spec.detached,
          stdio,
        })
      } catch (err: any) {
        appendAuditLog("opencode", spec, { exitCode: 127 }, cuesRoots)
        return {
          result: Promise.resolve({
            exitCode: 127,
            stdout: "",
            stderr: String(err?.message ?? err),
            timedOut: false,
          }),
          kill: () => {},
        }
      }
      if (wantStdin && child.stdin) {
        try { child.stdin.write(spec.input); child.stdin.end() } catch {}
      }
      let stdout = "", stderr = ""
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
      const result = new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
        let timedOut = false
        let killer: NodeJS.Timeout | null = null
        const timer = spec.timeoutMs
          ? setTimeout(() => {
              timedOut = true
              try { child.kill("SIGTERM") } catch {}
              killer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 1000)
            }, spec.timeoutMs)
          : null
        const finish = (code: number | null): void => {
          if (timer) clearTimeout(timer)
          if (killer) clearTimeout(killer)
          const exit = code ?? 0
          appendAuditLog("opencode", spec, { exitCode: exit, timedOut }, cuesRoots, Date.now() - startedAt)
          resolve({ exitCode: exit, stdout, stderr, timedOut })
        }
        child.on("exit", finish)
        child.on("error", (err: any) => {
          stderr += String(err?.message ?? err)
          finish(127)
        })
      })
      if (spec.detached) child.unref()
      return { result, kill: (sig?: string) => { try { child.kill(sig as any || "SIGTERM") } catch {} } }
    },
    log,
    // Shared TS blanks dispatched here. Anything not in the registry
    // falls through to spawnProcess, so the legacy blanks/<name>/*.sh
    // scripts still run for OS-level blanks (volume, brightness) and any
    // blank that hasn't been hoisted to runtime yet.
    blankInvoke,
    // Canonical status path — same shape across all hosts (CC, OC, future
    // Gemini). The pid suffix already disambiguates concurrent processes
    // and the JSON's `host` field tells you which host wrote it. The
    // earlier `opencues-opencode-status-` prefix was redundant + caused
    // the bridge helpers to look in the wrong place.
    statusFilePath: `/tmp/opencues-status-${process.pid}.json`,
    cursorStatePath: `/tmp/opencues-cursor-state-${process.pid}.json`,
    // In-process statusline hook — feeds the active tip into the
    // SolidJS signal the patched home footer reads. Format matches
    // Claude Code's statusline (highlight-statusline.sh):
    //   - cueBlank=true: <tip> alone
    //   - alts.length > 1: "<word> (N/M) - <tip>"  (tip optional)
    //   - else (no alts, no blank): <tip> alone, or null
    // PLUS a stable agent-task indicator while armed:
    //   - agentTask null/missing: nothing appended
    //   - agentTask present:      "[task: <prompt>]"  (no in-flight spinner)
    statusSnapshotHook: (payload: any) => {
      const agentTask = payload?.agentTask as string | null | undefined
      const agentBadge = agentTask ? `[task: ${agentTask}]` : null

      // Build the word/tip part (independent of agent state).
      let wordPart: string | null = null
      if (payload?.active) {
        const tip = payload?.cueTip as string | null | undefined
        const word = payload?.highlightedWord as string | undefined
        const alts = payload?.alts as readonly string[] | undefined
        const cueBlank = !!payload?.cueBlank
        if (cueBlank) {
          wordPart = tip ?? null
        } else if (alts && alts.length > 1 && word) {
          const idx = (payload?.currentAltIndex ?? 0) + 1
          const head = `${word} (${idx}/${alts.length})`
          wordPart = tip ? `${head} - ${tip}` : head
        } else {
          wordPart = tip ?? null
        }
      }

      // Combine — agent badge always wins a slot when present.
      const combined = wordPart && agentBadge
        ? `${wordPart} | ${agentBadge}`
        : (agentBadge ?? wordPart ?? null)
      setOpencuesTip(combined)
    },
    // Resolve TTS script across all known install layouts. OpenCode
    // doesn't ship its own speak.sh — it piggybacks on whichever
    // location the CC integration (or a past install of it) deployed.
    ttsScriptPath: resolveTtsScript(),
    ttsRate: 2,
    llmApiKey: process.env.GROQ_API_KEY,
    llmEndpoint: process.env.OPENCUES_LLM_ENDPOINT,
    llmDefaultModel: process.env.OPENCUES_LLM_MODEL,
    // Multi-provider key bag — runtime picks per CUES.md `llm-provider:`.
    llmApiKeys: {
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY,
    },
  })

  return bootResult
}

/** Forwards an OpenTUI useKeyboard event into the runtime. Returns true if consumed. */
export function dispatchOpenCuesKey(evt: any): boolean {
  if (!bootResult) return false
  const access = __ocPromptHolder.current
  const text = access?.read() ?? ""
  const cursor = access?.cursor() ?? 0
  const e: KeyEvent = {
    key: normaliseKeyName(evt),
    modifiers: {
      ctrl: !!evt.ctrl,
      alt: !!evt.option || !!evt.alt,
      shift: !!evt.shift,
      meta: !!evt.meta,
    },
    text,
    cursorOffset: cursor,
  }
  const consumed = bootResult.dispatchKey(e)
  // Trigger render so nav-driven highlight changes paint.
  if (consumed) triggerOpenCuesRender(access?.read() ?? text, access?.cursor() ?? cursor)
  return consumed
}

/** Notify runtime of text changes from the prompt component. */
export function notifyOpenCuesTextChange(text: string, cursor: number, source: "user" | "runtime" = "user"): void {
  const actualSource = sourceReclassifier.reclassify(text, source)
  try {
    if (process.env.OPENCUES_TRACE_CURSOR !== "0") {
      const ts = new Date().toISOString().slice(11, 23)
      require("fs").appendFile(
        "/tmp/opencues-cursor-trace.log",
        `[${ts}] notifyTextChange ${JSON.stringify({ cursor, source, actualSource, len: text.length, preview: text.slice(0, 40) }).slice(0, 400)}\n`,
        () => {},
      )
    }
  } catch { /* swallow */ }
  bootResult?.notifyTextChange(text, cursor, actualSource)
}

/** Notify runtime of cursor-only moves (no text change). Mouse click,
 *  arrow keys, focus etc. — opentui's EditBufferRenderable.onCursorChange
 *  fires these. Drives cursor-navigate auto-highlight. */
export function notifyOpenCuesCursorChange(text: string, cursor: number, source: "user" | "runtime" = "user"): void {
  try {
    if (process.env.OPENCUES_TRACE_CURSOR !== "0") {
      const ts = new Date().toISOString().slice(11, 23)
      require("fs").appendFile(
        "/tmp/opencues-cursor-trace.log",
        `[${ts}] notifyCursorChange ${JSON.stringify({ cursor, source, len: text.length }).slice(0, 400)}\n`,
        () => {},
      )
    }
  } catch { /* swallow */ }
  bootResult?.notifyCursorChange(text, cursor, source)
}

function normaliseKeyName(evt: any): string {
  if (evt.name) return String(evt.name).toLowerCase()
  if (evt.sequence) return String(evt.sequence)
  return ""
}

// ─── O.4: extmark applier ──────────────────────────────────────────────

/**
 * Track our own extmarks keyed by `kind:start:end` so successive renders
 * can DIFF (keep unchanged, delete stale, create new) instead of
 * clearing all and recreating. With ~14-30 dim ranges and the agent
 * armed, the clear-and-recreate path was burning 100-300 ms per
 * keystroke on extmark layout work — clearly visible as input lag.
 *
 * Stable case: typing at the end of the buffer with a fixed DynDef set
 * doesn't shift any earlier dim range, so the diff produces zero
 * mutations. Mid-buffer insertions only invalidate ranges downstream
 * of the edit; everything before is reused.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * OpenTUI extmark contract — read this before touching this section.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * `ExtmarksController` (in @opentui/core/src/lib/extmarks.ts) wraps
 * every editBuffer mutation method and either ADJUSTS or CLEARS our
 * extmarks. Two distinct categories:
 *
 *   ADJUSTS (extmarks survive, offsets shift):
 *     - insertChar / insertText
 *     - deleteChar / deleteCharBackward / deleteRange / deleteLine
 *     - newLine                ← Enter key path
 *     - deleteSelectedText
 *     - undo / redo
 *
 *   CLEARS (every extmark is wiped before the new content lands):
 *     - setText        ← `editBuffer.setText(text)` calls `this.clear()`
 *     - replaceText    ← same
 *     - clear          ← obvious
 *
 * Our `setText` and `pushText` adapter methods funnel through
 * `promptAccess.write(text)` which calls `editBuffer.setText` — so any
 * runtime-driven text replacement (agent edit, BlankFill substitute,
 * cycling, etc.) silently nukes every extmark we own. The diff in
 * `triggerOpenCuesRender` would then say "owned matches desired,
 * skip create" and leave the dim/highlight INVISIBLE because the
 * underlying extmarks are gone.
 *
 * Mitigation: `setText` and `pushText` reset `ocOwnedExtmarks = new Map()`
 * at the bottom of their adapter implementations. The next render
 * rebuilds from scratch. User-typed character paths are unaffected
 * because they go through `insertChar`, which preserves extmarks.
 *
 * Symptom this fixed: dims survived same-line typing but vanished the
 * moment the agent applied any edit (or after Enter, because the agent
 * usually settled and fired during the post-newline pause).
 */
type OcExtmarkKey = string // `${kind}:${start}:${end}`
let ocOwnedExtmarks = new Map<OcExtmarkKey, number>()
let ocStyleIdsCache: { dim?: number; highlight?: number; typeId?: number } = {}
// Tracked so we can drop stale extmark IDs whenever the prompt re-mounts
// (Solid.js reactive replacement of the textarea instance). Without this
// guard, the diff sees a "match" by key for an extmark whose ID is dead
// in the new textarea — and skips the create, leaving the dim invisible.
let ocLastTextarea: unknown = null

/**
 * Called by the patched Prompt component on every onContentChange
 * (and after our own setText). Pulls render directives from the
 * runtime, diffs against currently-owned extmarks: keeps unchanged
 * ones, removes stale ones, creates only what's new.
 */
export function triggerOpenCuesRender(text: string, cursor: number): void {
  if (!bootResult) return
  const access = __ocPromptHolder.current
  if (!access?.textarea || !access.syntax) return

  const syntax = access.syntax
  const textarea = access.textarea
  if (textarea.isDestroyed) return

  // Textarea swap detection — Solid.js can replace the prompt component,
  // which leaves our recorded extmark IDs pointing at a dead instance.
  // When that happens, drop the cache + style IDs (styles are registered
  // per-textarea) and start fresh.
  if (ocLastTextarea !== textarea) {
    ocOwnedExtmarks = new Map()
    ocStyleIdsCache = {}
    ocLastTextarea = textarea
  }

  // Lazy-register styles + extmark type on first call.
  if (ocStyleIdsCache.dim === undefined) {
    ocStyleIdsCache.dim = syntax.getStyleId("opencues-dim") ?? syntax.registerStyle("opencues-dim", { dim: true })
  }
  if (ocStyleIdsCache.highlight === undefined) {
    ocStyleIdsCache.highlight =
      syntax.getStyleId("opencues-highlight")
      ?? syntax.registerStyle("opencues-highlight", { fg: RGBA.fromValues(1, 1, 1, 1), bold: true })
  }
  if (ocStyleIdsCache.typeId === undefined) {
    ocStyleIdsCache.typeId = textarea.extmarks.registerType("opencues")
  }

  // Build the desired set from the current directive output.
  type Spec = { kind: "d" | "h"; start: number; end: number }
  const desired = new Map<OcExtmarkKey, Spec>()
  const directiveSets = bootResult.collectRenderDirectives(text, cursor)
  for (const directives of directiveSets) {
    if (directives.dimRanges) {
      for (const r of directives.dimRanges) {
        desired.set(`d:${r.start}:${r.end}`, { kind: "d", start: r.start, end: r.end })
      }
    }
    if (directives.highlight) {
      const h = directives.highlight
      desired.set(`h:${h.start}:${h.end}`, { kind: "h", start: h.start, end: h.end })
    }
  }

  // Delete extmarks no longer wanted.
  for (const [key, id] of ocOwnedExtmarks) {
    if (desired.has(key)) continue
    try { (textarea.extmarks as any).delete?.(id) } catch { /* swallow */ }
    ocOwnedExtmarks.delete(key)
  }

  // Create extmarks newly wanted (anything already present is reused).
  for (const [key, spec] of desired) {
    if (ocOwnedExtmarks.has(key)) continue
    const styleId = spec.kind === "d" ? ocStyleIdsCache.dim : ocStyleIdsCache.highlight
    const id = textarea.extmarks.create({
      start: spec.start,
      end: spec.end,
      styleId,
      typeId: ocStyleIdsCache.typeId,
    })
    ocOwnedExtmarks.set(key, id)
  }
}

// OpenCues bootstrap for OpenCode v1.4 — Phase O.1.
//
// What gets injected into the fork:
//
//   • THIS FILE — copied to packages/opencode/src/cli/cmd/tui/opencues.ts
//   • Two import + call additions in app.tsx (mount the bootstrap
//     once on TUI start; forward useKeyboard events).
//   • Two onInput hooks in component/prompt/index.tsx (forward text
//     changes; allow runtime to read/write input value).
//
// Everything else lives in opencues-runtime — this file is just the
// glue.

import type { CliRenderer, TextareaRenderable } from "@opentui/core"
import { RGBA } from "@opentui/core"
import { boot, type BootResult } from "opencues-runtime/dist/adapters/opencode/v1.4/boot"
import type { KeyEvent, LogLevel, RenderDirectives } from "opencues-runtime/dist/src/adapter"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import { spawn as nodeSpawn } from "node:child_process"

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
let lastRuntimeSetText: string | null = null

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
      // Append to a known location; matches Claude Code's pattern.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("fs").appendFileSync("/tmp/opencues.log", line)
    } catch {
      // Swallow — TUI swallows stderr anyway.
    }
  }

  bootResult = boot({
    hostVersion: opts.hostVersion,
    cwd: opts.cwd,
    getText: () => opts.promptAccess.read(),
    getCursorOffset: () => opts.promptAccess.cursor(),
    setText: (text) => { lastRuntimeSetText = text; opts.promptAccess.write(text) },
    setCursorOffset: (offset) => opts.promptAccess.setCursor(offset),
    // BlankFill needs pushText to deposit async script results back into
    // the prompt. Same plumbing as setText + cursor reposition.
    pushText: (text: string, cursor?: number) => {
      lastRuntimeSetText = text
      opts.promptAccess.write(text)
      if (cursor !== undefined) opts.promptAccess.setCursor(cursor)
    },
    forceRender: () => opts.renderer.requestRender(),
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
      const child = nodeSpawn(spec.command, spec.args, {
        env: spec.env,
        detached: !!spec.detached,
        stdio: spec.detached ? "ignore" : ["ignore", "pipe", "pipe"],
      })
      let stdout = "", stderr = ""
      child.stdout?.on("data", (d) => { stdout += d.toString() })
      child.stderr?.on("data", (d) => { stderr += d.toString() })
      const result = new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
        let timedOut = false
        const timer = spec.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGTERM") }, spec.timeoutMs) : null
        child.on("exit", (code) => {
          if (timer) clearTimeout(timer)
          resolve({ exitCode: code ?? 0, stdout, stderr, timedOut })
        })
      })
      if (spec.detached) child.unref()
      return { result, kill: (sig?: string) => { try { child.kill(sig as any || "SIGTERM") } catch {} } }
    },
    log,
    tipsPath: path.join(process.env.HOME ?? "~", ".claude/claude-code-tips.json"),
    statusFilePath: `/tmp/claude-highlight-state-${process.pid}.json`,
    cursorStatePath: `/tmp/opencues-cursor-state-${process.pid}.json`,
    ttsScriptPath: path.join(process.env.HOME ?? "~", ".claude/actions/speak.sh"),
    ttsRate: 2,
    llmApiKey: process.env.GROQ_API_KEY,
    llmEndpoint: process.env.OPENCUES_LLM_ENDPOINT,
    llmDefaultModel: process.env.OPENCUES_LLM_MODEL,
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
  let actualSource = source
  if (lastRuntimeSetText !== null && text === lastRuntimeSetText) {
    actualSource = "runtime"
    lastRuntimeSetText = null
  }
  bootResult?.notifyTextChange(text, cursor, actualSource)
}

function normaliseKeyName(evt: any): string {
  if (evt.name) return String(evt.name).toLowerCase()
  if (evt.sequence) return String(evt.sequence)
  return ""
}

// ─── O.4: extmark applier ──────────────────────────────────────────────

/** Track our own extmarks so we can remove them on the next render. */
let ocOwnedExtmarks: number[] = []
let ocStyleIdsCache: { dim?: number; highlight?: number; typeId?: number } = {}

/**
 * Called by the patched Prompt component on every onContentChange
 * (and after our own setText). Pulls render directives from the
 * runtime, clears our previous extmarks, and creates new ones for
 * dim ranges + the active highlight.
 */
export function triggerOpenCuesRender(text: string, cursor: number): void {
  if (!bootResult) return
  const access = __ocPromptHolder.current
  if (!access?.textarea || !access.syntax) return

  const syntax = access.syntax
  const textarea = access.textarea
  if (textarea.isDestroyed) return

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

  // Clear previous extmarks before re-applying.
  for (const id of ocOwnedExtmarks) {
    try { (textarea.extmarks as any).delete?.(id) } catch { /* swallow */ }
  }
  ocOwnedExtmarks = []

  const directiveSets = bootResult.collectRenderDirectives(text, cursor)
  for (const directives of directiveSets) {
    if (directives.dimRanges) {
      for (const r of directives.dimRanges) {
        const id = textarea.extmarks.create({
          start: r.start,
          end: r.end,
          styleId: ocStyleIdsCache.dim,
          typeId: ocStyleIdsCache.typeId,
        })
        ocOwnedExtmarks.push(id)
      }
    }
    if (directives.highlight) {
      const id = textarea.extmarks.create({
        start: directives.highlight.start,
        end: directives.highlight.end,
        styleId: ocStyleIdsCache.highlight,
        typeId: ocStyleIdsCache.typeId,
      })
      ocOwnedExtmarks.push(id)
    }
  }
}

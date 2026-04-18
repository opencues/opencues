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

import type { CliRenderer } from "@opentui/core"
import type { TextareaRenderable } from "@opentui/core"
import { boot, type BootResult } from "opencues-runtime/dist/adapters/opencode/v1.4/boot"
import type { KeyEvent, LogLevel } from "opencues-runtime/dist/src/adapter"
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
    setText: (text) => opts.promptAccess.write(text),
    setCursorOffset: (offset) => opts.promptAccess.setCursor(offset),
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
  })

  return bootResult
}

/** Forwards an OpenTUI useKeyboard event into the runtime. Returns true if consumed. */
export function dispatchOpenCuesKey(evt: any): boolean {
  if (!bootResult) return false
  const e: KeyEvent = {
    key: normaliseKeyName(evt),
    modifiers: {
      ctrl: !!evt.ctrl,
      alt: !!evt.option || !!evt.alt,
      shift: !!evt.shift,
      meta: !!evt.meta,
    },
    text: "",
    cursorOffset: 0,
  }
  return bootResult.dispatchKey(e)
}

/** Notify runtime of text changes from the prompt component. */
export function notifyOpenCuesTextChange(text: string, cursor: number, source: "user" | "runtime" = "user"): void {
  bootResult?.notifyTextChange(text, cursor, source)
}

function normaliseKeyName(evt: any): string {
  if (evt.name) return String(evt.name).toLowerCase()
  if (evt.sequence) return String(evt.sequence)
  return ""
}

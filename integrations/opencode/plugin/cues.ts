// cues.ts — OpenCode plugin that writes .cues/CUES.md on every user
// message, deterministically.
//
// Why a plugin instead of a Claude skill: the skill approach gated cue
// generation on model judgment per turn ("should I fire?") and the
// model was unreliable about it — turns went silent even on substantive
// domain pivots. A plugin's `chat.message` hook fires every time, no
// judgment needed.
//
// How it works:
//   1. On every chat.message, capture the user's text + the project dir.
//   2. Load the cues skill text (the system prompt for the cues call).
//   3. Pull the last few session turns as conversation context.
//   4. Spawn a throwaway session, send the cues prompt + context.
//   5. Write the response into <project>/.cues/CUES.md.
//   6. Delete the throwaway session.
//
// All of this runs concurrently with the main chat reply — OpenCode
// doesn't block on hook completion.
//
// Failure mode: if the cues call fails (LLM error, network, parse), we
// log and continue. The user's chat reply is never affected.

import type { Plugin } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

function log(level: string, msg: string) {
  try { fs.appendFileSync("/tmp/opencues.log", `[${new Date().toISOString()}][oc-cues-plugin][${level}] ${msg}\n`) } catch {}
}

const SKILL_LOCATIONS = [
  // Plugin-bundled prompt — `opencues install plugin cues` copies the
  // skill text alongside the plugin file at this exact path. Self-
  // contained: works even when the skill itself is uninstalled.
  path.join(os.homedir(), ".config/opencode/plugins/cues.SKILL.md"),
  // Fallback: user-installed skill (kept for backwards compat with
  // setups where only the skill was installed before the plugin existed).
  path.join(os.homedir(), ".config/opencode/skills/cues/SKILL.md"),
  path.join(os.homedir(), ".claude/skills/cues/SKILL.md"),
]

// How many recent session turns to include as context for the cues
// call. 0 = just the new message. Higher = better continuity, more tokens.
const CONTEXT_TURNS = parseInt(process.env["OPENCUES_CONTEXT_TURNS"] || "5", 10)

// Model used for the cues call — defaults to Haiku for low latency
// (~15-20s vs Sonnet's ~60s). Cues are an ambient surface that
// doesn't need deep reasoning; we want fast turnaround so the
// editor's prediction matches what the user types in the next few
// keystrokes. Override via OPENCUES_CUES_MODEL=provider/model.
function parseModel(spec: string): { providerID: string; modelID: string } {
  const slash = spec.indexOf("/")
  if (slash < 0) return { providerID: "anthropic", modelID: spec }
  return { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) }
}
const CUES_MODEL = parseModel(process.env["OPENCUES_CUES_MODEL"] || "anthropic/claude-haiku-4-5")

function loadSkillText(): string | null {
  for (const loc of SKILL_LOCATIONS) {
    if (fs.existsSync(loc)) {
      try { return fs.readFileSync(loc, "utf8") } catch { /* keep trying */ }
    }
  }
  return null
}

function extractUserText(parts: any[]): string {
  return parts
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
    .trim()
}

function extractAssistantText(parts: any[]): string {
  // Assistant messages can have text + tool-use + tool-result parts.
  // For context, we only want the text content the user actually saw.
  return parts
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
    .trim()
}

async function buildContext(client: any, sessionID: string): Promise<string> {
  if (CONTEXT_TURNS <= 0) return ""
  try {
    // List recent messages. The SDK signature: client.session.messages(...) or
    // client.session.message.list(...). We use the list endpoint.
    const res = await client.session.messages({ path: { id: sessionID } }).catch(() => null)
      ?? await client.session.message.list?.({ path: { sessionID } }).catch(() => null)
    if (!res?.data) return ""
    const msgs: any[] = Array.isArray(res.data) ? res.data : (res.data.messages ?? [])
    // Take the last CONTEXT_TURNS*2 entries (user+assistant pairs).
    const recent = msgs.slice(-CONTEXT_TURNS * 2)
    const lines: string[] = []
    for (const m of recent) {
      const role = m.info?.role || m.role
      const parts = m.parts || []
      const text = role === "user" ? extractUserText(parts) : extractAssistantText(parts)
      if (!text) continue
      lines.push(`[${role}] ${text.slice(0, 600)}`)
    }
    return lines.join("\n\n")
  } catch {
    return ""
  }
}

function existingCuesMd(projectDir: string): string | null {
  const p = path.join(projectDir, ".cues", "CUES.md")
  if (!fs.existsSync(p)) return null
  try { return fs.readFileSync(p, "utf8") } catch { return null }
}

function writeCuesMd(projectDir: string, content: string): void {
  const dir = path.join(projectDir, ".cues")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "CUES.md"), content, "utf8")
}

// Strip any preamble / trailing chatter the model might add despite the
// "no commentary" directive. Heuristic: if there's a "---" frontmatter
// fence in the output, take from the first "---" to the last meaningful
// line. If the model wraps in ```markdown ... ```, strip those fences.
function extractCuesContent(text: string): string {
  let t = text.trim()
  // Strip outer markdown code fence if present.
  const fenceMatch = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
  if (fenceMatch) t = fenceMatch[1].trim()
  // If there's a frontmatter block, that's where the file starts.
  const fmIdx = t.indexOf("---")
  if (fmIdx > 0 && fmIdx < 200) t = t.slice(fmIdx)
  return t
}

// Sessions we created for our own LLM calls — used to break the
// recursion loop where session.prompt fires chat.message back at us.
const ownSessions = new Set<string>()

export const cuesPlugin: Plugin = async (input) => {
  log("info", "plugin initialised")
  return {
    "chat.message": async (hookInput, output) => {
      // If this is our own throwaway session, skip — otherwise we'd
      // recurse infinitely (every session.prompt triggers chat.message).
      if (ownSessions.has(hookInput.sessionID)) return
      try {
        await runCuesUpdate(input, hookInput, output)
      } catch (err: any) {
        // Hook failures must NEVER break the main chat. Log + swallow.
        try {
          fs.appendFileSync(
            "/tmp/opencues.log",
            `[${new Date().toISOString()}][oc-cues-plugin][err] ${err?.stack || err}\n`,
          )
        } catch { /* swallow */ }
      }
    },
  }
}

async function runCuesUpdate(input: any, hookInput: any, output: any): Promise<void> {
  // chat.message hook input shape: { message: AssistantMessage, parts: Part[] }.
  // Parts live at output.parts (sibling of message), not output.message.parts.
  const parts = output?.parts ?? output?.message?.parts ?? []
  const userText = extractUserText(parts)
  if (!userText) return

  const skill = loadSkillText()
  if (!skill) {
    log("warn", `no SKILL.md found at any of ${SKILL_LOCATIONS.join(", ")}`)
    return
  }

  const projectDir = input.directory || process.cwd()
  const context = await buildContext(input.client, hookInput.sessionID)
  const existing = existingCuesMd(projectDir)

  // The cues prompt is the skill text (full body) + a USER section
  // overriding the skill's tool-calling and chat-reply directives. We
  // need the LLM to OUTPUT the file content directly, not call Write.
  const userPrompt = [
    "# CRITICAL OVERRIDES (these take precedence over the skill text)",
    "",
    "- DO NOT call any tools. No Write, no Edit, no Read, nothing. Tools are disabled.",
    "- DO NOT append a parenthetical chat reply (the skill says to — ignore that).",
    "- DO NOT include commentary, preamble, or explanation of any kind.",
    "- Your ENTIRE response must be the raw CUES.md file content.",
    "- The response MUST start with `---` (YAML frontmatter open) on the first line.",
    "- The response MUST end with ` ``` ` (closing fence of the tips JSON block).",
    "",
    context ? `# Recent conversation\n\n${context}` : "",
    `# User's new message\n\n${userText}`,
    existing ? `# Existing .cues/CUES.md\n\n\`\`\`\n${existing}\n\`\`\`` : "# No existing CUES.md — INITIAL mode.",
    "",
    "# Your task",
    "",
    "Following the skill instructions above (and the overrides at the top), output the FULL UPDATED `.cues/CUES.md` content. Just the file content, nothing else.",
  ].filter(Boolean).join("\n\n")

  // Throwaway session for the cues call. Uses the user's configured
  // model (no model override) — when the user picks Sonnet/Haiku for
  // the main chat, the cues call inherits that choice.
  let sessionID: string | undefined
  try {
    const create = await input.client.session.create({ body: {} })
    sessionID = create?.data?.id || create?.data?.sessionID
    if (!sessionID) {
      log("warn", "no session id in create response")
      return
    }
    ownSessions.add(sessionID)

    const response = await input.client.session.prompt({
      path: { id: sessionID },
      body: {
        // Pin a fast model for the cues call — decoupled from the
        // user's chat model so cues stay snappy on Sonnet/Opus sessions.
        model: CUES_MODEL,
        // System prompt = the skill text. User prompt = the context block.
        system: skill,
        // Disable all tools — we want a direct text response, not Write calls.
        // session.prompt's `tools` is a per-tool enable map; passing an empty
        // object disables every standard tool.
        tools: {},
        parts: [{ type: "text", text: userPrompt }],
      },
    })

    // Extract text from the response. Per SDK types: { info: AssistantMessage,
    // parts: Part[] }. Try all paths just in case the wrapper level differs.
    const parts =
      response?.data?.parts ??
      response?.data?.info?.parts ??
      response?.parts ??
      []
    let responseText: string | null = null
    if (Array.isArray(parts)) {
      responseText = parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim()
    }
    if (!responseText) {
      log("warn", "empty response text from session.prompt")
      return
    }

    const cuesContent = extractCuesContent(responseText)
    if (!cuesContent.startsWith("---")) {
      log("warn", `response did not start with frontmatter — first 80 chars: ${cuesContent.slice(0, 80).replace(/\n/g, "\\n")}`)
      // Still write — better a partial file than nothing.
    }
    writeCuesMd(projectDir, cuesContent)
    log("info", `wrote ${path.join(projectDir, ".cues/CUES.md")} (${cuesContent.length} bytes)`)
  } finally {
    if (sessionID) {
      ownSessions.delete(sessionID)
      try { await input.client.session.delete({ path: { id: sessionID } }) } catch { /* best effort */ }
    }
  }
}

export default cuesPlugin

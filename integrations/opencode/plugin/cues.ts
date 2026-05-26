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

const SKILL_LOCATIONS = [
  // User-installed (opencues install skill cues writes here)
  path.join(os.homedir(), ".config/opencode/skills/cues/SKILL.md"),
  // Claude Code shared location, useful when the user only installed there
  path.join(os.homedir(), ".claude/skills/cues/SKILL.md"),
]

// How many recent session turns to include as context for the cues
// call. 0 = just the new message. Higher = better continuity, more tokens.
const CONTEXT_TURNS = parseInt(process.env["OPENCUES_CONTEXT_TURNS"] || "5", 10)

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

export const cuesPlugin: Plugin = async (input) => {
  return {
    "chat.message": async (hookInput, output) => {
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

async function runCuesUpdate(input: any, _hookInput: any, output: any): Promise<void> {
  const userText = extractUserText(output.message.parts || [])
  if (!userText) return

  const skill = loadSkillText()
  if (!skill) {
    fs.appendFileSync(
      "/tmp/opencues.log",
      `[${new Date().toISOString()}][oc-cues-plugin][warn] no SKILL.md found at any of ${SKILL_LOCATIONS.join(", ")}\n`,
    )
    return
  }

  const projectDir = input.directory || process.cwd()
  const context = await buildContext(input.client, _hookInput.sessionID)
  const existing = existingCuesMd(projectDir)

  // The cues prompt is the skill text (full body) + a USER section with
  // the conversation context, the new message, and the existing file.
  // We tell the LLM to respond with the raw CUES.md content only.
  const userPrompt = [
    context ? `# Recent conversation\n\n${context}` : "",
    `# User's new message\n\n${userText}`,
    existing ? `# Existing .cues/CUES.md\n\n\`\`\`\n${existing}\n\`\`\`` : "# No existing CUES.md — INITIAL mode.",
    "",
    "# Your task",
    "",
    "Following the skill instructions above, output the FULL UPDATED `.cues/CUES.md` content.",
    "Respond with ONLY the file content — no preamble, no commentary, no code fences.",
    "Start the response with the YAML frontmatter (---).",
  ].filter(Boolean).join("\n\n")

  // Throwaway session for the cues call. Uses the user's configured
  // model (no model override) — when the user picks Sonnet/Haiku for
  // the main chat, the cues call inherits that choice.
  let sessionID: string | undefined
  try {
    const create = await input.client.session.create({ body: {} })
    sessionID = create?.data?.id || create?.data?.sessionID
    if (!sessionID) {
      fs.appendFileSync("/tmp/opencues.log", `[${new Date().toISOString()}][oc-cues-plugin][err] no session id in create response\n`)
      return
    }

    const response = await input.client.session.prompt({
      path: { id: sessionID },
      body: {
        // System prompt = the skill text. User prompt = the context block.
        system: skill,
        parts: [{ type: "text", text: userPrompt }],
      },
    })

    // Extract text from the response. Response shape varies; try common paths.
    let responseText: string | null = null
    const parts =
      response?.data?.parts ??
      response?.data?.message?.parts ??
      response?.data?.info?.parts ??
      []
    if (Array.isArray(parts)) {
      responseText = parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim()
    }
    if (!responseText) {
      fs.appendFileSync("/tmp/opencues.log", `[${new Date().toISOString()}][oc-cues-plugin][warn] empty response text\n`)
      return
    }

    const cuesContent = extractCuesContent(responseText)
    if (!cuesContent.startsWith("---")) {
      fs.appendFileSync(
        "/tmp/opencues.log",
        `[${new Date().toISOString()}][oc-cues-plugin][warn] response did not start with frontmatter; first 80 chars: ${cuesContent.slice(0, 80).replace(/\n/g, "\\n")}\n`,
      )
      // Still write it — better a partial file than nothing.
    }
    writeCuesMd(projectDir, cuesContent)
    fs.appendFileSync("/tmp/opencues.log", `[${new Date().toISOString()}][oc-cues-plugin][info] wrote ${path.join(projectDir, ".cues/CUES.md")} (${cuesContent.length} bytes)\n`)
  } finally {
    if (sessionID) {
      try { await input.client.session.delete({ path: { id: sessionID } }) } catch { /* best effort */ }
    }
  }
}

export default cuesPlugin

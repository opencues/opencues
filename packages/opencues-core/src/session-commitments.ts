/**
 * Session-commitments — a REASONING catalog of the Claude-Code-developer
 * decisions worth guarding, distilled from the CC session transcript so a
 * fast realtime matcher can flag when the user's DRAFT message contradicts
 * one of them.
 *
 * This is the SECOND "contradiction cue" engine and a deliberately different
 * shape from the deterministic one in `contradiction/`:
 *
 *   - `contradiction-cues-mode` (contradiction/*) is DETERMINISTIC — the model
 *     only routes a sentence to a verifier; the runtime COMPUTES the correction
 *     from data (real weekday, arithmetic, weather cache), so a cue can never
 *     hallucinate a false contradiction. Domain: real-world facts.
 *   - `session-contradiction-mode` (this file) is a WATCHLIST matcher — a slow
 *     producer distils the session into a commitments watchlist, and a fast
 *     matcher LLM authors the contradiction against it. The correction IS
 *     LLM-generated. Domain: CC-developer-productivity (stack / memory /
 *     compaction / architecture / scope decisions).
 *
 * The two-stage split is what makes the realtime half cheap: the matcher isn't
 * reasoning from scratch, it's checking the draft against a pre-built list.
 *
 * SAFETY class (same floor as sentence-cues, NOT the deterministic engine):
 * the matcher's output is a PASSIVE advisory — it never auto-splices, needs an
 * explicit Ctrl+Alt+↑ to apply the reconciled rewrite, and has no side-effect
 * channel. Worst-case injection is manipulated tip TEXT the user reads before
 * acting.
 *
 * Ingest, don't invoke: the `opencues extract-commitments` producer (kicked by
 * the CC statusline when the transcript grows) writes `session-commitments.json`
 * on a cadence; this source only REFERENCES it in the keystroke path.
 *
 * Design: docs/architecture/session-contradiction.md.
 */

export type SessionContradictionMode = 'off' | 'on';

/** The CC-developer categories a commitment can fall under. Kept as a loose
 *  union — an unknown category from a future producer is preserved verbatim
 *  and rendered as-is rather than dropped. */
export type CommitmentCategory =
  | 'stack'         // runtime / language / framework / tooling choice
  | 'architecture'  // structural decision (module layout, data flow, pattern)
  | 'constraint'    // an explicit "must / must-not" (deps, compat target, budget)
  | 'memory'        // what to persist / where (CLAUDE.md, notes) & compaction intent
  | 'scope'         // an in/out-of-scope boundary for the work
  | 'decision';     // a catch-all resolved choice not covered above

export const COMMITMENT_CATEGORIES: readonly CommitmentCategory[] =
  ['stack', 'architecture', 'constraint', 'memory', 'scope', 'decision'];

/** One distilled, checkable commitment from the session. TERSE by construction —
 *  a decision statement, never a code block, secret, or file dump. */
export interface SessionCommitment {
  /** Stable-ish short id (`c1`, `c2`, …) so the matcher can cite it. */
  readonly id: string;
  /** Which developer-concern this guards. */
  readonly category: string;
  /** The commitment as a single terse assertion, e.g. "Runtime is Bun, not
   *  Node" / "Do not add new npm dependencies" / "Keep the plan in CLAUDE.md,
   *  not chat — it survives /compact". */
  readonly statement: string;
}

export interface SessionCommitmentsSnapshot {
  readonly commitments: readonly SessionCommitment[];
  /** One-line "what the developer is working on right now" — conversation
   *  context for grounding cues (e.g. ask-cues). Distilled from the transcript
   *  alongside the commitments. Empty when the session is too thin. */
  readonly summary?: string;
  /** ISO string — when the producer last distilled the transcript. */
  readonly ingestedAt?: string;
  /** The CC session this was distilled from (for staleness / debugging). */
  readonly sessionId?: string;
}

/** Hard cap on watchlist size. Beyond this the matcher prompt bloats and the
 *  precision drops; the producer keeps the most load-bearing commitments. */
export const MAX_COMMITMENTS = 24;
/** Max characters of a single commitment statement — a terse decision, not a
 *  paragraph. Longer is dropped (a runaway extraction, not a commitment). */
export const MAX_STATEMENT_LEN = 200;

/**
 * Normalize + validate raw producer output into a snapshot: drop empties,
 * clamp statement length, cap count, assign stable `c<N>` ids (overriding any
 * producer-supplied id so the matcher's citations are always in-range). Pure
 * and defensive — malformed input yields a smaller (or empty) snapshot, never
 * a throw.
 */
export function buildSessionCommitmentsSnapshot(
  raw: ReadonlyArray<Partial<SessionCommitment> & { statement?: string }>,
  meta: { summary?: string; ingestedAt?: string; sessionId?: string } = {},
): SessionCommitmentsSnapshot {
  const commitments: SessionCommitment[] = [];
  for (const r of raw) {
    if (!r || typeof r.statement !== 'string') continue;
    const statement = r.statement.trim().replace(/\s+/g, ' ');
    if (!statement) continue;
    if (statement.length > MAX_STATEMENT_LEN) continue;
    const category = typeof r.category === 'string' && r.category.trim() ? r.category.trim() : 'decision';
    commitments.push({ id: `c${commitments.length + 1}`, category, statement });
    if (commitments.length >= MAX_COMMITMENTS) break;
  }
  const summary = typeof meta.summary === 'string' ? meta.summary.trim().replace(/\s+/g, ' ').slice(0, MAX_STATEMENT_LEN) : undefined;
  return { commitments, summary: summary || undefined, ingestedAt: meta.ingestedAt, sessionId: meta.sessionId };
}

/**
 * Tolerant parse of the producer's raw LLM output into `{ summary, commitments }`.
 * Accepts BOTH the new object form (`{"summary":…,"commitments":[…]}`) and the
 * legacy bare-array form (`[…]`), so an older snapshot / model reply still works.
 */
export function parseExtractionResult(raw: string): { summary?: string; commitments: Array<{ category?: string; statement?: string }> } {
  if (!raw) return { commitments: [] };
  // Prefer an object; fall back to a bare array.
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      const o = JSON.parse(obj[0]) as { summary?: unknown; commitments?: unknown };
      if (Array.isArray(o.commitments)) {
        return { summary: typeof o.summary === 'string' ? o.summary : undefined, commitments: o.commitments as Array<{ category?: string; statement?: string }> };
      }
    } catch { /* fall through to array */ }
  }
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) {
    try { const a = JSON.parse(arr[0]); if (Array.isArray(a)) return { commitments: a }; } catch { /* none */ }
  }
  return { commitments: [] };
}

/** One text turn extracted from the transcript for the producer to reason over. */
export interface TranscriptTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/**
 * Parse a Claude-Code `.jsonl` transcript into plain user/assistant TEXT turns.
 *
 * Deliberately narrow — ONLY the `text` blocks of user + assistant messages are
 * kept. tool_use inputs, tool_result outputs (file contents, command output),
 * thinking blocks, and images are ALL dropped: they're where secrets / large
 * payloads live, and they're not where the developer's *decisions* are stated.
 * This is the first line of the data-minimization boundary before anything is
 * sent to the (separate) cues-bucket provider — see the security section of
 * docs/architecture/session-contradiction.md.
 *
 * Tolerant: a malformed line is skipped, never fatal. Returns turns in file
 * order (oldest → newest).
 */
export function extractTranscriptTurns(jsonl: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  if (!jsonl) return turns;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const rec = obj as { type?: unknown; message?: unknown };
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const msg = rec.message as { role?: unknown; content?: unknown } | undefined;
    if (!msg) continue;
    const role: 'user' | 'assistant' = rec.type === 'user' ? 'user' : 'assistant';
    const text = stripHarnessFraming(textFromContent(msg.content));
    if (text) turns.push({ role, text });
  }
  return turns;
}

/**
 * Strip Claude Code harness framing that rides inside message content but isn't
 * the developer's prose: injected `<system-reminder>` context blocks, slash-
 * command scaffolding (`<command-name>` / `<command-message>` / `<command-args>`
 * / `<local-command-stdout>` / …), and the `<local-command-caveat>` notice.
 * These pollute the watchlist ("Do not respond to this context…" is not a
 * project decision). Conservative: removes the framing, keeps everything else.
 */
export function stripHarnessFraming(text: string): string {
  if (!text) return '';
  return text
    // Whole framing blocks (tags AND their content) → drop entirely: injected
    // context, slash-command scaffolding, command output. None of it is the
    // developer's prose.
    .replace(/<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|command-contents|user-prompt-submit-hook)>[\s\S]*?<\/\1>/gi, ' ')
    // Any leftover standalone framing tag (unpaired) → remove the tag.
    .replace(/<\/?(command-name|command-message|command-args|local-command-caveat|local-command-stdout|local-command-stderr|system-reminder|user-prompt-submit-hook|command-contents)[^>]*>/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Pull only human/model prose from a message's content (string or block array).
 *  Skips tool_use / tool_result / thinking / image blocks entirely. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      const t = b.text.trim();
      if (t) parts.push(t);
    }
    // tool_use / tool_result / thinking / image → intentionally dropped.
  }
  return parts.join('\n').trim();
}

/**
 * Stage-A extraction prompt — the SLOW producer call turns recent transcript
 * turns into the terse commitments watchlist. CC-developer-productivity focused;
 * precision over recall; data-minimizing (no secrets, no code — short decision
 * statements only).
 */
export const SESSION_COMMITMENTS_EXTRACT_SYSTEM = `You read a slice of a Claude Code (an AI coding assistant) session transcript and distil two things: (1) a one-line SUMMARY of what the developer is currently working on, and (2) their load-bearing COMMITMENTS — the decisions, constraints, and choices that, if silently contradicted later, would waste their time or undo their intent.

Output ONLY a JSON object (no prose, no markdown fences):
{"summary": "<one sentence, ≤160 chars: what the developer is building / focused on right now>", "commitments": [ {"category": <one of stack|architecture|constraint|memory|scope|decision>, "statement": "<one terse assertion, up to 160 chars>"} ]}

Output {"summary":"","commitments":[]} when the transcript states nothing durable.

The SUMMARY is context for a writing assistant — plain, concrete, present-tense ("Building a session-contradiction cue for Claude Code; tuning the extraction prompt"). No secrets, no code.

Each commitment: {"category": …, "statement": …} as above.

Categories:
- stack — a chosen runtime / language / framework / library / tool (and the rejected alternative if stated). e.g. "Runtime is Bun, not Node"; "Use pnpm, not npm".
- architecture — a structural decision. e.g. "Config lives in one shared ~/.cues, read by every host"; "Sources never call the host directly".
- constraint — an explicit must / must-not. e.g. "Do not add new npm dependencies"; "Must stay compatible with Node 18"; "No new UI without asking".
- memory — what to persist and where, and compaction intent. e.g. "Keep the running plan in CLAUDE.md so it survives /compact"; "Decisions go in the design doc, not chat".
- scope — an in-scope / out-of-scope boundary. e.g. "Not touching the auth module this session"; "Only the chrome integration, leave CC alone".
- decision — a resolved choice that doesn't fit above. e.g. "Ship behind an off-by-default flag first".

RULES (precision over recall — a wrong watchlist item is worse than a missing one):
- Extract a commitment ONLY when it was clearly DECIDED / AGREED / INSTRUCTED, not merely discussed, considered, or asked about. "Should we use Postgres?" is NOT a commitment; "Let's go with Postgres" is.
- IGNORE conversational process and self-narration — statements about what someone is ABOUT to do, is currently doing, or just did as a step: "I'll verify X", "let me run the tests", "now I'll check Y", "next I'll build Z", "will confirm parsing". These are steps, not durable commitments. Extract only decisions/constraints that OUTLAST the current step.
- IGNORE the assistant narrating its own plan or todo list. A commitment is something the DEVELOPER decided about the PROJECT, not the assistant's working notes.
- Prefer the MOST RECENT statement when a decision was revised — a later reversal supersedes the earlier choice.
- Write each statement as a standalone assertion a checker can compare a new sentence against. Name the concrete subject (the tool, the module, the file), never a pronoun.
- NEVER include secrets, API keys, tokens, credentials, file contents, code snippets, or personal data — only the decision itself.
- Keep it terse. No rationale, no history — just the current commitment.
- At most ${MAX_COMMITMENTS} items; if there are more, keep the most load-bearing.
- When in genuine doubt, leave it out.`;

/**
 * Render the producer INPUT — the recent transcript turns as a bounded
 * conversation transcript for the extraction call. Keeps the TAIL (most recent
 * decisions win) under `maxChars`; a turn straddling the budget boundary is
 * dropped whole rather than truncated mid-sentence.
 */
export function renderTranscriptForExtraction(
  turns: readonly TranscriptTurn[],
  maxChars = 48_000,
): string {
  const rendered: string[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const label = t.role === 'user' ? 'USER' : 'CLAUDE';
    const line = `${label}: ${t.text}`;
    if (total + line.length > maxChars && rendered.length > 0) break;
    rendered.push(line);
    total += line.length;
  }
  return rendered.reverse().join('\n\n');
}

/**
 * Render the session as CONVERSATION CONTEXT for a writing cue (ask-cues) — the
 * summary + the commitments as "what the developer is working on and has
 * decided". Lets a question be GROUNDED in the actual work (and stay silent
 * when the sentence is already consistent with it) instead of reacting to the
 * bare sentence. Returns '' when there's nothing to ground on.
 */
export function renderSessionContextForAsk(snapshot: SessionCommitmentsSnapshot | undefined): string {
  if (!snapshot) return '';
  const parts: string[] = [];
  if (snapshot.summary) parts.push(`Working on: ${snapshot.summary}`);
  if (snapshot.commitments.length > 0) {
    parts.push(`Decisions/constraints so far:\n${snapshot.commitments.map((c) => `- ${c.statement}`).join('\n')}`);
  }
  if (parts.length === 0) return '';
  return `\n\nSESSION CONTEXT (what the developer is doing in this Claude Code session — use it to make your question specific and to stay silent when the sentence is already fine given this context):\n${parts.join('\n')}`;
}

/**
 * Render the WATCHLIST block for the realtime matcher's SYSTEM message. Stable
 * within a session (the producer only rewrites it when the transcript grows),
 * so it prefix-caches on cerebras. Returns '' when off/empty so callers append
 * verbatim.
 */
export function renderSessionCommitmentsCatalog(
  snapshot: SessionCommitmentsSnapshot | undefined,
  mode: SessionContradictionMode,
): string {
  if (mode === 'off' || !snapshot || snapshot.commitments.length === 0) return '';
  const lines = snapshot.commitments.map((c) => `- ${c.id} [${c.category}]: ${c.statement}`);
  return `\n\nSESSION COMMITMENTS — decisions, constraints, and choices established earlier in THIS Claude Code session. Each is something the developer chose to do (or not do); silently going against one wastes their time.
${lines.join('\n')}`;
}

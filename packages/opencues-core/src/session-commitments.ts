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
  meta: { ingestedAt?: string; sessionId?: string } = {},
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
  return { commitments, ingestedAt: meta.ingestedAt, sessionId: meta.sessionId };
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
    const text = textFromContent(msg.content);
    if (text) turns.push({ role, text });
  }
  return turns;
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
export const SESSION_COMMITMENTS_EXTRACT_SYSTEM = `You read a slice of a Claude Code (an AI coding assistant) session transcript and extract the developer's load-bearing COMMITMENTS: the decisions, constraints, and choices that — if silently contradicted later in the session — would waste the developer's time or undo their intent. Output is a watchlist a fast checker uses to flag when the developer's next message goes against one of them.

Output ONLY a JSON array (no prose, no markdown fences). Output [] when the transcript states no durable commitment.

Each element: {"category": <one of stack|architecture|constraint|memory|scope|decision>, "statement": "<one terse assertion, up to 160 chars>"}.

Categories:
- stack — a chosen runtime / language / framework / library / tool (and the rejected alternative if stated). e.g. "Runtime is Bun, not Node"; "Use pnpm, not npm".
- architecture — a structural decision. e.g. "Config lives in one shared ~/.cues, read by every host"; "Sources never call the host directly".
- constraint — an explicit must / must-not. e.g. "Do not add new npm dependencies"; "Must stay compatible with Node 18"; "No new UI without asking".
- memory — what to persist and where, and compaction intent. e.g. "Keep the running plan in CLAUDE.md so it survives /compact"; "Decisions go in the design doc, not chat".
- scope — an in-scope / out-of-scope boundary. e.g. "Not touching the auth module this session"; "Only the chrome integration, leave CC alone".
- decision — a resolved choice that doesn't fit above. e.g. "Ship behind an off-by-default flag first".

RULES (precision over recall — a wrong watchlist item is worse than a missing one):
- Extract a commitment ONLY when it was clearly DECIDED / AGREED / INSTRUCTED, not merely discussed, considered, or asked about. "Should we use Postgres?" is NOT a commitment; "Let's go with Postgres" is.
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

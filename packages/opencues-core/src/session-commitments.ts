/**
 * Session-commitments — a REASONING catalog of the coding-session decisions
 * worth guarding, distilled from the host's session transcript so a
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
 *     LLM-generated. Domain: developer productivity (stack / memory /
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
 * each host's boot band when the transcript grows) writes `session-commitments.json`
 * on a cadence; this source only REFERENCES it in the keystroke path.
 *
 * Design: docs/architecture/session-contradiction.md.
 */

export type SessionContradictionMode = 'off' | 'on';

/** The developer-concern categories a commitment can fall under. Kept as a loose
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
  /** The host session this was distilled from (for staleness / debugging). */
  readonly sessionId?: string;
}

/** Hard cap on watchlist size. Beyond this the matcher prompt bloats and the
 *  precision drops; the producer keeps the most load-bearing commitments. */
/**
 * Filesystem-safe key for a cwd, used to SCOPE the watchlist per project. One
 * shared `session-commitments.json` let concurrent sessions/hosts in different
 * directories clobber each other's watchlist (last writer wins); scoping the
 * file by cwd fixes that. Empty cwd → `_default`. Pure (no deps) so the CLI
 * producer and the runtime ingest derive the same key.
 */
export function sessionCommitmentsKey(cwd: string | undefined): string {
  const k = (cwd || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  return k || '_default';
}

export const MAX_COMMITMENTS = 24;

// ── Company / project rules (static watchlist entries) ─────────────────────
//
// The matcher takes ANY watchlist, and benching it against org-policy
// statements across five industries (engineering, comms, support, healthcare,
// finance — tests/benchmarks/session-contradiction/company-rules-bench.mjs)
// scored 19/19 recall, 19/19 right-rule-cited, 0 false alarms on
// topic-adjacent compliant traps, on both gpt-oss and gemma, with the
// production prompt UNCHANGED. So rules are not a new engine: they are
// watchlist entries that come from a file instead of a transcript.
//
// `RULES.md` lives in the standard `.cues` search paths (project beats user).
// Format: one rule per `- ` bullet; headings, prose, comments and frontmatter
// are ignored, so the file can be a readable policy document whose bullets are
// the enforced part. Kept deliberately curated — the matcher's precision
// degrades as the prompt bloats, and a measured near-duplicate pair SILENCED
// it (see commitmentDedupeKey), which is why merging dedupes and caps.

/** The rules file name, resolved against each `.cues` search root. */
export const RULES_FILE = 'RULES.md';

/** Parse RULES.md: every `- ` / `* ` bullet is one rule statement. Everything
 *  else — headings, prose, frontmatter — is ignored. Over-long lines are
 *  dropped (a paragraph pasted as a bullet is not a rule). */
export function parseRulesMd(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const lines = text.split('\n');
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (i === 0 && trimmed === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) { if (trimmed === '---') inFrontmatter = false; continue; }
    const m = /^[-*]\s+(.+)$/.exec(trimmed);
    if (!m) continue;
    const statement = m[1].trim().replace(/\s+/g, ' ');
    if (!statement || statement.length > MAX_STATEMENT_LEN) continue;
    out.push(statement);
    if (out.length >= MAX_COMMITMENTS) break;
  }
  return out;
}

/**
 * Merge static rules with the session-produced commitments into one live
 * watchlist. Rules come FIRST with stable `r<N>` ids — stable order keeps the
 * rendered catalog byte-identical across ticks, which is what lets cerebras
 * prefix-cache it. Session commitments keep their producer ids but are DROPPED
 * when they near-duplicate a rule (commitmentDedupeKey): the producer can
 * re-distil "no new npm dependencies" out of a session where the user restated
 * a rule, and a near-duplicate pair is the measured failure mode that turns
 * the matcher OFF. Total is capped at MAX_COMMITMENTS, rules first — an org
 * that ships 24 rules has left no room for session decisions, which the
 * caller should warn about rather than silently accept.
 */
export function mergeRulesIntoCommitments(
  rules: readonly string[],
  commitments: readonly SessionCommitment[],
): SessionCommitment[] {
  const out: SessionCommitment[] = [];
  const seen = new Set<string>();
  for (const statement of rules) {
    const key = commitmentDedupeKey(statement);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `r${out.length + 1}`, category: 'rule', statement });
    if (out.length >= MAX_COMMITMENTS) return out;
  }
  for (const c of commitments) {
    const key = commitmentDedupeKey(c.statement);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= MAX_COMMITMENTS) break;
  }
  return out;
}
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

// ── Incremental distillation ──────────────────────────────────────────────
// The producer reads only the last 256KB TAIL of a session, so in a long,
// tool-heavy coding session only the most-recent prose turns survive and early
// decisions age out of every re-distillation — the recall boundary the
// real-transcript bench surfaced (RESULTS-real-transcripts.txt). Incremental
// distillation fixes it: the accumulated watchlist is PRESERVED across ticks and
// each fresh tail-distillation is MERGED in, so a decision made early keeps
// guarding even after it scrolls out of the tail.
//
// The merge is split by trust of judgement, per the project's "content judgement
// → model; safety/data-loss invariant → deterministic floor" rule:
//   • PRESERVATION + dedup + cap  → deterministic (`mergeSessionCommitments`), so
//     accumulation can NEVER silently lose a decision.
//   • SUPERSESSION (did a newer decision REPLACE an older one — "actually switch
//     to X") → its OWN small LLM call (`SESSION_COMMITMENTS_SUPERSEDE_SYSTEM`),
//     NOT folded into the extraction prompt (overloading it regresses extraction
//     — see the SUMMON-in-classifier lesson). The model only names which PRIOR
//     statements to DROP; it cannot cause a silent loss.
// Without supersession handling, naive accumulation would keep both "use
// Postgres" and a later "use SQLite" — the matcher would then FALSE-ALARM on a
// draft that follows the current (SQLite) decision. Precision was the feature's
// best property (~100% on real transcripts); the supersession call protects it.

/** Normalize a statement for dedup: lowercase, strip punctuation, collapse
 *  whitespace. Restatements ("use Bun." / "Use Bun") collapse to one. */
export function normalizeCommitmentStatement(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The MERGE-time dedup key: `normalizeCommitmentStatement` plus a leading
 * article. Distillation is an LLM call, so the same decision comes back
 * phrased slightly differently on different ticks — "Runtime is Bun, not
 * Node." on one and "The runtime is Bun, not Node." on the next — and the
 * exact-match key keeps both.
 *
 * That is not merely untidy. Measured against the live matcher (cerebras /
 * gemma-4-31b, temp 0, 3 runs each): one commitment flags the contradicting
 * draft 3/3, two DISTINCT commitments flag it 3/3, and the near-duplicate
 * PAIR flags it 0/3. A watchlist that says the same thing twice and nothing
 * else reads to the model as something other than a decision list, and the
 * feature goes silent — with no error, on the machine where it was working an
 * hour earlier.
 *
 * Deliberately NOT folded into `normalizeCommitmentStatement`: that function
 * is also the persisted cue-dismissal key (`dismissalKey`, pinned by test), so
 * widening it would silently invalidate dismissals users already recorded.
 * Merging is in-process and has no such history to honour.
 *
 * Kept to articles on purpose. Every additional equivalence is a chance to
 * collapse two decisions that genuinely differ, and a lost decision is a worse
 * failure than a duplicated one.
 */
export function commitmentDedupeKey(s: string): string {
  return normalizeCommitmentStatement(s).replace(/^(?:the|a|an) /, '');
}

/**
 * Deterministically merge an accumulated PRIOR watchlist with a FRESH
 * tail-distillation, dropping any prior statement the caller marked SUPERSEDED.
 * Preservation is guaranteed: a prior decision survives unless it is explicitly
 * superseded or duplicated. Fresh wins on a dup (keeps the newest phrasing +
 * category). Cap keeps the most-recently-affirmed (fresh first, then prior) so a
 * runaway watchlist can't grow unbounded — early decisions only drop past the
 * cap, not for being old.
 */
export function mergeSessionCommitments(
  prior: ReadonlyArray<{ category?: string; statement?: string }>,
  fresh: ReadonlyArray<{ category?: string; statement?: string }>,
  superseded: ReadonlyArray<string> = [],
): Array<{ category?: string; statement?: string }> {
  const dropped = new Set(superseded.map(commitmentDedupeKey).filter(Boolean));
  const seen = new Set<string>();
  const out: Array<{ category?: string; statement?: string }> = [];
  // Fresh first (newest wins on dup + survives the cap), then surviving prior.
  for (const c of [...fresh, ...prior]) {
    if (!c || typeof c.statement !== 'string') continue;
    const norm = commitmentDedupeKey(c.statement);
    if (!norm || dropped.has(norm) || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ category: c.category, statement: c.statement });
    if (out.length >= MAX_COMMITMENTS) break;
  }
  return out;
}

/** Parse the supersession call's reply into the list of PRIOR statements a newer
 *  decision has replaced. Tolerant: accepts a bare array or `{superseded:[…]}`. */
export function parseSupersededResult(raw: string): string[] {
  if (!raw) return [];
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) {
    try { const o = JSON.parse(obj[0]) as { superseded?: unknown }; if (Array.isArray(o.superseded)) return o.superseded.filter((x): x is string => typeof x === 'string'); } catch { /* array below */ }
  }
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) {
    try { const a = JSON.parse(arr[0]); if (Array.isArray(a)) return a.filter((x): x is string => typeof x === 'string'); } catch { /* none */ }
  }
  return [];
}

/** Its OWN focused call (not folded into extraction). Given the PRIOR watchlist
 *  and the FRESH tail decisions, name only the PRIOR statements a FRESH decision
 *  REPLACES on the same topic. Preservation stays deterministic; this decides
 *  only what to drop. */
export const SESSION_COMMITMENTS_SUPERSEDE_SYSTEM = `You maintain a developer's running list of session decisions. You are given the PRIOR decisions recorded earlier and the FRESH decisions the developer is making right now.

Your ONLY job: find PRIOR decisions that a FRESH decision REPLACES or REVERSES on the SAME topic — e.g. PRIOR "Use Postgres for the store" and FRESH "switch the store to SQLite"; PRIOR "single-threaded worker" and FRESH "move the worker to a thread pool". These are the ones to drop, because keeping both would make the list self-contradictory.

Do NOT drop a prior decision just because it isn't repeated in FRESH — silence is not reversal. Only drop on a genuine same-topic replacement/reversal.

Return ONLY JSON: {"superseded": ["<exact PRIOR statement to drop>", …]}  (empty array if none).`;

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
 * Parse a Gemini CLI conversation into plain user/assistant TEXT turns. Gemini
 * writes either append-only JSONL (v0.41 `ChatRecordingService`) OR an older
 * single-object `{ messages: [...] }` file — this handles both. Per-record
 * shape: `{ type: "user"|"gemini"|"info"|"error"|..., content: PartListUnion }`,
 * where the assistant role value is `"gemini"` (not `"assistant"`), content is a
 * string or Gemini `{text}` parts, and control lines (`$rewindTo`, `$set`,
 * bare `{sessionId,...}` metadata) are interleaved and must be skipped. Only
 * user + gemini text is kept — same data-minimization as the Claude Code parser.
 */
export function extractGeminiTranscriptTurns(input: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  if (!input) return turns;
  const push = (rec: unknown): void => {
    if (!rec || typeof rec !== 'object') return;
    const r = rec as { type?: unknown; content?: unknown; $rewindTo?: unknown; $set?: unknown };
    if ('$rewindTo' in r || '$set' in r) return;                 // control lines
    if (r.type !== 'user' && r.type !== 'gemini') return;        // skip info/error/warning/metadata
    const role: 'user' | 'assistant' = r.type === 'user' ? 'user' : 'assistant';
    const text = stripHarnessFraming(geminiContentText(r.content));
    if (text) turns.push({ role, text });
  };
  // Try whole-object form first (`{ messages: [...] }` / bare array).
  const trimmed = input.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const obj = JSON.parse(trimmed) as { messages?: unknown } | unknown[];
      const arr = Array.isArray(obj) ? obj : Array.isArray((obj as { messages?: unknown }).messages) ? (obj as { messages: unknown[] }).messages : null;
      if (arr) { for (const m of arr) push(m); return turns; }
    } catch { /* fall through to JSONL */ }
  }
  // JSONL form — one record per line.
  for (const line of input.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { push(JSON.parse(t)); } catch { /* skip malformed line */ }
  }
  return turns;
}

/** Extract text from a Gemini `content` (PartListUnion): string, `{text}`, or
 *  an array of those. Non-text parts (function calls, etc.) are dropped. */
function geminiContentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map(geminiContentText).filter(Boolean).join('\n').trim();
  if (content && typeof content === 'object') {
    const c = content as { text?: unknown };
    if (typeof c.text === 'string') return c.text.trim();
  }
  return '';
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
/**
 * Parse a DeepSeek Harness session into plain user/assistant TEXT turns.
 *
 * dsh writes an append-only event log — many record types per session, of which
 * only two carry conversation:
 *
 *   `user/message`      → `data.content[]`
 *   `assistant/message` → `data.message.content[]`
 *
 * Everything else (`turn/start`, `step/end`, `request/header`, `assistant/chunk`,
 * `session/title-llm-request`, sandbox + approval policy records, …) is
 * infrastructure and is skipped. The streaming `assistant/chunk` records are
 * deliberately ignored: the final `assistant/message` carries the same prose
 * assembled, so reading chunks would duplicate every reply.
 *
 * DATA MINIMIZATION. dsh types the model's thinking as its own content block
 * (`{type:"reasoning"}`) alongside `{type:"text"}`, so `textFromContent` drops
 * it by construction — the same boundary the Claude Code and Gemini parsers keep, where
 * only user + assistant PROSE reaches the commitments producer and tool I/O and
 * thinking never do.
 *
 * Takes decoded JSONL. The on-disk file is a run of CONCATENATED ZSTD FRAMES
 * (one per appended record), which the caller decodes — that step needs
 * `node:zlib` and this module stays browser-safe.
 */
export function extractDshTranscriptTurns(jsonl: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  if (!jsonl) return turns;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const rec = obj as { type?: unknown; data?: unknown };
    if (rec.type !== 'user/message' && rec.type !== 'assistant/message') continue;
    const data = rec.data as { content?: unknown; message?: unknown; source?: unknown } | undefined;
    if (!data) continue;
    const role: 'user' | 'assistant' = rec.type === 'user/message' ? 'user' : 'assistant';
    // ONLY WHAT THE HUMAN TYPED. dsh injects harness material as `user/message`
    // records too, distinguished solely by `data.source.kind`:
    //
    //   `user`          — the person typing. The only kind we want.
    //   `plugin`        — e.g. @deepseek-ai/dsh-system-prompt's runtime-context
    //                     snapshot ("Current DSH file policy: workspace-write…").
    //   `skill-catalog` — the entire installed-skill catalog, every description
    //                     in full, as one message.
    //
    // Without this gate all three reach the commitments producer as things the
    // user "said": a sandbox policy and a skill catalogue become candidate
    // decisions to be contradicted later, and the catalogue alone is larger
    // than most real conversations. Observed on a first real session — the
    // three-turn transcript was one genuine turn and two injections.
    if (role === 'user') {
      const kind = (data.source as { kind?: unknown } | undefined)?.kind;
      if (kind !== 'user') continue;
    }
    // The two records nest their content differently: the user record carries
    // it directly, the assistant record wraps it in a `message` envelope.
    const content = role === 'user'
      ? data.content
      : (data.message as { content?: unknown } | undefined)?.content;
    const text = stripHarnessFraming(textFromContent(content));
    if (text) turns.push({ role, text });
  }
  return turns;
}

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
 * turns into the terse commitments watchlist. Developer-productivity focused;
 * precision over recall; data-minimizing (no secrets, no code — short decision
 * statements only).
 */
export const SESSION_COMMITMENTS_EXTRACT_SYSTEM = `You read a slice of an AI coding assistant session transcript and distil two things: (1) a one-line SUMMARY of what the developer is currently working on, and (2) their load-bearing COMMITMENTS — the decisions, constraints, and choices that, if silently contradicted later, would waste their time or undo their intent.

Output ONLY a JSON object (no prose, no markdown fences):
{"summary": "<one sentence, ≤160 chars: what the developer is building / focused on right now>", "commitments": [ {"category": <one of stack|architecture|constraint|memory|scope|decision>, "statement": "<one terse assertion, up to 160 chars>"} ]}

Output {"summary":"","commitments":[]} when the transcript states nothing durable.

The SUMMARY is context for a writing assistant — plain, concrete, present-tense ("Building a session-contradiction cue; tuning the extraction prompt"). No secrets, no code.

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
  return `\n\nSESSION CONTEXT (what the developer is doing in this coding session — use it to make your question specific and to stay silent when the sentence is already fine given this context):\n${parts.join('\n')}`;
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
  return `\n\nSESSION COMMITMENTS — decisions, constraints, and choices established earlier in THIS coding session. Each is something the developer chose to do (or not do); silently going against one wastes their time.
${lines.join('\n')}`;
}

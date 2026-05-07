/**
 * Holds the currently-armed agent task (continuously-running
 * background loop declared via `agentically <X> _`). Singleton state
 * — at most ONE task armed at a time. Lives in memory, dies on host
 * restart.
 *
 * Per-task evaluation cache: each entry records (textHash, taskId).
 * A word is "already evaluated" iff BOTH the text content is unchanged
 * AND the taskId matches the currently-armed task. New arm or
 * appendToPrompt regenerates taskId, which invalidates the entire
 * cache (the new prompt may want to re-evaluate even unchanged text).
 *
 * See docs/architecture/agent-task.md for the full design.
 */

export interface AgentTaskEvaluation {
  /** Hash of the word's text content as last evaluated under taskId. */
  readonly textHash: string;
  /** Which task this evaluation belongs to. Mismatch → re-evaluate. */
  readonly taskId: string;
}

/** Max number of recent edit signatures we keep per task (anti-oscillation). */
const MAX_EDIT_SIGNATURES = 64;

export class AgentTaskState {
  private _taskId: string | null = null;
  private _prompt: string = '';
  private _evaluations = new Map<number, AgentTaskEvaluation>();
  private _armedAt = 0;

  /**
   * Recently-applied edit signatures, in insertion order. Each signature
   * is "<originalWord>→<editedWord>". Used to detect oscillation: if a
   * proposed edit's signature is the INVERSE of a recent one (i.e. would
   * undo a prior agent edit), we drop it before apply.
   *
   * Survives appendToPrompt (oscillation often happens ACROSS task ADDs
   * — each ADD freshens the cache, the LLM reconsiders the same word,
   * and may flip its prior verdict). Cleared by arm() and stop() because
   * a fresh task is allowed to undo prior decisions intentionally.
   *
   * Bounded by MAX_EDIT_SIGNATURES; oldest entries drop on overflow.
   */
  private _recentEditSignatures: string[] = [];
  private _recentEditSignatureSet = new Set<string>();

  // ── Read API ─────────────────────────────────────────────────────────

  get armed(): boolean { return this._taskId !== null; }
  get taskId(): string | null { return this._taskId; }
  get prompt(): string { return this._prompt; }
  get armedAt(): number { return this._armedAt; }

  /**
   * True iff the word at `wordIndex` has already been evaluated
   * against the CURRENT taskId AND its text hash is unchanged.
   *
   * Both conditions must hold — if the task changed, prior evaluations
   * are stale; if the text content changed, we need to re-look.
   */
  isEvaluated(wordIndex: number, currentTextHash: string): boolean {
    if (!this._taskId) return false;
    const entry = this._evaluations.get(wordIndex);
    if (!entry) return false;
    return entry.taskId === this._taskId && entry.textHash === currentTextHash;
  }

  // ── Mutation API ─────────────────────────────────────────────────────

  /**
   * Arm a fresh task. Replaces any existing prompt; generates a new
   * taskId; clears the evaluation cache (since the new prompt may want
   * to re-look at words the previous prompt already saw).
   */
  arm(prompt: string): void {
    this._taskId = generateTaskId();
    this._prompt = prompt.trim();
    this._evaluations.clear();
    this._recentEditSignatures = [];
    this._recentEditSignatureSet.clear();
    this._armedAt = Date.now();
  }

  /**
   * Append to the existing task prompt. New taskId so the agent
   * re-evaluates the whole doc against the augmented prompt — the
   * new sub-task may want to edit text the old prompt already cleared.
   *
   * No-op if no task is currently armed (use arm() instead).
   */
  appendToPrompt(addition: string): void {
    if (!this._taskId) return;
    this._taskId = generateTaskId();
    this._prompt = `${this._prompt} AND ${addition.trim()}`;
    this._evaluations.clear();
  }

  /**
   * Clear the task entirely. Existing agent-applied edits live as
   * DynDefs in the runtime — they STAY in the buffer (user can revert
   * each via cycling Down). We just stop firing.
   */
  stop(): void {
    this._taskId = null;
    this._prompt = '';
    this._evaluations.clear();
    this._recentEditSignatures = [];
    this._recentEditSignatureSet.clear();
    this._armedAt = 0;
  }

  /**
   * Record that the agent looked at the word at `wordIndex` (with
   * given text hash) under the current taskId. Subsequent calls to
   * isEvaluated() with the same hash return true.
   */
  recordEvaluation(wordIndex: number, textHash: string): void {
    if (!this._taskId) return;
    this._evaluations.set(wordIndex, { textHash, taskId: this._taskId });
  }

  /**
   * Drop a single evaluation entry. Used when the runtime knows a
   * specific position was edited (e.g. by another LLM source) and the
   * agent's cache for that position is stale even if the hash hasn't
   * been recomputed yet.
   */
  forgetEvaluation(wordIndex: number): void {
    this._evaluations.delete(wordIndex);
  }

  /**
   * Record that an edit `originalWord → editedWord` was just applied.
   * Subsequent edits whose signature is the inverse will be flagged by
   * `wouldInvertRecent`.
   *
   * No-op when no task is armed (defensive — apply path shouldn't run).
   * No-op for DELETE edits (`editedWord === ''`) — the inverse would be
   * inserting deleted text, which never appears as an LLM-emitted edit
   * anyway, and skipping them keeps the signature buffer focused on
   * meaningful add-then-remove churn.
   */
  recordEditSignature(originalWord: string, editedWord: string): void {
    if (!this._taskId) return;
    if (editedWord === '') return;
    const sig = `${originalWord}→${editedWord}`;
    if (this._recentEditSignatureSet.has(sig)) return;     // already recorded
    this._recentEditSignatures.push(sig);
    this._recentEditSignatureSet.add(sig);
    while (this._recentEditSignatures.length > MAX_EDIT_SIGNATURES) {
      const dropped = this._recentEditSignatures.shift()!;
      this._recentEditSignatureSet.delete(dropped);
    }
  }

  /**
   * True iff a previously-applied edit had the INVERSE of the proposed
   * edit — i.e. some prior pass turned X into Y, and now the agent wants
   * to turn Y back into X.
   *
   * Catches the comma-flip class (`Later` ↔ `Later,`) and similar
   * model-vacillation across passes (often triggered by `add task`
   * appending refinements to the prompt and freshening the cache).
   */
  wouldInvertRecent(originalWord: string, editedWord: string): boolean {
    if (editedWord === '') return false;
    const inverse = `${editedWord}→${originalWord}`;
    return this._recentEditSignatureSet.has(inverse);
  }

  // ── Diagnostics ──────────────────────────────────────────────────────

  /** For debug logging — count of words with cached evaluations. */
  evaluationCount(): number {
    return this._evaluations.size;
  }
}

/**
 * Hash a word's text. Used as the cache key. Cheap and collision-safe
 * for our scale (per-doc word counts in low thousands, max). The
 * specific algorithm doesn't matter — equality is the only operation.
 */
export function hashWordText(word: string): string {
  // FNV-1a 32-bit. Tiny, fast, no deps.
  let h = 2166136261;
  for (let i = 0; i < word.length; i += 1) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/**
 * Generate a unique taskId. Doesn't need to be cryptographic — just
 * unique within the process lifetime. Use crypto.randomUUID where
 * available; otherwise a counter + timestamp fallback.
 */
function generateTaskId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// KataCoach — modal guided-scenario runtime (PROTOTYPE).
//
// A kata is an ordered script of steps the user works through inside
// their real editor, authored as `katas/<name>/KATA.md` under any
// `.cues/` search path. The coach is a debounced background LLM call that
// receives the WHOLE kata script (stable → provider prefix-cache) plus
// the user's recent typed activity, and returns (a) whether the current
// step is satisfied and (b) ONE short coaching line shown on the
// statusline. The model owns progress judgement; the runtime owns only
// safety floors (step index clamped to bounds, never moves backward,
// advances at most one step per tick).
//
// STRUCTURAL INVARIANTS (mirrors ambient-context, security-audit row #21):
//   - Coach output is DISPLAY-ONLY. It feeds the statusline field and the
//     step counter — never the buffer, never an exec/side-effect layer.
//     A malicious KATA.md can at worst show wrong text and mis-advance
//     its own step counter.
//   - The runtime observes typed text AND salient key presses (the
//     adapter's onKey stream — passive, never consumed): Tab/Shift+Tab,
//     Enter, Escape, arrows, and modifier combos. A buffer transitioning
//     non-empty → empty is additionally recorded as a `submitted` event.
//     Together these make "unobservable" steps (mode toggles, pickers)
//     detectable without the user having to type `done` — seamlessness
//     is the point. `done _` / `next _` / `skip _` remain as manual
//     escape hatches but katas should never require them.
//   - While a kata is active the Resolver is suppressed entirely
//     (ResolverOptions.externallySuppressed) — kata mode overrides
//     normal cue/blank behaviour, and `stop kata _` restores it with
//     zero settings churn because nothing was ever written to OPENCUES.md.
//
// Control phrases (keyword-bound, `_`-gated like every blank trigger):
//   start kata <id|name> _   activate (bare `start kata _` = first found)
//   stop kata _              deactivate
//   done _ / next _              advance past an unobservable step
//   skip _                       force-advance a typed step
//
// Observability: every transition emits a structured event
// (kata.started / kata.tick / kata.step-advanced /
// kata.completed / kata.stopped) via adapter.emitEvent — the
// agentic harness's oc-events / scenario assertions see the coach loop
// the same way they see transform-blank passes.

import type { HostAdapter, KeyEvent, TextChangeEvent, Unsubscribe } from '../adapter';
import type { ConfigLoader } from './config-loader';
import type { ResolvedAgentLLM } from './agent-rewrite';
import { dispatchChat } from '@opencues/core';

// ──────────────────────────────────────────────────────────────────────
// KATA.md parsing
// ──────────────────────────────────────────────────────────────────────

export interface KataStep {
  /** Heading text after `## ` (e.g. "Step 1" or "Step 1 — enter plan mode"). */
  readonly title: string;
  /** Full step body — instruction prose + optional `coach:` notes. The
   *  body rides into the system prompt VERBATIM; fidelity lives in the
   *  file, not in a schema. */
  readonly body: string;
}

export interface KataDoc {
  readonly name: string;
  readonly id: string | null;
  readonly title: string;
  /** Curriculum link — the kata to suggest on completion
   *  (`next: cc-fix-a-bug` frontmatter; name or id). */
  readonly next: string | null;
  readonly steps: readonly KataStep[];
}

/** Parse a KATA.md — frontmatter (name/id/title) + `## ` step sections.
 *  Returns null when the doc has no steps (not a usable kata). */
export function parseKataMd(raw: string, fallbackName: string): KataDoc | null {
  let name = fallbackName;
  let id: string | null = null;
  let title = fallbackName;
  let next: string | null = null;
  let body = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = raw.slice(fm[0].length);
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === 'name') name = m[2];
      else if (key === 'id') id = m[2].replace(/^#/, '');
      else if (key === 'title') title = m[2];
      else if (key === 'next') next = m[2];
    }
  }
  const steps: KataStep[] = [];
  const parts = body.split(/^##\s+/m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const stepTitle = (nl === -1 ? part : part.slice(0, nl)).trim();
    const stepBody = (nl === -1 ? '' : part.slice(nl + 1)).trim();
    if (stepTitle.length > 0) steps.push({ title: stepTitle, body: stepBody });
  }
  if (steps.length === 0) return null;
  return { name, id, title, next, steps };
}

// ──────────────────────────────────────────────────────────────────────
// Control-phrase detection
// ──────────────────────────────────────────────────────────────────────

// Phrase must LEAD the sentence containing the trailing `_` — same trigger
// model as blank shapes (spec/blank-spec.md § Trigger model).
const RE_START = /(^|[\n.!?]\s+)(start|restart)\s+kata(?:\s+#?(.+?))?\s*_\s*$/i;
const RE_STOP = /(^|[\n.!?]\s+)stop\s+kata\s*_\s*$/i;
// Advance words fire on a TRAILING match (start or any whitespace
// before them) — unlike start/stop they don't need to lead a sentence.
// The natural moment to skip is with your step attempt still in the
// buffer ("git checkout main skip _"); requiring sentence-leading made
// that silently dead (live-reported). Only checked while a kata is
// ACTIVE, and the resolver is suppressed then, so a trailing `_` has no
// competing meaning.
const RE_ADVANCE = /(^|\s)(done|next|skip)\s*_\s*$/i;

export type ControlPhrase =
  | { kind: 'start'; arg: string | null; phraseStart: number; fresh?: boolean }
  | { kind: 'stop'; phraseStart: number }
  | { kind: 'advance'; word: string; phraseStart: number };

export function matchControlPhrase(text: string, active: boolean): ControlPhrase | null {
  let m = RE_START.exec(text);
  if (m) return { kind: 'start', arg: m[3]?.trim() ?? null, phraseStart: m.index + m[1].length, fresh: m[2].toLowerCase() === 'restart' };
  m = RE_STOP.exec(text);
  if (m) return { kind: 'stop', phraseStart: m.index + m[1].length };
  if (active) {
    m = RE_ADVANCE.exec(text);
    if (m) return { kind: 'advance', word: m[2].toLowerCase(), phraseStart: m.index + m[1].length };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// Coach state + module
// ──────────────────────────────────────────────────────────────────────

/** One piece of a coach line. `command: true` marks text the user
 *  should literally type or press — consumers render it distinctly
 *  (colour/bold) so commands are never mistaken for prose. */
export interface CoachSegment {
  readonly text: string;
  readonly command: boolean;
  /** **bold** emphasis (non-command). */
  readonly bold?: boolean;
  /** ~dim~ decoration — meta text (hints, separators) renderers de-emphasise. */
  readonly dim?: boolean;
}

/** Parse backtick markup in a coach line: `like this` spans are
 *  commands. Returns the plain display string (markup stripped) and
 *  the ordered segments. Unbalanced backticks degrade to plain text. */
export function parseCoachMarkup(line: string): { plain: string; segments: readonly CoachSegment[] } {
  const segments: CoachSegment[] = [];
  // Backtick commands and **bold** emphasis; anything unmatched stays prose.
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|~([^~]+)~/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) segments.push({ text: line.slice(last, m.index), command: false });
    if (m[1] !== undefined) segments.push({ text: m[1], command: true });
    else if (m[2] !== undefined) segments.push({ text: m[2], command: false, bold: true });
    else segments.push({ text: m[3], command: false, dim: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) segments.push({ text: line.slice(last), command: false });
  if (segments.length === 0) segments.push({ text: line, command: false });
  return { plain: segments.map(s => s.text).join(''), segments };
}

/** Strip a redundant "Step N —/:" prefix from an authored step title —
 *  the statusline head already carries the counter, so displaying
 *  "Kata 3/4: Step 3 — switch model" says it three times. */
export function cleanStepTitle(t: string): string {
  const cleaned = t.replace(/^step\s*\d+\s*(?:[—–\-:.]\s*)?/i, '').trim();
  return cleaned.length > 0 ? cleaned : t;
}

/** Statusline-facing snapshot. Also mirrored into kata.* events. */
export interface KataStatus {
  readonly name: string;
  readonly title: string;
  /** 1-based current step. */
  readonly step: number;
  readonly stepCount: number;
  readonly stepTitle: string;
  readonly coach: string | null;
  /** Coach line split into prose vs command spans (backtick markup in
   *  the raw line). Same content as `coach` — rich consumers render
   *  commands in a distinct colour; plain consumers use `coach`. */
  readonly coachSegments: readonly CoachSegment[] | null;
  /** True when the last coach verdict was OFF_TRACK — the user's
   *  activity contradicts the current step. Consumers should render
   *  the coach line as a correction (e.g. ✗ prefix / warning colour)
   *  rather than neutral guidance. Cleared on the next on-track tick,
   *  step advance, or control phrase. */
  readonly offTrack: boolean;
}

interface TraceEntry {
  readonly kind: 'typed' | 'submitted' | 'key';
  readonly text: string;
  /** For 'key' entries — consecutive-repeat count ("shift+tab ×2"). */
  count?: number;
}

const TRACE_MAX = 10;
const COACH_MAX_CHARS = 140;
const DEFAULT_CADENCE_MS = 300;
const DEFAULT_NUDGE_MS = 30_000;

export interface KataCoachOptions {
  /** `<searchPath>/katas` dirs, priority order (project first). */
  readonly katasDirs: readonly string[];
  /** Same lazy resolver AgentRewrite uses (auditors bucket). Null = no
   *  key; the coach then degrades to static step instructions. */
  readonly resolveLLM: () => ResolvedAgentLLM | null;
  /** Debounce between text-change and coach tick. Default 300ms. */
  readonly cadenceMs?: number | (() => number);
  /** Idle window before a proactive nudge. Default 30s; 0 disables.
   *  Thunk form re-read per arm so `kata-nudge-ms` hot-reloads. */
  readonly nudgeMs?: number | (() => number);
  /** Progress persistence file (JSON). Omit to disable persistence
   *  (chrome — no fs). Read at start (resume), written on every step
   *  advance / stop / completion. */
  readonly progressFile?: string;
  /** Optional speaker (host TTS). Gated by the `kata-voice` scalar
   *  (default off); used SPARINGLY — step advances, nudges, completion
   *  — never per-tick (a coach that narrates every keystroke is
   *  unbearable). */
  readonly speak?: (text: string) => void;
  readonly log?: (msg: string) => void;
  /** Test seam. Defaults to a lazy NodeHttpAdapter on native hosts. */
  readonly httpAdapter?: { post(url: string, body: string, headers: Record<string, string>): Promise<string> };
}

export class KataCoach {
  private _unsubText: Unsubscribe | null = null;
  private _doc: KataDoc | null = null;
  /** 0-based current step index. */
  private _stepIndex = 0;
  private _coachLine: string | null = null;
  private _offTrack = false;
  private _trace: TraceEntry[] = [];
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _inFlight = false;
  /** Buffer snapshot the in-flight tick was built from — stale-drop guard. */
  private _tickSnapshot = '';
  private _lastText = '';
  /** Our own consume-writes, so their echo isn't recorded as user
   *  activity. TTL-pruned (250ms — mirrors boot-common's
   *  RUNTIME_WRITE_TTL_MS): a stale entry must never swallow a LATER
   *  legitimate user event with identical text. The empty string is the
   *  dangerous case — every consume writes '', and every user submit
   *  produces '' — which is exactly how a lingering entry ate the
   *  submit-detection signal (caught by kata.scenarios.test.ts). */
  private _selfWrites: Array<{ text: string; addedAt: number }> = [];
  private _httpAgent: KataCoachOptions['httpAdapter'] | null = null;
  private readonly _logFn: (msg: string) => void;
  /** Consecutive bare-Escape presses — the DETERMINISTIC escape hatch.
   *  3 within the window exits kata mode with zero LLM involvement,
   *  zero phrase knowledge, in any language, even with a dead API key.
   *  Every other escape path (stop kata _, coach-honoured stop) is
   *  richer but requires knowledge or a working model; this one is the
   *  floor. */
  private _escCount = 0;
  private _escResetTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed coach calls — 2+ flips the coach line to the
   *  deterministic offline hint. Reset on any successful tick. */
  private _consecutiveErrors = 0;
  /** Idle-nudge machinery. The timer re-arms on every user activity
   *  (text, salient key) and on step advance; fires at most twice per
   *  step (nudge 1 re-orients, nudge 2 offers skip _, then quiet — an
   *  assistant that nags forever is worse than none). */
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _nudgeCount = 0;
  private _idleSince = 0;
  /** Lesson journal — one line per COMPLETED step recording how it was
   *  completed (the evidence at advance time). Rides into every coach
   *  call as LESSON SO FAR, so the coach and its nudges have context
   *  across the whole lesson, not just the recent trace ring. Bounded
   *  by stepCount; wiped on start/stop. */
  private _journal: string[] = [];
  /** When the current step became active — time-on-step rides into the
   *  coach/nudge context so guidance can acknowledge effort. */
  private _stepStartedAt = 0;

  /** Deterministic degraded-mode line: current step + how to advance
   *  manually + the exit. Idempotent per step (deduped by content). */
  private setOfflineCoachLine(why: string): void {
    if (!this._doc) return;
    const i = Math.min(this._stepIndex, this._doc.steps.length - 1);
    const line = `${cleanStepTitle(this._doc.steps[i].title)} — coach offline (${why}); type \`next _\` when done`;
    if (this._coachLine === line) return;
    this._coachLine = line;
    this._offTrack = false;
    this.refreshStatusline();
  }
  /** Transient user-facing notice (e.g. "no kata found") shown via
   *  the statusline kata block while no kata is active. */
  private _notice: { text: string; until: number; offTrack?: boolean } | null = null;

  constructor(
    private adapter: HostAdapter,
    private configLoader: ConfigLoader,
    private options: KataCoachOptions,
  ) {
    this._logFn = options.log ?? ((msg) => adapter.log('debug', msg));
  }

  get active(): boolean { return this._doc !== null; }

  /** Read-only trace view — for tests + future bridge dumps. */
  traceSnapshot(): ReadonlyArray<{ kind: string; text: string; count?: number }> {
    return this._trace.map(t => ({ ...t }));
  }

  /** Resolver suppression predicate — active kata OR a control phrase
   *  mid-typing. Wired into ResolverOptions.externallySuppressed so normal
   *  cue/blank sources never race the kata's own trigger handling. */
  shouldSuppressResolve(text: string): boolean {
    if (this._doc !== null) return true;
    return matchControlPhrase(text, false) !== null;
  }

  /** Statusline payload feed. Null when no kata is active. */
  status(): KataStatus | null {
    if (!this._doc) {
      // Transient failure notice (failed `start kata N _`). step 0 /
      // stepCount 0 marks it as a notice, not a running kata.
      if (this._notice && Date.now() < this._notice.until) {
        const parsed = parseCoachMarkup(this._notice.text);
        return {
          name: 'katas', title: 'katas', step: 0, stepCount: 0,
          stepTitle: '', coach: parsed.plain, coachSegments: parsed.segments,
          offTrack: this._notice.offTrack ?? true,
        };
      }
      return null;
    }
    const i = Math.min(this._stepIndex, this._doc.steps.length - 1);
    const parsed = this._coachLine !== null ? parseCoachMarkup(this._coachLine) : null;
    return {
      name: this._doc.name,
      title: this._doc.title,
      step: i + 1,
      stepCount: this._doc.steps.length,
      stepTitle: this._doc.steps[i].title,
      coach: parsed?.plain ?? null,
      coachSegments: parsed?.segments ?? null,
      offTrack: this._offTrack,
    };
  }

  subscribe(): void {
    this._unsubText = this.adapter.onTextChange(e => this.onTextChange(e));
  }

  unsubscribe(): void {
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }

  /**
   * Passive key observation feeding the coach trace. HOSTS MUST WIRE
   * THIS AS THE FIRST KEY HANDLER — before buildSharedRuntime subscribes
   * Navigation/Cycling — because key dispatch is emit-until-consumed:
   * a late subscriber never sees Ctrl+Alt+arrows (Navigation consumes
   * them), which blinds the coach to exactly the presses cycling
   * katas teach. Observation only — callers must NOT treat any key
   * as consumed on the kata's behalf.
   *
   * Salient = not plain typing (that shows up as buffer changes):
   * tab / escape / arrows always; enter only on an empty buffer (a
   * non-empty submit is already traced as `submitted`); any key with
   * ctrl/alt/meta. */
  observeKey(e: KeyEvent): void {
    if (!this._doc) return;
    const k = e.key.toLowerCase();
    const mods = e.modifiers;
    const anyMod = mods.ctrl || mods.alt || mods.meta || mods.shift;

    // Deterministic escape hatch: 3 bare Escapes within 2.5s of each
    // other → exit kata mode. Runs BEFORE any trace/LLM logic so it
    // works with no API key, no network, no phrase knowledge. Passive —
    // the host's own Escape behaviour (clear input, interrupt) is
    // untouched; requiring three presses keeps a normal double-Esc
    // (CC's clear-input) from killing the kata by accident.
    // Accept meta/alt/shift-flavoured Escape too: terminals encode a
    // bare ESC as a sequence prefix, so rapid consecutive presses are
    // delivered ESC-prefixed and surface as {meta: true, name:
    // 'escape'} — requiring no-modifiers silently ate presses 2-3 of
    // the hatch (live-reported on oc-shell inside tmux). Only Ctrl+Esc
    // is excluded (OS-level chord).
    if ((k === 'escape' || k === 'esc') && !mods.ctrl) {
      // Escape still lands in the trace (katas can teach Esc — e.g.
      // claude-code-power's double-Escape step; the next tick sees it),
      // but escape presses never SCHEDULE a tick: the countdown hint
      // below must not race an LLM verdict.
      const last = this._trace[this._trace.length - 1];
      if (last && last.kind === 'key' && last.text === 'escape') {
        last.count = (last.count ?? 1) + 1;
      } else {
        this.pushTrace({ kind: 'key', text: 'escape', count: 1 });
      }
      this._escCount++;
      if (this._escResetTimer) clearTimeout(this._escResetTimer);
      if (this._escCount >= 3) {
        this._escCount = 0;
        const name = this._doc.name;
        const id = this._doc.id;
        this.deactivate();
        this._notice = {
          text: `Kata exited — type \`start kata ${id ?? name} _\` to pick it back up`,
          until: Date.now() + 10_000,
          offTrack: false,
        };
        setTimeout(() => { this._notice = null; this.refreshStatusline(); }, 10_100);
        this.adapter.emitEvent?.('kata.stopped', { name, reason: 'escape-key' });
        this._logFn(`Kata: exited "${name}" via Esc ×3`);
        this.refreshStatusline();
        return;
      }
      // Countdown hint — deterministic, overwrites the coach line so the
      // exit is discoverable mid-press without any model round-trip.
      this._coachLine = `\`Esc\` ×${3 - this._escCount} more to exit the kata · or type \`stop kata _\``;
      this._escResetTimer = setTimeout(() => { this._escCount = 0; }, 2_500);
      this.armIdleTimer();
      this.refreshStatusline();
      return; // escape presses never feed the trace/tick
    }
    if (this._escCount > 0) this._escCount = 0;

    const isEnter = k === 'return' || k === 'enter';
    const salient = ['tab', 'escape', 'up', 'down', 'left', 'right'].includes(k)
      || (isEnter && e.text.trim().length === 0)
      || mods.ctrl || mods.alt || mods.meta;
    if (!salient) return;
    const label = [
      mods.ctrl ? 'ctrl' : '', mods.alt ? 'alt' : '',
      mods.shift ? 'shift' : '', mods.meta ? 'meta' : '',
      isEnter ? 'enter' : k,
    ].filter(Boolean).join('+');
    const last = this._trace[this._trace.length - 1];
    if (last && last.kind === 'key' && last.text === label) {
      last.count = (last.count ?? 1) + 1;
    } else {
      this.pushTrace({ kind: 'key', text: label, count: 1 });
    }
    this.armIdleTimer();
    this.scheduleTick();
  }

  // ── text-change pipeline ─────────────────────────────────────────────

  private onTextChange(e: TextChangeEvent): void {
    const text = e.text;
    const prev = this._lastText;
    this._lastText = text;
    // Skip echoes of our own consume-writes (and runtime writes generally
    // when active — the coach reads USER activity only). TTL-pruned:
    // past the echo window a matching text is a real user event.
    const now = Date.now();
    this._selfWrites = this._selfWrites.filter(w => now - w.addedAt < 250);
    const selfIdx = this._selfWrites.findIndex(w => w.text === text);
    if (selfIdx !== -1) { this._selfWrites.splice(selfIdx, 1); return; }
    // Submit detection runs for ANY non-self-write wipe: on CC the
    // host's clear-after-Enter arrives as source 'runtime' (only OC
    // delivers it as 'user'), and no runtime module ever wipes the
    // buffer to empty on its own — so nonempty→empty that isn't ours
    // IS the user submitting. Everything else in the trace remains
    // user-source only.
    if (this._doc && text.trim().length === 0 && prev.trim().length > 0
      && this.configLoader.opencuesState.settings.get('katas-mode') !== 'off') {
      this.pushTrace({ kind: 'submitted', text: prev.trim() });
      this.armIdleTimer();
      this.scheduleTick();
      return;
    }
    if (e.source !== 'user') return;
    if (text === prev) return;

    // Feature gate — read lazily so OPENCUES.md hot-reload applies.
    if (this.configLoader.opencuesState.settings.get('katas-mode') === 'off') return;

    const ctl = matchControlPhrase(text, this.active);
    if (ctl) { void this.handleControl(ctl, text); return; }
    if (!this._doc) return;

    // Record activity for the coach trace (submits handled above,
    // source-agnostically).
    if (text.trim().length > 0) {
      // Coalesce ONLY continued typing (the new text extends / trims the
      // previous snapshot) — a change of direction (different prefix)
      // is a distinct ATTEMPT and must stay its own entry. Full
      // replacement-coalescing collapsed "/memory" → "/setup" → "/start"
      // into one morphing entry, making it impossible for the coach to
      // count failed attempts (reveal-after-N-failures, stuck
      // escalation).
      const last = this._trace[this._trace.length - 1];
      const continues = last?.kind === 'typed'
        && (text.startsWith(last.text) || last.text.startsWith(text));
      if (continues) {
        this._trace[this._trace.length - 1] = { kind: 'typed', text };
      } else {
        this.pushTrace({ kind: 'typed', text });
      }
    }
    this.armIdleTimer();
    this.scheduleTick();
  }

  private pushTrace(entry: TraceEntry): void {
    this._trace.push(entry);
    if (this._trace.length > TRACE_MAX) this._trace.shift();
  }

  // ── control phrases ──────────────────────────────────────────────────

  private async handleControl(ctl: ControlPhrase, text: string): Promise<void> {
    switch (ctl.kind) {
      case 'start': {
        let doc = await this.loadKata(ctl.arg);
        // Fuzzy fallback — deterministic match failed but the user named
        // SOMETHING ("start kata the git one _"). One bounded-codomain
        // LLM pick over the installed catalogue (same safety shape as
        // fluid-config: the model can only choose among installed names;
        // exact id/name matches never consult it; validation floor
        // rejects anything outside the list).
        if (!doc && ctl.arg) {
          const picked = await this.llmPickKata(ctl.arg);
          if (picked) {
            doc = await this.loadKata(picked);
            if (doc) this.adapter.emitEvent?.('kata.matched', { arg: ctl.arg, picked });
          }
        }
        if (!doc) {
          this._logFn(`Kata: no kata found for "${ctl.arg ?? '(first)'}" under ${this.options.katasDirs.join(', ')}`);
          const available = await this.listKatas();
          const listing = available.length === 0
            ? 'none installed — add one under ~/.cues/katas/'
            : available.map(t => t.id ? `\`${t.id}: ${t.name}\`` : `\`${t.name}\``).join(' · ');
          this._notice = {
            text: `No kata "${ctl.arg ?? ''}" — available → ${listing}`.slice(0, 200),
            until: Date.now() + 10_000,
          };
          setTimeout(() => { this._notice = null; this.refreshStatusline(); }, 10_100);
          this.adapter.emitEvent?.('kata.not-found', { arg: ctl.arg, available: listing });
          this.refreshStatusline();
          return;
        }
        this._notice = null;
        this._doc = doc;
        this._lastDocName = doc.name;
        this._stepIndex = 0;
        this._trace = [];
        this._journal = [];
        this._stepStartedAt = Date.now();
        // Resume: saved mid-kata progress puts the user back where
        // they left off (journal included, so lesson memory survives a
        // restart). A completed record starts fresh.
        const saved = ctl.fresh ? undefined : (await this.loadProgress())[doc.name];
        if (saved && !saved.completed && saved.step > 0 && saved.step < doc.steps.length) {
          this._stepIndex = saved.step;
          this._journal = Array.isArray(saved.journal) ? [...saved.journal] : [];
          this._coachLine = `Welcome back to **${doc.title}** — next: ${cleanStepTitle(doc.steps[saved.step].title)}`;
        } else {
          this._coachLine = `**${doc.title}** — first: ${cleanStepTitle(doc.steps[0].title)}~ · Esc ×3 exits~`;
        }
        this.consumePhrase(text, ctl.phraseStart);
        this.adapter.emitEvent?.('kata.started', {
          name: doc.name, id: doc.id, title: doc.title, stepCount: doc.steps.length,
          resumedAtStep: this._stepIndex > 0 ? this._stepIndex + 1 : undefined,
        });
        this.maybeSpeak(this._coachLine ?? '');
        this._logFn(`Kata: started "${doc.name}" (${doc.steps.length} steps)`);
        this.refreshStatusline();
        this.armIdleTimer();
        return;
      }
      case 'stop': {
        if (!this._doc) { this.consumePhrase(text, ctl.phraseStart); return; }
        const name = this._doc.name;
        this.saveProgress({ step: this._stepIndex });
        this.deactivate();
        this.consumePhrase(text, ctl.phraseStart);
        this.adapter.emitEvent?.('kata.stopped', { name, reason: 'user' });
        this._logFn(`Kata: stopped "${name}"`);
        this.refreshStatusline();
        return;
      }
      case 'advance': {
        if (!this._doc) return;
        this.consumePhrase(text, ctl.phraseStart);
        this.advanceStep('user');
        return;
      }
    }
  }

  /** Remove the control phrase from the buffer (shape-derived clearing —
   *  the command span is consumed, prior content survives). */
  private consumePhrase(text: string, phraseStart: number): void {
    const kept = text.slice(0, phraseStart).replace(/\s+$/, '');
    this._selfWrites.push({ text: kept, addedAt: Date.now() });
    if (this._selfWrites.length > 4) this._selfWrites.shift();
    this._lastText = kept;
    // Deferred one tick — a write issued INSIDE the host's text-change
    // dispatch is clobbered when the host finishes applying the very
    // change that triggered us (observed on OpenTUI: `done _` stayed in
    // the buffer while an await-deferred write for `start kata 1 _`
    // landed fine).
    setTimeout(() => {
      if (this.adapter.pushText) this.adapter.pushText(kept, kept.length);
      else { this.adapter.setText(kept); this.adapter.setCursorOffset(kept.length); }
      this.refreshStatusline();
    }, 0);
  }

  private advanceStep(reason: 'user' | 'coach'): void {
    if (!this._doc) return;
    const from = this._stepIndex;
    // Journal the completed step with the evidence that closed it.
    const doneStep = this._doc.steps[from];
    const evidence = this._trace.length > 0 ? this._trace[this._trace.length - 1] : null;
    const how = reason === 'user'
      ? 'user advanced manually'
      : evidence === null ? 'completed'
        : evidence.kind === 'submitted' ? `submitted: "${evidence.text.slice(0, 60)}"`
          : evidence.kind === 'key' ? `pressed: ${evidence.text}${(evidence.count ?? 1) > 1 ? ` (×${evidence.count})` : ''}`
            : `typed: "${evidence.text.slice(0, 60)}"`;
    this._journal.push(`Step ${from + 1} (${doneStep.title}) ✓ — ${how}`);
    if (from + 1 >= this._doc.steps.length) {
      const name = this._doc.name;
      const title = this._doc.title;
      const next = this._doc.next;
      const stepCount = this._doc.steps.length;
      // Completion recap — the journal tells the story; the curriculum
      // link offers the next lesson. Shown as a 20s notice so the
      // ending lands instead of silently vanishing.
      const recap = this._journal.map(l => cleanStepTitle(l.replace(/^Step \d+ \(([^)]*)\).*/, '$1'))).join(' → ');
      const nextBit = next ? ` · next up: type \`start kata ${next} _\`` : '';
      this.saveProgress({ step: 0, completed: true });
      this.deactivate();
      // Actionable link BEFORE the decorative journey — single-line
      // statuslines clip the tail, and the tail must never be the link.
      this._notice = {
        text: `🎉 ${title} — complete (${stepCount}/${stepCount})${nextBit}${recap ? ` — ${recap}` : ''}`.slice(0, 220),
        until: Date.now() + 20_000,
        offTrack: false,
      };
      setTimeout(() => { this._notice = null; this.refreshStatusline(); }, 20_100);
      this.adapter.emitEvent?.('kata.completed', { name, stepCount, reason, next: next ?? undefined });
      this.maybeSpeak(`Kata complete! ${stepCount} of ${stepCount}.${next ? ' Next up: ' + next : ''}`);
      this._logFn(`Kata: completed "${name}" 🎉`);
      this.refreshStatusline();
      return;
    }
    this._stepIndex = from + 1;
    this._offTrack = false;
    this._stepStartedAt = Date.now();
    this.saveProgress({ step: this._stepIndex });
    const next = this._doc.steps[this._stepIndex];
    this._coachLine = `✓ Now: ${cleanStepTitle(next.title)}`;
    this.maybeSpeak(`Step ${this._stepIndex + 1} of ${this._doc.steps.length}: ${cleanStepTitle(next.title)}`);
    this.adapter.emitEvent?.('kata.step-advanced', {
      name: this._doc.name, fromStep: from + 1, toStep: this._stepIndex + 1, reason,
    });
    this._logFn(`Kata: step ${from + 1} → ${this._stepIndex + 1} (${reason})`);
    this.refreshStatusline();
    this.armIdleTimer();
  }

  private deactivate(): void {
    this._doc = null;
    this._stepIndex = 0;
    this._coachLine = null;
    this._offTrack = false;
    this._trace = [];
    this._journal = [];
    this._nudgeCount = 0;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
  }

  /** Speak via the host TTS iff `kata-voice: on`. Plain text only
   *  (markup stripped); fire-and-forget. */
  private maybeSpeak(text: string): void {
    if (!this.options.speak) return;
    if (this.configLoader.opencuesState.settings.get('kata-voice') !== 'on') return;
    try { this.options.speak(parseCoachMarkup(text).plain); } catch { /* never load-bearing */ }
  }

  private refreshStatusline(): void {
    try { this.adapter.forceRender?.(); } catch { /* host may not support */ }
  }

  // ── progress persistence ─────────────────────────────────────────────

  private async loadProgress(): Promise<Record<string, { step: number; journal?: string[]; completed?: boolean }>> {
    if (!this.options.progressFile) return {};
    try {
      const raw = await this.adapter.readFile(this.options.progressFile);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }

  /** Fire-and-forget write — persistence is never load-bearing. */
  private saveProgress(update: { step: number; completed?: boolean } | null): void {
    if (!this.options.progressFile || !this._lastDocName) return;
    const name = this._lastDocName;
    // Snapshot NOW — the write runs async and deactivate() may wipe the
    // journal before it lands (live-caught: stop-path saves persisted
    // an empty journal, so resume lost the lesson memory).
    const journal = [...this._journal];
    void this.loadProgress().then(all => {
      if (update === null) delete all[name];
      else all[name] = { step: update.step, journal, completed: update.completed ?? false, updatedAt: Date.now() } as never;
      return this.adapter.writeFile(this.options.progressFile!, JSON.stringify(all, null, 2));
    }).catch(() => { /* soft */ });
  }

  /** Doc name survives deactivate for the final save. */
  private _lastDocName: string | null = null;

  // ── kata discovery ───────────────────────────────────────────────

  /** Fuzzy kata pick: one LLM call choosing among INSTALLED names only.
   *  Returns a validated installed name, or null (no LLM / no pick /
   *  hallucinated name). Never throws. */
  private async llmPickKata(arg: string): Promise<string | null> {
    const resolved = this.options.resolveLLM();
    if (!resolved) return null;
    const available = await this.listKatas();
    if (available.length === 0) return null;
    try {
      const out = await dispatchChat(
        resolved.provider as unknown as Parameters<typeof dispatchChat>[0],
        this.getHttpAgent() as Parameters<typeof dispatchChat>[1],
        {
          model: resolved.model,
          messages: [
            { role: 'system', content: `The user wants to start a kata (guided practice scenario) but their request didn't exactly match an installed name. Pick the single best match from the INSTALLED list, or NONE if nothing plausibly matches. Reply with EXACTLY one line: KATA: <name> or KATA: NONE.\n\nINSTALLED:\n${available.map(k => `- ${k.name}`).join('\n')}` },
            { role: 'user', content: arg },
          ],
          maxTokens: 1024,
          temperature: 0,
          seed: 42,
        },
        { apiKey: resolved.apiKey, endpoint: resolved.endpoint, maxThinking: resolved.maxThinking ?? true },
      );
      const m = out.match(/KATA:\s*(\S+)/i);
      if (!m || /^none$/i.test(m[1])) return null;
      // FLOOR: only an installed name is honoured.
      const hit = available.find(k => k.name.toLowerCase() === m[1].toLowerCase());
      return hit ? hit.name : null;
    } catch { return null; }
  }

  /** Enumerate installed katas (id + name) across the search dirs.
   *  Used for the not-found notice so a failed start tells the user
   *  what they CAN type instead of failing silently. */
  private async listKatas(): Promise<Array<{ id: string | null; name: string }>> {
    const out: Array<{ id: string | null; name: string }> = [];
    const seen = new Set<string>();
    for (const dir of this.options.katasDirs) {
      let entries;
      try { entries = await this.adapter.readDir?.(dir); } catch { entries = null; }
      if (!entries) continue;
      for (const entry of entries) {
        if (!entry.isDirectory || seen.has(entry.name)) continue;
        let raw: string | null = null;
        try { raw = await this.adapter.readFile(`${dir}/${entry.name}/KATA.md`); } catch { raw = null; }
        if (!raw) continue;
        const doc = parseKataMd(raw, entry.name);
        if (!doc) continue;
        seen.add(entry.name);
        out.push({ id: doc.id, name: doc.name });
      }
    }
    return out.sort((a, b) => (parseInt(a.id ?? '999', 10) || 999) - (parseInt(b.id ?? '999', 10) || 999));
  }

  private async loadKata(arg: string | null): Promise<KataDoc | null> {
    for (const dir of this.options.katasDirs) {
      let entries;
      try { entries = await this.adapter.readDir?.(dir); } catch { entries = null; }
      if (!entries) continue;
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        let raw: string | null = null;
        try { raw = await this.adapter.readFile(`${dir}/${entry.name}/KATA.md`); } catch { raw = null; }
        if (!raw) continue;
        const doc = parseKataMd(raw, entry.name);
        if (!doc) continue;
        if (arg === null) return doc;
        const want = arg.replace(/^#/, '').toLowerCase();
        if (doc.id?.toLowerCase() === want || doc.name.toLowerCase() === want) return doc;
        // `#01` style ids: compare numerically too (1 == 01).
        if (doc.id && /^\d+$/.test(want) && /^\d+$/.test(doc.id)
          && parseInt(doc.id, 10) === parseInt(want, 10)) return doc;
      }
    }
    return null;
  }

  // ── coach tick (debounced LLM call) ──────────────────────────────────

  private cadence(): number {
    const c = this.options.cadenceMs;
    const n = typeof c === 'function' ? c() : c;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : DEFAULT_CADENCE_MS;
  }

  // ── idle nudge (proactive check-in) ──────────────────────────────────

  private nudgeWindow(): number {
    const c = this.options.nudgeMs;
    const n = typeof c === 'function' ? c() : c;
    if (n === 0) return 0; // explicit disable
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : DEFAULT_NUDGE_MS;
  }

  /** (Re)arm the idle timer. Called on every user activity, on step
   *  advance, and at activation. Any activity also resets the per-step
   *  nudge counter — the cap exists to stop NAGGING, not to stop
   *  nudging a user who came back and stalled again. */
  private armIdleTimer(resetCount = true): void {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (resetCount) this._nudgeCount = 0;
    if (!this._doc) return;
    const win = this.nudgeWindow();
    if (win <= 0) return;
    this._idleSince = Date.now();
    this._idleTimer = setTimeout(() => { void this.fireNudge(); }, win);
    (this._idleTimer as { unref?: () => void }).unref?.();
  }

  private async fireNudge(): Promise<void> {
    this._idleTimer = null;
    if (!this._doc) return;
    if (this._nudgeCount >= 2) return; // said our piece — stay quiet
    if (this._inFlight) { this.armIdleTimer(false); return; } // let the tick land first
    const doc = this._doc;
    const stepAtDispatch = this._stepIndex;
    const idleMs = Date.now() - this._idleSince;
    this._nudgeCount++;
    const nudgeNumber = this._nudgeCount;
    const skipHint = nudgeNumber >= 2 ? ' · stuck? `skip _` skips this step' : '';
    const resolved = this.options.resolveLLM();
    if (!resolved) {
      // Deterministic nudge — same idea, no model.
      const i = Math.min(stepAtDispatch, doc.steps.length - 1);
      this._coachLine = `Still there? ${cleanStepTitle(doc.steps[i].title)}${skipHint || ' — type `next _` when done'}`;
      this._offTrack = false;
      this.adapter.emitEvent?.('kata.nudge', { step: i + 1, nudgeNumber, idleMs, deterministic: true, coach: this._coachLine });
      this.refreshStatusline();
      this.armIdleTimer(false);
      return;
    }
    this._inFlight = true;
    const started = Date.now();
    try {
      const out = await dispatchChat(
        resolved.provider as unknown as Parameters<typeof dispatchChat>[0],
        this.getHttpAgent() as Parameters<typeof dispatchChat>[1],
        {
          model: resolved.model,
          messages: [
            { role: 'system', content: this.systemPrompt(doc) },
            { role: 'user', content: this.userPrompt(stepAtDispatch, { idleMs, nudgeNumber }) },
          ],
          maxTokens: 2048,
          temperature: 0,
          seed: 42,
        },
        { apiKey: resolved.apiKey, endpoint: resolved.endpoint, maxThinking: resolved.maxThinking ?? true },
      );
      const latencyMs = Date.now() - started;
      if (this._doc !== doc || this._stepIndex !== stepAtDispatch) return; // world moved on
      const verdict = parseCoachResponse(out);
      // A nudge is ADVISORY: no new evidence arrived, so the verdict can
      // never advance a step and never marks off-track — only the COACH
      // line is taken (plus the deterministic skip hint on nudge 2).
      // CONTROL: STOP is also ignored here — quitting is a response to
      // the USER's words, and the user said nothing.
      if (verdict) {
        this._coachLine = (verdict.coach.slice(0, COACH_MAX_CHARS - skipHint.length) + skipHint);
        this._offTrack = false;
        this.adapter.emitEvent?.('kata.nudge', { step: stepAtDispatch + 1, nudgeNumber, idleMs, latencyMs, coach: this._coachLine, model: resolved.model });
        this.maybeSpeak(this._coachLine);
        this.refreshStatusline();
      } else {
        this.adapter.emitEvent?.('kata.nudge', { step: stepAtDispatch + 1, nudgeNumber, idleMs, latencyMs, parseError: true });
      }
    } catch (err) {
      this._logFn(`Kata: nudge call failed — ${err instanceof Error ? err.message : String(err)}`);
      this.adapter.emitEvent?.('kata.nudge', { step: stepAtDispatch + 1, nudgeNumber, idleMs, error: true });
    } finally {
      this._inFlight = false;
      this.armIdleTimer(false); // next nudge (or quiet if capped) after another window
    }
  }

  private scheduleTick(): void {
    if (!this._doc) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      void this.tick();
    }, this.cadence());
  }

  private async tick(): Promise<void> {
    if (!this._doc || this._inFlight) return;
    const resolved = this.options.resolveLLM();
    if (!resolved) {
      // No LLM (missing key / provider unresolved). Degrade LOUDLY, not
      // silently: the kata keeps working as static instruction
      // cards with manual advancement — but only if the user is told.
      this.setOfflineCoachLine('no LLM key');
      return;
    }
    const doc = this._doc;
    const stepAtDispatch = this._stepIndex;
    this._tickSnapshot = this._lastText;
    this._inFlight = true;
    const started = Date.now();
    try {
      const out = await dispatchChat(
        resolved.provider as unknown as Parameters<typeof dispatchChat>[0],
        this.getHttpAgent() as Parameters<typeof dispatchChat>[1],
        {
          model: resolved.model,
          messages: [
            { role: 'system', content: this.systemPrompt(doc) },
            { role: 'user', content: this.userPrompt(stepAtDispatch) },
          ],
          maxTokens: 2048, // reasoning models spend tokens thinking before the 3 output lines
          temperature: 0,
          seed: 42,
        },
        { apiKey: resolved.apiKey, endpoint: resolved.endpoint, maxThinking: resolved.maxThinking ?? true },
      );
      const latencyMs = Date.now() - started;
      // Stale-drop: kata stopped, step moved (user typed done _), or
      // buffer changed while in flight → discard; next tick re-asks.
      if (this._doc !== doc || this._stepIndex !== stepAtDispatch) {
        this.adapter.emitEvent?.('kata.tick', { stale: true, latencyMs });
        return;
      }
      this._consecutiveErrors = 0;
      const verdict = parseCoachResponse(out);
      if (!verdict) {
        this._logFn(`Kata: unparseable coach response (${latencyMs}ms): ${out.slice(0, 120)}`);
        this.adapter.emitEvent?.('kata.tick', { parseError: true, latencyMs });
        return;
      }
      // Safety floors — trust the model, clamp the blast radius:
      // never backward, at most +1 forward per tick.
      // The coach's one permitted action: stop on the user's explicit
      // request. Releases the modal override (fail-open) — a spurious
      // STOP costs the user a restart, never their buffer or settings.
      if (verdict.control === 'STOP') {
        const name = doc.name;
        const id = doc.id;
        this.deactivate();
        this._notice = {
          text: `Kata stopped — type \`start kata ${id ?? name} _\` to pick it back up`,
          until: Date.now() + 10_000,
          offTrack: false,
        };
        setTimeout(() => { this._notice = null; this.refreshStatusline(); }, 10_100);
        this.adapter.emitEvent?.('kata.stopped', { name, reason: 'coach-user-request', latencyMs });
        this._logFn(`Kata: stopped "${name}" (coach honoured user request)`);
        this.refreshStatusline();
        return;
      }
      const wantsAdvance = verdict.status === 'STEP_DONE'
        || (verdict.step !== null && verdict.step > stepAtDispatch + 1);
      this._coachLine = verdict.coach.slice(0, COACH_MAX_CHARS);
      this._offTrack = verdict.status === 'OFF_TRACK';
      this.adapter.emitEvent?.('kata.tick', {
        step: stepAtDispatch + 1,
        claimedStep: verdict.step,
        status: verdict.status,
        coach: this._coachLine,
        latencyMs,
        model: resolved.model,
        provider: resolved.provider.id,
      });
      if (wantsAdvance) {
        this.advanceStep('coach');
        // Auto-walk: when the evidence already belongs to a step beyond
        // the one we just advanced to (the model claimed further ahead),
        // re-ask immediately so progress catches up one clamped step per
        // tick instead of stalling until the next user action.
        if (this._doc && verdict.step !== null && verdict.step > this._stepIndex + 1) {
          this.scheduleTick();
        }
      } else {
        this.refreshStatusline();
      }
    } catch (err) {
      // Fail-safe: a dead coach degrades to static instructions — never
      // touches the buffer, never loses progress. After two consecutive
      // failures (one could be a blip), surface the manual-advance
      // affordance so the user isn't left typing into a void.
      const latencyMs = Date.now() - started;
      this._logFn(`Kata: coach call failed (${latencyMs}ms) — ${err instanceof Error ? err.message : String(err)}`);
      this.adapter.emitEvent?.('kata.tick', { error: true, latencyMs });
      this._consecutiveErrors++;
      if (this._consecutiveErrors >= 2) this.setOfflineCoachLine('coach unreachable');
    } finally {
      this._inFlight = false;
      // If the buffer moved while we were in flight, re-ask.
      if (this._doc && this._lastText !== this._tickSnapshot) this.scheduleTick();
    }
  }

  private systemPrompt(doc: KataDoc): string {
    // Stable per kata per session — lands in the provider's prompt
    // prefix cache (see docs/architecture/cerebras.md). Per-tick data
    // stays in the user message.
    const steps = doc.steps
      .map((s, i) => `### Step ${i + 1}: ${s.title}\n${s.body}`)
      .join('\n\n');
    return `You are a KATA COACH embedded in a text editor's input box. The user is working through a scripted kata step by step. You observe their activity as a trace of events:
- typed: "<text>" — the current state of what they typed into the input box
- submitted (pressed Enter): "<text>" — they sent that text and the buffer cleared
- pressed: <key> (×N) — a salient key press outside normal typing (tab, shift+tab, enter on an empty buffer, escape, arrow keys, ctrl/alt combos). Steps that happen OUTSIDE the input box (mode toggles, pickers, menus) are detected from these.

You cannot see their screen — only this trace and the current buffer.

On every check-in, judge the user's progress on the CURRENT step and give one short coaching line.

Rules:
- Judge ONLY from the trace and the current buffer.
- STATUS is one of:
  IN_PROGRESS — the user is working on the current step (or no relevant activity yet)
  STEP_DONE   — the activity (typing, submits, or key presses) satisfies the current step's goal
  OFF_TRACK   — the activity contradicts the current step's goal
- Detection is your job — the user should NEVER have to announce completion. When the step's expected key presses appear in the trace (e.g. shift+tab ×2 for a mode toggle, arrows + enter for a picker), that IS completion: STEP_DONE.
- If the activity clearly belongs to a LATER step than the current one (e.g. the current step is a mode toggle you can't fully verify, but they're already typing the next step's request), the current step is behind them: STEP_DONE. EXCEPTION: a step's own coach notes always override this — when they mark the order as strict (skipping = OFF_TRACK), enforce the order instead.
- COACH is ONE line (max 100 chars): the next micro-action ("Press Enter to open the model picker"), a fix ("add: don't implement yet"), or brief encouragement. Follow any coach notes in the step body.
- In COACH, wrap anything the user should LITERALLY type or press in backticks: commands (\`/init\`, \`git status\`, \`skip _\`), exact text to enter, key names (\`Enter\`, \`Shift+Tab\`). The display renders these distinctly so the user can tell commands from prose. Do not backtick ordinary words. You may **bold** one key word for emphasis when it genuinely helps.
- Meta-questions to you ("help", "what do I do now?", "where am I?") are NOT off-track — answer them: STATUS IN_PROGRESS, COACH restates the current micro-action. When they ask what they've DONE so far, answer from LESSON SO FAR in a few words, then the next action (e.g. "You've run /init and gotten an overview — now ask how to run the tests."). OFF_TRACK is reserved for actions that contradict the step.
- TRUST COMPLETION CLAIMS **only** on steps you cannot observe: if a step happens outside the input box (a key press, a menu, a mode toggle) and the user explicitly claims completion ("done", "I did it", "I'm in plan mode now"), that's STEP_DONE — never hold them hostage to key-press evidence you might have missed. BUT if the step's goal IS observable (they must TYPE or SUBMIT specific content), a bare claim like "done, I pasted it" with no such entry in the trace is NOT completion: stay on the step and ask for the actual content.
- USER CONTROLS you must know (and mention when relevant): the user can type "stop kata _" to exit the kata at any time, and "skip _" to force-skip the current step. When they want to quit, are frustrated, or ask how to exit → COACH must include: type stop kata _ to exit. When they've been stuck on the same step for several checks despite your coaching → give the EXACT text to type, and mention skip _ as the escape.
- Coach in the user's language: if they're typing in French, coach in French; same for any language. The control phrases (stop kata _, skip _) and commands (/init, /model) stay verbatim in English.
- When a step's coach notes set an attempt threshold ("after 3 wrong attempts, reveal…"), compare it against the DISTINCT ATTEMPTS THIS STEP number provided in the check-in. Count reached → OBEY the note and give the exact answer; continuing to hint past the threshold is wrong.
- Never repeat your previous coach line verbatim — each check-in adds information, rephrases more concretely, or escalates.
- Never invent steps. Answer for the CURRENT step only.

Respond in EXACTLY this format (three lines — plus the optional CONTROL line — nothing else):
STEP: <current step number>
STATUS: <IN_PROGRESS|STEP_DONE|OFF_TRACK>
COACH: <one line>
CONTROL: STOP   ← include this fourth line ONLY when the user EXPLICITLY asks to stop/quit/exit the kata (in any language: "please stop this kata", "quitte le tutoriel", …). The runtime then ends the kata for them. Do NOT emit it for frustration, insults, or struggling alone — for those, keep coaching and offer "stop kata _" in COACH. When you emit CONTROL: STOP, make COACH a brief goodbye.

KATA: ${doc.title}
STEPS (${doc.steps.length} total):

${steps}`;
  }

  private userPrompt(stepIndex: number, nudge?: { idleMs: number; nudgeNumber: number }): string {
    const trace = this._trace.length === 0
      ? '(no activity yet)'
      : this._trace.map(t => {
        if (t.kind === 'submitted') return `- submitted (pressed Enter): "${t.text}"`;
        if (t.kind === 'key') return `- pressed: ${t.text}${(t.count ?? 1) > 1 ? ` (×${t.count})` : ''}`;
        return `- typed: "${t.text}"`;
      }).join('\n');
    const buffer = this._lastText.trim().length === 0 ? '(empty)' : this._lastText;
    const journal = this._journal.length === 0
      ? ''
      : `LESSON SO FAR:\n${this._journal.map(l => `- ${l}`).join('\n')}\n`;
    // Deterministic attempt count — models are unreliable at counting
    // trace entries themselves (gemma never reveals-after-3 without
    // this); typed/submitted entries are attempts, key presses aren't.
    const attempts = this._trace.filter(t => t.kind !== 'key').length;
    const attemptsLine = `\nDISTINCT ATTEMPTS THIS STEP: ${attempts}`;
    const timeOnStep = this._stepStartedAt > 0
      ? `\nTIME ON CURRENT STEP: ~${Math.max(1, Math.round((Date.now() - this._stepStartedAt) / 1000))}s`
      : '';
    const nudgeBlock = nudge
      ? `\nNUDGE CHECK-IN: the user has been idle for ~${Math.round(nudge.idleMs / 1000)}s on the current step (nudge ${nudge.nudgeNumber} of 2). Give ONE short, warm, context-aware nudge — reference their partial input or what they've already completed when helpful. There is NO new evidence, so STATUS must not be STEP_DONE.`
      : '';
    return `CURRENT STEP: ${stepIndex + 1}${timeOnStep}${attemptsLine}\n${journal}RECENT ACTIVITY:\n${trace}\nCURRENT BUFFER: ${buffer}${nudgeBlock}`;
  }

  private getHttpAgent(): NonNullable<KataCoachOptions['httpAdapter']> {
    if (this.options.httpAdapter) return this.options.httpAdapter;
    if (this._httpAgent) return this._httpAgent;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NodeHttpAdapter } = require('@opencues/core/node-http-adapter');
    this._httpAgent = new NodeHttpAdapter({ maxSockets: 2, timeout: 30000 }) as NonNullable<KataCoachOptions['httpAdapter']>; // BROWSER-SAFE-ALLOW: native-host fallback only — getHttpAgent is bypassed when options.httpAdapter is supplied (chrome)
    return this._httpAgent!;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Response parsing — tolerant three-line format
// ──────────────────────────────────────────────────────────────────────

export interface CoachVerdict {
  readonly step: number | null;
  readonly status: 'IN_PROGRESS' | 'STEP_DONE' | 'OFF_TRACK';
  readonly coach: string;
  /** The coach's single permitted ACTION: 'STOP' ends kata mode on
   *  the user's explicit request ("please stop this kata"). This is
   *  the one deliberate exception to display-only coach output — it
   *  RELEASES the modal override (fail-open direction), never acquires
   *  anything, and the deterministic `stop kata _` phrase remains
   *  as the always-works path. */
  readonly control: 'STOP' | null;
}

export function parseCoachResponse(raw: string): CoachVerdict | null {
  const stepM = raw.match(/^\s*STEP:\s*(\d+)\s*$/mi);
  const statusM = raw.match(/^\s*STATUS:\s*(IN_PROGRESS|STEP_DONE|OFF_TRACK)\s*$/mi);
  const coachM = raw.match(/^\s*COACH:\s*(.+?)\s*$/mi);
  const controlM = raw.match(/^\s*CONTROL:\s*(STOP)\s*$/mi);
  if (!statusM || !coachM) return null;
  return {
    step: stepM ? parseInt(stepM[1], 10) : null,
    status: statusM[1].toUpperCase() as CoachVerdict['status'],
    coach: coachM[1],
    control: controlM ? 'STOP' : null,
  };
}

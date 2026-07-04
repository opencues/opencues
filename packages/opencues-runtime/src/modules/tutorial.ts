// TutorialCoach — modal guided-scenario runtime (PROTOTYPE).
//
// A tutorial is an ordered script of steps the user works through inside
// their real editor, authored as `tutorials/<name>/TUTORIAL.md` under any
// `.cues/` search path. The coach is a debounced background LLM call that
// receives the WHOLE tutorial script (stable → provider prefix-cache) plus
// the user's recent typed activity, and returns (a) whether the current
// step is satisfied and (b) ONE short coaching line shown on the
// statusline. The model owns progress judgement; the runtime owns only
// safety floors (step index clamped to bounds, never moves backward,
// advances at most one step per tick).
//
// STRUCTURAL INVARIANTS (mirrors ambient-context, security-audit row #21):
//   - Coach output is DISPLAY-ONLY. It feeds the statusline field and the
//     step counter — never the buffer, never an exec/side-effect layer.
//     A malicious TUTORIAL.md can at worst show wrong text and mis-advance
//     its own step counter.
//   - The runtime observes typed text AND salient key presses (the
//     adapter's onKey stream — passive, never consumed): Tab/Shift+Tab,
//     Enter, Escape, arrows, and modifier combos. A buffer transitioning
//     non-empty → empty is additionally recorded as a `submitted` event.
//     Together these make "unobservable" steps (mode toggles, pickers)
//     detectable without the user having to type `done` — seamlessness
//     is the point. `done _` / `next _` / `skip _` remain as manual
//     escape hatches but tutorials should never require them.
//   - While a tutorial is active the Resolver is suppressed entirely
//     (ResolverOptions.externallySuppressed) — tutorial mode overrides
//     normal cue/blank behaviour, and `stop tutorial _` restores it with
//     zero settings churn because nothing was ever written to OPENCUES.md.
//
// Control phrases (keyword-bound, `_`-gated like every blank trigger):
//   start tutorial <id|name> _   activate (bare `start tutorial _` = first found)
//   stop tutorial _              deactivate
//   done _ / next _              advance past an unobservable step
//   skip _                       force-advance a typed step
//
// Observability: every transition emits a structured event
// (tutorial.started / tutorial.tick / tutorial.step-advanced /
// tutorial.completed / tutorial.stopped) via adapter.emitEvent — the
// agentic harness's oc-events / scenario assertions see the coach loop
// the same way they see transform-blank passes.

import type { HostAdapter, KeyEvent, TextChangeEvent, Unsubscribe } from '../adapter';
import type { ConfigLoader } from './config-loader';
import type { ResolvedAgentLLM } from './agent-rewrite';
import { dispatchChat } from '@opencues/core';

// ──────────────────────────────────────────────────────────────────────
// TUTORIAL.md parsing
// ──────────────────────────────────────────────────────────────────────

export interface TutorialStep {
  /** Heading text after `## ` (e.g. "Step 1" or "Step 1 — enter plan mode"). */
  readonly title: string;
  /** Full step body — instruction prose + optional `coach:` notes. The
   *  body rides into the system prompt VERBATIM; fidelity lives in the
   *  file, not in a schema. */
  readonly body: string;
}

export interface TutorialDoc {
  readonly name: string;
  readonly id: string | null;
  readonly title: string;
  readonly steps: readonly TutorialStep[];
}

/** Parse a TUTORIAL.md — frontmatter (name/id/title) + `## ` step sections.
 *  Returns null when the doc has no steps (not a usable tutorial). */
export function parseTutorialMd(raw: string, fallbackName: string): TutorialDoc | null {
  let name = fallbackName;
  let id: string | null = null;
  let title = fallbackName;
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
    }
  }
  const steps: TutorialStep[] = [];
  const parts = body.split(/^##\s+/m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const stepTitle = (nl === -1 ? part : part.slice(0, nl)).trim();
    const stepBody = (nl === -1 ? '' : part.slice(nl + 1)).trim();
    if (stepTitle.length > 0) steps.push({ title: stepTitle, body: stepBody });
  }
  if (steps.length === 0) return null;
  return { name, id, title, steps };
}

// ──────────────────────────────────────────────────────────────────────
// Control-phrase detection
// ──────────────────────────────────────────────────────────────────────

// Phrase must LEAD the sentence containing the trailing `_` — same trigger
// model as blank shapes (spec/blank-spec.md § Trigger model).
const RE_START = /(^|[\n.!?]\s+)start\s+tutorial(?:\s+#?(\S+))?\s*_\s*$/i;
const RE_STOP = /(^|[\n.!?]\s+)stop\s+tutorial\s*_\s*$/i;
const RE_ADVANCE = /(^|[\n.!?]\s+)(done|next|skip)\s*_\s*$/i;

export type ControlPhrase =
  | { kind: 'start'; arg: string | null; phraseStart: number }
  | { kind: 'stop'; phraseStart: number }
  | { kind: 'advance'; word: string; phraseStart: number };

export function matchControlPhrase(text: string, active: boolean): ControlPhrase | null {
  let m = RE_START.exec(text);
  if (m) return { kind: 'start', arg: m[2] ?? null, phraseStart: m.index + m[1].length };
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

/** Statusline-facing snapshot. Also mirrored into tutorial.* events. */
export interface TutorialStatus {
  readonly name: string;
  readonly title: string;
  /** 1-based current step. */
  readonly step: number;
  readonly stepCount: number;
  readonly stepTitle: string;
  readonly coach: string | null;
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

export interface TutorialCoachOptions {
  /** `<searchPath>/tutorials` dirs, priority order (project first). */
  readonly tutorialsDirs: readonly string[];
  /** Same lazy resolver AgentRewrite uses (auditors bucket). Null = no
   *  key; the coach then degrades to static step instructions. */
  readonly resolveLLM: () => ResolvedAgentLLM | null;
  /** Debounce between text-change and coach tick. Default 300ms. */
  readonly cadenceMs?: number | (() => number);
  readonly log?: (msg: string) => void;
  /** Test seam. Defaults to a lazy NodeHttpAdapter on native hosts. */
  readonly httpAdapter?: { post(url: string, body: string, headers: Record<string, string>): Promise<string> };
}

export class TutorialCoach {
  private _unsubText: Unsubscribe | null = null;
  private _doc: TutorialDoc | null = null;
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
   *  submit-detection signal (caught by tutorial.scenarios.test.ts). */
  private _selfWrites: Array<{ text: string; addedAt: number }> = [];
  private _httpAgent: TutorialCoachOptions['httpAdapter'] | null = null;
  private readonly _logFn: (msg: string) => void;
  /** Consecutive bare-Escape presses — the DETERMINISTIC escape hatch.
   *  3 within the window exits tutorial mode with zero LLM involvement,
   *  zero phrase knowledge, in any language, even with a dead API key.
   *  Every other escape path (stop tutorial _, coach-honoured stop) is
   *  richer but requires knowledge or a working model; this one is the
   *  floor. */
  private _escCount = 0;
  private _escResetTimer: ReturnType<typeof setTimeout> | null = null;
  /** Transient user-facing notice (e.g. "no tutorial found") shown via
   *  the statusline tutorial block while no tutorial is active. */
  private _notice: { text: string; until: number; offTrack?: boolean } | null = null;

  constructor(
    private adapter: HostAdapter,
    private configLoader: ConfigLoader,
    private options: TutorialCoachOptions,
  ) {
    this._logFn = options.log ?? ((msg) => adapter.log('debug', msg));
  }

  get active(): boolean { return this._doc !== null; }

  /** Read-only trace view — for tests + future bridge dumps. */
  traceSnapshot(): ReadonlyArray<{ kind: string; text: string; count?: number }> {
    return this._trace.map(t => ({ ...t }));
  }

  /** Resolver suppression predicate — active tutorial OR a control phrase
   *  mid-typing. Wired into ResolverOptions.externallySuppressed so normal
   *  cue/blank sources never race the tutorial's own trigger handling. */
  shouldSuppressResolve(text: string): boolean {
    if (this._doc !== null) return true;
    return matchControlPhrase(text, false) !== null;
  }

  /** Statusline payload feed. Null when no tutorial is active. */
  status(): TutorialStatus | null {
    if (!this._doc) {
      // Transient failure notice (failed `start tutorial N _`). step 0 /
      // stepCount 0 marks it as a notice, not a running tutorial.
      if (this._notice && Date.now() < this._notice.until) {
        return {
          name: 'tutorials', title: 'tutorials', step: 0, stepCount: 0,
          stepTitle: '', coach: this._notice.text, offTrack: this._notice.offTrack ?? true,
        };
      }
      return null;
    }
    const i = Math.min(this._stepIndex, this._doc.steps.length - 1);
    return {
      name: this._doc.name,
      title: this._doc.title,
      step: i + 1,
      stepCount: this._doc.steps.length,
      stepTitle: this._doc.steps[i].title,
      coach: this._coachLine,
      offTrack: this._offTrack,
    };
  }

  subscribe(): void {
    this._unsubText = this.adapter.onTextChange(e => this.onTextChange(e));
  }

  unsubscribe(): void {
    if (this._unsubText) { this._unsubText(); this._unsubText = null; }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
  }

  /**
   * Passive key observation feeding the coach trace. HOSTS MUST WIRE
   * THIS AS THE FIRST KEY HANDLER — before buildSharedRuntime subscribes
   * Navigation/Cycling — because key dispatch is emit-until-consumed:
   * a late subscriber never sees Ctrl+Alt+arrows (Navigation consumes
   * them), which blinds the coach to exactly the presses cycling
   * tutorials teach. Observation only — callers must NOT treat any key
   * as consumed on the tutorial's behalf.
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
    // other → exit tutorial mode. Runs BEFORE any trace/LLM logic so it
    // works with no API key, no network, no phrase knowledge. Passive —
    // the host's own Escape behaviour (clear input, interrupt) is
    // untouched; requiring three presses keeps a normal double-Esc
    // (CC's clear-input) from killing the tutorial by accident.
    if ((k === 'escape' || k === 'esc') && !anyMod) {
      // Escape still lands in the trace (tutorials can teach Esc — e.g.
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
          text: `Tutorial exited — type start tutorial ${id ?? name} _ to pick it back up`,
          until: Date.now() + 10_000,
          offTrack: false,
        };
        setTimeout(() => { this._notice = null; this.refreshStatusline(); }, 10_100);
        this.adapter.emitEvent?.('tutorial.stopped', { name, reason: 'escape-key' });
        this._logFn(`Tutorial: exited "${name}" via Esc ×3`);
        this.refreshStatusline();
        return;
      }
      // Countdown hint — deterministic, overwrites the coach line so the
      // exit is discoverable mid-press without any model round-trip.
      this._coachLine = `Esc ×${3 - this._escCount} more to exit the tutorial`;
      this._escResetTimer = setTimeout(() => { this._escCount = 0; }, 2_500);
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
    if (e.source !== 'user') return;
    if (text === prev) return;

    // Feature gate — read lazily so OPENCUES.md hot-reload applies.
    if (this.configLoader.opencuesState.settings.get('tutorials-mode') === 'off') return;

    const ctl = matchControlPhrase(text, this.active);
    if (ctl) { void this.handleControl(ctl, text); return; }
    if (!this._doc) return;

    // Record activity for the coach trace.
    if (text.trim().length === 0 && prev.trim().length > 0) {
      // Buffer went non-empty → empty: the user submitted (Enter).
      this.pushTrace({ kind: 'submitted', text: prev.trim() });
    } else if (text.trim().length > 0) {
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
        const doc = await this.loadTutorial(ctl.arg);
        if (!doc) {
          this._logFn(`Tutorial: no tutorial found for "${ctl.arg ?? '(first)'}" under ${this.options.tutorialsDirs.join(', ')}`);
          const available = await this.listTutorials();
          const listing = available.length === 0
            ? 'none installed — add one under ~/.cues/tutorials/'
            : available.map(t => t.id ? `${t.id}: ${t.name}` : t.name).join(' · ');
          this._notice = {
            text: `No tutorial "${ctl.arg ?? ''}" — available → ${listing}`.slice(0, 200),
            until: Date.now() + 10_000,
          };
          setTimeout(() => { this._notice = null; this.refreshStatusline(); }, 10_100);
          this.adapter.emitEvent?.('tutorial.not-found', { arg: ctl.arg, available: listing });
          this.refreshStatusline();
          return;
        }
        this._notice = null;
        this._doc = doc;
        this._stepIndex = 0;
        this._trace = [];
        this._coachLine = `Step 1/${doc.steps.length} — ${doc.steps[0].title} · Esc ×3 exits`;
        this.consumePhrase(text, ctl.phraseStart);
        this.adapter.emitEvent?.('tutorial.started', {
          name: doc.name, id: doc.id, title: doc.title, stepCount: doc.steps.length,
        });
        this._logFn(`Tutorial: started "${doc.name}" (${doc.steps.length} steps)`);
        this.refreshStatusline();
        return;
      }
      case 'stop': {
        if (!this._doc) { this.consumePhrase(text, ctl.phraseStart); return; }
        const name = this._doc.name;
        this.deactivate();
        this.consumePhrase(text, ctl.phraseStart);
        this.adapter.emitEvent?.('tutorial.stopped', { name, reason: 'user' });
        this._logFn(`Tutorial: stopped "${name}"`);
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
    // the buffer while an await-deferred write for `start tutorial 1 _`
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
    if (from + 1 >= this._doc.steps.length) {
      const name = this._doc.name;
      const stepCount = this._doc.steps.length;
      this.deactivate();
      this.adapter.emitEvent?.('tutorial.completed', { name, stepCount, reason });
      this._logFn(`Tutorial: completed "${name}" 🎉`);
      this.refreshStatusline();
      return;
    }
    this._stepIndex = from + 1;
    this._offTrack = false;
    const next = this._doc.steps[this._stepIndex];
    this._coachLine = `✓ — Step ${this._stepIndex + 1}/${this._doc.steps.length}: ${next.title}`;
    this.adapter.emitEvent?.('tutorial.step-advanced', {
      name: this._doc.name, fromStep: from + 1, toStep: this._stepIndex + 1, reason,
    });
    this._logFn(`Tutorial: step ${from + 1} → ${this._stepIndex + 1} (${reason})`);
    this.refreshStatusline();
  }

  private deactivate(): void {
    this._doc = null;
    this._stepIndex = 0;
    this._coachLine = null;
    this._offTrack = false;
    this._trace = [];
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
  }

  private refreshStatusline(): void {
    try { this.adapter.forceRender?.(); } catch { /* host may not support */ }
  }

  // ── tutorial discovery ───────────────────────────────────────────────

  /** Enumerate installed tutorials (id + name) across the search dirs.
   *  Used for the not-found notice so a failed start tells the user
   *  what they CAN type instead of failing silently. */
  private async listTutorials(): Promise<Array<{ id: string | null; name: string }>> {
    const out: Array<{ id: string | null; name: string }> = [];
    const seen = new Set<string>();
    for (const dir of this.options.tutorialsDirs) {
      let entries;
      try { entries = await this.adapter.readDir?.(dir); } catch { entries = null; }
      if (!entries) continue;
      for (const entry of entries) {
        if (!entry.isDirectory || seen.has(entry.name)) continue;
        let raw: string | null = null;
        try { raw = await this.adapter.readFile(`${dir}/${entry.name}/TUTORIAL.md`); } catch { raw = null; }
        if (!raw) continue;
        const doc = parseTutorialMd(raw, entry.name);
        if (!doc) continue;
        seen.add(entry.name);
        out.push({ id: doc.id, name: doc.name });
      }
    }
    return out.sort((a, b) => (parseInt(a.id ?? '999', 10) || 999) - (parseInt(b.id ?? '999', 10) || 999));
  }

  private async loadTutorial(arg: string | null): Promise<TutorialDoc | null> {
    for (const dir of this.options.tutorialsDirs) {
      let entries;
      try { entries = await this.adapter.readDir?.(dir); } catch { entries = null; }
      if (!entries) continue;
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        let raw: string | null = null;
        try { raw = await this.adapter.readFile(`${dir}/${entry.name}/TUTORIAL.md`); } catch { raw = null; }
        if (!raw) continue;
        const doc = parseTutorialMd(raw, entry.name);
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
    if (!resolved) return; // no key — static instructions only
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
      // Stale-drop: tutorial stopped, step moved (user typed done _), or
      // buffer changed while in flight → discard; next tick re-asks.
      if (this._doc !== doc || this._stepIndex !== stepAtDispatch) {
        this.adapter.emitEvent?.('tutorial.tick', { stale: true, latencyMs });
        return;
      }
      const verdict = parseCoachResponse(out);
      if (!verdict) {
        this._logFn(`Tutorial: unparseable coach response (${latencyMs}ms): ${out.slice(0, 120)}`);
        this.adapter.emitEvent?.('tutorial.tick', { parseError: true, latencyMs });
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
          text: `Tutorial stopped — type start tutorial ${id ?? name} _ to pick it back up`,
          until: Date.now() + 10_000,
          offTrack: false,
        };
        setTimeout(() => { this._notice = null; this.refreshStatusline(); }, 10_100);
        this.adapter.emitEvent?.('tutorial.stopped', { name, reason: 'coach-user-request', latencyMs });
        this._logFn(`Tutorial: stopped "${name}" (coach honoured user request)`);
        this.refreshStatusline();
        return;
      }
      const wantsAdvance = verdict.status === 'STEP_DONE'
        || (verdict.step !== null && verdict.step > stepAtDispatch + 1);
      this._coachLine = verdict.coach.slice(0, COACH_MAX_CHARS);
      this._offTrack = verdict.status === 'OFF_TRACK';
      this.adapter.emitEvent?.('tutorial.tick', {
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
      // touches the buffer, never loses progress.
      const latencyMs = Date.now() - started;
      this._logFn(`Tutorial: coach call failed (${latencyMs}ms) — ${err instanceof Error ? err.message : String(err)}`);
      this.adapter.emitEvent?.('tutorial.tick', { error: true, latencyMs });
    } finally {
      this._inFlight = false;
      // If the buffer moved while we were in flight, re-ask.
      if (this._doc && this._lastText !== this._tickSnapshot) this.scheduleTick();
    }
  }

  private systemPrompt(doc: TutorialDoc): string {
    // Stable per tutorial per session — lands in the provider's prompt
    // prefix cache (see docs/architecture/cerebras.md). Per-tick data
    // stays in the user message.
    const steps = doc.steps
      .map((s, i) => `### Step ${i + 1}: ${s.title}\n${s.body}`)
      .join('\n\n');
    return `You are a TUTORIAL COACH embedded in a text editor's input box. The user is working through a scripted tutorial step by step. You observe their activity as a trace of events:
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
- Meta-questions to you ("help", "what do I do now?", "where am I?") are NOT off-track — answer them: STATUS IN_PROGRESS, COACH restates the current micro-action. OFF_TRACK is reserved for actions that contradict the step.
- TRUST COMPLETION CLAIMS on steps you can't observe: if the user explicitly claims they completed an outside-the-input-box action ("done", "I did it", "I'm in plan mode now") and the trace doesn't contradict them, that's STEP_DONE. Never hold a user hostage to key-press evidence you might simply have missed.
- USER CONTROLS you must know (and mention when relevant): the user can type "stop tutorial _" to exit the tutorial at any time, and "skip _" to force-skip the current step. When they want to quit, are frustrated, or ask how to exit → COACH must include: type stop tutorial _ to exit. When they've been stuck on the same step for several checks despite your coaching → give the EXACT text to type, and mention skip _ as the escape.
- Coach in the user's language: if they're typing in French, coach in French; same for any language. The control phrases (stop tutorial _, skip _) and commands (/init, /model) stay verbatim in English.
- Never invent steps. Answer for the CURRENT step only.

Respond in EXACTLY this format (three lines — plus the optional CONTROL line — nothing else):
STEP: <current step number>
STATUS: <IN_PROGRESS|STEP_DONE|OFF_TRACK>
COACH: <one line>
CONTROL: STOP   ← include this fourth line ONLY when the user EXPLICITLY asks to stop/quit/exit the tutorial (in any language: "please stop this tutorial", "quitte le tutoriel", …). The runtime then ends the tutorial for them. Do NOT emit it for frustration, insults, or struggling alone — for those, keep coaching and offer "stop tutorial _" in COACH. When you emit CONTROL: STOP, make COACH a brief goodbye.

TUTORIAL: ${doc.title}
STEPS (${doc.steps.length} total):

${steps}`;
  }

  private userPrompt(stepIndex: number): string {
    const trace = this._trace.length === 0
      ? '(no activity yet)'
      : this._trace.map(t => {
        if (t.kind === 'submitted') return `- submitted (pressed Enter): "${t.text}"`;
        if (t.kind === 'key') return `- pressed: ${t.text}${(t.count ?? 1) > 1 ? ` (×${t.count})` : ''}`;
        return `- typed: "${t.text}"`;
      }).join('\n');
    const buffer = this._lastText.trim().length === 0 ? '(empty)' : this._lastText;
    return `CURRENT STEP: ${stepIndex + 1}\nRECENT ACTIVITY:\n${trace}\nCURRENT BUFFER: ${buffer}`;
  }

  private getHttpAgent(): NonNullable<TutorialCoachOptions['httpAdapter']> {
    if (this.options.httpAdapter) return this.options.httpAdapter;
    if (this._httpAgent) return this._httpAgent;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NodeHttpAdapter } = require('@opencues/core/node-http-adapter');
    this._httpAgent = new NodeHttpAdapter({ maxSockets: 2, timeout: 30000 }) as NonNullable<TutorialCoachOptions['httpAdapter']>; // BROWSER-SAFE-ALLOW: native-host fallback only — getHttpAgent is bypassed when options.httpAdapter is supplied (chrome)
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
  /** The coach's single permitted ACTION: 'STOP' ends tutorial mode on
   *  the user's explicit request ("please stop this tutorial"). This is
   *  the one deliberate exception to display-only coach output — it
   *  RELEASES the modal override (fail-open direction), never acquires
   *  anything, and the deterministic `stop tutorial _` phrase remains
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

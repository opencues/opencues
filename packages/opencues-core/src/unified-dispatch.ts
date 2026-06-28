/**
 * Unified model-driven dispatch (Stage 1 — PURE engine).
 *
 * Replaces the five opinionated `_`-routing mechanisms (keyword exact-match,
 * blankProximity, blankReplace:auto, the source-claim race, BlankIntent) with
 * ONE model decision per `_`, gated behind `dispatch-mode: model` (default
 * `heuristic`). The model reads the buffer and decides which blank, what
 * action, what argument, and the substitution span; the runtime EXECUTES the
 * decision and enforces the safety floors (no buffer destruction; no exec with
 * an unsanitized arg; executor validates the command).
 *
 * Design + the floors + the staging: docs/architecture/unified-dispatch.md.
 *
 * This module is PURE — prompt construction + decision parsing only. No I/O,
 * no LLM. Stage 2 wires it into the resolver behind the flag.
 */

// ────────────────────────────────────────────────────────────────────
// Catalog the classifier sees — what each blank can do
// ────────────────────────────────────────────────────────────────────

export interface DispatchBlankSpec {
  /** Blank name (e.g. `volume`, `weather`, `stocks`). */
  readonly name: string;
  /** One-line description of what it returns / does. */
  readonly description: string;
  /** Which actions the blank supports. */
  readonly actions: ReadonlyArray<'get' | 'set' | 'step'>;
  /** True for read-only DATA blanks (weather/stocks/crypto) whose value is a
   *  pure fetch. False for action blanks (volume/brightness). Informs the
   *  model whether a conversational query should resolve inline vs act. */
  readonly readOnly: boolean;
}

// ────────────────────────────────────────────────────────────────────
// The decision
// ────────────────────────────────────────────────────────────────────

export interface DispatchDecision {
  /** What handles this `_`:
   *  - `action`    → run a blank's get/set/step (the executor; deterministic)
   *  - `lookup`    → hand to fluid-blank (model-driven inline answer)
   *  - `transform` → hand to transform-blank (model-driven rewrite)
   *  - `none`      → nothing fires */
  readonly route: 'action' | 'lookup' | 'transform' | 'none';
  /** For `action` — the chosen blank. */
  readonly blank?: string;
  readonly action?: 'get' | 'set' | 'step';
  /** city / ticker / set-value / step-direction. */
  readonly arg?: string;
  /** Char span [start, end) the result replaces — MODEL-CHOSEN (this is what
   *  kills blankReplace:auto). Defaults to the `_` position when omitted. */
  readonly replaceStart?: number;
  readonly replaceEnd?: number;
}

// ────────────────────────────────────────────────────────────────────
// Prompt
// ────────────────────────────────────────────────────────────────────

export const DISPATCH_SYSTEM = `You route a single underscore (_) in the user's text to the right handler.

The user typed text containing exactly one _. Decide what should replace it (and possibly some surrounding words). Output EXACTLY four labelled lines:
ROUTE: action | lookup | transform | none
BLANK: <blank name, for ROUTE=action; else empty>
ACTION: get | set | step   (for ROUTE=action; else empty)
ARG: <the argument — a city / ticker / set-value / step direction; or empty>
REPLACE: <start>-<end>     (0-based char span of the user's text to replace with the result; or just the _ position)

ROUTING RULES:
- ROUTE=action — the user wants a value or change a LISTED blank provides. Two flavours:
   • setting change ("volume 50 _", "brightness up _") → ACTION set/step, ARG the value/direction.
   • data query for a listed blank — TERSE ("weather oslo _", "nvda _") OR CONVERSATIONAL ("what's the weather like in oslo _", "how much is bitcoin _") → ACTION get, ARG the subject (oslo / NVDA / bitcoin).
  Pick the BLANK whose domain matches, and set REPLACE to where the value belongs:
   • terse command → replace the WHOLE command phrase ("weather oslo _" → 0-(len)).
   • conversational sentence → replace ONLY the _ (or the short trailing fragment) so the value reads inside the sentence and the user's words survive.
  Routing a conversational weather/stock/crypto question to ACTION is CORRECT — it fetches REAL live data the answer needs. Preserve the sentence with the REPLACE span, NOT by avoiding the action.
- ROUTE=lookup — a conversational question with NO listed blank for its domain (general knowledge: "the capital of France is _"). fluid-blank answers inline; REPLACE only the _.
- ROUTE=transform — the user wants surrounding text rewritten/generated ("make this formal _", "draft an email _").
- ROUTE=none — the text only MENTIONS a blank's keyword in passing, not as a request ("the weather was lovely today _", "i bought apple stock years ago _"), or nothing fits. Leave the _ alone.

KEY: distinguish a genuine REQUEST from descriptive prose. "what's the weather like in oslo _" is a request → ACTION get (keep the sentence via REPLACE). "the weather was lovely _" is prose → none.`;

/** Render the available-blanks catalog for the dispatch prompt. */
export function renderDispatchCatalog(blanks: ReadonlyArray<DispatchBlankSpec>): string {
  if (blanks.length === 0) return '';
  const lines = blanks.map(b =>
    `- ${b.name} [${b.actions.join('/')}${b.readOnly ? ', read-only data' : ', action'}] — ${b.description}`,
  ).join('\n');
  return `\n\nAVAILABLE BLANKS:\n${lines}`;
}

/** Build the full system prompt (static rules + the blank catalog). */
export function buildDispatchSystem(blanks: ReadonlyArray<DispatchBlankSpec>): string {
  return `${DISPATCH_SYSTEM}${renderDispatchCatalog(blanks)}`;
}

// ────────────────────────────────────────────────────────────────────
// Parser — total, validate-and-degrade (malformed → route:none)
// ────────────────────────────────────────────────────────────────────

const NONE: DispatchDecision = { route: 'none' };

function lineVal(text: string, label: string): string {
  // [ \t]* (NOT \s*) so an empty value doesn't swallow the next line.
  const m = text.match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'im'));
  return m ? m[1]!.trim() : '';
}

/**
 * Parse the classifier's labelled output into a DispatchDecision. Unknown /
 * malformed routes degrade to `none` (never throws). `bufferLen` clamps the
 * REPLACE span so a hallucinated range can't drive an out-of-bounds splice.
 */
export function parseDispatchDecision(output: string, bufferLen: number): DispatchDecision {
  const routeRaw = lineVal(output, 'ROUTE').toLowerCase();
  const route = (['action', 'lookup', 'transform', 'none'] as const).find(r => r === routeRaw);
  if (!route || route === 'none') return NONE;

  let replaceStart: number | undefined;
  let replaceEnd: number | undefined;
  const rep = lineVal(output, 'REPLACE').match(/(\d+)\s*-\s*(\d+)/);
  if (rep) {
    const s = Math.max(0, Math.min(bufferLen, parseInt(rep[1]!, 10)));
    const e = Math.max(s, Math.min(bufferLen, parseInt(rep[2]!, 10)));
    replaceStart = s;
    replaceEnd = e;
  }

  if (route === 'lookup' || route === 'transform') {
    return { route, replaceStart, replaceEnd };
  }

  // route === 'action' — needs a blank + action.
  const blank = lineVal(output, 'BLANK').toLowerCase() || undefined;
  const actionRaw = lineVal(output, 'ACTION').toLowerCase();
  const action = (['get', 'set', 'step'] as const).find(a => a === actionRaw);
  const arg = lineVal(output, 'ARG') || undefined;
  if (!blank || !action) return NONE; // an action with no blank/action is meaningless
  return { route: 'action', blank, action, arg, replaceStart, replaceEnd };
}

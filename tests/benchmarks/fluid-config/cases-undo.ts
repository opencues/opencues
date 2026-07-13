/**
 * ACTION (undo/redo) cases for the config-intent classifier — the
 * fourth intent kind added July 2026. Run by prod.ts (which drives the
 * PRODUCTION SYSTEM_PROMPT from @opencues/core, unlike fused.ts's
 * settings-only bench prompt).
 *
 * Language invariance is the point of this suite: the trigger verb
 * must classify in any language, with counts normalized from digits
 * AND number-words. Cases marked [in-prompt] appear as few-shot
 * examples in the production prompt; the rest probe generalization.
 *
 * Negatives pin the boundary: undo/revert of something OUTSIDE the
 * buffer/runtime (git commits, deploys) and "redo X" = "do X over"
 * are task requests → NONE.
 */

export interface UndoActionCase {
  id: string;
  category: 'hit-action' | 'reject-action';
  input: string;
  expected: {
    /** null = expect NONE (reject). */
    action: 'undo' | 'redo' | null;
    count?: number;
  };
}

export const UNDO_CASES: UndoActionCase[] = [
  // ── Positives — English ─────────────────────────────────────────
  { id: 'ua-bare',        category: 'hit-action', input: 'undo _',                          expected: { action: 'undo', count: 1 } },            // [in-prompt]
  { id: 'ua-that',        category: 'hit-action', input: 'undo that _',                     expected: { action: 'undo', count: 1 } },
  { id: 'ua-count-3',     category: 'hit-action', input: 'undo 3 _',                        expected: { action: 'undo', count: 3 } },            // [in-prompt]
  { id: 'ua-count-words', category: 'hit-action', input: 'undo the last two changes _',     expected: { action: 'undo', count: 2 } },            // [in-prompt]
  { id: 'ua-revert',      category: 'hit-action', input: 'revert that last change _',       expected: { action: 'undo', count: 1 } },
  { id: 'ua-redo',        category: 'hit-action', input: 'redo _',                          expected: { action: 'redo', count: 1 } },            // [in-prompt]
  { id: 'ua-redo-that',   category: 'hit-action', input: 'redo that _',                     expected: { action: 'redo', count: 1 } },

  // ── Positives — language invariance ─────────────────────────────
  { id: 'ua-ja',          category: 'hit-action', input: '元に戻して _',                      expected: { action: 'undo', count: 1 } },            // [in-prompt]
  { id: 'ua-ja-count',    category: 'hit-action', input: '3回元に戻して _',                   expected: { action: 'undo', count: 3 } },
  { id: 'ua-es',          category: 'hit-action', input: 'deshacer _',                      expected: { action: 'undo', count: 1 } },            // [in-prompt]
  { id: 'ua-de',          category: 'hit-action', input: 'rückgängig machen _',             expected: { action: 'undo', count: 1 } },
  { id: 'ua-zh',          category: 'hit-action', input: '撤销 _',                           expected: { action: 'undo', count: 1 } },
  { id: 'ua-fr',          category: 'hit-action', input: 'annuler ça _',                    expected: { action: 'undo', count: 1 } },
  { id: 'ua-ru',          category: 'hit-action', input: 'отменить _',                      expected: { action: 'undo', count: 1 } },
  { id: 'ua-fr-count',    category: 'hit-action', input: 'annuler les trois derniers _',    expected: { action: 'undo', count: 3 } },

  // ── Negatives — outside-the-buffer targets are task requests ────
  { id: 'ur-commit',      category: 'reject-action', input: 'undo my last commit _',        expected: { action: null } },                        // [in-prompt]
  { id: 'ur-deploy',      category: 'reject-action', input: 'revert the deploy _',          expected: { action: null } },
  { id: 'ur-migration',   category: 'reject-action', input: 'undo the migration _',         expected: { action: null } },
  { id: 'ur-redo-report', category: 'reject-action', input: 'redo the report _',            expected: { action: null } },                        // [in-prompt]
  { id: 'ur-redo-hw',     category: 'reject-action', input: 'redo my homework _',           expected: { action: null } },
  { id: 'ur-prose',       category: 'reject-action', input: 'the undo button in figma is broken _', expected: { action: null } },
];

/** Post-confirmation context — the buffer holds the visible pair/answer
 *  of the change being undone (the MOST COMMON live undo context; found
 *  via agentic scenario 109 misclassifying `debug-mode on undo _` as a
 *  SETTING re-apply). Appended after the v2.2 run; part of v2.3. */
export const UNDO_CONTEXT_CASES: UndoActionCase[] = [
  { id: 'ua-after-pair',      category: 'hit-action', input: 'debug-mode on undo _',           expected: { action: 'undo', count: 1 } },  // [in-prompt]
  { id: 'ua-after-pair-2',    category: 'hit-action', input: 'voice-mode inactive undo _',     expected: { action: 'undo', count: 1 } },
  { id: 'ua-after-pair-redo', category: 'hit-action', input: 'tips-mode off redo _',           expected: { action: 'redo', count: 1 } },
  { id: 'ua-after-answer',    category: 'hit-action', input: 'Paris undo _',                   expected: { action: 'undo', count: 1 } },
  { id: 'ua-after-pair-ja',   category: 'hit-action', input: 'voice-mode active 元に戻して _',   expected: { action: 'undo', count: 1 } },
];
UNDO_CASES.push(...UNDO_CONTEXT_CASES);

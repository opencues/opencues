/**
 * Built-in blanks whose multi-line get() output is ONE answer (a card
 * whose lines belong together), NOT a list of cycleable alternatives.
 *
 * This is the CODE-side twin of the "blankMultilineIsAnswer: true"
 * frontmatter flag (see blank-spec.md). Both exist for the same reason
 * (opencues #339: a multi-line card was truncated to line[0] by the
 * split-into-alternatives fill path), but they cover different populations:
 *
 * - The frontmatter flag lets a USER-authored script blank opt in.
 * - This set makes the four SHIPPED built-ins carry the property in code,
 *   so existing users get the fix from the runtime bundle alone — without
 *   needing seed-configs to re-inject the flag into a BLANK.md they already
 *   have (seed-configs is first-time-copy only and never overwrites an
 *   existing user file, so the flag would otherwise never reach an
 *   upgrading user).
 *
 * These are inherent-single-card built-ins: the location "map" card, the
 * claude-status block, and the "model" catalog. Their single matching set
 * lives here (a lightweight, dependency-free module) so blank-fill.ts can
 * consult it without importing the whole impl registry. Keep it in sync with
 * the built-ins registered in BUILTIN_BLANKS (./index.ts) and the
 * defaults/blanks/<name>/BLANK.md that also declare the frontmatter flag.
 *
 * NOT included: `note`. Its recall modes (`note recall X _`, bare `note _`
 * browsing recent entries) return MULTIPLE matches that the user cycles
 * through with Ctrl+Alt+Up — a genuine list, like `hackernews`. Joining its
 * lines would collapse every match into one blob and break recall cycling
 * (regressed note-blank.scenarios.test.ts before this was pulled back out).
 */
export const SINGLE_ANSWER_BUILTIN_BLANKS: ReadonlySet<string> = new Set([
  'location',
  'claude-status',
  'model',
]);

/**
 * True when a blank's multi-line output should be committed as one joined
 * answer rather than split into cycleable alternatives — either because it
 * declares the blankMultilineIsAnswer frontmatter flag, or because it is one
 * of the shipped single-card built-ins above.
 */
export function isSingleAnswerBlank(
  blankName: string | undefined,
  frontmatterFlag: boolean | undefined,
): boolean {
  if (frontmatterFlag === true) return true;
  return blankName !== undefined && SINGLE_ANSWER_BUILTIN_BLANKS.has(blankName);
}

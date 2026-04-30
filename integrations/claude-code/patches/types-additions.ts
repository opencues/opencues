/**
 * Types to add to src/types.ts
 *
 * Add these fields to the MiscSettings interface (or equivalent settings interface).
 * These are all optional fields with ? modifier.
 */

// ============================================================================
// ADD TO MiscSettings INTERFACE:
// ============================================================================

// --- OpenCues Runtime Selector ---
// v1 = legacy 22-seam patch (default). v2 = plug-and-play runtime (Phase 1+).
// See integrations/claude-code/reintegration/refactor.md.
opencuesRuntime?: 'v1' | 'v2';

// --- Cursor State Export ---
// Exports cursor position to a JSON file in real-time
enableCursorStateExport?: boolean;
cursorStateExportPath?: string;

// --- Word Highlight Navigation ---
// Ctrl+Alt+Arrow to navigate and highlight words/numbers
enableWordHighlight?: boolean;
highlightColor?: 'white' | 'cyan' | 'yellow' | 'inverse' | 'underline';
highlightIndexFromLeft?: boolean;
highlightWrap?: boolean;
highlightAutoScroll?: boolean;
highlightClearOnEscape?: boolean;
highlightClearOnNavigation?: boolean;
highlightWordPattern?: 'whitespace' | 'alphanum' | string;
highlightMode?: 'words' | 'numbers';  // 'words' = all navigable, 'numbers' = numeric only
highlightExportEnabled?: boolean;
highlightExportPath?: string;
numberDimming?: boolean;  // dim all numbers in input (dark gray)

// --- Dynamic Highlight (LLM-based word analysis) ---
// Type "submit" or use auto-submit to trigger LLM analysis
enableDynamicHighlight?: boolean;
dynamicHighlightScriptPath?: string;  // Path to LLM analysis script
dynamicHighlightAutoSubmit?: boolean;  // Auto-submit on new words (500ms debounce)
dynamicHighlightDebounceMs?: number;   // Debounce delay for auto-submit (default 500)

// --- Blank Overrides ---
// Words that trigger external scripts when filled / cycled
blankOverrides?: {
  [word: string]: {
    name: string;              // Blank identifier, used for default script path
    scriptPath?: string;       // Custom script path (optional, defaults to ~/.claude/actions/{name}.sh)
  };
};

// ============================================================================
// COMPLETE EXAMPLE (for reference):
// ============================================================================

/*
export interface MiscSettings {
  // ... existing fields ...
  showTweakccVersion: boolean;
  showPatchesApplied: boolean;
  expandThinkingBlocks: boolean;
  enableConversationTitle: boolean;
  hideStartupBanner: boolean;
  hideCtrlGToEdit: boolean;
  hideStartupClawd: boolean;
  increaseFileReadLimit: boolean;
  suppressLineNumbers: boolean;
  suppressRateLimitOptions: boolean;

  // --- ADD THESE FIELDS ---
  enableCursorStateExport?: boolean;
  cursorStateExportPath?: string;
  enableWordHighlight?: boolean;
  highlightColor?: 'white' | 'cyan' | 'yellow' | 'inverse' | 'underline';
  highlightIndexFromLeft?: boolean;
  highlightWrap?: boolean;
  highlightAutoScroll?: boolean;
  highlightClearOnEscape?: boolean;
  highlightClearOnNavigation?: boolean;
  highlightWordPattern?: 'whitespace' | 'alphanum' | string;
  highlightMode?: 'words' | 'numbers';
  highlightExportEnabled?: boolean;
  highlightExportPath?: string;
  numberDimming?: boolean;
}
*/

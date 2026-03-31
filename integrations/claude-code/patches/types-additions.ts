/**
 * Types to add to src/types.ts
 *
 * Add these fields to the MiscSettings interface (or equivalent settings interface).
 * These are all optional fields with ? modifier.
 */

// ============================================================================
// ADD TO MiscSettings INTERFACE:
// ============================================================================

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
highlightMode?: 'words' | 'numbers' | 'gender' | 'both';  // 'words' = all, 'numbers' = numeric only, 'gender' = gender only, 'both' = numbers + gender
highlightExportEnabled?: boolean;
highlightExportPath?: string;
numberDimming?: boolean;  // dim all numbers in input (dark gray)

// --- Dynamic Highlight (LLM-based word analysis) ---
// Type "submit" or use auto-submit to trigger LLM analysis
enableDynamicHighlight?: boolean;
dynamicHighlightScriptPath?: string;  // Path to LLM analysis script
dynamicHighlightAutoSubmit?: boolean;  // Auto-submit on new words (500ms debounce)
dynamicHighlightDebounceMs?: number;   // Debounce delay for auto-submit (default 500)

// --- Action Word Overrides ---
// Words that trigger external scripts on Up/Down instead of normal behavior
actionWordOverrides?: {
  [word: string]: {
    action: string;           // Action identifier, used for default script path
    scriptPath?: string;      // Custom script path (optional, defaults to ~/.claude/actions/{action}.sh)
    upArgs?: string[];        // Arguments passed when Up is pressed
    downArgs?: string[];      // Arguments passed when Down is pressed
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
  highlightMode?: 'words' | 'numbers' | 'gender' | 'both';
  highlightExportEnabled?: boolean;
  highlightExportPath?: string;
  numberDimming?: boolean;
}
*/

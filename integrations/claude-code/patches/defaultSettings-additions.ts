/**
 * Default settings to add to src/defaultSettings.ts
 *
 * Add these fields inside the `misc:` object in DEFAULT_SETTINGS.
 */

// ============================================================================
// ADD TO misc: {} OBJECT:
// ============================================================================

// --- Cursor State Export ---
enableCursorStateExport: true,
cursorStateExportPath: '/tmp/claude-cursor-state.json',

// --- Word Highlight Navigation ---
enableWordHighlight: true,
highlightColor: 'white',
highlightIndexFromLeft: false,
highlightWrap: false,
highlightAutoScroll: true,
highlightClearOnEscape: true,
highlightClearOnNavigation: false,
highlightWordPattern: 'whitespace',
highlightMode: 'numbers',  // 'words' = all words, 'numbers' = only numeric tokens
highlightExportEnabled: true,
highlightExportPath: '/tmp/claude-highlight-state.json',
numberDimming: true,  // dim all numbers in input (dark gray)

// --- Dynamic Highlight (LLM-based word analysis) ---
enableDynamicHighlight: true,
dynamicHighlightScriptPath: '~/.claude/llm-analyze.sh',
dynamicHighlightAutoSubmit: true,   // Auto-submit mode (recommended)
dynamicHighlightDebounceMs: 500,    // Debounce delay for auto-submit

// --- Control Word Overrides ---
cueControlOverrides: {
  volume: {
    control: 'volume',
    upArgs: ['up', '5'],
    downArgs: ['down', '5'],
  },
},

// ============================================================================
// COMPLETE EXAMPLE (for reference):
// ============================================================================

/*
export const DEFAULT_SETTINGS: Settings = {
  // ... other settings ...

  misc: {
    showTweakccVersion: true,
    showPatchesApplied: true,
    expandThinkingBlocks: true,
    enableConversationTitle: true,
    hideStartupBanner: false,
    hideCtrlGToEdit: false,
    hideStartupClawd: false,
    increaseFileReadLimit: false,
    suppressLineNumbers: true,
    suppressRateLimitOptions: false,

    // --- ADD THESE FIELDS ---
    enableCursorStateExport: true,
    cursorStateExportPath: '/tmp/claude-cursor-state.json',
    enableWordHighlight: true,
    highlightColor: 'white',
    highlightIndexFromLeft: false,
    highlightWrap: false,
    highlightAutoScroll: true,
    highlightClearOnEscape: true,
    highlightClearOnNavigation: false,
    highlightWordPattern: 'whitespace',
    highlightMode: 'numbers',
    highlightExportEnabled: true,
    highlightExportPath: '/tmp/claude-highlight-state.json',
    numberDimming: true,
  },

  // ... other settings ...
};
*/

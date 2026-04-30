/**
 * Additions to src/patches/index.ts
 *
 * This file shows what to add to index.ts to integrate the custom patches.
 */

// ============================================================================
// STEP 1: ADD IMPORTS (at top of file, with other imports)
// ============================================================================

import { writeCursorStateExport } from './cursorStateExport';
import { writeWordHighlight } from './wordHighlight';
import { writeDynamicHighlight } from './dynamicHighlight';
import { writeOpenCuesRuntimeV2 } from './opencuesRuntime';

// ============================================================================
// STEP 2: ADD PATCH APPLICATION (inside applyCustomization function)
// ============================================================================

// Add this code BEFORE the final write (before the "Write the modified content back" section)
// It should go after all the other patch applications.
//
// The `content` variable holds the current file content.
// The `result` variable is used for null checking.
// The `config` parameter contains the user's settings.

/*

  // Branch on runtime version: v2 bypasses all v1 cues patches and injects a
  // single bootstrap at the KeyDispatcher seam. v1 (default) runs the legacy
  // 22-seam patch stack below. See refactor.md §10.
  const runtimeVersion = config.settings.misc?.opencuesRuntime ?? 'v2';
  if (runtimeVersion === 'v2') {
    if ((result = writeOpenCuesRuntimeV2(content))) content = result;
    else console.error('patch: opencues v2 bootstrap failed — see above.');
  } else {

  // Apply cursor state export patch (if enabled)
  if (config.settings.misc?.enableCursorStateExport) {
    const exportPath = config.settings.misc?.cursorStateExportPath || '/tmp/opencues-cursor-state.json';
    if ((result = writeCursorStateExport(content, exportPath))) content = result;
  }

  // Apply word highlight navigation patches (if enabled)
  // Ctrl+Alt+Left/Right to navigate and highlight words
  if (config.settings.misc?.enableWordHighlight) {
    const highlightConfig = {
      enableWordHighlight: config.settings.misc.enableWordHighlight,
      highlightColor: config.settings.misc.highlightColor,
      highlightIndexFromLeft: config.settings.misc.highlightIndexFromLeft,
      highlightWrap: config.settings.misc.highlightWrap,
      highlightAutoScroll: config.settings.misc.highlightAutoScroll,
      highlightClearOnEscape: config.settings.misc.highlightClearOnEscape,
      highlightClearOnNavigation: config.settings.misc.highlightClearOnNavigation,
      highlightWordPattern: config.settings.misc.highlightWordPattern,
      highlightMode: config.settings.misc.highlightMode,
      highlightExportEnabled: config.settings.misc.highlightExportEnabled,
      highlightExportPath: config.settings.misc.highlightExportPath,
      numberDimming: config.settings.misc.numberDimming,
      blankOverrides: config.settings.misc.blankOverrides,  // Blank words like "volume"
    };
    if ((result = writeWordHighlight(content, highlightConfig))) content = result;
  }

  // Apply dynamic highlight patches (if enabled)
  // Enables LLM-based word analysis with auto-submit on new words
  // Default to enabled if not explicitly set to false
  const enableDynamic = config.settings.misc?.enableDynamicHighlight !== false;
  if (enableDynamic && config.settings.misc?.enableWordHighlight) {
    const dynamicConfig = {
      enableDynamicHighlight: true,
      dynamicHighlightScriptPath: config.settings.misc?.dynamicHighlightScriptPath || '~/.claude/llm-analyze.sh',
      dynamicHighlightAutoSubmit: config.settings.misc?.dynamicHighlightAutoSubmit || false,
      dynamicHighlightDebounceMs: config.settings.misc?.dynamicHighlightDebounceMs || 500,
    };
    if ((result = writeDynamicHighlight(content, dynamicConfig))) content = result;
  }

  } // end v1 runtime branch

*/

// ============================================================================
// IMPORTANT NOTES:
// ============================================================================

// 1. Each patch returns null on failure, so we check before assigning:
//    if ((result = writeXxx(content))) content = result;
//
// 2. The config paths should match your settings structure:
//    config.settings.misc?.enableCursorStateExport
//    Adjust if your settings structure is different.
//
// 3. For word highlight, we pass a config object with all the options
//    rather than individual parameters.

/**
 * Word Highlight Navigation Patch
 * ================================
 *
 * Adds Ctrl+Alt+Left/Right keyboard shortcuts to navigate between words in Claude
 * Code's input box and highlight the selected word in white.
 *
 * ## Feature Overview
 *
 * - **Ctrl+Alt+Left**: Move highlight to the left (index++)
 * - **Ctrl+Alt+Right**: Move highlight to the right (index--)
 * - **Ctrl+Alt+Up**: Increment highlighted number by 1
 * - **Ctrl+Alt+Down**: Decrement highlighted number (stops at original value)
 * - **Escape**: Clear highlight
 * - **Typing**: Clear highlight (any text change)
 *
 * Words are indexed right-to-left: rightmost word = index 0.
 *
 * ## The Invisible Character Solution (CRITICAL)
 * =============================================
 *
 * ### The Problem
 *
 * When the user presses Ctrl+Alt+Arrow to navigate highlights, we need to:
 * 1. Update the highlight state (globalThis._hlState)
 * 2. Trigger a visual refresh so the new highlight appears
 *
 * The challenge is that Claude Code's input system uses React with optimizations
 * that prevent unnecessary re-renders. Simply updating state isn't enough.
 *
 * ### How Claude Code's Input Refresh Works
 *
 * The input handler function `BA()` processes keystrokes like this:
 *
 * ```javascript
 * function BA(AA, wA) {
 *   let zA = VA(wA)(KA);  // Call key handler, get new InputZone
 *
 *   if (zA) {
 *     if (!R.equals(zA)) {                    // <-- EQUALITY CHECK
 *       if (R.text !== zA.text) K(zA.text);  // onChange callback
 *       k(zA.offset);                         // onOffsetChange callback
 *     }
 *   }
 * }
 * ```
 *
 * Key insight: The `K()` callback (onChange) is ONLY called when text changes.
 * The `k()` callback (onOffsetChange) is called when offset changes.
 *
 * The `InputZone.equals()` method compares:
 * ```javascript
 * equals(A) { return this.offset === A.offset && this.measuredText === A.measuredText }
 * ```
 *
 * ### Why Previous Approaches Failed
 *
 * 1. **Returning unchanged R**: `R.equals(R)` is TRUE → no callbacks → no refresh
 *
 * 2. **Calling k(offset) directly**: Only onOffsetChange fires. React sees only
 *    offset changed and deprioritizes/batches the re-render. Result: ~500ms lag.
 *
 * 3. **Calling K(text) + k(offset)**: We tried this but K and k are NOT directly
 *    accessible from inside the key handler. They're in the outer closure but
 *    the key handler returns a function that executes later.
 *
 * 4. **insert(" ").backspace()**: After inserting and deleting, text is unchanged,
 *    so `R.text !== zA.text` is FALSE and K() isn't called.
 *
 * 5. **Toggling offset**: Even if equals() returns FALSE, K() still isn't called
 *    because text hasn't changed.
 *
 * ### The Solution: Strip R, Check PARENT, Insert OPPOSITE
 *
 * We use TWO invisible Unicode characters and toggle based on what PARENT has:
 * - `\u200B` (zero-width space)
 * - `\u200C` (zero-width non-joiner)
 *
 * The key insight: Strip invisible chars from R (so it's clean for processing),
 * but check what the PARENT value has and insert the OPPOSITE.
 *
 * ```javascript
 * // At start of input handler (before key processing):
 * globalThis._parentValue = A;  // Store parent value
 * R = stripInvisibleChars(R);   // Clean R for processing
 *
 * // In key handler (APPEND at END, not insert at cursor!):
 * var parentHasB = globalThis._parentValue.indexOf("\u200B") >= 0;
 * var parentHasC = globalThis._parentValue.indexOf("\u200C") >= 0;
 * if (parentHasB) return i5.fromText(R.text + "\u200C", G, R.offset);
 * else if (parentHasC) return i5.fromText(R.text + "\u200B", G, R.offset);
 * else return i5.fromText(R.text + "\u200B", G, R.offset);
 * ```
 *
 * This works because:
 *
 * 1. **R is always clean**: No invisible chars persist, no cursor issues
 * 2. **Each navigation produces DIFFERENT value**: We insert OPPOSITE of parent
 * 3. **K() is always called**: New value differs from parent state
 * 4. **User typing stays clean**: R is stripped, so typed text has no invisible chars
 *
 * Flow for navigation:
 * - Parent has "hello\u200B", R stripped to "hello"
 * - Check parent → has B → append C at end → return "hello\u200C"
 * - K("hello\u200C") called, differs from parent → instant refresh ✓
 * - Note: Append at END preserves cursor position (avoids "cursor wall" bug)
 *
 * Flow for user typing:
 * - Parent has "hello\u200B", R stripped to "hello"
 * - User types "x" → R becomes "hellox"
 * - K("hellox") called, differs from parent → refresh ✓
 * - Parent now has clean "hellox"
 *
 * @see references/word-highlight.md for feature reference
 *
 * ### Handling Clear-on-Typing
 *
 * Since we're inserting a character, the clear-on-typing logic would normally
 * clear the highlight. We filter out BOTH invisible characters when comparing:
 *
 * ```javascript
 * var _cleanNew = newText.replace(/[\u200B\u200C]/g, "");
 * var _cleanOld = oldText.replace(/[\u200B\u200C]/g, "");
 * if (_cleanNew !== _cleanOld) {
 *   // Real user typing - clear highlight
 * }
 * ```
 *
 * This way:
 * - Our navigation inserts → doesn't clear highlight
 * - User types anything → clears highlight
 *
 * ### Performance
 *
 * The toggle approach provides **instant** visual updates, matching the speed
 * of normal typing. There's no perceptible lag because we're using the exact
 * same code path that regular typing uses, and each navigation is guaranteed
 * to produce a different state value.
 *
 * ## Implementation Notes
 *
 * - See ./index.ts for how patches are applied
 * - State is stored in globalThis._hlState and globalThis._hlText
 * - Visual rendering wraps the renderedValue output with ANSI-aware processing
 * - Word highlighting is applied after rainbow input (if enabled)
 *
 * @see docs/systems-diagram.md for architecture overview
 */

// Please see the note about writing patches in ./index

import { LocationResult, showDiff, getRequireFuncName, escapeIdent } from './index';

/**
 * Find the key action dispatcher function.
 *
 * This function handles key events with a switch statement.
 * Pattern: function XXX(YY){switch(!0){case YY.escape:
 */
const findKeyDispatcherLocation = (oldFile: string): LocationResult | null => {
  // Find the function with switch(!0) for key handling
  // Note: Don't escape ! - it's not a special regex character
  const funcPattern = /\bfunction ([$\w]+)\(([$\w]+)\)\{switch\(!0\)\{case \2\.escape:/;
  const match = oldFile.match(funcPattern);

  if (!match || match.index === undefined) {
    console.error('patch: wordHighlight: failed to find key dispatcher function');
    return null;
  }

  // Find the position right after "switch(!0){"
  const switchStartPos = oldFile.indexOf('switch(!0){', match.index);
  if (switchStartPos === -1) {
    console.error('patch: wordHighlight: failed to find switch statement');
    return null;
  }

  return {
    startIndex: switchStartPos + 'switch(!0){'.length,
    endIndex: switchStartPos + 'switch(!0){'.length,
    identifiers: [
      match[1], // function name (VA)
      match[2], // key param name (AA)
    ],
  };
};

/**
 * Find the input state handler function to inject clear-on-typing logic.
 *
 * Same pattern as cursorStateExport.
 */
const findInputStateHandlerLocation = (oldFile: string): LocationResult | null => {
  // Extended pattern to also capture G (config variable) from fromText(A,G,T)
  const funcPattern =
    /function ([$\w]+)\(\{value:([$\w]+),onChange:([$\w]+),[^}]+externalOffset:([$\w]+),onOffsetChange:([$\w]+)[^}]+\}\)\{[^}]*let ([$\w]+)=\4,([$\w]+)=\5,([$\w]+)=([$\w]+)\.fromText\(\2,([$\w]+),\6\)/;

  const match = oldFile.match(funcPattern);

  if (!match || match.index === undefined) {
    console.error('patch: wordHighlight: failed to find input state handler function pattern');
    return null;
  }

  // Find the return statement in the function
  const funcStart = match.index;
  // Increased from 10000 to 30000 because the key handler and raw sequence patches
  // inject code into VA (which is inside NV1), pushing the return statement further away
  const searchSection = oldFile.slice(funcStart, funcStart + 30000);

  const returnPattern = /return\{onInput:([$\w]+),renderedValue:/;
  const returnMatch = searchSection.match(returnPattern);

  if (!returnMatch || returnMatch.index === undefined) {
    console.error('patch: wordHighlight: failed to find return statement in input handler');
    return null;
  }

  return {
    startIndex: funcStart + returnMatch.index,
    endIndex: funcStart + returnMatch.index,
    identifiers: [
      match[1],   // function name (NV1 or f31)
      match[2],   // value param name (A)
      match[3],   // onChange param name (K)
      match[4],   // externalOffset param name (j)
      match[5],   // onOffsetChange param name (M)
      match[6],   // T variable (assigned from externalOffset)
      match[7],   // k variable (assigned from onOffsetChange)
      match[8],   // R variable (InputZone instance)
      match[9],   // InputZone class name (i5)
      match[10],  // G variable (InputZone config)
      returnMatch[1], // onInput function name (BA)
    ],
  };
};

/**
 * Find the chalk variable used in Claude Code.
 */
const findChalkVar = (oldFile: string): string | null => {
  const methodPattern = /\b([$\w]+)\.(bold|dim|inverse)\(/g;
  const counts = new Map<string, number>();

  let match;
  while ((match = methodPattern.exec(oldFile)) !== null) {
    const varName = match[1];
    counts.set(varName, (counts.get(varName) || 0) + 1);
  }

  let maxCount = 0;
  let chalkVar: string | null = null;

  for (const [varName, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      chalkVar = varName;
    }
  }

  return chalkVar;
};

/**
 * Find the renderedValue location.
 * This needs to work both before and after rainbow input has wrapped the value.
 *
 * Pattern 1 (original): renderedValue:R.render(...)
 * Pattern 2 (after rainbow): renderedValue:(function(){...var _rv=R.render(...)...})()
 *
 * We extract the original render call to pass through, or the wrapped IIFE.
 */
const findRenderedValueLocation = (oldFile: string): LocationResult | null => {
  // First, check if rainbow input has already wrapped this
  // Pattern: renderedValue:(function(){...})()
  const wrappedPattern = /renderedValue:\(function\(\)\{/;
  const wrappedMatch = oldFile.match(wrappedPattern);

  if (wrappedMatch && wrappedMatch.index !== undefined) {
    // Rainbow has already wrapped - we need to find the entire IIFE
    // IIFE structure: (function(){...})()
    // Need to find the closing })() - not just the first )
    const startIdx = wrappedMatch.index + 'renderedValue:'.length;
    let depth = 0;
    let endIdx = startIdx;

    for (let i = startIdx; i < oldFile.length; i++) {
      if (oldFile[i] === '(') depth++;
      if (oldFile[i] === ')') {
        depth--;
        if (depth === 0) {
          // Found the closing ) of (function(){...})
          // Now check if there's () immediately after to invoke it
          endIdx = i + 1;
          if (oldFile[i + 1] === '(' && oldFile[i + 2] === ')') {
            endIdx = i + 3; // Include the ()
          }
          break;
        }
      }
    }

    // The wrapped IIFE is from startIdx to endIdx
    const wrappedCode = oldFile.slice(startIdx, endIdx);

    return {
      startIndex: wrappedMatch.index,
      endIndex: wrappedMatch.index + 'renderedValue:'.length + wrappedCode.length,
      identifiers: [wrappedCode], // Store the entire wrapped code
    };
  }

  // Try 4-parameter pattern first (v2.1.x)
  const pattern4 = /renderedValue:([$\w]+)\.render\(([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)/;
  let match = oldFile.match(pattern4);

  if (match && match.index !== undefined) {
    return {
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      identifiers: [
        match[1], // InputZone variable (R)
        match[2], // param1 (_)
        match[3], // param2 (O)
        match[4], // param3 (Z)
        match[5], // param4 (s)
      ],
    };
  }

  // Try 3-parameter pattern (v2.0.x)
  const pattern3 = /renderedValue:([$\w]+)\.render\(([$\w]+),([$\w]+),([$\w]+)\)/;
  match = oldFile.match(pattern3);

  if (match && match.index !== undefined) {
    return {
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      identifiers: [
        match[1], // InputZone variable (L)
        match[2], // cursorChar (K)
        match[3], // mask (X)
        match[4], // invert function (V)
      ],
    };
  }

  console.error('patch: wordHighlight: failed to find renderedValue pattern');
  return null;
};

export interface WordHighlightConfig {
  enableWordHighlight?: boolean;
  highlightColor?: 'white' | 'cyan' | 'yellow' | 'inverse' | 'underline';
  highlightOverridesRainbow?: boolean;
  highlightIndexFromLeft?: boolean;
  highlightWrap?: boolean;
  highlightAutoScroll?: boolean;
  highlightClearOnEscape?: boolean;
  highlightClearOnNavigation?: boolean;
  highlightWordPattern?: 'whitespace' | 'alphanum' | string;
  highlightMode?: string;  // deprecated — always navigates all words with alts
  highlightExportEnabled?: boolean;
  highlightExportPath?: string;
  numberDimming?: boolean;  // dim all numbers in input (dark gray)
  cueControlOverrides?: Record<string, { control: string; upArgs?: string[]; downArgs?: string[]; scriptPath?: string }>;
}

const DEFAULT_CONFIG: Required<WordHighlightConfig> = {
  enableWordHighlight: true,
  highlightColor: 'white',
  highlightOverridesRainbow: true,
  highlightIndexFromLeft: false,
  highlightWrap: false,
  highlightAutoScroll: true,
  highlightClearOnEscape: true,
  highlightClearOnNavigation: false,
  highlightWordPattern: 'whitespace',
  highlightMode: 'words',  // deprecated — always navigates all words with alts
  highlightExportEnabled: true,
  highlightExportPath: '/tmp/claude-highlight-state.json',
  numberDimming: true,  // dim all numbers in input (dark gray)
  cueControlOverrides: {},
};

/**
 * Write word highlight key handler patch.
 *
 * Injects Ctrl+Alt+Left/Right key handling into the key dispatcher.
 */
export const writeWordHighlightKeyHandler = (
  oldFile: string,
  config: WordHighlightConfig = {}
): string | null => {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const location = findKeyDispatcherLocation(oldFile);
  if (!location) {
    return null;
  }

  const keyParam = location.identifiers![1];
  const requireFuncName = getRequireFuncName(oldFile);

  // Find InputZone class name and config variable for fromText calls
  // Needed to append invisible char at END of text (not at cursor position)
  const fromTextPattern = /([$\w]+)=([$\w]+)\.fromText\(([$\w]+),([$\w]+),([$\w]+)\)/;
  const fromTextMatch = oldFile.match(fromTextPattern);
  if (!fromTextMatch) {
    console.error('patch: wordHighlight: failed to find InputZone.fromText pattern for key handler');
    return null;
  }
  const inputZoneVar = fromTextMatch[1];    // h (the InputZone instance)
  const inputZoneClass = fromTextMatch[2]; // i5
  const configVar = fromTextMatch[4];       // G

  // Build navigation logic based on config
  const indexExpr = cfg.highlightIndexFromLeft
    ? '_hlW[globalThis._hlState.index]'
    : '_hlW[_hlW.length-1-globalThis._hlState.index]';

  const maxCheck = cfg.highlightWrap
    ? 'globalThis._hlState.index=(globalThis._hlState.index+1)%_hlW.length'
    : 'if(globalThis._hlState.index<_hlW.length-1)globalThis._hlState.index++';

  const minCheck = cfg.highlightWrap
    ? 'globalThis._hlState.index=(globalThis._hlState.index-1+_hlW.length)%_hlW.length'
    : 'if(globalThis._hlState.index>0)globalThis._hlState.index--';

  // Create the key handler cases for Ctrl+Alt+Left and Ctrl+Alt+Right
  // Check multiple ways Alt can be indicated: meta, option, alt
  //
  // Toggle between two invisible characters to force React re-render:
  // - \u200B (zero-width space)
  // - \u200C (zero-width non-joiner)
  //
  // IMPORTANT: Append at END of text, not at cursor position!
  // Using R.insert() would insert at cursor, causing "cursor wall" bug.
  // Using fromText(R.text + char, G, R.offset) appends at end, preserving cursor.
  //
  // Navigation filter: numbers + control words are always navigable
  // Words with dynamic alts are added by dynamicHighlight.ts patch later
  const filterCode = `var _targetIdx=[];
_allW.forEach(function(w,i){if(globalThis._isCueControl&&globalThis._isCueControl(w))_targetIdx.push(i);});`;

  // Left/Right handlers: navigate between cue-control and step-pattern targets
  // Don't reset when navigating - the map persists so we remember originals across navigation
  const keyHandlerCode = `case(${keyParam}.leftArrow&&${keyParam}.ctrl&&(${keyParam}.meta||${keyParam}.option||${keyParam}.alt)):return()=>{
if(!globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:""};

var _allW=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
${filterCode}
if(!_targetIdx.length)return ${inputZoneVar};
if(!globalThis._hlState.active){
globalThis._hlState.active=true;globalThis._hlState.index=0;globalThis._hlState.wordIndex=_targetIdx[_targetIdx.length-1];globalThis._hlState.text=globalThis._hlText;
}else{
if(globalThis._hlState.index<_targetIdx.length-1){
globalThis._hlState.index++;
globalThis._hlState.wordIndex=_targetIdx[_targetIdx.length-1-globalThis._hlState.index];
}
}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _pv=globalThis._parentValue||"";
var _parentHasB=_pv.indexOf("\\u200B")>=0;
var _parentHasC=_pv.indexOf("\\u200C")>=0;
if(_parentHasB){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200C",${configVar},${inputZoneVar}.offset);}
else if(_parentHasC){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
else{return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
};
case(${keyParam}.rightArrow&&${keyParam}.ctrl&&(${keyParam}.meta||${keyParam}.option||${keyParam}.alt)):return()=>{
if(!globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:""};

var _allW=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
${filterCode}
if(!_targetIdx.length)return ${inputZoneVar};
if(!globalThis._hlState.active){
globalThis._hlState.active=true;globalThis._hlState.index=0;globalThis._hlState.wordIndex=_targetIdx[_targetIdx.length-1];globalThis._hlState.text=globalThis._hlText;
}else{
if(globalThis._hlState.index>0){
globalThis._hlState.index--;
globalThis._hlState.wordIndex=_targetIdx[_targetIdx.length-1-globalThis._hlState.index];
}else{
globalThis._hlState={active:false,index:null,wordIndex:null,text:""};
}
}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _pv=globalThis._parentValue||"";
var _parentHasB=_pv.indexOf("\\u200B")>=0;
var _parentHasC=_pv.indexOf("\\u200C")>=0;
if(_parentHasB){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200C",${configVar},${inputZoneVar}.offset);}
else if(_parentHasC){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
else{return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
};
case(${keyParam}.upArrow&&${keyParam}.ctrl&&(${keyParam}.meta||${keyParam}.option||${keyParam}.alt)):return()=>{
var _r=globalThis._cycleAlt&&globalThis._cycleAlt(1,null,null,null,${requireFuncName});
if(_r&&_r.refresh){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
if(_r&&_r.text){var _off=_r.wStart<${inputZoneVar}.offset?${inputZoneVar}.offset+_r.lenDiff:${inputZoneVar}.offset;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}
return ${inputZoneVar};
};
case(${keyParam}.downArrow&&${keyParam}.ctrl&&(${keyParam}.meta||${keyParam}.option||${keyParam}.alt)):return()=>{
var _r=globalThis._cycleAlt&&globalThis._cycleAlt(-1,null,null,null,${requireFuncName});
if(_r&&_r.refresh){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
if(_r&&_r.text){var _off=_r.wStart<${inputZoneVar}.offset?${inputZoneVar}.offset+_r.lenDiff:${inputZoneVar}.offset;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}
return ${inputZoneVar};
};
`;

  const newFile =
    oldFile.slice(0, location.startIndex) +
    keyHandlerCode +
    oldFile.slice(location.endIndex);

  showDiff(
    oldFile,
    newFile,
    keyHandlerCode,
    location.startIndex,
    location.endIndex
  );

  return newFile;
};

/**
 * Write word highlight clear-on-typing patch.
 *
 * Injects code to clear highlight state when text changes.
 */
export const writeWordHighlightClearOnTyping = (
  oldFile: string,
  config: WordHighlightConfig = {}
): string | null => {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const location = findInputStateHandlerLocation(oldFile);
  if (!location) {
    return null;
  }

  const valueParam = location.identifiers![1];    // A (value)
  const onChangeParam = location.identifiers![2]; // K (onChange)
  const inputZoneVar = location.identifiers![7];  // R
  const inputZoneClass = location.identifiers![8]; // i5
  const configVar = location.identifiers![9];     // G
  const requireFuncName = getRequireFuncName(oldFile);

  // Export highlight state to JSON file for status line consumption
  // Using writeFileSync so the file is ready before status line runs
  // Path includes process.pid to avoid interference between multiple Claude Code instances
  // Export uses wordIndex directly (stored by key handlers for numbers-only mode)
  const exportCode = cfg.highlightExportEnabled ? `
var _hlWords=_hlText.split(/\\s+/).filter(function(w){return w});
var _hlExport={active:globalThis._hlState?globalThis._hlState.active:false,highlightedWordIndex:null,highlightedWord:null,wordCount:_hlWords.length,originalNumber:null,cueTip:null,altCueTips:null,alts:null,timestamp:Date.now()};
if(globalThis._hlState&&globalThis._hlState.active&&globalThis._hlState.wordIndex!=null){
var _idx=globalThis._hlState.wordIndex;
_hlExport.highlightedWordIndex=_idx;
_hlExport.highlightedWord=_hlWords[_idx]||null;
var _isCA=globalThis._isCueControl&&globalThis._isCueControl(_hlWords[_idx]||"");
_hlExport._debug={word:_hlWords[_idx],isCA:!!_isCA,cueControlTip:globalThis._cueControlTip||null,overrides:Object.keys(globalThis._cueControlOverrides||{}),cueValues:globalThis._cueControlValues||null};
var _cbDw=globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.find(function(d){return d.index===_idx&&d.metadata&&d.metadata.controlName;});
if(_cbDw){
// Control-bound blank: only show in status if blankTip is set
if(_cbDw.cueTip){_hlExport.cueControl=true;_hlExport.cueTip=_cbDw.cueTip;if(_cbDw.metadata&&_cbDw.metadata.listControl)_hlExport.listControl=true;}
}else if(_isCA){_hlExport.cueControl=true;_hlExport.alts=[_hlWords[_idx]];_hlExport.currentAltIndex=0;
var _caWord=(_hlWords[_idx]||"").toLowerCase();var _caOvr=(globalThis._cueControlOverrides||{})[_caWord];
var _caTip=_caOvr?_caOvr.tip||_caOvr.control:_caWord;
_hlExport.cueTip=_caTip;
}
if(globalThis._dynDefs&&globalThis._dynDefs.words&&!_isCA&&!_cbDw){
var _dw=globalThis._dynDefs.words.find(function(d){return d.index===_idx;});
if(_dw){_hlExport.cueTip=_dw.cueTip||null;_hlExport.altCueTips=_dw.altCueTips||null;_hlExport.alts=_dw.alts||null;_hlExport.currentAltIndex=typeof _dw.currentAltIndex==="number"?_dw.currentAltIndex:0;}
}
}
var _hlExportPath="/tmp/claude-highlight-state-"+process.pid+".json";
try{${requireFuncName}("fs").writeFileSync(_hlExportPath,JSON.stringify(_hlExport));}catch(_e){}
// TTS: speak tip on navigation, cancel on deselect or word change
// Check both _dynDefs (tips/LLM) and _cueControlOverrides (controls) for speak flag
var _ttsShouldSpeak=false;
if(_hlExport.cueTip){
var _ttsWord=globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.find(function(d){return d.index===_idx;});
if(_ttsWord&&_ttsWord.speak){_ttsShouldSpeak=true;}
else if(_hlExport.cueControl){var _ttsCtrl=(globalThis._cueControlOverrides||{})[(_hlExport.highlightedWord||"").toLowerCase()];if(_ttsCtrl&&_ttsCtrl.speak)_ttsShouldSpeak=true;}
}
var _ttsKey=_ttsShouldSpeak?(_idx+":"+_hlExport.cueTip):null;
if(_ttsKey!==globalThis._ttsLastKey){
globalThis._ttsLastKey=_ttsKey;
if(globalThis._ttsTimer){clearTimeout(globalThis._ttsTimer);globalThis._ttsTimer=null;}
if(globalThis._ttsPid){try{process.kill(globalThis._ttsPid);}catch(_ke){}globalThis._ttsPid=null;}
if(_ttsShouldSpeak){
globalThis._ttsTimer=setTimeout(function(){
var _ttsHome=process.env.HOME||"/home/"+(process.env.USER||"root");
var _cp=${requireFuncName}("child_process");
var _exePath=_ttsHome+"/.claude/actions/SpeakCtl.exe";
try{if(${requireFuncName}("fs").existsSync(_exePath)){var _p=_cp.spawn(_exePath,[_hlExport.cueTip,String(globalThis._ttsRate||2)],{detached:true,stdio:"ignore"});globalThis._ttsPid=_p.pid;_p.unref();}
else{var _ttsScript=globalThis._ttsScript||(_ttsHome+"/.claude/actions/speak.sh");var _p2=_cp.spawn("bash",[_ttsScript,_hlExport.cueTip,String(globalThis._ttsRate||2)],{detached:true,stdio:"ignore"});globalThis._ttsPid=_p2.pid;_p2.unref();}}catch(_te){}
},80);
}}
` : '';

  // Full code consists of three parts:
  //
  // 1. Store parent value in globalThis (OUTSIDE IIFE)
  //    - Key handler (VA) doesn't have access to valueParam (A)
  //    - We store it so key handler can check what char parent has
  //
  // 2. Strip invisible chars from R (OUTSIDE IIFE)
  //    - Must be outside IIFE because we need to reassign R (let-bound in outer scope)
  //    - This ensures R is clean for all input processing
  //    - Cursor position adjusted to account for removed chars
  //
  // 3. Clear-on-typing detection (IIFE for variable isolation)
  //    - Compare text WITHOUT invisible chars to detect real user typing
  //    - If real typing detected, clear highlight state
  // Serialize control word overrides to inject into cli.js
  const controlOvrJson = JSON.stringify(cfg.cueControlOverrides || {});

  const fullCode = `
globalThis._parentValue=${valueParam};
if(!globalThis._cueControlOverrides){globalThis._cueControlOverrides=${controlOvrJson};globalThis._staticCueControlOverrides=${controlOvrJson};}
globalThis._forceInputRefresh=function(){
if(globalThis._refreshTimer)return;
globalThis._refreshTimer=setTimeout(function(){
globalThis._refreshTimer=null;
var _t=globalThis._hlText||"";
var _pv=globalThis._parentValue||"";
var _hasB=_pv.indexOf("\\u200B")>=0;
var _tc=_hasB?"\\u200C":"\\u200B";
${onChangeParam}(_t+_tc);
},16);
};
if(globalThis._pendingCursorOffset!=null){var _pcClean=${inputZoneVar}.text.replace(/[\\u200B\\u200C]/g,"");if(_pcClean!==(globalThis._pendingCursorText||"")){globalThis._pendingCursorOffset=null;globalThis._pendingCursorText=null;}else{${inputZoneVar}=${inputZoneClass}.fromText(${inputZoneVar}.text,${configVar},globalThis._pendingCursorOffset);}}
if(${inputZoneVar}.text.indexOf("\\u200B")>=0||${inputZoneVar}.text.indexOf("\\u200C")>=0){
var _zwsClean=${inputZoneVar}.text.replace(/[\\u200B\\u200C]/g,"");
var _beforeC=${inputZoneVar}.text.slice(0,${inputZoneVar}.offset);
var _zwsCount=(_beforeC.match(/[\\u200B\\u200C]/g)||[]).length;
${inputZoneVar}=${inputZoneClass}.fromText(_zwsClean,${configVar},${inputZoneVar}.offset-_zwsCount);
}
(function(){
var _hlText=${valueParam}.replace(/[\\u200B\\u200C]/g,"");
var _oldText=(globalThis._hlText||"").replace(/[\\u200B\\u200C]/g,"");
globalThis._hlText=_hlText;
// Auto-populate: replace _ with control value when pending
if(globalThis._pendingAutoPopulate){
var _ap=globalThis._pendingAutoPopulate;
var _apWords=_hlText.split(/\\s+/).filter(function(w){return w;});
if(_ap.index<_apWords.length&&_apWords[_ap.index]==="_"){
globalThis._pendingAutoPopulate=null;
var _apPos=0;
for(var _apj=0;_apj<_ap.index;_apj++){_apPos=_hlText.indexOf(_apWords[_apj],_apPos)+_apWords[_apj].length;}
var _apStart=_hlText.indexOf("_",_apPos);
if(_apStart>=0){
var _apNew=_hlText.slice(0,_apStart)+_ap.value+_hlText.slice(_apStart+1);
globalThis._hlText=_apNew;
globalThis._dynLastAnalyzed=_apNew.split(/\\s+/).filter(function(w){return w;});
globalThis._dynPrevWords=globalThis._dynLastAnalyzed.slice();
var _apWc=_ap.value.split(/\\s+/).length;
if(_apWc>1&&globalThis._dynDefs&&globalThis._dynDefs.words){
var _apDef=globalThis._dynDefs.words.find(function(d){return d.index===_ap.index;});
if(_apDef){_apDef.spanLength=_apWc;_apDef.word=_ap.value;
if(!globalThis._dynSpans)globalThis._dynSpans={};
for(var _asi=0;_asi<_apWc;_asi++){globalThis._dynSpans[_ap.index+_asi]={originalIndex:_ap.index,spanLength:_apWc};}
}}
globalThis._pendingCursorOffset=_apStart+_ap.value.length;
globalThis._pendingCursorText=_apNew;
${onChangeParam}(_apNew+(_hlText.indexOf("\\u200B")>=0?"\\u200C":"\\u200B"));
return;
}
}
}
if(globalThis._hlState&&globalThis._hlState.active){
if(_hlText!==_oldText){
globalThis._hlState={active:false,index:null,wordIndex:null,text:""};
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
}
}${exportCode}
})();
`;

  const newFile =
    oldFile.slice(0, location.startIndex) +
    fullCode +
    oldFile.slice(location.endIndex);

  showDiff(
    oldFile,
    newFile,
    fullCode,
    location.startIndex,
    location.endIndex
  );

  return newFile;
};

/**
 * Find and patch escape key handling to clear highlight.
 */
export const writeWordHighlightClearOnEscape = (
  oldFile: string,
  config: WordHighlightConfig = {}
): string | null => {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.highlightClearOnEscape) {
    return oldFile; // No change needed
  }

  // Find the escape key case in the key dispatcher
  // Pattern: case AA.escape:return()=>{...}
  const escapePattern = /case ([$\w]+)\.escape:return\(\)=>\{/;
  const match = oldFile.match(escapePattern);

  if (!match || match.index === undefined) {
    console.error('patch: wordHighlight: failed to find escape case');
    return null;
  }

  // Inject clear code at the start of the escape handler
  const insertPos = match.index + match[0].length;
  const clearCode = 'if(globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:""};';

  const newFile =
    oldFile.slice(0, insertPos) +
    clearCode +
    oldFile.slice(insertPos);

  showDiff(
    oldFile,
    newFile,
    clearCode,
    insertPos,
    insertPos
  );

  return newFile;
};

/**
 * Write word highlight visual rendering patch.
 *
 * Wraps renderedValue to apply white color to highlighted word.
 * This works both before and after rainbow input has already wrapped the value.
 */
export const writeWordHighlightRendering = (
  oldFile: string,
  config: WordHighlightConfig = {}
): string | null => {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const chalkVar = findChalkVar(oldFile);
  if (!chalkVar) {
    console.error('patch: wordHighlight: failed to find chalk variable');
    return null;
  }

  const location = findRenderedValueLocation(oldFile);
  if (!location) {
    return null;
  }

  const identifiers = location.identifiers!;

  // Determine if rainbow has already wrapped the value
  // If identifiers has only 1 element starting with "(function", it's wrapped
  const isWrapped = identifiers.length === 1 && identifiers[0].startsWith('(function');

  // Build the render call - either the original or the wrapped version
  let renderCall: string;
  if (isWrapped) {
    // Rainbow has wrapped it - use the entire wrapped IIFE
    renderCall = identifiers[0];
  } else if (identifiers.length === 5) {
    // 4 parameters (v2.1.x)
    const inputZoneVar = identifiers[0];
    renderCall = `${inputZoneVar}.render(${identifiers[1]},${identifiers[2]},${identifiers[3]},${identifiers[4]})`;
  } else {
    // 3 parameters (v2.0.x)
    const inputZoneVar = identifiers[0];
    renderCall = `${inputZoneVar}.render(${identifiers[1]},${identifiers[2]},${identifiers[3]})`;
  }

  // Build color application code based on config
  // Use raw ANSI codes for consistency
  let colorCode: string;
  // IMPORTANT: Each color code starts with \x1b[0m to reset any previous styling
  // This fixes the "double cursor" bug where inverse mode leaks to adjacent characters
  // when we discard _pending (which may contain \x1b[27m inverse-off code)
  switch (cfg.highlightColor) {
    case 'cyan':
      colorCode = `"\\x1b[0m\\x1b[1;96m"+_ch+"\\x1b[0m"`;  // reset + bold bright cyan
      break;
    case 'yellow':
      colorCode = `"\\x1b[0m\\x1b[1;93m"+_ch+"\\x1b[0m"`;  // reset + bold bright yellow
      break;
    case 'inverse':
      colorCode = `"\\x1b[0m\\x1b[7m"+_ch+"\\x1b[27m"`;    // reset + inverse
      break;
    case 'underline':
      colorCode = `"\\x1b[0m\\x1b[4m"+_ch+"\\x1b[24m"`;    // reset + underline
      break;
    case 'white':
    default:
      colorCode = `"\\x1b[0m\\x1b[1;97m"+_ch+"\\x1b[0m"`;  // reset + bold bright white
      break;
  }

  // Word index is now stored directly in _hlState.wordIndex (for numbers-only mode)
  // ANSI-aware rendering with:
  // 1. Number dimming (dark gray for all numbers)
  // 2. Highlight rendering (configurable color for highlighted word, overrides dimming)
  // 3. Linked words highlight together
  // This wraps the previous output (either raw or rainbow-processed)
  const numberDimmingEnabled = cfg.numberDimming !== false;  // default true
  // Use raw ANSI code for dark gray (90 = dark gray foreground)
  // Starts with reset to clear any previous styling (like inverse mode from cursor)
  const dimCode = `"\\x1b[0m\\x1b[90m"+_ch+"\\x1b[0m"`;

  // Universal rendering — numbers dimmed, highlighted word + linked + spans in highlight color
  const numberRenderCode = numberDimmingEnabled ? `var _searchPos=0;
var _hlSpanLen=1;
if(globalThis._dynDefs&&globalThis._dynDefs.words&&_hlWordIdx>=0){
var _hlDef=globalThis._dynDefs.words.find(function(d){return d.index===_hlWordIdx;});
if(_hlDef&&_hlDef.spanLength)_hlSpanLen=_hlDef.spanLength;
}
for(var _ni=0;_ni<_words.length;_ni++){
var _w=_words[_ni];
var _wStart=_clean.indexOf(_w,_searchPos);
if(_wStart<0)break;
if(_ni===_hlWordIdx){
_hlStart=_wStart;
if(_hlSpanLen>1){
var _spanEnd=_wStart+_w.length;
for(var _si=1;_si<_hlSpanLen;_si++){
var _nw=_words[_ni+_si];
if(_nw){var _ns=_clean.indexOf(_nw,_spanEnd);if(_ns>=0)_spanEnd=_ns+_nw.length;}
}
_hlEnd=_spanEnd;
}else{_hlEnd=_wStart+_w.length;}
}
else if((globalThis._stepPatterns||[]).some(function(s){return s.re.test(_w);})){_numRanges.push({start:_wStart,end:_wStart+_w.length});}
_searchPos=_wStart+_w.length;
}` : `var _hlSpanLen=1;
if(globalThis._dynDefs&&globalThis._dynDefs.words&&_hlWordIdx>=0){
var _hlDef=globalThis._dynDefs.words.find(function(d){return d.index===_hlWordIdx;});
if(_hlDef&&_hlDef.spanLength)_hlSpanLen=_hlDef.spanLength;
}
if(_hlWordIdx>=0&&_hlWordIdx<_words.length){
var _hlWord=_words[_hlWordIdx];
var _wordPos=0;
for(var _wi=0;_wi<_words.length;_wi++){
var _wStart=_clean.indexOf(_words[_wi],_wordPos);
if(_wi===_hlWordIdx){
_hlStart=_wStart;
if(_hlSpanLen>1){
var _spanEnd=_wStart+_hlWord.length;
for(var _si=1;_si<_hlSpanLen;_si++){
var _nw=_words[_wi+_si];
if(_nw){var _ns=_clean.indexOf(_nw,_spanEnd);if(_ns>=0)_spanEnd=_ns+_nw.length;}
}
_hlEnd=_spanEnd;
}else{_hlEnd=_wStart+_hlWord.length;}
break;
}
_wordPos=_wStart+_words[_wi].length;
}
}`;

  const newCode = `renderedValue:(function(){
var _rv=${renderCall};
if(typeof _rv!=="string")return _rv;
var _ap=/\\x1b\\[[0-9;]*m/g;
var _clean=_rv.replace(_ap,'');
var _words=_clean.split(/\\s+/).filter(function(w){return w});
if(!_words.length)return _rv;
var _hlWordIdx=(globalThis._hlState&&globalThis._hlState.active&&globalThis._hlState.wordIndex!=null)?globalThis._hlState.wordIndex:-1;
var _numRanges=[];
var _hlStart=-1,_hlEnd=-1;
${numberRenderCode}
// Skip our color overrides for words that have external highlights (e.g. shimmer).
// kP4 splits text char-by-char for shimmer — our per-char ANSI codes break that.
// The word remains navigable/selectable — only the visual override is skipped.
var _extHl=globalThis._extHighlights||[];
if(_extHl.length>0){
if(_hlStart>=0){for(var _ehi=0;_ehi<_extHl.length;_ehi++){var _eh=_extHl[_ehi];if(_eh.start<_hlEnd&&_eh.end>_hlStart){_hlStart=-1;_hlEnd=-1;break;}}}
for(var _nri=_numRanges.length-1;_nri>=0;_nri--){var _nr=_numRanges[_nri];for(var _ehi2=0;_ehi2<_extHl.length;_ehi2++){var _eh2=_extHl[_ehi2];if(_eh2.start<_nr.end&&_eh2.end>_nr.start){_numRanges.splice(_nri,1);break;}}}
}
var _out='',_cp=0,_i=0,_inv=false,_pending='';
while(_i<_rv.length){
var _am=_rv.slice(_i).match(/^\\x1b\\[[0-9;]*m/);
if(_am){
if(_am[0]==='\\x1b[7m')_inv=true;
if(_am[0]==='\\x1b[27m'||_am[0]==='\\x1b[0m')_inv=false;
_pending+=_am[0];
_i+=_am[0].length;continue;
}
var _ch=_rv[_i];
var _inHl=_hlStart>=0&&_cp>=_hlStart&&_cp<_hlEnd;
var _inNum=false;
for(var _ri=0;_ri<_numRanges.length;_ri++){
if(_cp>=_numRanges[_ri].start&&_cp<_numRanges[_ri].end){_inNum=true;break;}
}
if(_inv){_out+=_pending+_ch;}
else if(_inHl){_out+=${colorCode};}
else if(_inNum){_out+=${dimCode};}
else{_out+=_pending+_ch;}
_pending='';
_cp++;_i++;
}
return _out;
})()`;

  let newFile =
    oldFile.slice(0, location.startIndex) +
    newCode +
    oldFile.slice(location.endIndex);

  showDiff(
    oldFile,
    newFile,
    newCode,
    location.startIndex,
    location.endIndex
  );

  // Inject globalThis._extHighlights store in the parent function (R5)
  // so our renderedValue can skip ANSI for words with external highlights (shimmer).
  // Pattern: "else P=<chalk>.inverse;let X=uu8(" — inject before "let X=uu8("
  const extHlPattern = /else ([$\w]+)=([$\w]+)\.inverse;let ([$\w]+)=uu8\(/;
  const extHlMatch = newFile.match(extHlPattern);
  if (extHlMatch && extHlMatch.index !== undefined) {
    const insertAt = extHlMatch.index + `else ${extHlMatch[1]}=${extHlMatch[2]}.inverse;`.length;
    const extHlCode = `globalThis._extHighlights=A.highlights||[];`;
    newFile = newFile.slice(0, insertAt) + extHlCode + newFile.slice(insertAt);
  }

  return newFile;
};

/**
 * Write word highlight raw sequence fallback patch.
 *
 * Injects detection for raw escape sequences in the default case handler.
 * This is a fallback for terminals that don't set meta/option properties.
 *
 * Raw sequences:
 * - \x1B[1;7D = Ctrl+Alt+Left (modifier 7)
 * - \x1B[1;7C = Ctrl+Alt+Right (modifier 7)
 */
export const writeWordHighlightRawSequence = (
  oldFile: string,
  config: WordHighlightConfig = {}
): string | null => {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const requireFuncName = getRequireFuncName(oldFile);

  // Find the default case with the nested switch that handles raw sequences
  // Pattern: default:return function(wA){switch(!0){case(wA==="\x1B[H"
  // Note: In the file, \x1B is stored as literal characters (backslash-x-1-B)
  // In regex, \\ matches a literal backslash, so \\x1B matches \x1B in the file
  const defaultPattern = /default:return function\(([$\w]+)\)\{switch\(!0\)\{case\(\1==="\\x1B\[H"/;
  const match = oldFile.match(defaultPattern);

  if (!match || match.index === undefined) {
    console.error('patch: wordHighlight: failed to find default case for raw sequences');
    return null;
  }

  const rawParam = match[1]; // wA

  // Build navigation logic based on config
  const maxCheck = cfg.highlightWrap
    ? 'globalThis._hlState.index=(globalThis._hlState.index+1)%_hlW.length'
    : 'if(globalThis._hlState.index<_hlW.length-1)globalThis._hlState.index++';

  const minCheck = cfg.highlightWrap
    ? 'globalThis._hlState.index=(globalThis._hlState.index-1+_hlW.length)%_hlW.length'
    : 'if(globalThis._hlState.index>0)globalThis._hlState.index--';

  // Insert after "switch(!0){"
  const insertPos = oldFile.indexOf('switch(!0){', match.index) + 'switch(!0){'.length;

  // Find InputZone class name and config variable for fromText calls
  // Needed to append invisible char at END of text (not at cursor position)
  const fromTextPattern = /([$\w]+)=([$\w]+)\.fromText\(([$\w]+),([$\w]+),([$\w]+)\)/;
  const fromTextMatch = oldFile.match(fromTextPattern);
  if (!fromTextMatch) {
    console.error('patch: wordHighlight: failed to find InputZone.fromText pattern for raw sequence handler');
    return null;
  }
  const inputZoneVar = fromTextMatch[1];    // h (the InputZone instance)
  const inputZoneClass = fromTextMatch[2]; // i5
  const configVar = fromTextMatch[4];       // G

  // Add raw sequence handling - check for Ctrl+Alt+Arrow sequences (modifier 7)
  // In template string, \\ becomes \ in output, so \\x1B outputs \x1B
  // Note: Raw sequence handlers are in nested switch inside default case, R and k are in outer scope
  //
  // IMPORTANT: Append at END of text, not at cursor position!
  // Using R.insert() would insert at cursor, causing "cursor wall" bug.
  // Using fromText(R.text + char, G, R.offset) appends at end, preserving cursor.
  //
  // Mode-dependent navigation for raw escape sequences
  // index 0 = rightmost word/number (same as original word highlight behavior)
  // Navigation filter for raw sequence handlers — numbers + control words
  const rawFilterCode1 = `var _targetIdx=[];
_allW.forEach(function(w,i){if(globalThis._isCueControl&&globalThis._isCueControl(w))_targetIdx.push(i);});`;

  const rawFilterCode2 = `var _targetIdx2=[];
_allW2.forEach(function(w,i){if(globalThis._isCueControl&&globalThis._isCueControl(w))_targetIdx2.push(i);});`;

  // Raw sequence handlers for Left/Right navigation and Up/Down cycling
  const rawHandlerCode = `case(${rawParam}==="\\x1B[1;7D"):if(!globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:""};

var _allW=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
${rawFilterCode1}
if(_targetIdx.length){
if(!globalThis._hlState.active){
globalThis._hlState.active=true;globalThis._hlState.index=0;globalThis._hlState.wordIndex=_targetIdx[_targetIdx.length-1];globalThis._hlState.text=globalThis._hlText;
}else{
if(globalThis._hlState.index<_targetIdx.length-1){
globalThis._hlState.index++;
globalThis._hlState.wordIndex=_targetIdx[_targetIdx.length-1-globalThis._hlState.index];
}
}
}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _pv=globalThis._parentValue||"";
var _parentHasB=_pv.indexOf("\\u200B")>=0;
var _parentHasC=_pv.indexOf("\\u200C")>=0;
if(_parentHasB){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200C",${configVar},${inputZoneVar}.offset);}
else if(_parentHasC){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
else{return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
case(${rawParam}==="\\x1B[1;7C"):if(!globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:""};

var _allW2=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
${rawFilterCode2}
if(_targetIdx2.length){
if(!globalThis._hlState.active){
globalThis._hlState.active=true;globalThis._hlState.index=0;globalThis._hlState.wordIndex=_targetIdx2[_targetIdx2.length-1];globalThis._hlState.text=globalThis._hlText;
}else{
if(globalThis._hlState.index>0){
globalThis._hlState.index--;
globalThis._hlState.wordIndex=_targetIdx2[_targetIdx2.length-1-globalThis._hlState.index];
}else{
globalThis._hlState={active:false,index:null,wordIndex:null,text:""};
}
}
}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _pv2=globalThis._parentValue||"";
var _parentHasB2=_pv2.indexOf("\\u200B")>=0;
var _parentHasC2=_pv2.indexOf("\\u200C")>=0;
if(_parentHasB2){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200C",${configVar},${inputZoneVar}.offset);}
else if(_parentHasC2){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
else{return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
case(${rawParam}==="\\x1B[1;7A"):
var _rUp=globalThis._cycleAlt&&globalThis._cycleAlt(1,null,null,null,${requireFuncName});
if(_rUp&&_rUp.refresh){var _pvU=globalThis._parentValue||"";return ${inputZoneClass}.fromText(${inputZoneVar}.text+(_pvU.indexOf("\\u200B")>=0?"\\u200C":"\\u200B"),${configVar},${inputZoneVar}.offset);}
if(_rUp&&_rUp.text){var _cU=${inputZoneVar}.offset;var _wEU=_rUp.wStart+_rUp.newLen-_rUp.lenDiff;var _offU=_cU<=_rUp.wStart?_cU:_cU>=_wEU?_cU+_rUp.lenDiff:_rUp.wStart+_rUp.newLen;if(_offU>_rUp.text.length)_offU=_rUp.text.length;if(_offU<0)_offU=0;return ${inputZoneClass}.fromText(_rUp.text,${configVar},_offU);}
return ${inputZoneVar};
case(${rawParam}==="\\x1B[1;7B"):
var _rDn=globalThis._cycleAlt&&globalThis._cycleAlt(-1,null,null,null,${requireFuncName});
if(_rDn&&_rDn.refresh){var _pvD=globalThis._parentValue||"";return ${inputZoneClass}.fromText(${inputZoneVar}.text+(_pvD.indexOf("\\u200B")>=0?"\\u200C":"\\u200B"),${configVar},${inputZoneVar}.offset);}
if(_rDn&&_rDn.text){var _cD=${inputZoneVar}.offset;var _wED=_rDn.wStart+_rDn.newLen-_rDn.lenDiff;var _offD=_cD<=_rDn.wStart?_cD:_cD>=_wED?_cD+_rDn.lenDiff:_rDn.wStart+_rDn.newLen;if(_offD>_rDn.text.length)_offD=_rDn.text.length;if(_offD<0)_offD=0;return ${inputZoneClass}.fromText(_rDn.text,${configVar},_offD);}
return ${inputZoneVar};
`;

  const newFile =
    oldFile.slice(0, insertPos) +
    rawHandlerCode +
    oldFile.slice(insertPos);

  showDiff(
    oldFile,
    newFile,
    rawHandlerCode,
    insertPos,
    insertPos
  );

  return newFile;
};

/**
 * Export the status line trigger to globalThis.
 *
 * This patches the INK component to expose the debounced vh6 trigger
 * so that the word highlight key handler can trigger a status line refresh.
 *
 * Pattern: O=Wn(()=>X(A),300)
 * Becomes: O=Wn(()=>X(A),300);globalThis._triggerStatusLineRefresh=O
 */
export const writeStatusLineTriggerExport = (oldFile: string): string | null => {
  // Try old pattern first: O=Wn(()=>X(A),300) - debounced via Wn helper
  const oldPattern = /(\w+)=Wn\(\(\)=>(\w+)\(([A-Z])\),300\)/;
  let match = oldFile.match(oldPattern);

  if (match && match.index !== undefined) {
    const debounceVar = match[1];
    const originalCode = match[0];
    const replacement = `${originalCode};globalThis._triggerStatusLineRefresh=${debounceVar}`;
    const newFile = oldFile.replace(oldPattern, replacement);
    showDiff(oldFile, newFile, replacement, match.index, match.index + originalCode.length);
    return newFile;
  }

  // New pattern (v2.1.69+): G=GP.useCallback(()=>{if(D.current!==void 0)clearTimeout(D.current);D.current=setTimeout((N,E)=>{N.current=void 0,E()},300,D,W)},[W])
  // This is the debounced status line refresh using React useCallback
  // Use a simpler pattern without backreferences to avoid regex engine issues
  const newPattern = /([$\w]+)=[$\w]+\.useCallback\(\(\)=>\{if\([$\w]+\.current!==void 0\)clearTimeout\([$\w]+\.current\);[$\w]+\.current=setTimeout\(\([$\w]+,[$\w]+\)=>\{[$\w]+\.current=void 0,[$\w]+\(\)\},300,[$\w]+,[$\w]+\)\},\[[$\w]+\]\)/;
  match = oldFile.match(newPattern);

  if (!match || match.index === undefined) {
    console.error('patch: statusLineTrigger: failed to find debounced vh6 pattern');
    return null;
  }

  const debounceVar = match[1]; // G
  const originalCode = match[0];
  const replacement = `${originalCode};globalThis._triggerStatusLineRefresh=${debounceVar}`;
  const newFile = oldFile.replace(newPattern, replacement);
  showDiff(oldFile, newFile, replacement, match.index, match.index + originalCode.length);
  return newFile;
};

/**
 * Apply all word highlight patches.
 *
 * This is the main entry point that applies all patches in the correct order.
 * Returns the final patched content or null if any patch fails.
 */
export const writeWordHighlight = (
  oldFile: string,
  config: WordHighlightConfig = {}
): string | null => {
  let content = oldFile;
  let result: string | null;

  // 1. Apply key handler patch (Ctrl+Alt+Left/Right detection via properties)
  result = writeWordHighlightKeyHandler(content, config);
  if (!result) {
    console.error('patch: wordHighlight: failed to apply key handler patch');
    return null;
  }
  content = result;

  // 2. Apply raw sequence fallback patch (for terminals that don't set meta/option)
  result = writeWordHighlightRawSequence(content, config);
  if (!result) {
    console.error('patch: wordHighlight: failed to apply raw sequence patch');
    // Don't fail entirely - this is a fallback
  } else {
    content = result;
  }

  // 3. Apply clear-on-escape patch
  result = writeWordHighlightClearOnEscape(content, config);
  if (!result) {
    console.error('patch: wordHighlight: failed to apply clear-on-escape patch');
    return null;
  }
  content = result;

  // 4. Apply clear-on-typing patch (must be before rendering patch)
  result = writeWordHighlightClearOnTyping(content, config);
  if (!result) {
    console.error('patch: wordHighlight: failed to apply clear-on-typing patch');
    return null;
  }
  content = result;

  // 5. Apply visual rendering patch
  result = writeWordHighlightRendering(content, config);
  if (!result) {
    console.error('patch: wordHighlight: failed to apply rendering patch');
    return null;
  }
  content = result;

  // 6. Apply status line trigger export (optional - enables status line refresh on highlight change)
  result = writeStatusLineTriggerExport(content);
  if (result) {
    content = result;
  } else {
    console.log('patch: wordHighlight: status line trigger export not applied (optional)');
  }

  return content;
};

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
 * v2.1.110+: function t(O6,k6){switch(O6.key){case"escape":
 * Injection point: BEFORE the switch, so we can prepend if-blocks.
 */
const findKeyDispatcherLocation = (oldFile: string): LocationResult | null => {
  // Matches: function t(O6,k6){switch(O6.key){case"escape":
  // Groups: [1]=funcName, [2]=eventParam (O6), [3]=keyParam (k6)
  const funcPattern = /function ([$\w]+)\(([$\w]+),([$\w]+)\)\{switch\(\2\.key\)\{case"escape":/;
  const match = oldFile.match(funcPattern);

  if (!match || match.index === undefined) {
    console.error('patch: wordHighlight: failed to find key dispatcher function');
    return null;
  }

  // Inject BEFORE the switch — right after the opening { of the function
  const funcBodyStart = match.index + `function ${match[1]}(${match[2]},${match[3]}){`.length;

  return {
    startIndex: funcBodyStart,
    endIndex: funcBodyStart,
    identifiers: [
      match[1], // function name (t)
      match[2], // event param (O6)
      match[3], // key param (k6)
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
  // Increased from 10000 to 30000 to 60000 because each additional patch
  // (key handler, raw sequence, clearOnTyping) injects code pushing the return further
  const searchSection = oldFile.slice(funcStart, funcStart + 60000);

  // v2.1.110+: return{handleKeyDown: (was onInput: pre-v2.1.110)
  const returnPattern = /return\{handleKeyDown:([$\w]+),renderedValue:/;
  const returnMatch = searchSection.match(returnPattern);

  if (!returnMatch || returnMatch.index === undefined) {
    console.error('patch: wordHighlight: failed to find return statement in input handler');
    return null;
  }

  return {
    startIndex: funcStart + returnMatch.index,
    endIndex: funcStart + returnMatch.index,
    identifiers: [
      match[1],   // function name (Dy8)
      match[2],   // value param name (q)
      match[3],   // onChange param name (K)
      match[4],   // externalOffset param name (f)
      match[5],   // onOffsetChange param name (v)
      match[6],   // x variable (assigned from externalOffset)
      match[7],   // B variable (assigned from onOffsetChange)
      match[8],   // m variable (InputZone instance)
      match[9],   // InputZone class name (cK)
      match[10],  // P variable (columns — 2nd arg to fromText)
      returnMatch[1], // handleKeyDown function name (z6)
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

  // Try 5-parameter pattern (v2.1.110+): m.render(X,H,M,j6,G)
  const pattern5 = /renderedValue:([$\w]+)\.render\(([$\w]+),([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)/;
  let match = oldFile.match(pattern5);

  if (match && match.index !== undefined) {
    return {
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      identifiers: [
        match[1], // InputZone variable (m)
        match[2], // param1 (X)
        match[3], // param2 (H)
        match[4], // param3 (M)
        match[5], // param4 (j6)
        match[6], // param5 (G)
      ],
    };
  }

  // Try 4-parameter pattern (v2.1.x)
  const pattern4 = /renderedValue:([$\w]+)\.render\(([$\w]+),([$\w]+),([$\w]+),([$\w]+)\)/;
  match = oldFile.match(pattern4);

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

  const eventParam = location.identifiers![1]; // O6 — DOM-style keyboard event
  const requireFuncName = getRequireFuncName(oldFile);

  // Find InputZone class name and columns variable for fromText calls
  // Needed to append invisible char at END of text (not at cursor position)
  // v2.1.110: m=cK.fromText(q,P,x) — [1]=m, [2]=cK, [3]=q, [4]=P(cols), [5]=x
  const fromTextPattern = /([$\w]+)=([$\w]+)\.fromText\(([$\w]+),([$\w]+),([$\w]+)\)/;
  const fromTextMatch = oldFile.match(fromTextPattern);
  if (!fromTextMatch) {
    console.error('patch: wordHighlight: failed to find InputZone.fromText pattern for key handler');
    return null;
  }
  const inputZoneVar = fromTextMatch[1];   // m
  const inputZoneClass = fromTextMatch[2]; // cK
  const configVar = fromTextMatch[4];      // P (columns — 2nd arg to fromText)

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
  // Navigation filter: cue words when _isCueControl is defined; all words as fallback
  // _isCueControl is set by dynamicHighlight.ts after cues-core init
  const filterCode = `var _targetIdx=[];
_allW.forEach(function(w,i){
var _fLw=(w||"").toLowerCase();
if(globalThis._isCueControl&&globalThis._isCueControl(w))_targetIdx.push(i);
else if(globalThis._localCueMap&&globalThis._localCueMap.has(_fLw))_targetIdx.push(i);
else if(globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.some(function(d){return d.index===i&&d.alts&&d.alts.length>1;}))_targetIdx.push(i);
});
if(!_targetIdx.length)_allW.forEach(function(w,i){_targetIdx.push(i);});`;

  // v2.1.110: injected as if-blocks BEFORE switch(O6.key){...}
  // O6 is the DOM-style keyboard event: .key is string ("left","right",...), .ctrl/.meta/.alt are booleans
  const keyHandlerCode = `if(${eventParam}.key==="left"&&${eventParam}.ctrl&&(${eventParam}.meta||${eventParam}.alt||${eventParam}.option)){
if(!globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:""};

var _allW=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
${filterCode}
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
globalThis._hlManualNav=true;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _pv=globalThis._parentValue||"";
var _parentHasB=_pv.indexOf("\\u200B")>=0;
var _parentHasC=_pv.indexOf("\\u200C")>=0;
if(_parentHasB){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200C",${configVar},${inputZoneVar}.offset);}
else if(_parentHasC){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
else{return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
}
if(${eventParam}.key==="right"&&${eventParam}.ctrl&&(${eventParam}.meta||${eventParam}.alt||${eventParam}.option)){
if(!globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:""};

var _allW=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
${filterCode}
if(_targetIdx.length){
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
}
globalThis._hlManualNav=true;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _pv=globalThis._parentValue||"";
var _parentHasB=_pv.indexOf("\\u200B")>=0;
var _parentHasC=_pv.indexOf("\\u200C")>=0;
if(_parentHasB){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200C",${configVar},${inputZoneVar}.offset);}
else if(_parentHasC){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
else{return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
}
if(${eventParam}.key==="up"&&${eventParam}.ctrl&&(${eventParam}.meta||${eventParam}.alt||${eventParam}.option)){
var _r=globalThis._cycleAlt&&globalThis._cycleAlt(1,null,null,null,${requireFuncName});
if(_r&&_r.refresh){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
if(_r&&_r.text){var _off=_r.wStart<${inputZoneVar}.offset?${inputZoneVar}.offset+_r.lenDiff:${inputZoneVar}.offset;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}
return ${inputZoneVar};
}
if(${eventParam}.key==="down"&&${eventParam}.ctrl&&(${eventParam}.meta||${eventParam}.alt||${eventParam}.option)){
var _r=globalThis._cycleAlt&&globalThis._cycleAlt(-1,null,null,null,${requireFuncName});
if(_r&&_r.refresh){return ${inputZoneClass}.fromText(${inputZoneVar}.text+"\\u200B",${configVar},${inputZoneVar}.offset);}
if(_r&&_r.text){var _off=_r.wStart<${inputZoneVar}.offset?${inputZoneVar}.offset+_r.lenDiff:${inputZoneVar}.offset;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}
return ${inputZoneVar};
}
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
  const onOffsetChangeVar = location.identifiers![6]; // k (onOffsetChange)
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
_hlExport._debug={word:_hlWords[_idx],isCA:!!_isCA,cueControlTip:globalThis._cueControlTip||null,overrides:Object.keys(globalThis._cueControlOverrides||{}),cueValues:globalThis._cueControlValues||null,httpAdapterLoaded:!!globalThis._httpAdapter,cueResolverLoaded:!!globalThis._cueResolver,cueSourceCount:globalThis._cueSourceCount||0,dynDefsCount:(globalThis._dynDefs&&globalThis._dynDefs.words)?globalThis._dynDefs.words.length:0,blankSlotsCount:(globalThis._blankSlots||[]).length};
var _cbDw=globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.find(function(d){return d.index===_idx&&d.metadata&&d.metadata.controlName;});
if(_cbDw){
// Control-bound blank: only show in status if blankTip is set
// Selector/satellite words: read tips from opencues.md tips block (hot-reloadable)
if(_cbDw.metadata&&(_cbDw.metadata.selectorWord||_cbDw.metadata.satelliteWord)){
var _ownTip=null;
var _ownSetting=_cbDw.metadata.selectorWord?_cbDw.metadata.currentSetting:null;
if(_cbDw.metadata.satelliteWord){var _pSel=globalThis._dynDefs.words.find(function(d){return d.index===_cbDw.metadata.parentIndex;});if(_pSel&&_pSel.metadata)_ownSetting=_pSel.metadata.currentSetting;}
if(_ownSetting){
if(_cbDw.metadata.satelliteWord&&globalThis._openCuesSatTips&&globalThis._openCuesSatTips[_ownSetting])_ownTip=globalThis._openCuesSatTips[_ownSetting][_cbDw.word]||null;
if(!_ownTip&&globalThis._openCuesTips)_ownTip=globalThis._openCuesTips[_ownSetting]||null;
}
_cbDw.cueTip=_ownTip;delete _cbDw.altCueTips;
}
if(_cbDw.cueTip){_hlExport.cueControl=true;_hlExport.cueTip=_cbDw.cueTip;if(_cbDw.metadata&&_cbDw.metadata.listControl)_hlExport.listControl=true;if(_cbDw.metadata&&_cbDw.metadata.blankReadOnly)_hlExport.blankReadOnly=true;}
// Clear so returning to the word control triggers a fresh script get
globalThis._cueControlTipWord=null;
}else if(_isCA){_hlExport.cueControl=true;_hlExport.alts=[_hlWords[_idx]];_hlExport.currentAltIndex=0;
var _caWord=(_hlWords[_idx]||"").toLowerCase();var _caOvr=(globalThis._cueControlOverrides||{})[_caWord];
var _caTip=null;
if(_caOvr){_caTip=_caOvr.tip||_caOvr.control;}
else if(globalThis._localCueMap){var _lcm=globalThis._localCueMap.get(_caWord);if(_lcm&&_lcm.cueTip)_caTip=_lcm.cueTip;}
if(!_caTip){var _spsT=globalThis._stepPatterns||[];for(var _sptI=0;_sptI<_spsT.length;_sptI++){if(_spsT[_sptI].re.test(_hlWords[_idx]||"")){var _stc=_spsT[_sptI].ctrl;if(_stc.stepTip)_caTip=_stc.stepTip;break;}}}
// On navigation to this word (index changed), call script get once and cache in _cueControlTip
// On re-renders (same word, cycling), rely on _cueControlTip already set by dynamicHighlight interval
var _navChanged=globalThis._cueControlTipWord!==_caWord;
if(_navChanged){
  globalThis._cueControlTipWord=_caWord;
  globalThis._cueControlTip=null;
  if(_caOvr&&_caOvr.script){
    try{var _liveTip=${requireFuncName}("child_process").execSync("bash "+_caOvr.script+" get",{timeout:2000,encoding:"utf8"}).trim();if(_liveTip)globalThis._cueControlTip=_liveTip;}
    catch(_e){}
  }
}
if(globalThis._cueControlTip)_caTip=globalThis._cueControlTip;
if(globalThis._openCuesCurrent&&globalThis._openCuesCurrent["tips-mode"]==="off")_caTip=null;
_hlExport.cueTip=_caTip;
}
if(!_isCA&&!_cbDw){globalThis._cueControlTipWord=null;globalThis._cueControlTip=null;}
if(globalThis._dynDefs&&globalThis._dynDefs.words&&!_isCA&&!_cbDw){
var _dw=globalThis._dynDefs.words.find(function(d){return d.index===_idx;});
if(_dw){_hlExport.cueTip=_dw.cueTip||null;_hlExport.altCueTips=_dw.altCueTips||null;_hlExport.alts=_dw.alts||null;_hlExport.currentAltIndex=typeof _dw.currentAltIndex==="number"?_dw.currentAltIndex:0;}
}
}
var _hlExportPath="/tmp/claude-highlight-state-"+process.pid+".json";
try{${requireFuncName}("fs").writeFileSync(_hlExportPath,JSON.stringify(_hlExport));}catch(_e){}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
// TTS: speak tip on navigation, cancel on deselect or word change
// Check both _dynDefs (tips/LLM) and _cueControlOverrides (controls) for speak flag
var _ttsShouldSpeak=false;
var _ttsVoiceOff=globalThis._openCuesCurrent&&globalThis._openCuesCurrent["voice-mode"]==="inactive";
if(_hlExport.cueTip&&!_ttsVoiceOff){
var _ttsWord=globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.find(function(d){return d.index===_idx;});
if(_ttsWord&&_ttsWord.speak){_ttsShouldSpeak=true;}
else if(_hlExport.cueControl){var _ttsLw=(_hlExport.highlightedWord||"").toLowerCase();var _ttsCtrl=(globalThis._cueControlOverrides||{})[_ttsLw];if(_ttsCtrl&&_ttsCtrl.speak){_ttsShouldSpeak=true;}else if(globalThis._localCueMap){var _ttsLcm=globalThis._localCueMap.get(_ttsLw);if(_ttsLcm&&_ttsLcm.speak)_ttsShouldSpeak=true;}}
}
// For cue-controls, key on index only — tip content changes on every cycle (tip.txt) and must not re-trigger TTS
var _ttsKey=_ttsShouldSpeak?(_hlExport.cueControl?String(_idx):(_idx+":"+_hlExport.cueTip)):null;
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
if(!globalThis._cuesCore){try{
var _ccHome=process.env.HOME||"~";
var _cues=${requireFuncName}(_ccHome+"/.claude/node_modules/cues-core");
var _tipsC=${requireFuncName}("fs").readFileSync(_ccHome+"/.claude/claude-code-tips.json","utf8");
var _td=_cues.parseLocalCueFile(_tipsC);
globalThis._cuesCore=_cues;
globalThis._localCueMap=_cues.buildLookupMap(_td);
try{
var _NodeHttpAdapter=${requireFuncName}(_ccHome+"/.claude/node_modules/cues-core/node-http-adapter").NodeHttpAdapter;
globalThis._httpAdapter=new _NodeHttpAdapter({maxSockets:2,timeout:30000,providerOverrides:{}});
if(process.env.GROQ_API_KEY)setTimeout(function(){try{globalThis._httpAdapter.warmup("https://api.groq.com/openai/v1/models",{Authorization:"Bearer "+process.env.GROQ_API_KEY});}catch(_we){}},1000);
}catch(_ha){globalThis._httpAdapter=null;}
try{
var _rfs=${requireFuncName}("fs");
var _ctrlPath=process.cwd()+"/controls.md";
if(_rfs.existsSync(_ctrlPath)){
var _parsedCtrl=_cues.parseCuesMd(_rfs.readFileSync(_ctrlPath,"utf8"));
if(_parsedCtrl&&_parsedCtrl.controls)Object.assign(globalThis._cueControlOverrides,_parsedCtrl.controls);
}
var _cuesPath=process.cwd()+"/cues.md";
var _parsedCues=null;
if(_rfs.existsSync(_cuesPath)){
_parsedCues=_cues.parseCuesMd(_rfs.readFileSync(_cuesPath,"utf8"));
if(_parsedCues&&_parsedCues.tips){
var _cwdMap=_cues.buildLookupMap(_parsedCues.tips);
_cwdMap.forEach(function(v,k){globalThis._localCueMap.set(k,v);});
}
}
var _blanksPath=process.cwd()+"/blanks.md";
var _parsedBlanks=null;
if(_rfs.existsSync(_blanksPath)){
_parsedBlanks=_cues.parseCuesMd(_rfs.readFileSync(_blanksPath,"utf8"));
}
var _rFsAdp={readFile:function(p){try{return _rfs.readFileSync(p,"utf8");}catch(_fe){return null;}},readDir:function(p){try{return _rfs.readdirSync(p,{withFileTypes:true}).map(function(d){return{name:d.name,isDirectory:d.isDirectory()};});}catch(_fe){return null;}}};
var _folderCfgs=_cues.discoverFolderConfigs({basePath:process.cwd(),readFile:_rFsAdp.readFile,readDir:_rFsAdp.readDir});
if(_folderCfgs.controlOverrides)Object.assign(globalThis._cueControlOverrides,_folderCfgs.controlOverrides);
var _stepPats=[];
Object.values(globalThis._cueControlOverrides||{}).forEach(function(_sc){
if(_sc.stepPattern){try{_stepPats.push({re:new RegExp(_sc.stepPattern),ctrl:_sc});}catch(_spe){}}
if(_sc.stepSuffixes&&_sc.stepSuffixes.length){_sc.stepSuffixes.forEach(function(_sf){var _esc=_sf.replace(/[^a-zA-Z0-9]/g,'\\\\$&');try{_stepPats.push({re:new RegExp('^-?\\\\d+(\\\\.\\\\d+)?'+_esc+'$'),ctrl:Object.assign({},_sc,{stepSuffix:_sf})});}catch(_spe){}});}
});
globalThis._stepPatterns=_stepPats;
var _ocPath=process.cwd()+"/opencues.md";
if(_rfs.existsSync(_ocPath)){
var _ocContent=_rfs.readFileSync(_ocPath,"utf8");
var _ocCurrent={};
var _ocLines=_ocContent.split(/\\r?\\n/);
var _inFm=false;
for(var _oli=0;_oli<_ocLines.length;_oli++){
var _ol=_ocLines[_oli];
var _olT=_ol.trim();
if(_olT==="---"){_inFm=!_inFm;continue;}
if(!_inFm||_ol.charAt(0)===" "||_ol.charAt(0)==="\\t")continue;
var _ci=_olT.indexOf(":");
if(_ci<=0)continue;
var _ocKey=_olT.slice(0,_ci).trim();
var _ocVal=_olT.slice(_ci+1).trim();
if(_ocKey==="settings")break;
_ocCurrent[_ocKey]=_ocVal;
}
globalThis._openCuesCurrent=_ocCurrent;
globalThis._debugLog=function(_dMsg){if(!globalThis._openCuesCurrent||globalThis._openCuesCurrent["debug-mode"]!=="on")return;try{${requireFuncName}("fs").appendFileSync("/tmp/claude-cues-debug-"+process.pid+".log","["+new Date().toISOString()+"] "+_dMsg+"\\n");}catch(_dle){}};
}
try{
var _mergedDC=_cues.mergeConfigs({cuesConfig:_parsedCues||undefined,blanksConfig:_parsedBlanks||undefined},_folderCfgs);
var _srcs=_cues.buildSourcesFromConfig(_mergedDC.cuesConfig,_mergedDC.blanksConfig,{httpAdapter:globalThis._httpAdapter,endpoint:"https://api.groq.com/openai/v1/chat/completions",apiKey:process.env.GROQ_API_KEY||"",defaultModel:"openai/gpt-oss-120b",controls:globalThis._cueControlOverrides});
globalThis._cueResolver=new _cues.CueResolver(_srcs);
globalThis._cueSourceCount=_srcs.length;
if(globalThis._debugLog)globalThis._debugLog("startup: "+Object.keys(globalThis._cueControlOverrides||{}).length+" overrides, "+(globalThis._localCueMap?globalThis._localCueMap.size:0)+" tips, "+(globalThis._stepPatterns||[]).length+" stepPatterns, "+(globalThis._cueSourceCount||0)+" llm sources");
}catch(_re){globalThis._cueResolver=null;globalThis._cueSourceCount=0;}
}catch(_cte){}
}catch(_e){globalThis._cuesCore=null;globalThis._localCueMap=null;}}
if(!globalThis._isCueControl)globalThis._isCueControl=function(_w){var _low=(_w||"").toLowerCase();if((globalThis._cueControlOverrides||{})[_low])return true;if((globalThis._stepPatterns||[]).some(function(s){return s.re.test(_w);}))return true;return false;};
if(!globalThis._cycleAlt)globalThis._cycleAlt=function(_dir,_a,_b,_c,_req){
if(!globalThis._hlState||!globalThis._hlState.active)return null;
var _wds=(globalThis._hlText||"").split(/\\s+/).filter(function(w){return w;});
var _wi=globalThis._hlState.wordIndex;
if(_wi==null||_wi<0||_wi>=_wds.length)return null;
var _lw=(_wds[_wi]||"").toLowerCase();
var _ovr=(globalThis._cueControlOverrides||{})[_lw];
var _spList=globalThis._stepPatterns||[];
var _stepCtrl=null;
for(var _spi=0;_spi<_spList.length;_spi++){if(_spList[_spi].re.test(_wds[_wi])){_stepCtrl=_spList[_spi].ctrl;break;}}
if(_stepCtrl){
var _stStep=(_stepCtrl.step!=null)?_stepCtrl.step:1;
var _stMin=(_stepCtrl.stepMin!=null)?_stepCtrl.stepMin:null;
var _stMax=(_stepCtrl.stepMax!=null)?_stepCtrl.stepMax:null;
var _stFmt=_stepCtrl.stepFormat||null;
var _stSuffix=_stepCtrl.stepSuffix||"";
var _curWord=_wds[_wi];
var _stRaw=(_stSuffix&&_curWord.endsWith(_stSuffix))?_curWord.slice(0,-_stSuffix.length):_curWord;
var _stNum=parseFloat(_stRaw);
if(isNaN(_stNum))return null;
var _stResult=_stNum+(_stStep*_dir);
if(_stMin!=null&&_stResult<_stMin)_stResult=_stMin;
if(_stMax!=null&&_stResult>_stMax)_stResult=_stMax;
var _stFormatted=(_stFmt==="integer")?String(Math.round(_stResult)):String(_stResult);
var _stNewWord=_stFormatted+_stSuffix;
var _stText=globalThis._hlText||"";
var _stWordPos=0;
for(var _stWli=0;_stWli<_wi;_stWli++){_stWordPos=_stText.indexOf(_wds[_stWli],_stWordPos)+_wds[_stWli].length;}
var _stWStart=_stText.indexOf(_curWord,_stWordPos);
if(_stWStart<0)return null;
var _stNewText=_stText.slice(0,_stWStart)+_stNewWord+_stText.slice(_stWStart+_curWord.length);
globalThis._hlText=_stNewText;
globalThis._hlState.text=_stNewText;
globalThis._lastResolvedText=_stNewText;
return {text:_stNewText,wStart:_stWStart,lenDiff:_stNewWord.length-_curWord.length};
}
if(globalThis._localCueMap&&!(_ovr&&_ovr.script)){
var _dyn=globalThis._dynDefs=globalThis._dynDefs||{words:[]};
var _dWord=_dyn.words.find(function(w){return w.index===_wi;});
var _tipR=globalThis._localCueMap.get(_lw);
if(_tipR&&_tipR.alternatives&&_tipR.alternatives.length>1){
if(_dWord&&_dWord.source==="tips"){}
else if(_dWord){_dWord.alts=_tipR.alternatives;_dWord.cueTip=_tipR.cueTip;_dWord.altCueTips=_tipR.altCueTips;_dWord.speak=_tipR.speak||false;_dWord.source="tips";_dWord.currentAltIndex=0;}
else{var _tipDef={index:_wi,word:_wds[_wi],alts:_tipR.alternatives,cueTip:_tipR.cueTip,altCueTips:_tipR.altCueTips,speak:_tipR.speak||false,source:"tips",currentAltIndex:0};_dyn.words.push(_tipDef);_dWord=_tipDef;}
}
if(_dWord&&_dWord.alts&&_dWord.alts.length>1){
var _curA=typeof _dWord.currentAltIndex==="number"?_dWord.currentAltIndex:0;
var _nextA=(_curA+_dir+_dWord.alts.length)%_dWord.alts.length;
_dWord.currentAltIndex=_nextA;
var _newWord=_dWord.alts[_nextA];
if(_newWord==null)return null;
var _taText=globalThis._hlText||"";
var _taCurWord=_wds[_wi];
var _taWordPos=0;
for(var _tawi=0;_tawi<_wi;_tawi++){_taWordPos=_taText.indexOf(_wds[_tawi],_taWordPos)+_wds[_tawi].length;}
var _taWStart=_taText.indexOf(_taCurWord,_taWordPos);
if(_taWStart<0)return null;
var _taNewText=_taText.slice(0,_taWStart)+_newWord+_taText.slice(_taWStart+_taCurWord.length);
globalThis._hlText=_taNewText;
globalThis._hlState.text=_taNewText;
globalThis._lastResolvedText=_taNewText;
return {text:_taNewText,wStart:_taWStart,lenDiff:_newWord.length-_taCurWord.length};
}
}
if(!_ovr||!_ovr.script)return null;
var _args=_dir>0?_ovr.upArgs:_ovr.downArgs;
if(!_args||!_args.length)return null;
if(!globalThis._cueControlTip)globalThis._cueControlTip=_ovr.tip||_ovr.control;
if(!globalThis._cueControlTimers)globalThis._cueControlTimers={};
var _ctrl=_ovr.control;var _script=_ovr.script;var _aargs=_args;
if(globalThis._cueControlTimers[_ctrl])clearTimeout(globalThis._cueControlTimers[_ctrl]);
globalThis._cueControlTimers[_ctrl]=setTimeout(function(){
try{_req("child_process").spawn("bash",[_script].concat(_aargs),{detached:true,stdio:"ignore"}).unref();}catch(_e){}
setTimeout(function(){
try{
if(globalThis._cueControlTipWord==null)return;
if(globalThis._openCuesCurrent&&globalThis._openCuesCurrent["tips-mode"]==="off")return;
var _lt=_req("child_process").execSync("bash "+_script+" get",{timeout:1000,encoding:"utf8"}).trim();
if(_lt){
globalThis._cueControlTip=_lt;
var _ep="/tmp/claude-highlight-state-"+process.pid+".json";
var _fs=_req("fs");
var _ex=JSON.parse(_fs.readFileSync(_ep,"utf8"));
_ex.cueTip=_lt;_ex.timestamp=Date.now();
_fs.writeFileSync(_ep,JSON.stringify(_ex));
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
}
}catch(_e){}
},200);
},50);
return {refresh:true};
};
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
if(globalThis._pendingCursorTarget!=null){var _pcClean=${inputZoneVar}.text.replace(/[\\u200B\\u200C]/g,"");var _pcBefore=${inputZoneVar}.text.slice(0,${inputZoneVar}.offset);var _pcZws=(_pcBefore.match(/[\\u200B\\u200C]/g)||[]).length;var _pcCur=${inputZoneVar}.offset-_pcZws;var _pcExp=globalThis._pendingCursorExpected;if(globalThis._forceCursorMove||(_pcExp!=null&&Math.abs(_pcCur-_pcExp)<=1)){var _pcT=Math.min(globalThis._pendingCursorTarget,_pcClean.length);${inputZoneVar}=${inputZoneClass}.fromText(_pcClean,${configVar},_pcT);${onOffsetChangeVar}(_pcT);}globalThis._pendingCursorTarget=null;globalThis._pendingCursorExpected=null;globalThis._forceCursorMove=false;}
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
if(_hlText!==_oldText&&globalThis._dynDefs&&globalThis._dynDefs.words){
var _cocOld=_oldText.split(/\\s+/).filter(function(w){return w;});
var _cocNew=_hlText.split(/\\s+/).filter(function(w){return w;});
var _cocMin=Math.min(_cocOld.length,_cocNew.length);
for(var _cwi=0;_cwi<_cocMin;_cwi++){
if(_cocOld[_cwi]!==_cocNew[_cwi]){
var _cdef=globalThis._dynDefs.words.find(function(d){return d.index===_cwi;});
if(_cdef){
if(_cdef.alts&&_cdef.alts.indexOf(_cocNew[_cwi])>=0){_cdef.word=_cocNew[_cwi];_cdef.currentAltIndex=_cdef.alts.indexOf(_cocNew[_cwi]);}
else{_cdef.word=_cocNew[_cwi];_cdef.alts=null;_cdef.currentAltIndex=0;_cdef.cueTip=null;_cdef.altCueTips=null;_cdef.source=null;}
}
}
}
if(_cocNew.length<_cocOld.length){
for(var _cri=_cocNew.length;_cri<_cocOld.length;_cri++){
var _crdef=globalThis._dynDefs.words.find(function(d){return d.index===_cri;});
if(_crdef){_crdef.alts=null;_crdef.currentAltIndex=0;_crdef.cueTip=null;_crdef.altCueTips=null;_crdef.source=null;}
}
}
}
if(globalThis._cuesCore&&globalThis._localCueMap&&globalThis._cuesCore.lookupMultiple){
try{
var _eagerWords=_hlText.split(/\\s+/).filter(function(w){return w;});
var _eagerLookup=globalThis._cuesCore.lookupMultiple(_eagerWords,globalThis._localCueMap,{skipPattern:/^_$/,skipFn:globalThis._isCueControl});
if(_eagerLookup.found.length>0){
if(!globalThis._dynDefs)globalThis._dynDefs={words:[]};
globalThis._dynDefs.words=globalThis._cuesCore.mergeWordDefs(globalThis._dynDefs.words,_eagerLookup.found);
}
}catch(_eleE){}
}
var _blankSlots=[];
if(globalThis._cueControlOverrides){
var _bwds=_hlText.split(/\\s+/).filter(function(w){return w;});
for(var _bi=0;_bi<_bwds.length;_bi++){
if(_bwds[_bi]!=="_")continue;
var _bfFound=null;
for(var _bj=_bi-1;_bj>=0&&!_bfFound;_bj--){
var _bOvrKeys=Object.keys(globalThis._cueControlOverrides);
for(var _bok=0;_bok<_bOvrKeys.length&&!_bfFound;_bok++){
var _boc=globalThis._cueControlOverrides[_bOvrKeys[_bok]];
if(!_boc||!_boc.blankKeywords)continue;
var _bprox=_boc.blankProximity;
if(_bprox!=null&&(_bi-_bj-1)>_bprox)continue;
for(var _bki=0;_bki<_boc.blankKeywords.length&&!_bfFound;_bki++){
var _bkw=_boc.blankKeywords[_bki];
var _bkwW=_bkw.split(" ");
var _bkwS=_bj-_bkwW.length+1;
if(_bkwS<0)continue;
var _bMatch=true;
for(var _bmi=0;_bmi<_bkwW.length;_bmi++){
if((_bwds[_bkwS+_bmi]||"").toLowerCase()!==_bkwW[_bmi]){_bMatch=false;break;}
}
if(_bMatch)_bfFound={index:_bi,keyword:_bkw,controlName:_bOvrKeys[_bok],keywordStart:_bkwS,keywordEnd:_bj,proximity:_bi-_bj-1};
}
}
}
if(_bfFound)_blankSlots.push(_bfFound);
}
}
globalThis._blankSlots=_blankSlots;
if(globalThis._debugLog&&_blankSlots.length>0)globalThis._debugLog("blankSlots: "+_blankSlots.length+" detected");
if(_blankSlots.length>0&&globalThis._forceInputRefresh){
var _apopWords=_bwds.slice();
var _apopClearSet={};
var _apopped=false;
for(var _apsi=_blankSlots.length-1;_apsi>=0;_apsi--){
var _apSlot=_blankSlots[_apsi];
var _apCtrl=(globalThis._cueControlOverrides||{})[_apSlot.controlName];
if(!_apCtrl||_apCtrl.blankAutoPopulate===false)continue;
if(!_apCtrl.stepValues||!_apCtrl.stepValues.length)continue;
_apopWords[_apSlot.index]=_apCtrl.stepValues[0];
if(_apCtrl.blankKeywordExpansions&&_apCtrl.blankKeywordExpansions[_apSlot.keyword]){
_apopWords[_apSlot.keywordStart]=_apCtrl.blankKeywordExpansions[_apSlot.keyword];
for(var _apke=_apSlot.keywordStart+1;_apke<=_apSlot.keywordEnd;_apke++)_apopClearSet[_apke]=true;
}
if(_apCtrl.blankClearKeywords){for(var _apkc=_apSlot.keywordStart;_apkc<=_apSlot.keywordEnd;_apkc++)_apopClearSet[_apkc]=true;}
_apopped=true;
}
if(_apopped){
var _apopFinal=[];
for(var _apfi=0;_apfi<_apopWords.length;_apfi++){if(!_apopClearSet[_apfi])_apopFinal.push(_apopWords[_apfi]);}
var _apopText=_apopFinal.join(" ");
globalThis._hlText=_apopText;
if(globalThis._hlState)globalThis._hlState.text=_apopText;
globalThis._lastResolvedText=_apopText;
if(globalThis._debugLog)globalThis._debugLog("autoPopulate: "+_apopText);
globalThis._forceInputRefresh();
}
}
if(!globalThis._pendingBlankFills)globalThis._pendingBlankFills={};
for(var _bsi=0;_bsi<_blankSlots.length;_bsi++){
var _bsSlot=_blankSlots[_bsi];
var _bsCtrl=(globalThis._cueControlOverrides||{})[_bsSlot.controlName];
if(!_bsCtrl||_bsCtrl.blankAutoPopulate===false)continue;
if(_bsCtrl.stepValues&&_bsCtrl.stepValues.length)continue;
if(!_bsCtrl.blankScript)continue;
var _bsKey=_hlText+"::"+_bsSlot.index;
if(globalThis._pendingBlankFills[_bsKey])continue;
globalThis._pendingBlankFills[_bsKey]=true;
var _ctxWords=[];
for(var _cwi=0;_cwi<_bwds.length;_cwi++){
if(_cwi>=_bsSlot.keywordStart&&_cwi<=_bsSlot.keywordEnd)continue;
if(_cwi===_bsSlot.index)continue;
_ctxWords.push(_bwds[_cwi]);
}
(function(_slot,_ctrl,_key,_ctx){
try{
var _bsHome=process.env.HOME||"/home/"+(process.env.USER||"root");
var _bsPath=(_ctrl.blankScript||"").replace(/^~/,_bsHome);
var _bsEnv=Object.assign({},process.env);
if(_ctrl.model)_bsEnv.CUES_MODEL=_ctrl.model;
if(_ctrl.apiUrl)_bsEnv.CUES_API_URL=_ctrl.apiUrl;
if(_ctrl.apiKeyEnv)_bsEnv.CUES_API_KEY_ENV=_ctrl.apiKeyEnv;
if(_ctrl.altCount)_bsEnv.CUES_ALT_COUNT=String(_ctrl.altCount);
if(_ctrl.includeOriginal!==undefined)_bsEnv.CUES_INCLUDE_ORIGINAL=String(_ctrl.includeOriginal);
if(_ctrl.prompts){for(var _pk in _ctrl.prompts){_bsEnv["CUES_PROMPT_"+_pk.toUpperCase().replace(/[^A-Z0-9]/g,"_")]=_ctrl.prompts[_pk];}}
${requireFuncName}("child_process").execFile("bash",[_bsPath,"get",_slot.keyword].concat(_ctx),{timeout:8000,encoding:"utf8",env:_bsEnv},function(_err,_stdout){
delete globalThis._pendingBlankFills[_key];
if(_err)return;
var _out=(_stdout||"").trim();
if(!_out)return;
var _ct=globalThis._hlText||"";
var _cw=_ct.split(/\\s+/).filter(function(w){return w;});
if(_cw[_slot.index]!=="_")return;
var _wp=0;
for(var _wi=0;_wi<_slot.index;_wi++){_wp=_ct.indexOf(_cw[_wi],_wp)+_cw[_wi].length;}
var _up=_ct.indexOf("_",_wp);
if(_up<0)return;
var _nt=_ct.slice(0,_up)+_out+_ct.slice(_up+1);
if(_ctrl.blankKeywordExpansions&&_ctrl.blankKeywordExpansions[_slot.keyword]){
var _ntXW=_nt.split(/\\s+/).filter(function(w){return w;});
var _ntXKept=[];
for(var _ntxi=0;_ntxi<_ntXW.length;_ntxi++){
if(_ntxi===_slot.keywordStart)_ntXKept.push(_ctrl.blankKeywordExpansions[_slot.keyword]);
else if(_ntxi>_slot.keywordStart&&_ntxi<=_slot.keywordEnd)continue;
else _ntXKept.push(_ntXW[_ntxi]);
}
_nt=_ntXKept.join(" ");
}
if(_ctrl.blankClearKeywords){
var _ntW=_nt.split(/\\s+/).filter(function(w){return w;});
var _ntKept=[];
for(var _ntci=0;_ntci<_ntW.length;_ntci++){if(_ntci<_slot.keywordStart||_ntci>_slot.keywordEnd)_ntKept.push(_ntW[_ntci]);}
_nt=_ntKept.join(" ");
}
globalThis._hlText=_nt;
if(globalThis._hlState)globalThis._hlState.text=_nt;
globalThis._lastResolvedText=_nt;
if(globalThis._debugLog)globalThis._debugLog("autoPopulate (script "+_slot.controlName+"): "+_out);
if(globalThis._forceInputRefresh)globalThis._forceInputRefresh();
});}catch(_be){delete globalThis._pendingBlankFills[_key];}
})(_bsSlot,_bsCtrl,_bsKey,_ctxWords);
}
if(globalThis._cueResolver&&process.env.GROQ_API_KEY){
var _asText=_hlText;
if(_asText!==globalThis._lastResolvedText){
if(globalThis._autoSubmitTimer)clearTimeout(globalThis._autoSubmitTimer);
globalThis._autoSubmitTimer=setTimeout(function(){
var _asWords=_asText.split(/\\s+/).filter(function(w){return w;});
if(_asWords.length<2)return;
var _gen=(globalThis._resolveGen=(globalThis._resolveGen||0)+1);
globalThis._lastResolvedText=_asText;
if(globalThis._debugLog)globalThis._debugLog("autoSubmit ["+_asWords.length+" words]: "+_asText);
globalThis._cueResolver.resolve({text:_asText,words:_asWords,domain:"claude-code"}).then(function(_res){
if(_gen!==globalThis._resolveGen)return;
var _newDefs=globalThis._cuesCore.convertCueResultsToWordDefs(_res.results||[]);
if(!globalThis._dynDefs)globalThis._dynDefs={words:[]};
globalThis._dynDefs.words=globalThis._cuesCore.mergeWordDefs(globalThis._dynDefs.words,_newDefs);
if(globalThis._debugLog)globalThis._debugLog("llm result: "+(_res.results||[]).length+" results, "+_newDefs.length+" wordDefs");
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
}).catch(function(_lre){if(globalThis._debugLog)globalThis._debugLog("llm error: "+(_lre&&_lre.message||_lre));});
},500);
}
}
// blankClearOnEdit: remove spawned words scheduled by pair cleanup
if(globalThis._pendingClearOnEdit){
var _pce=globalThis._pendingClearOnEdit;
globalThis._pendingClearOnEdit=null;
var _pceText=_hlText;var _pceWords=_pceText.split(/\\s+/).filter(function(w){return w;});
for(var _pcei=0;_pcei<_pce.length;_pcei++){
var _pceIdx=_pce[_pcei];if(_pceIdx>=_pceWords.length)continue;
var _pceP=0;for(var _pcep=0;_pcep<_pceIdx;_pcep++){_pceP=_pceText.indexOf(_pceWords[_pcep],_pceP)+_pceWords[_pcep].length;}
var _pceS=_pceText.indexOf(_pceWords[_pceIdx],_pceP);var _pceE=_pceS+_pceWords[_pceIdx].length;
if(_pceE<_pceText.length&&_pceText.charAt(_pceE)===" ")_pceE++;
else if(_pceS>0&&_pceText.charAt(_pceS-1)===" ")_pceS--;
_pceText=_pceText.slice(0,_pceS)+_pceText.slice(_pceE);
_pceWords.splice(_pceIdx,1);
}
if(_pceText!==_hlText){
globalThis._hlText=_pceText;
globalThis._dynLastAnalyzed=_pceText.split(/\\s+/).filter(function(w){return w;});
globalThis._dynPrevWords=globalThis._dynLastAnalyzed.slice();
${onChangeParam}(_pceText+(_hlText.indexOf("\\u200B")>=0?"\\u200C":"\\u200B"));
return;
}
}
// Auto-populate: replace _ with control value when pending
if(globalThis._pendingAutoPopulate){
var _ap=globalThis._pendingAutoPopulate;
var _apWords=_hlText.split(/\\s+/).filter(function(w){return w;});
if(_ap.index<_apWords.length&&_apWords[_ap.index]==="_"){
globalThis._pendingAutoPopulate=null;
// Keyword expansion: replace typed shorthand with full display name before blank fill
var _apBase=_hlText;
if(_ap.keywordExpansion){
var _ke=_ap.keywordExpansion;
var _keW=_apBase.split(/\\s+/).filter(function(w){return w;});
if(_ke.wordIndex<_keW.length){
var _keP=0;
for(var _kei=0;_kei<_ke.wordIndex;_kei++){_keP=_apBase.indexOf(_keW[_kei],_keP)+_keW[_kei].length;}
var _keS=_apBase.indexOf(_keW[_ke.wordIndex],_keP);
if(_keS>=0){_apBase=_apBase.slice(0,_keS)+_ke.expansion+_apBase.slice(_keS+_keW[_ke.wordIndex].length);}
}
}
// Keyword clearing: remove keyword context words from text before blank fill
var _apOrigIdx=_ap.index;
if(_ap.blankClearKeywords&&_ap.blankKeywordIndices&&_ap.blankKeywordIndices.length>0){
var _kcW=_apBase.split(/\\s+/).filter(function(w){return w;});
var _kcIdxs=_ap.blankKeywordIndices.slice().sort(function(a,b){return b-a;});
for(var _kci=0;_kci<_kcIdxs.length;_kci++){
var _kcIdx=_kcIdxs[_kci];
if(_kcIdx<_kcW.length&&_kcIdx!==_ap.index){
// Find character position of this word
var _kcP=0;for(var _kcj=0;_kcj<_kcIdx;_kcj++){_kcP=_apBase.indexOf(_kcW[_kcj],_kcP)+_kcW[_kcj].length;}
var _kcS=_apBase.indexOf(_kcW[_kcIdx],_kcP);
var _kcE=_kcS+_kcW[_kcIdx].length;
// Remove word + adjacent whitespace
if(_kcE<_apBase.length&&_apBase.charAt(_kcE)===" ")_kcE++;
else if(_kcS>0&&_apBase.charAt(_kcS-1)===" ")_kcS--;
_apBase=_apBase.slice(0,_kcS)+_apBase.slice(_kcE);
_kcW.splice(_kcIdx,1);
// Adjust blank index if keyword was before it
if(_kcIdx<_ap.index)_ap.index--;
}}
}
// After clearing, shift ALL WordDef indices and metadata pointers
if(_apOrigIdx!==_ap.index&&globalThis._dynDefs&&globalThis._dynDefs.words){
var _kcRemovedSet={};for(var _kri=0;_kri<_ap.blankKeywordIndices.length;_kri++){_kcRemovedSet[_ap.blankKeywordIndices[_kri]]=true;}
// Remove WordDefs at keyword indices BEFORE shifting (they're for removed words)
globalThis._dynDefs.words=globalThis._dynDefs.words.filter(function(_kf){return !_kcRemovedSet[_kf.index];});
var _kcShiftFor=function(_idx){var _s=0;for(var _ksi=0;_ksi<_ap.blankKeywordIndices.length;_ksi++){if(_ap.blankKeywordIndices[_ksi]<_idx&&_ap.blankKeywordIndices[_ksi]!==_apOrigIdx)_s++;}return _idx-_s;};
for(var _kdi=0;_kdi<globalThis._dynDefs.words.length;_kdi++){
var _kd=globalThis._dynDefs.words[_kdi];
_kd.index=_kcShiftFor(_kd.index);
if(_kd.metadata){
if(typeof _kd.metadata.childIndex==="number")_kd.metadata.childIndex=_kcShiftFor(_kd.metadata.childIndex);
if(typeof _kd.metadata.parentIndex==="number")_kd.metadata.parentIndex=_kcShiftFor(_kd.metadata.parentIndex);
}}
// Also shift span tracking
if(globalThis._dynSpans){var _kcNewSpans={};Object.keys(globalThis._dynSpans).forEach(function(k){var ki=parseInt(k,10);if(!_kcRemovedSet[ki]){_kcNewSpans[_kcShiftFor(ki)]=globalThis._dynSpans[k];}});globalThis._dynSpans=_kcNewSpans;}
}
var _apBaseWords=_apBase.split(/\\s+/).filter(function(w){return w;});
var _apPos=0;
for(var _apj=0;_apj<_ap.index;_apj++){_apPos=_apBase.indexOf(_apBaseWords[_apj],_apPos)+_apBaseWords[_apj].length;}
var _apStart=_apBase.indexOf("_",_apPos);
if(_apStart>=0){
if(_ap.satellite!=null){
// Selector+satellite: insert selector + separator + satellite replacing the single _.
// Separator is normalized to space-padded so all tokens are clean word boundaries.
var _apSel=_ap.value;var _apSat=_ap.satellite;
var _apSepRaw=(_ap.displaySeparator||"").replace(/[\\u0009]/g,"\\t");
var _apSepTrim=_apSepRaw.replace(/^\\s+|\\s+$/g,"");
var _apSepDisplay=_apSepTrim?(" "+_apSepTrim+" "):" ";
var _apFullInsert=_apSel+_apSepDisplay+_apSat;
var _apFullWords=_apFullInsert.split(/\\s+/).filter(function(w){return w;});
var _apTotalWc=_apFullWords.length;
var _apSelWc=_apSel.split(/\\s+/).filter(function(w){return w;}).length||1;
var _apSatWc=_apSat.split(/\\s+/).filter(function(w){return w;}).length||1;
var _apSepWc=_apTotalWc-_apSelWc-_apSatWc;
// Replacing 1 underscore with _apTotalWc words. Downstream index shift:
var _apShift=_apTotalWc-1;
var _apNew=_apBase.slice(0,_apStart)+_apFullInsert+_apBase.slice(_apStart+1);
globalThis._hlText=_apNew;
globalThis._dynLastAnalyzed=_apNew.split(/\\s+/).filter(function(w){return w;});
globalThis._dynPrevWords=globalThis._dynLastAnalyzed.slice();
var _apN=_ap.index;var _apSatN=_apN+_apSelWc+_apSepWc;
// Shift existing WordDefs at index > N by _apShift
if(globalThis._dynDefs&&globalThis._dynDefs.words){
globalThis._dynDefs.words.forEach(function(d){if(d.index>_apN)d.index+=_apShift;});
globalThis._dynDefs.words.forEach(function(d){if(d.metadata){if(d.metadata.childIndex!=null&&d.metadata.childIndex>_apN)d.metadata.childIndex+=_apShift;if(d.metadata.parentIndex!=null&&d.metadata.parentIndex>_apN)d.metadata.parentIndex+=_apShift;}});
}
// Shift dynSpans keys > N by _apShift
if(globalThis._dynSpans){var _nsps={};Object.keys(globalThis._dynSpans).forEach(function(k){var ki=parseInt(k,10);var sv=globalThis._dynSpans[k];_nsps[ki>_apN?ki+_apShift:ki]=sv;});globalThis._dynSpans=_nsps;}
// Get selector + satellite values from _openCuesSettings
var _apOcSet=globalThis._openCuesSettings||{};
var _apSelVals=Object.keys(_apOcSet);if(_apSelVals.length===0)_apSelVals=[_apSel];
var _apSatVals=_apOcSet[_apSel]||[_apSat];
// Create selector WordDef at N (word field holds the joined multi-word text; spanLength if > 1)
if(!globalThis._dynDefs)globalThis._dynDefs={words:[]};
var _apExSel=globalThis._dynDefs.words.findIndex(function(d){return d.index===_apN;});
var _apSelTip=(globalThis._openCuesTips&&globalThis._openCuesTips[_apSel])||null;
var _apSelDef={index:_apN,word:_apSel,alts:_apSelVals,currentAltIndex:Math.max(0,_apSelVals.indexOf(_apSel)),source:"control-blank",cueTip:_apSelTip,metadata:{controlName:_ap.controlName,blankScript:_ap.blankScript,selectorWord:true,childIndex:_apSatN,currentSetting:_apSel,separator:_apSepDisplay,blankClearOnEdit:_ap.blankClearOnEdit||false}};
if(_apSelWc>1){
_apSelDef.spanLength=_apSelWc;
if(!globalThis._dynSpans)globalThis._dynSpans={};
for(var _sli=0;_sli<_apSelWc;_sli++){globalThis._dynSpans[_apN+_sli]={originalIndex:_apN,spanLength:_apSelWc};}
}
if(_apExSel>=0){globalThis._dynDefs.words[_apExSel]=_apSelDef;}else{globalThis._dynDefs.words.push(_apSelDef);}
// Create satellite WordDef at N + selectorSpanLen + sepWc (word field holds joined text; spanLength if > 1)
var _apSatTip=(globalThis._openCuesSatTips&&globalThis._openCuesSatTips[_apSel]&&globalThis._openCuesSatTips[_apSel][_apSat])||(globalThis._openCuesTips&&globalThis._openCuesTips[_apSel])||null;
var _apSatDef={index:_apSatN,word:_apSat,alts:_apSatVals,currentAltIndex:Math.max(0,_apSatVals.indexOf(_apSat)),source:"control-blank",cueTip:_apSatTip,metadata:{controlName:_ap.controlName,blankScript:_ap.blankScript,satelliteWord:true,parentIndex:_apN,blankClearOnEdit:_ap.blankClearOnEdit||false}};
if(_apSatWc>1){
_apSatDef.spanLength=_apSatWc;
if(!globalThis._dynSpans)globalThis._dynSpans={};
for(var _sxi=0;_sxi<_apSatWc;_sxi++){globalThis._dynSpans[_apSatN+_sxi]={originalIndex:_apSatN,spanLength:_apSatWc};}
}
globalThis._dynDefs.words.push(_apSatDef);
var _apCB1=${inputZoneVar}.text.slice(0,${inputZoneVar}.offset);var _apCZ1=(_apCB1.match(/[\\u200B\\u200C]/g)||[]).length;var _apCO1=${inputZoneVar}.offset-_apCZ1;globalThis._pendingCursorTarget=_apCO1>=_apStart?Math.max(_apCO1,_apStart+1)+(_apFullInsert.length-1):_apCO1;globalThis._pendingCursorExpected=_apCO1;
${onChangeParam}(_apNew+(_hlText.indexOf("\\u200B")>=0?"\\u200C":"\\u200B"));
return;
}
var _apNew=_apBase.slice(0,_apStart)+_ap.value+_apBase.slice(_apStart+1);
globalThis._hlText=_apNew;
globalThis._dynLastAnalyzed=_apNew.split(/\\s+/).filter(function(w){return w;});
globalThis._dynPrevWords=globalThis._dynLastAnalyzed.slice();
var _apWc=_ap.value.split(/\\s+/).length;
if(_apWc>1){
if(!globalThis._dynSpans)globalThis._dynSpans={};
for(var _asi=0;_asi<_apWc;_asi++){globalThis._dynSpans[_ap.index+_asi]={originalIndex:_ap.index,spanLength:_apWc};}
// Set spanLength on the WordDef and update word to the resolved value
if(globalThis._dynDefs&&globalThis._dynDefs.words){var _apDef=globalThis._dynDefs.words.find(function(d){return d.index===_ap.index;});if(_apDef){_apDef.spanLength=_apWc;_apDef.word=_ap.value;if(_apDef.alts&&_apDef.alts.indexOf(_ap.value)<0)_apDef.alts.unshift(_ap.value);}}
}else{
// Single-word value: update word to resolved value
if(globalThis._dynDefs&&globalThis._dynDefs.words){var _apDef1=globalThis._dynDefs.words.find(function(d){return d.index===_ap.index;});if(_apDef1){_apDef1.word=_ap.value;if(_apDef1.alts&&_apDef1.alts.indexOf(_ap.value)<0)_apDef1.alts.unshift(_ap.value);}}
}
// Store consume-all alts directly from _pendingAutoPopulate data (no _dynDefs lookup)
if(_ap.consumeAllAlts&&_ap.consumeAllAlts.length>1){
globalThis._consumeAllAlts={index:_ap.index,alts:_ap.consumeAllAlts,currentAltIndex:0,spanLength:_apWc,cueTip:_ap.consumeAllTip||null,controlName:_ap.controlName||null};
}
var _apCB2=${inputZoneVar}.text.slice(0,${inputZoneVar}.offset);var _apCZ2=(_apCB2.match(/[\\u200B\\u200C]/g)||[]).length;var _apCO2=${inputZoneVar}.offset-_apCZ2;globalThis._pendingCursorTarget=_apCO2>=_apStart?Math.max(_apCO2,_apStart+1)+(_ap.value.length-1):_apCO2;globalThis._pendingCursorExpected=_apCO2;
${onChangeParam}(_apNew+(_hlText.indexOf("\\u200B")>=0?"\\u200C":"\\u200B"));
return;
}
}
}
if(_hlText!==_oldText&&globalThis._consumeAllAlts){var _caC=globalThis._consumeAllAlts;var _caOW=_oldText.split(/\\s+/).filter(function(w){return w;});var _caNW=_hlText.split(/\\s+/).filter(function(w){return w;});var _caChanged=false;for(var _caCk=_caC.index;_caCk<_caC.index+(_caC.spanLength||1);_caCk++){if((_caOW[_caCk]||"")!==(_caNW[_caCk]||"")){_caChanged=true;break;}}if(_caChanged||_caNW.length<_caC.index+(_caC.spanLength||1)){for(var _caCi=0;_caCi<(_caC.spanLength||1);_caCi++){if(globalThis._dynSpans)delete globalThis._dynSpans[_caC.index+_caCi];}if(globalThis._dynDefs&&globalThis._dynDefs.words){globalThis._dynDefs.words=globalThis._dynDefs.words.filter(function(d){return d.index<_caC.index||d.index>=_caC.index+(_caC.spanLength||1);});}globalThis._consumeAllAlts=null;}}
var _cnWasManual=globalThis._hlManualNav;
if(globalThis._hlState&&globalThis._hlState.active){
if(_hlText!==_oldText){
globalThis._hlState={active:false,index:null,wordIndex:null,text:""};
globalThis._dismissedBlanks=null;
globalThis._hlManualNav=false;
globalThis._cursorNavLastWordIdx=undefined;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
}
}
// Auto-navigate: highlight follows cursor to navigable words
// Skip if previous highlight was from manual nav/cycling (text changed due to cycle, not typing)
if(!_cnWasManual&&globalThis._openCuesCurrent&&globalThis._openCuesCurrent["cursor-navigate"]==="active"){
var _cnClean=_hlText;
var _cnOffset=(globalThis._mockCursorOffset!=null?globalThis._mockCursorOffset:${inputZoneVar}.offset);
// Strip ZWC from offset count
var _cnBefore=${inputZoneVar}.text.slice(0,_cnOffset);
var _cnZwc=(_cnBefore.match(/[\\u200B\\u200C]/g)||[]).length;
_cnOffset=_cnOffset-_cnZwc;
var _cnWords=_cnClean.split(/\\s+/).filter(function(w){return w;});
// Map cursor offset to word index
var _cnWordIdx=-1;
var _cnPos=0;
for(var _cni=0;_cni<_cnWords.length;_cni++){
var _cnWS=_cnClean.indexOf(_cnWords[_cni],_cnPos);
var _cnWE=_cnWS+_cnWords[_cni].length;
if(_cnOffset>=_cnWS&&_cnOffset<=_cnWE){_cnWordIdx=_cni;break;}
_cnPos=_cnWE;
}
// Re-evaluate if cursor word changed OR if on same word but highlight inactive (new data may have arrived)
if(_cnWordIdx!==globalThis._cursorNavLastWordIdx||(_cnWordIdx>=0&&(!globalThis._hlState||!globalThis._hlState.active))){
globalThis._cursorNavLastWordIdx=_cnWordIdx;
globalThis._hlManualNav=false;
if(_cnWordIdx>=0){
var _cnW=_cnWords[_cnWordIdx];var _cnWLow=_cnW.toLowerCase();
var _cnNav=false;
// Keyword context skip
var _cnKw=false;
if(globalThis._dynDefs&&globalThis._dynDefs.words){for(var _cnki=0;_cnki<globalThis._dynDefs.words.length;_cnki++){var _cnkd=globalThis._dynDefs.words[_cnki];if(_cnkd&&_cnkd.metadata&&_cnkd.metadata.blankKeywordIndices&&_cnkd.index!==_cnWordIdx){for(var _cnkj=0;_cnkj<_cnkd.metadata.blankKeywordIndices.length;_cnkj++){if(_cnkd.metadata.blankKeywordIndices[_cnkj]===_cnWordIdx){_cnKw=true;break;}}if(_cnKw)break;}}}
if(!_cnKw){
var _cnSpan=globalThis._dynSpans&&globalThis._dynSpans[_cnWordIdx];
var _cnNonOrig=_cnSpan&&_cnSpan.originalIndex!==_cnWordIdx;
if(!_cnNonOrig){
if(globalThis._isCueControl&&globalThis._isCueControl(_cnW))_cnNav=true;
if(!_cnNav&&globalThis._localCueMap&&globalThis._localCueMap.has(_cnWLow))_cnNav=true;
if(!_cnNav&&globalThis._dynDefs&&globalThis._dynDefs.words){var _cnD=globalThis._dynDefs.words.find(function(d){return d.index===_cnWordIdx&&((d.alts&&d.alts.length>1)||(d.metadata&&d.metadata.controlName));});if(_cnD)_cnNav=true;}
if(!_cnNav&&_cnSpan)_cnNav=true;
}else{_cnNav=true;}// non-origin span → snap to origin
}
if(_cnNav){
var _cnTarget=_cnWordIdx;
if(globalThis._dynSpans&&globalThis._dynSpans[_cnWordIdx])_cnTarget=globalThis._dynSpans[_cnWordIdx].originalIndex;
globalThis._hlState={active:true,index:0,wordIndex:_cnTarget,text:_hlText};
}else if(!globalThis._hlManualNav){
globalThis._hlState={active:false,index:null,wordIndex:null,text:""};
}
}else if(!globalThis._hlManualNav){
globalThis._hlState={active:false,index:null,wordIndex:null,text:""};
}
}
}
${exportCode}
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

  // Find the escape key case in the key dispatcher.
  // v2.1.110+: case"escape":if(Z)return;return c(),m;
  // Must anchor to the full dispatcher pattern — a bare /case"escape":/ also
  // matches an earlier ANSI-sequence parser state machine, which is not where
  // the user's escape keypress is handled.
  const escapePattern = /case"escape":if\([$\w]+\)return;return [$\w]+\(\),[$\w]+;/;
  const match = oldFile.match(escapePattern);

  if (!match || match.index === undefined) {
    console.error('patch: wordHighlight: failed to find escape case');
    return null;
  }

  const escapeCaseLen = 'case"escape":'.length;

  // Inject clear code right after case"escape": (keeps the rest of the original branch intact)
  const insertPos = match.index + escapeCaseLen;
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
  } else if (identifiers.length === 6) {
    // 5 parameters (v2.1.110+): m.render(X,H,M,j6,G)
    const inputZoneVar = identifiers[0];
    renderCall = `${inputZoneVar}.render(${identifiers[1]},${identifiers[2]},${identifiers[3]},${identifiers[4]},${identifiers[5]})`;
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
if(globalThis._consumeAllAlts&&globalThis._consumeAllAlts.index===_hlWordIdx&&globalThis._consumeAllAlts.spanLength>_hlSpanLen)_hlSpanLen=globalThis._consumeAllAlts.spanLength;
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
else if((globalThis._stepPatterns||[]).some(function(s){return s.re.test(_w);})||(globalThis._cueControlOverrides||{})[_w.toLowerCase()]||(_ni!==_hlWordIdx&&globalThis._localCueMap&&globalThis._localCueMap.has(_w.toLowerCase()))||(_ni!==_hlWordIdx&&globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.some(function(d){return d.index===_ni&&d.alts&&d.alts.length>1;}))){_numRanges.push({start:_wStart,end:_wStart+_w.length});}
_searchPos=_wStart+_w.length;
}` : `var _hlSpanLen=1;
if(globalThis._dynDefs&&globalThis._dynDefs.words&&_hlWordIdx>=0){
var _hlDef=globalThis._dynDefs.words.find(function(d){return d.index===_hlWordIdx;});
if(_hlDef&&_hlDef.spanLength)_hlSpanLen=_hlDef.spanLength;
if(globalThis._consumeAllAlts&&globalThis._consumeAllAlts.index===_hlWordIdx&&globalThis._consumeAllAlts.spanLength>_hlSpanLen)_hlSpanLen=globalThis._consumeAllAlts.spanLength;
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
  // v2.1.110+: this pattern no longer exists — raw sequences are handled differently
  // This patch is now optional; if the pattern is missing we skip gracefully
  const defaultPattern = /default:return function\(([$\w]+)\)\{switch\(!0\)\{case\(\1==="\\x1B\[H"/;
  const match = oldFile.match(defaultPattern);

  if (!match || match.index === undefined) {
    console.warn('patch: wordHighlight: raw sequence handler not found — skipping (terminal may use modifier keys instead)');
    return oldFile;
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
globalThis._hlManualNav=true;
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
globalThis._hlManualNav=true;
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

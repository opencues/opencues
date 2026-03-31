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
 * @see docs/word-highlight-system.md for full technical documentation
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
 * @see docs/implementation-notes.md for detailed patching guide
 * @see hci.md for full HCI specification
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
  highlightMode?: 'words' | 'numbers' | 'gender' | 'both';  // 'words' = all, 'numbers' = numeric only, 'gender' = gender only, 'both' = numbers + gender
  highlightExportEnabled?: boolean;
  highlightExportPath?: string;
  numberDimming?: boolean;  // dim all numbers in input (dark gray)
  actionWordOverrides?: Record<string, { action: string; upArgs?: string[]; downArgs?: string[]; scriptPath?: string }>;
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
  highlightMode: 'both',  // 'words' = all words, 'numbers' = only numeric tokens, 'both' = numbers + gender + action words
  highlightExportEnabled: true,
  highlightExportPath: '/tmp/claude-highlight-state.json',
  numberDimming: true,  // dim all numbers in input (dark gray)
  actionWordOverrides: {},
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
  // Mode-dependent navigation:
  // - 'numbers': filter to words matching /^-?\d+(\.\d+)?$/ (integers, decimals, negatives)
  // - 'words': navigate all words
  // - 'gender': filter to root words (boy/girl only)
  // - 'both': filter to numbers AND root gender words
  // Store wordIndex (actual position in all words) for rendering
  // index 0 = rightmost word/number (same as original word highlight behavior)
  // Default to 'numbers' mode if not specified (handles undefined from config)
  const isNumbersMode = cfg.highlightMode === 'numbers' || cfg.highlightMode === undefined;
  const isGenderMode = cfg.highlightMode === 'gender';
  const isBothMode = cfg.highlightMode === 'both';
  // Action words are always navigable regardless of mode
  const actOvrCheck = `(globalThis._actionWordOverrides||{})[w.toLowerCase()]`;
  const filterCode = isBothMode
    ? `var _numP=/^-?\\d+(\\.\\d+)?$/;
var _rootPat=/^(boy|girl)$/i;
var _targetIdx=[];
_allW.forEach(function(w,i){if(_numP.test(w)||_rootPat.test(w)||${actOvrCheck})_targetIdx.push(i);});`
    : isGenderMode
    ? `var _rootPat=/^(boy|girl)$/i;
var _targetIdx=[];
_allW.forEach(function(w,i){if(_rootPat.test(w)||${actOvrCheck})_targetIdx.push(i);});`
    : isNumbersMode
    ? `var _numP=/^-?\\d+(\\.\\d+)?$/;
var _targetIdx=[];
_allW.forEach(function(w,i){if(_numP.test(w)||${actOvrCheck})_targetIdx.push(i);});`
    : `var _targetIdx=[];
_allW.forEach(function(w,i){_targetIdx.push(i);});`;

  // Left/Right handlers: Use originalNumbers map to track floor per word index
  // Don't reset when navigating - the map persists so we remember originals across navigation
  const keyHandlerCode = `case(${keyParam}.leftArrow&&${keyParam}.ctrl&&(${keyParam}.meta||${keyParam}.option||${keyParam}.alt)):return()=>{
if(!globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:"",originalNumbers:{},originalGender:undefined};
if(!globalThis._hlState.originalNumbers)globalThis._hlState.originalNumbers={};
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
if(!globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:"",originalNumbers:{},originalGender:undefined};
if(!globalThis._hlState.originalNumbers)globalThis._hlState.originalNumbers={};
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
globalThis._hlState={active:false,index:null,wordIndex:null,text:"",originalNumbers:{},originalGender:undefined};
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
if(!globalThis._hlState||!globalThis._hlState.active)return ${inputZoneVar};
if(globalThis._hlState.wordIndex===null||globalThis._hlState.wordIndex===undefined)return ${inputZoneVar};
if(!globalThis._hlState.originalNumbers)globalThis._hlState.originalNumbers={};
var _allW=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
var _idx=globalThis._hlState.wordIndex;
if(_idx<0||_idx>=_allW.length)return ${inputZoneVar};
var _word=_allW[_idx];
var _rootPat=/^(boy|girl)$/i;
if(_rootPat.test(_word)){
var _maleGroup=['boy','he','him','his','man',"he's"];
var _femaleGroup=['girl','she','her','woman',"she's"];
var _flipMap={boy:'girl',girl:'boy',he:'she',she:'he',him:'her',his:'her',her:'him',man:'woman',woman:'man',"he's":"she's","she's":"he's"};
var _selLower=_word.toLowerCase();
var _linkedGroup=_maleGroup.indexOf(_selLower)>=0?_maleGroup:_femaleGroup;
if(globalThis._hlState.originalGender===undefined)globalThis._hlState.originalGender=globalThis._hlText;
var _newText=globalThis._hlText;
var _offsetDelta=0;
for(var _gi=_allW.length-1;_gi>=0;_gi--){
var _gw=_allW[_gi].toLowerCase();
if(_linkedGroup.indexOf(_gw)>=0&&_flipMap[_gw]){
var _origWord=_allW[_gi];
var _flipped=_flipMap[_gw];
_flipped=_flipped.split('').map(function(c,ci){return ci<_origWord.length&&_origWord[ci]===_origWord[ci].toUpperCase()?c.toUpperCase():c;}).join('');
var _wPos=0;
for(var _wi2=0;_wi2<_gi;_wi2++){_wPos=_newText.indexOf(_allW[_wi2],_wPos)+_allW[_wi2].length;}
var _wStart2=_newText.indexOf(_origWord,_wPos);
if(_wStart2>=0){if(_wStart2<${inputZoneVar}.offset)_offsetDelta+=(_flipped.length-_origWord.length);_newText=_newText.slice(0,_wStart2)+_flipped+_newText.slice(_wStart2+_origWord.length);}
}
}
globalThis._hlText=_newText;
globalThis._hlState.text=_newText;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
return ${inputZoneClass}.fromText(_newText,${configVar},${inputZoneVar}.offset+_offsetDelta);
}
var _numP=/^-?\\d+(\\.\\d+)?$/;
if(!_numP.test(_word))return ${inputZoneVar};
var _num=parseFloat(_word);
if(globalThis._hlState.originalNumbers[_idx]===undefined)globalThis._hlState.originalNumbers[_idx]=_num;
var _newNum=_num+1;
var _isInt=_word.indexOf(".")<0;
var _newWord=_isInt?String(Math.round(_newNum)):String(_newNum);
var _text=globalThis._hlText;
var _wordPos=0;
for(var _wi=0;_wi<_idx;_wi++){
_wordPos=_text.indexOf(_allW[_wi],_wordPos)+_allW[_wi].length;
}
var _wStart=_text.indexOf(_word,_wordPos);
var _wEnd=_wStart+_word.length;
var _newText=_text.slice(0,_wStart)+_newWord+_text.slice(_wEnd);
globalThis._hlText=_newText;
globalThis._hlState.text=_newText;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _lenDiff=_newWord.length-_word.length;
var _newOffset=_wStart<${inputZoneVar}.offset?${inputZoneVar}.offset+_lenDiff:${inputZoneVar}.offset;
return ${inputZoneClass}.fromText(_newText,${configVar},_newOffset);
};
case(${keyParam}.downArrow&&${keyParam}.ctrl&&(${keyParam}.meta||${keyParam}.option||${keyParam}.alt)):return()=>{
if(!globalThis._hlState||!globalThis._hlState.active)return ${inputZoneVar};
if(globalThis._hlState.wordIndex===null||globalThis._hlState.wordIndex===undefined)return ${inputZoneVar};
if(!globalThis._hlState.originalNumbers)globalThis._hlState.originalNumbers={};
var _allW=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
var _idx=globalThis._hlState.wordIndex;
if(_idx<0||_idx>=_allW.length)return ${inputZoneVar};
var _word=_allW[_idx];
var _rootPat=/^(boy|girl)$/i;
if(_rootPat.test(_word)){
if(globalThis._hlState.originalGender!==undefined){
var _newText=globalThis._hlState.originalGender;
globalThis._hlText=_newText;
globalThis._hlState.text=_newText;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _newOffset=Math.min(${inputZoneVar}.offset,_newText.length);
return ${inputZoneClass}.fromText(_newText,${configVar},_newOffset);
}
return ${inputZoneVar};
}
var _numP=/^-?\\d+(\\.\\d+)?$/;
if(!_numP.test(_word))return ${inputZoneVar};
var _num=parseFloat(_word);
if(globalThis._hlState.originalNumbers[_idx]===undefined)globalThis._hlState.originalNumbers[_idx]=_num;
var _orig=globalThis._hlState.originalNumbers[_idx];
var _newNum=_num-1;
if(_newNum<_orig)_newNum=_orig;
var _isInt=_word.indexOf(".")<0;
var _newWord=_isInt?String(Math.round(_newNum)):String(_newNum);
var _text=globalThis._hlText;
var _wordPos=0;
for(var _wi=0;_wi<_idx;_wi++){
_wordPos=_text.indexOf(_allW[_wi],_wordPos)+_allW[_wi].length;
}
var _wStart=_text.indexOf(_word,_wordPos);
var _wEnd=_wStart+_word.length;
var _newText=_text.slice(0,_wStart)+_newWord+_text.slice(_wEnd);
globalThis._hlText=_newText;
globalThis._hlState.text=_newText;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _lenDiff=_newWord.length-_word.length;
var _newOffset=_wStart<${inputZoneVar}.offset?${inputZoneVar}.offset+_lenDiff:${inputZoneVar}.offset;
return ${inputZoneClass}.fromText(_newText,${configVar},_newOffset);
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
var _hlOrigNum=null;
if(globalThis._hlState&&globalThis._hlState.originalNumbers&&globalThis._hlState.wordIndex!=null){
_hlOrigNum=globalThis._hlState.originalNumbers[globalThis._hlState.wordIndex];
if(_hlOrigNum===undefined)_hlOrigNum=null;
}
var _hlExport={active:globalThis._hlState?globalThis._hlState.active:false,highlightedWordIndex:null,highlightedWord:null,wordCount:_hlWords.length,originalNumber:_hlOrigNum,timestamp:Date.now()};
if(globalThis._hlState&&globalThis._hlState.active&&globalThis._hlState.wordIndex!=null){
var _idx=globalThis._hlState.wordIndex;
_hlExport.highlightedWordIndex=_idx;
_hlExport.highlightedWord=_hlWords[_idx]||null;
}
var _hlExportPath="/tmp/claude-highlight-state-"+process.pid+".json";
try{${requireFuncName}("fs").writeFileSync(_hlExportPath,JSON.stringify(_hlExport));}catch(_e){}
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
  // Serialize action word overrides to inject into cli.js
  const actionOvrJson = JSON.stringify(cfg.actionWordOverrides || {});

  const fullCode = `
globalThis._parentValue=${valueParam};
if(!globalThis._actionWordOverrides)globalThis._actionWordOverrides=${actionOvrJson};
globalThis._forceInputRefresh=function(){
var _t=globalThis._hlText||"";
var _pv=globalThis._parentValue||"";
var _hasB=_pv.indexOf("\\u200B")>=0;
var _tc=_hasB?"\\u200C":"\\u200B";
${onChangeParam}(_t+_tc);
};
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
if(globalThis._hlState&&globalThis._hlState.active){
if(_hlText!==_oldText){
globalThis._hlState={active:false,index:null,wordIndex:null,text:"",originalNumbers:{},originalGender:undefined};
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
  const clearCode = 'if(globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:"",originalNumbers:{},originalGender:undefined};';

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
  // 1. Number dimming (dark gray for all numbers) - or root word dimming for gender mode
  // 2. Highlight rendering (white for highlighted word, overrides dimming)
  // 3. Gender mode: highlight related words (he/him/man or she/her/woman) when root selected
  // This wraps the previous output (either raw or rainbow-processed)
  const numberDimmingEnabled = cfg.numberDimming !== false;  // default true
  const isGenderModeRender = cfg.highlightMode === 'gender';
  const isBothModeRender = cfg.highlightMode === 'both';
  // Use raw ANSI code for dark gray (90 = dark gray foreground)
  // Starts with reset to clear any previous styling (like inverse mode from cursor)
  const dimCode = `"\\x1b[0m\\x1b[90m"+_ch+"\\x1b[0m"`;

  // Gender mode rendering: highlight related words when root selected (span-aware)
  const genderRenderCode = `
var _maleWords=['boy','he','him','his','man',"he's"];
var _femaleWords=['girl','she','her','woman',"she's"];
var _rootPat=/^(boy|girl)$/i;
var _selectedWord=(_hlWordIdx>=0&&_hlWordIdx<_words.length)?_words[_hlWordIdx].toLowerCase():null;
var _relatedGroup=null;
if(_selectedWord&&_maleWords.indexOf(_selectedWord)>=0)_relatedGroup=_maleWords;
if(_selectedWord&&_femaleWords.indexOf(_selectedWord)>=0)_relatedGroup=_femaleWords;
var _hlRanges=[];
var _dimRanges=[];
var _searchPos=0;
var _dynHlDef=globalThis._dynDefs&&globalThis._dynDefs.words?globalThis._dynDefs.words.find(function(d){return d.index===_hlWordIdx;}):null;
var _hlSpanLen=(_dynHlDef&&_dynHlDef.spanLength)?_dynHlDef.spanLength:1;
for(var _wi=0;_wi<_words.length;_wi++){
var _w=_words[_wi];
var _wStart=_clean.indexOf(_w,_searchPos);
if(_wStart<0)break;
var _wLower=_w.toLowerCase();
var _isDynLinked=_dynHlDef&&_dynHlDef.linked&&_dynHlDef.linked.indexOf(_wi)>=0;
var _isInHlSpan=(_wi>=_hlWordIdx&&_wi<_hlWordIdx+_hlSpanLen);
if(_relatedGroup&&_relatedGroup.indexOf(_wLower)>=0){
_hlRanges.push({start:_wStart,end:_wStart+_w.length});
}else if(_isInHlSpan&&globalThis._dynDefs){
_hlRanges.push({start:_wStart,end:_wStart+_w.length});
}else if(_isDynLinked){
_hlRanges.push({start:_wStart,end:_wStart+_w.length});
}else if(_rootPat.test(_w)){
_dimRanges.push({start:_wStart,end:_wStart+_w.length});
}
_searchPos=_wStart+_w.length;
}`;

  // Both mode rendering: dim numbers AND root gender words, highlight appropriately
  const bothRenderCode = `
var _numPat=/^-?\\d+(\\.\\d+)?$/;
var _maleWords=['boy','he','him','his','man',"he's"];
var _femaleWords=['girl','she','her','woman',"she's"];
var _rootPat=/^(boy|girl)$/i;
var _selectedWord=(_hlWordIdx>=0&&_hlWordIdx<_words.length)?_words[_hlWordIdx]:null;
var _selLower=_selectedWord?_selectedWord.toLowerCase():null;
var _isNumSelected=_selectedWord&&_numPat.test(_selectedWord);
var _isGenderSelected=_selectedWord&&_rootPat.test(_selectedWord);
var _relatedGroup=null;
if(_isGenderSelected){
if(_maleWords.indexOf(_selLower)>=0)_relatedGroup=_maleWords;
if(_femaleWords.indexOf(_selLower)>=0)_relatedGroup=_femaleWords;
}
var _hlRanges=[];
var _dimRanges=[];
var _searchPos=0;
var _dynHlDef=globalThis._dynDefs&&globalThis._dynDefs.words?globalThis._dynDefs.words.find(function(d){return d.index===_hlWordIdx;}):null;
var _hlSpanLen=(_dynHlDef&&_dynHlDef.spanLength)?_dynHlDef.spanLength:1;
for(var _wi=0;_wi<_words.length;_wi++){
var _w=_words[_wi];
var _wStart=_clean.indexOf(_w,_searchPos);
if(_wStart<0)break;
var _wLower=_w.toLowerCase();
var _isDynLinked=_dynHlDef&&_dynHlDef.linked&&_dynHlDef.linked.indexOf(_wi)>=0;
var _isInHlSpan=(_wi>=_hlWordIdx&&_wi<_hlWordIdx+_hlSpanLen);
if(_isNumSelected&&_isInHlSpan){
_hlRanges.push({start:_wStart,end:_wStart+_w.length});
}else if(_isGenderSelected&&_relatedGroup&&_relatedGroup.indexOf(_wLower)>=0){
_hlRanges.push({start:_wStart,end:_wStart+_w.length});
}else if(_isInHlSpan&&globalThis._dynDefs){
_hlRanges.push({start:_wStart,end:_wStart+_w.length});
}else if(_isDynLinked){
_hlRanges.push({start:_wStart,end:_wStart+_w.length});
}else if(_numPat.test(_w)||_rootPat.test(_w)){
_dimRanges.push({start:_wStart,end:_wStart+_w.length});
}
_searchPos=_wStart+_w.length;
}`;

  // Standard number mode rendering - span-aware highlighting
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
else if(_numPat.test(_w)){_numRanges.push({start:_wStart,end:_wStart+_w.length});}
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

  // Shared render loop for gender and both modes (uses _hlRanges/_dimRanges arrays)
  const rangeBasedRenderLoop = `var _out='',_cp=0,_i=0,_inv=false,_pending='';
while(_i<_rv.length){
var _am=_rv.slice(_i).match(/^\\x1b\\[[0-9;]*m/);
if(_am){
if(_am[0]==='\\x1b[7m')_inv=true;
if(_am[0]==='\\x1b[27m'||_am[0]==='\\x1b[0m')_inv=false;
_pending+=_am[0];
_i+=_am[0].length;continue;
}
var _ch=_rv[_i];
var _inHl=false;
for(var _hi=0;_hi<_hlRanges.length;_hi++){
if(_cp>=_hlRanges[_hi].start&&_cp<_hlRanges[_hi].end){_inHl=true;break;}
}
var _inDim=false;
for(var _di=0;_di<_dimRanges.length;_di++){
if(_cp>=_dimRanges[_di].start&&_cp<_dimRanges[_di].end){_inDim=true;break;}
}
if(_inv){_out+=_pending+_ch;}
else if(_inHl){_out+=${colorCode};}
else if(_inDim){_out+=${dimCode};}
else{_out+=_pending+_ch;}
_pending='';
_cp++;_i++;
}
return _out;
})()`;

  const newCode = isBothModeRender ? `renderedValue:(function(){
var _rv=${renderCall};
if(typeof _rv!=="string")return _rv;
var _ap=/\\x1b\\[[0-9;]*m/g;
var _clean=_rv.replace(_ap,'');
var _words=_clean.split(/\\s+/).filter(function(w){return w});
if(!_words.length)return _rv;
var _hlWordIdx=(globalThis._hlState&&globalThis._hlState.active&&globalThis._hlState.wordIndex!=null)?globalThis._hlState.wordIndex:-1;
${bothRenderCode}
${rangeBasedRenderLoop}` : isGenderModeRender ? `renderedValue:(function(){
var _rv=${renderCall};
if(typeof _rv!=="string")return _rv;
var _ap=/\\x1b\\[[0-9;]*m/g;
var _clean=_rv.replace(_ap,'');
var _words=_clean.split(/\\s+/).filter(function(w){return w});
if(!_words.length)return _rv;
var _hlWordIdx=(globalThis._hlState&&globalThis._hlState.active&&globalThis._hlState.wordIndex!=null)?globalThis._hlState.wordIndex:-1;
${genderRenderCode}
${rangeBasedRenderLoop}` : `renderedValue:(function(){
var _rv=${renderCall};
if(typeof _rv!=="string")return _rv;
var _ap=/\\x1b\\[[0-9;]*m/g;
var _clean=_rv.replace(_ap,'');
var _words=_clean.split(/\\s+/).filter(function(w){return w});
if(!_words.length)return _rv;
var _numPat=/^-?\\d+(\\.\\d+)?$/;
var _hlWordIdx=(globalThis._hlState&&globalThis._hlState.active&&globalThis._hlState.wordIndex!=null)?globalThis._hlState.wordIndex:-1;
var _numRanges=[];
var _hlStart=-1,_hlEnd=-1;
${numberRenderCode}
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

  const newFile =
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
  // Default to 'numbers' mode if not specified (handles undefined from config)
  const isNumbersModeRaw = cfg.highlightMode === 'numbers' || cfg.highlightMode === undefined;
  const isGenderModeRaw = cfg.highlightMode === 'gender';
  const isBothModeRaw = cfg.highlightMode === 'both';
  const rawActOvrCheck = `(globalThis._actionWordOverrides||{})[w.toLowerCase()]`;
  const rawFilterCode1 = isBothModeRaw
    ? `var _numP=/^-?\\d+(\\.\\d+)?$/;
var _rootPat=/^(boy|girl)$/i;
var _targetIdx=[];
_allW.forEach(function(w,i){if(_numP.test(w)||_rootPat.test(w)||${rawActOvrCheck})_targetIdx.push(i);});`
    : isGenderModeRaw
    ? `var _rootPat=/^(boy|girl)$/i;
var _targetIdx=[];
_allW.forEach(function(w,i){if(_rootPat.test(w)||${rawActOvrCheck})_targetIdx.push(i);});`
    : isNumbersModeRaw
    ? `var _numP=/^-?\\d+(\\.\\d+)?$/;
var _targetIdx=[];
_allW.forEach(function(w,i){if(_numP.test(w)||${rawActOvrCheck})_targetIdx.push(i);});`
    : `var _targetIdx=[];
_allW.forEach(function(w,i){_targetIdx.push(i);});`;

  const rawFilterCode2 = isBothModeRaw
    ? `var _numP2=/^-?\\d+(\\.\\d+)?$/;
var _rootPat2=/^(boy|girl)$/i;
var _targetIdx2=[];
_allW2.forEach(function(w,i){if(_numP2.test(w)||_rootPat2.test(w)||${rawActOvrCheck})_targetIdx2.push(i);});`
    : isGenderModeRaw
    ? `var _rootPat2=/^(boy|girl)$/i;
var _targetIdx2=[];
_allW2.forEach(function(w,i){if(_rootPat2.test(w)||${rawActOvrCheck})_targetIdx2.push(i);});`
    : isNumbersModeRaw
    ? `var _numP2=/^-?\\d+(\\.\\d+)?$/;
var _targetIdx2=[];
_allW2.forEach(function(w,i){if(_numP2.test(w)||${rawActOvrCheck})_targetIdx2.push(i);});`
    : `var _targetIdx2=[];
_allW2.forEach(function(w,i){_targetIdx2.push(i);});`;

  // Raw sequence handlers for Left/Right: Use originalNumbers map to track floor per word index
  const rawHandlerCode = `case(${rawParam}==="\\x1B[1;7D"):if(!globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:"",originalNumbers:{},originalGender:undefined};
if(!globalThis._hlState.originalNumbers)globalThis._hlState.originalNumbers={};
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
case(${rawParam}==="\\x1B[1;7C"):if(!globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:"",originalNumbers:{},originalGender:undefined};
if(!globalThis._hlState.originalNumbers)globalThis._hlState.originalNumbers={};
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
globalThis._hlState={active:false,index:null,wordIndex:null,text:"",originalNumbers:{},originalGender:undefined};
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
case(${rawParam}==="\\x1B[1;7A"):if(!globalThis._hlState||!globalThis._hlState.active)return ${inputZoneVar};
if(globalThis._hlState.wordIndex===null||globalThis._hlState.wordIndex===undefined)return ${inputZoneVar};
if(!globalThis._hlState.originalNumbers)globalThis._hlState.originalNumbers={};
var _allW3=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
var _idx3=globalThis._hlState.wordIndex;
if(_idx3<0||_idx3>=_allW3.length)return ${inputZoneVar};
var _word3=_allW3[_idx3];
var _rootPat3=/^(boy|girl)$/i;
if(_rootPat3.test(_word3)){
var _maleGroup3=['boy','he','him','his','man',"he's"];
var _femaleGroup3=['girl','she','her','woman',"she's"];
var _flipMap3={boy:'girl',girl:'boy',he:'she',she:'he',him:'her',his:'her',her:'him',man:'woman',woman:'man',"he's":"she's","she's":"he's"};
var _selLower3=_word3.toLowerCase();
var _linkedGroup3=_maleGroup3.indexOf(_selLower3)>=0?_maleGroup3:_femaleGroup3;
if(globalThis._hlState.originalGender===undefined)globalThis._hlState.originalGender=globalThis._hlText;
var _newText3=globalThis._hlText;
var _offsetDelta3=0;
for(var _gi3=_allW3.length-1;_gi3>=0;_gi3--){
var _gw3=_allW3[_gi3].toLowerCase();
if(_linkedGroup3.indexOf(_gw3)>=0&&_flipMap3[_gw3]){
var _origWord3=_allW3[_gi3];
var _flipped3=_flipMap3[_gw3];
_flipped3=_flipped3.split('').map(function(c,ci){return ci<_origWord3.length&&_origWord3[ci]===_origWord3[ci].toUpperCase()?c.toUpperCase():c;}).join('');
var _wPos3=0;
for(var _wi32=0;_wi32<_gi3;_wi32++){_wPos3=_newText3.indexOf(_allW3[_wi32],_wPos3)+_allW3[_wi32].length;}
var _wStart32=_newText3.indexOf(_origWord3,_wPos3);
if(_wStart32>=0){if(_wStart32<${inputZoneVar}.offset)_offsetDelta3+=(_flipped3.length-_origWord3.length);_newText3=_newText3.slice(0,_wStart32)+_flipped3+_newText3.slice(_wStart32+_origWord3.length);}
}
}
globalThis._hlText=_newText3;
globalThis._hlState.text=_newText3;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
return ${inputZoneClass}.fromText(_newText3,${configVar},${inputZoneVar}.offset+_offsetDelta3);
}
var _numP3=/^-?\\d+(\\.\\d+)?$/;
if(!_numP3.test(_word3))return ${inputZoneVar};
var _num3=parseFloat(_word3);
if(globalThis._hlState.originalNumbers[_idx3]===undefined)globalThis._hlState.originalNumbers[_idx3]=_num3;
var _newNum3=_num3+1;
var _isInt3=_word3.indexOf(".")<0;
var _newWord3=_isInt3?String(Math.round(_newNum3)):String(_newNum3);
var _text3=globalThis._hlText;
var _wordPos3=0;
for(var _wi3=0;_wi3<_idx3;_wi3++){
_wordPos3=_text3.indexOf(_allW3[_wi3],_wordPos3)+_allW3[_wi3].length;
}
var _wStart3=_text3.indexOf(_word3,_wordPos3);
var _wEnd3=_wStart3+_word3.length;
var _newText3n=_text3.slice(0,_wStart3)+_newWord3+_text3.slice(_wEnd3);
globalThis._hlText=_newText3n;
globalThis._hlState.text=_newText3n;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _lenDiff3=_newWord3.length-_word3.length;
var _newOffset3=_wStart3<${inputZoneVar}.offset?${inputZoneVar}.offset+_lenDiff3:${inputZoneVar}.offset;
return ${inputZoneClass}.fromText(_newText3n,${configVar},_newOffset3);
case(${rawParam}==="\\x1B[1;7B"):if(!globalThis._hlState||!globalThis._hlState.active)return ${inputZoneVar};
if(globalThis._hlState.wordIndex===null||globalThis._hlState.wordIndex===undefined)return ${inputZoneVar};
if(!globalThis._hlState.originalNumbers)globalThis._hlState.originalNumbers={};
var _allW4=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
var _idx4=globalThis._hlState.wordIndex;
if(_idx4<0||_idx4>=_allW4.length)return ${inputZoneVar};
var _word4=_allW4[_idx4];
var _rootPat4=/^(boy|girl)$/i;
if(_rootPat4.test(_word4)){
if(globalThis._hlState.originalGender!==undefined){
var _newText4g=globalThis._hlState.originalGender;
globalThis._hlText=_newText4g;
globalThis._hlState.text=_newText4g;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _newOffset4g=Math.min(${inputZoneVar}.offset,_newText4g.length);
return ${inputZoneClass}.fromText(_newText4g,${configVar},_newOffset4g);
}
return ${inputZoneVar};
}
var _numP4=/^-?\\d+(\\.\\d+)?$/;
if(!_numP4.test(_word4))return ${inputZoneVar};
var _num4=parseFloat(_word4);
if(globalThis._hlState.originalNumbers[_idx4]===undefined)globalThis._hlState.originalNumbers[_idx4]=_num4;
var _orig4=globalThis._hlState.originalNumbers[_idx4];
var _newNum4=_num4-1;
if(_newNum4<_orig4)_newNum4=_orig4;
var _isInt4=_word4.indexOf(".")<0;
var _newWord4=_isInt4?String(Math.round(_newNum4)):String(_newNum4);
var _text4=globalThis._hlText;
var _wordPos4=0;
for(var _wi4=0;_wi4<_idx4;_wi4++){
_wordPos4=_text4.indexOf(_allW4[_wi4],_wordPos4)+_allW4[_wi4].length;
}
var _wStart4=_text4.indexOf(_word4,_wordPos4);
var _wEnd4=_wStart4+_word4.length;
var _newText4=_text4.slice(0,_wStart4)+_newWord4+_text4.slice(_wEnd4);
globalThis._hlText=_newText4;
globalThis._hlState.text=_newText4;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _lenDiff4=_newWord4.length-_word4.length;
var _newOffset4=_wStart4<${inputZoneVar}.offset?${inputZoneVar}.offset+_lenDiff4:${inputZoneVar}.offset;
return ${inputZoneClass}.fromText(_newText4,${configVar},_newOffset4);
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

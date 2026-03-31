---
last_updated: 2026-03-31
---

# System Exploration: Code Path Mapping

This document maps user scenarios to the exact code that executes in the patched `cli.js`.

**cli.js location:** `/home/wilfred/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js`

---

## Quick Reference: Key Line Numbers

| Component | Lines | Purpose |
|-----------|-------|---------|
| `_forceInputRefresh` definition | 4803-4809 | Trigger UI re-render from async code |
| R stripping (invisible chars) | 4810-4814 | Clean InputZone of toggle chars |
| IIFE start | 4816 | Variable isolation for clearing logic |
| `_hlText` setup | 4817-4819 | Strip invisible chars, capture old text |
| Per-word clearing | 4820-4840 | Smart clearing based on word changes |
| Highlight state clearing | 4841-4847 | Clear navigation state on text change |
| Export to JSON | 4848-4860 | Write state for status line |
| Submit trigger detection | 4862-4910 | Detect "submit", spawn LLM, poll result |
| Navigation key handlers | 4268-4330 | Ctrl+Alt+Left/Right main handlers |
| Up/Down cycle handlers | 4331-4480 | Ctrl+Alt+Up/Down with dynamic support |
| Raw sequence handlers | 4530-4780 | Fallback for terminals without meta key |
| Rendering | 4950-5030 | Apply dim/highlight colors |

---

## Scenario 1: User Types Text

**Trigger:** Any keystroke that changes text

**Code Path:**
```
Input handler called with new value (A)
    ↓
Line 4802: globalThis._parentValue=A
    ↓
Line 4810-4814: Strip invisible chars from R (InputZone)
    ↓
Line 4817: var _hlText=A.replace(/[\u200B\u200C]/g,"")
Line 4818: var _oldText=(globalThis._hlText||"").replace(...)
Line 4819: globalThis._hlText=_hlText
    ↓
Line 4820: if(_hlText!==_oldText && _dynDefs && _dynDefs.words)
    ↓ (if text changed and defs exist)
Lines 4821-4840: Per-word clearing logic
    ↓
Line 4841: if(_hlState && _hlState.active)
    ↓ (if highlight was active)
Line 4843: Clear _hlState (user typed, so deactivate highlight)
```

**Relevant Code (lines 4817-4847):**
```javascript
var _hlText=A.replace(/[\u200B\u200C]/g,"");
var _oldText=(globalThis._hlText||"").replace(/[\u200B\u200C]/g,"");
globalThis._hlText=_hlText;
if(_hlText!==_oldText&&globalThis._dynDefs&&globalThis._dynDefs.words){
  var _oldW=_oldText.split(/\s+/).filter(function(w){return w;});
  var _newW=_hlText.split(/\s+/).filter(function(w){return w;});
  if(_oldW.length===_newW.length){
    for(var _wi=0;_wi<_oldW.length;_wi++){
      if(_oldW[_wi]!==_newW[_wi]){
        var _def=globalThis._dynDefs.words.find(function(d){return d.index===_wi;});
        if(_def&&_def.alts){
          if(_def.alts.indexOf(_newW[_wi])>=0){
            _def.word=_newW[_wi];
            _def.currentAltIndex=_def.alts.indexOf(_newW[_wi]);
          }else{
            _def.alts=null;
            _def.currentAltIndex=undefined;
          }
        }
      }
    }
  }else{
    globalThis._dynDefs=undefined;
  }
}
if(globalThis._hlState&&globalThis._hlState.active){
  if(_hlText!==_oldText){
    globalThis._hlState={active:false,index:null,wordIndex:null,text:"",originalNumbers:{},originalGender:undefined};
    if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
  }
}
```

---

## Scenario 2: User Types "submit"

> **HISTORICAL NOTE**: The "submit" keyword trigger and bash script spawning described in this scenario are no longer used. All LLM analysis now goes through cues-core's CueResolver with auto-submit (always on). This section is kept for historical reference of the original architecture.

**Trigger:** Text contains word "submit" (case-insensitive)

**Code Path:**
```
After per-word clearing completes...
    ↓
Line 4862: (function(){ var _dynText=globalThis._hlText||""
Line 4863: var _submitPat=/\bsubmit\b/i
Line 4864: var _submitMatch=_dynText.match(_submitPat)
    ↓ (if "submit" found)
Line 4866: Remove "submit", clean whitespace
Line 4867: globalThis._hlText=_cleanText
Line 4868-4869: Write text to /tmp/claude-llm-input-{PID}.txt
Line 4870-4871: Spawn bash script with input/output paths
Line 4872-4875: Set up polling state (_dynPending, _dynResultPath, _dynPollStart)
Line 4876: Start polling interval (100ms)
```

**Relevant Code (lines 4862-4910):**
```javascript
(function(){
var _dynText=globalThis._hlText||"";
var _submitPat=/\bsubmit\b/i;
var _submitMatch=_dynText.match(_submitPat);
if(_submitMatch){
  var _cleanText=_dynText.replace(_submitPat,"").replace(/\s+/g," ").trim();
  globalThis._hlText=_cleanText;
  var _inputPath="/tmp/claude-llm-input-"+process.pid+".txt";
  var _resultPath="/tmp/claude-llm-result-"+process.pid+".json";
  try{
    kA("fs").writeFileSync(_inputPath,_cleanText);
    var _scriptPath=(process.env.HOME||"~")+"/.claude/llm-analyze.sh";
    kA("child_process").spawn("bash",[_scriptPath,_inputPath,_resultPath],
      {detached:true,stdio:"ignore",env:process.env}).unref();
    globalThis._dynPending=true;
    globalThis._dynResultPath=_resultPath;
    globalThis._dynPollStart=Date.now();
    globalThis._dynPollInterval=setInterval(function(){
      // ... polling callback (see Scenario 3)
    },100);
  }catch(_e){console.error("dynamicHighlight spawn error:",_e);}
  R=i5.fromText(_cleanText,G,Math.min(R.offset,_cleanText.length));
}
})();
```

---

## Scenario 3: LLM Result Arrives

> **HISTORICAL NOTE**: The file-polling approach described in Scenarios 3 and 3a is no longer used. LLM results now arrive via cues-core's async CueResolver (Promise-based, no file polling). This section is kept for historical reference.

**Trigger:** Polling callback finds result file exists

**Code Path:**
```
Polling callback runs (every 100ms)
    ↓
Check if result file exists
    ↓ (if file exists)
Clear polling interval
Read and parse JSON
    ↓ (if valid JSON with words array)
Set globalThis._dynDefs=_json
Write timing to /tmp/claude-llm-timing-{PID}.txt
Call _triggerStatusLineRefresh()
Call _forceInputRefresh()  ← TRIGGERS UI REFRESH
```

## Scenario 3a: LLM Analysis Fails (Retry Logic)

**Trigger:** 30 seconds pass with no result file

**Code Path:**
```
Polling timeout after 30s
    ↓
Check _dynRetryCount < 1?
    ↓ (YES - first failure)
Increment _dynRetryCount
Log "RETRY after 30s timeout" to timing file
    ↓
Wait 600ms (setTimeout)
    ↓
Re-spawn LLM script
Reset _dynPollStart
Start new polling interval
    ↓
If second attempt times out after 30s:
    Log "FAILED after retry" to timing file
    Set _dynPending=false (give up)
```

**Timing file output on retry:**
```
RETRY after 30s timeout (attempt 2)
523ms (retry) | 5 words with alts | model: qwen-3-32b
```

**Or on complete failure:**
```
RETRY after 30s timeout (attempt 2)
FAILED after retry
```

**Relevant Code (lines 4888-4905):**
```javascript
var _exists=kA("fs").existsSync(_resultPath);
if(_exists){
  clearInterval(globalThis._dynPollInterval);
  var _elapsed=Date.now()-globalThis._dynPollStart;
  try{
    var _content=kA("fs").readFileSync(_resultPath,"utf8");
    var _json=JSON.parse(_content);
    if(_json&&_json.words&&Array.isArray(_json.words)){
      globalThis._dynDefs=_json;
      var _wordsWithAlts=_json.words.filter(function(w){return w.alts&&w.alts.length>1;}).length;
      var _timingPath="/tmp/claude-llm-timing-"+process.pid+".txt";
      kA("fs").writeFileSync(_timingPath,_elapsed+"ms | "+_wordsWithAlts+" words with alts | model: "+(_json._model||"unknown")+"\n",{flag:"a"});
      if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
      if(globalThis._forceInputRefresh)globalThis._forceInputRefresh();
    }
  }catch(_pe){}
  globalThis._dynPending=false;
  try{kA("fs").unlinkSync(_resultPath);}catch(_ue){}
}
```

**`_forceInputRefresh` code (lines 4803-4809):**
```javascript
globalThis._forceInputRefresh=function(){
  var _t=globalThis._hlText||"";
  var _pv=globalThis._parentValue||"";
  var _hasB=_pv.indexOf("\u200B")>=0;
  var _tc=_hasB?"\u200C":"\u200B";
  K(_t+_tc);  // K is onChange callback → triggers React re-render
};
```

---

## Scenario 4: User Presses Ctrl+Alt+Left (Navigate)

**Trigger:** Key event with leftArrow + ctrl + (meta|option|alt)

**Code Path:**
```
Key dispatcher function called
    ↓
Line 4268: case(AA.leftArrow&&AA.ctrl&&(AA.meta||AA.option||AA.alt)):return()=>{
    ↓
Line 4269-4270: Initialize _hlState if needed
Line 4271-4277: Build _targetIdx array (words that can be highlighted)
    ↓
    For each word, check:
    - _numP.test(w) → is it a number?
    - _rootPat.test(w) → is it boy/girl?
    - _hasDynAlt → does _dynDefs have alts for this word?
    ↓
Line 4278-4287: Update highlight state
    - If not active: activate at rightmost target
    - If active: move left (index++)
Line 4288: Trigger status line refresh
Line 4289-4293: Return InputZone with toggled invisible char
```

**Relevant Code (lines 4268-4295):**
```javascript
case(AA.leftArrow&&AA.ctrl&&(AA.meta||AA.option||AA.alt)):return()=>{
if(!globalThis._hlState)globalThis._hlState={active:false,index:null,wordIndex:null,text:"",originalNumbers:{},originalGender:undefined};
if(!globalThis._hlState.originalNumbers)globalThis._hlState.originalNumbers={};
var _allW=globalThis._hlText?globalThis._hlText.split(/\s+/).filter(function(w){return w}):[];
var _numP=/^-?\d+(\.\d+)?$/;
var _rootPat=/^(boy|girl)$/i;
var _targetIdx=[];
_allW.forEach(function(w,i){
  // Note: d.alts.indexOf(w)>=0 ensures word must be IN alts to be navigable
  var _hasDynAlt=globalThis._dynDefs&&globalThis._dynDefs.words&&
    globalThis._dynDefs.words.find(function(d){return d.index===i&&d.alts&&d.alts.length>1&&d.alts.indexOf(w)>=0;});
  if((_numP.test(w)||_rootPat.test(w))||_hasDynAlt)_targetIdx.push(i);
});
if(!_targetIdx.length)return R;
if(!globalThis._hlState.active){
  globalThis._hlState.active=true;
  globalThis._hlState.index=0;
  globalThis._hlState.wordIndex=_targetIdx[_targetIdx.length-1];
  globalThis._hlState.text=globalThis._hlText;
}else{
  if(globalThis._hlState.index<_targetIdx.length-1){
    globalThis._hlState.index++;
    globalThis._hlState.wordIndex=_targetIdx[_targetIdx.length-1-globalThis._hlState.index];
  }
}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
var _pv=globalThis._parentValue||"";
var _parentHasB=_pv.indexOf("\u200B")>=0;
if(_parentHasB){return i5.fromText(R.text+"\u200C",G,R.offset);}
else{return i5.fromText(R.text+"\u200B",G,R.offset);}
};
```

---

## Scenario 5: User Presses Ctrl+Alt+Up (Cycle Alternative)

**Trigger:** Key event with upArrow + ctrl + (meta|option|alt), highlight active

**Code Path:**
```
Key dispatcher function called
    ↓
Line 4331: case(AA.upArrow&&AA.ctrl&&(AA.meta||AA.option||AA.alt)):return()=>{
    ↓
Line 4332-4334: Check _hlState is active with valid wordIndex
    ↓
Line 4336-4355: DYNAMIC MODE CHECK (runs first if _dynDefs exists)
    - Find word definition for current wordIndex
    - If has alts: cycle to next alt
    - Replace word in text
    - Handle linked words (cycle together)
    - Return new InputZone
    ↓ (if no dynamic defs, fall through to hardcoded behavior)
Line 4356-4400: HARDCODED MODE
    - Gender: flip boy↔girl with linked words
    - Numbers: increment by 1
```

**Dynamic Cycle Code (lines 4336-4355):**
```javascript
if(globalThis._dynDefs&&globalThis._hlState&&globalThis._hlState.active&&globalThis._hlState.wordIndex!=null){
  var _dWords=globalThis._dynDefs.words;
  var _dIdx=globalThis._hlState.wordIndex;
  var _dWord=_dWords.find(function(w){return w.index===_dIdx;});
  if(_dWord&&_dWord.alts&&_dWord.alts.length>1){
    var _curIdx=typeof _dWord.currentAltIndex==='number'?_dWord.currentAltIndex:0;
    var _nextAlt=(_curIdx+1)%_dWord.alts.length;  // Wrap around
    _dWord.currentAltIndex=_nextAlt;
    var _newWord=_dWord.alts[_nextAlt];
    // ... find word position, replace in text ...
    // ... handle linked words ...
    globalThis._hlText=_newText;
    globalThis._hlState.text=_newText;
    if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
    return i5.fromText(_newText,G,_newOffset);
  }
}
```

---

## Scenario 6: User Edits Word to Something NOT in Alternatives

**Trigger:** Text change where word at index i changes to value not in `_dynDefs.words[i].alts`

**Example:** "dog" → "do" → "dog" (typing recovery)

**Code Path:**
```
Input handler called (same as Scenario 1)
    ↓
Line 4820: if(_hlText!==_oldText && _dynDefs && _dynDefs.words)
    ↓ (text changed, defs exist)
Line 4821-4822: Split old and new text into word arrays
Line 4823: if(_oldW.length===_newW.length)
    ↓ (same word count)
Line 4824-4832: For each word index...
    Line 4825: if(_oldW[_wi]!==_newW[_wi])  ← word changed
        Line 4826: Find definition for this index
        Line 4827: if(_def.alts && _def.alts.indexOf(_newW[_wi])>=0)  ← IN alts?
            Line 4828-4829: Update word/currentAltIndex
        (else: DO NOTHING - alts preserved for recovery!)
```

**Relevant Code (lines 4824-4832):**
```javascript
for(var _wi=0;_wi<_oldW.length;_wi++){
  if(_oldW[_wi]!==_newW[_wi]){
    var _def=globalThis._dynDefs.words.find(function(d){return d.index===_wi;});
    // If word IS in alts, update index; otherwise clear alts (handles index shifts)
    if(_def&&_def.alts&&_def.alts.indexOf(_newW[_wi])>=0){
      _def.word=_newW[_wi];
      _def.currentAltIndex=_def.alts.indexOf(_newW[_wi]);
    }
  }
}
```

**Key Behavior:**
- Word changes to something IN alts → update tracking (valid cycle)
- Word changes to something NOT in alts → **DO NOTHING** (alts preserved)
- This allows recovery: "dog" → "do" → "dog" still has alternatives!

**Navigation/Rendering also check:**
```javascript
// Word must be IN alts to be navigable/dimmed
d.alts.indexOf(w)>=0  // Added to _hasDynAlt check
```

---

## Scenario 7: User Adds/Removes a Word

**Trigger:** Text change where word count differs from previous

**Code Path:**
```
Input handler called (same as Scenario 1)
    ↓
Line 4820: if(_hlText!==_oldText && _dynDefs && _dynDefs.words)
    ↓ (text changed, defs exist)
Line 4821-4822: Split old and new text into word arrays
Line 4823: if(_oldW.length===_newW.length)  ← FALSE (different counts)
    ↓ (else branch)
Line 4839: globalThis._dynDefs=undefined  ← CLEAR ALL DEFINITIONS
```

**Relevant Code (lines 4838-4840):**
```javascript
}else{
  globalThis._dynDefs=undefined;
}
```

---

## Scenario 8: Typing Recovery ("dog" → "do" → "dog")

**Trigger:** User partially deletes a word then types it back

**Example:** Text has "dog" with `alts = ["dog", "cat", "puppy"]`

**Step 1: Delete 'g' → "do"**
```
Per-word clearing runs:
    ↓
Line 4827: if(_def.alts && _def.alts.indexOf("do")>=0)  ← FALSE
    ↓
(else branch removed - DO NOTHING)
    ↓
Alts PRESERVED: ["dog", "cat", "puppy"] still exists!

Navigation check for "do":
    ↓
d.alts.indexOf("do")>=0  ← FALSE
    ↓
"do" is NOT added to _targetIdx → not navigable
```

**Step 2: Type 'g' → "dog"**
```
Per-word clearing runs:
    ↓
Line 4827: if(_def.alts && _def.alts.indexOf("dog")>=0)  ← TRUE
    ↓
Line 4828-4829: Update _def.word="dog", _def.currentAltIndex=0

Navigation check for "dog":
    ↓
d.alts.indexOf("dog")>=0  ← TRUE
    ↓
"dog" IS added to _targetIdx → navigable again!
```

**Key insight:** Alts are never destroyed during same-word-count edits. The navigation/rendering just temporarily ignores words that don't match their alts array.

---

## Scenario 9: Rendering (Every Frame)

**Trigger:** React render cycle

**Code Path:**
```
renderedValue getter called
    ↓
Line 4950: (function(){ var _rv=R.render(...)  ← Get base rendered value
Line 4955-4960: Strip ANSI codes to get clean text, split into words
Line 4962: Get _hlWordIdx from _hlState.wordIndex
    ↓
Line 4970-4995: Build _hlRanges and _dimRanges arrays
    For each word:
    - If selected word with _dynDefs → add to _hlRanges
    - If linked to selected word → add to _hlRanges
    - If number or root gender word → add to _dimRanges
    - If has dynamic alts (and not selected) → add to _dimRanges
    ↓
Line 4997-5025: Character-by-character rendering
    For each character:
    - If in inverse mode (cursor) → pass through unchanged
    - If in _hlRanges → apply highlight color (bold white)
    - If in _dimRanges → apply dim color (dark gray)
    - Else → pass through with pending ANSI codes
```

**Relevant Code (lines 4985-4995):**
```javascript
// Check for dynamic alt dimming
// Note: d.alts.indexOf(_w)>=0 ensures word must be IN alts to be dimmed
}else if(globalThis._dynDefs&&globalThis._dynDefs.words){
  var _dynDef=globalThis._dynDefs.words.find(function(d){
    return d.index===_wi&&d.alts&&d.alts.length>1&&d.alts.indexOf(_w)>=0;
  });
  if(_dynDef&&_wi!==_hlWordIdx)_dimRanges.push({start:_wStart,end:_wStart+_w.length});
}
```

**Character rendering loop (lines 4997-5025):**
```javascript
var _out='',_cp=0,_i=0,_inv=false,_pending='';
while(_i<_rv.length){
  var _am=_rv.slice(_i).match(/^\x1b\[[0-9;]*m/);
  if(_am){
    if(_am[0]==='\x1b[7m')_inv=true;
    if(_am[0]==='\x1b[27m'||_am[0]==='\x1b[0m')_inv=false;
    _pending+=_am[0];
    _i+=_am[0].length;continue;
  }
  var _ch=_rv[_i];
  var _inHl=/* check _hlRanges */;
  var _inDim=/* check _dimRanges */;
  if(_inv){_out+=_pending+_ch;}           // Cursor char - pass through
  else if(_inHl){_out+="\x1b[0m\x1b[1;97m"+_ch+"\x1b[0m";}  // Highlight
  else if(_inDim){_out+="\x1b[0m\x1b[90m"+_ch+"\x1b[0m";}   // Dim
  else{_out+=_pending+_ch;}               // Normal
  _pending='';
  _cp++;_i++;
}
return _out;
```

---

## Global State Reference

| Variable | Purpose | Set By |
|----------|---------|--------|
| `globalThis._hlState` | Navigation state (active, index, wordIndex, etc.) | Key handlers |
| `globalThis._hlText` | Current input text (stripped of invisible chars) | Input handler |
| `globalThis._parentValue` | Raw parent value (for toggle detection) | Input handler |
| `globalThis._dynDefs` | LLM-generated word definitions | Polling callback |
| `globalThis._dynPending` | Whether LLM analysis in progress | Submit detection |
| `globalThis._dynResultPath` | Path to result JSON | Submit detection |
| `globalThis._dynPollStart` | Timestamp when polling started | Submit detection |
| `globalThis._dynPollInterval` | Polling interval handle | Submit detection |
| `globalThis._dynRetryCount` | Retry attempts (0=first try, 1=retried) | Timeout handler |
| `globalThis._forceInputRefresh` | Function to trigger UI refresh | Input handler |
| `globalThis._triggerStatusLineRefresh` | Function to refresh status line | INK component |

---

## File Paths

| Path | Purpose |
|------|---------|
| `/tmp/claude-llm-timing-{PID}.txt` | Timing log (appended) |
| `/tmp/claude-highlight-state-{PID}.json` | Highlight state for status line |

> **HISTORICAL NOTE**: `/tmp/claude-llm-input-{PID}.txt`, `/tmp/claude-llm-result-{PID}.json`, and `~/.claude/llm-analyze.sh` were used by the old bash-script-based LLM pipeline. LLM calls now go through cues-core inline.

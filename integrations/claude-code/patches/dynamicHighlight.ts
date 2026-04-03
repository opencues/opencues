/**
 * Dynamic Highlight Patch
 * =======================
 *
 * Adds LLM-powered word alternatives to Claude Code's word highlight system.
 * Words are analyzed automatically as you type, with alternatives available
 * for cycling via Ctrl+Alt+Up/Down.
 *
 * ## How It Works
 *
 * 1. User types text → three-tier auto-submit trigger fires:
 *    - Tier 1: Space typed (50ms debounce) — analyze completed word
 *    - Tier 2: 300ms pause — analyze final word
 *    - Tier 3: Word edited mid-sentence (50ms) — re-analyze changed word
 * 2. Per-word tips lookup runs first (~0ms from hash map)
 * 3. Remaining words sent to CueResolver → Groq API (~400ms)
 * 4. Words with alternatives turn gray (dimmed)
 * 5. Ctrl+Alt+Up/Down cycles through alternatives
 *
 * ## Sources (via cues-core CueResolver)
 *
 * - GrammarSource (priority 50) — synonym, opposite, creative alternatives
 * - MathSource (priority 90) — evaluates expressions (4*12=_ → 48)
 * - FactualSource (priority 90) — answers questions (capital of France → Paris)
 * - Tips lookup — instant O(1) from ~/.claude/claude-code-tips.json
 *
 * ## Cycling Priority
 *
 * When Up/Down pressed on highlighted word:
 * 1. Action word override → spawn external script, return
 * 2. Dynamic alts → cycle through alternatives + update linked words
 * 3. Fall through to wordHighlight (numbers)
 *
 * ## Key State
 *
 * - globalThis._dynDefs — word definitions with alts, tips, linked indices
 * - globalThis._dynPending — true while LLM request in flight
 * - globalThis._dynSpans — multi-word alternative tracking
 * - globalThis._cueResolver — CueResolver instance (from cues-core)
 * - globalThis._localCueMap — hash map for instant tips lookup
 * - globalThis._cycleAlt — shared cycling function (action words, alts, spans)
 *
 * @see references/dynamic-highlight.md for full feature reference
 * @see docs/systems-diagram.md for architecture overview
 */

import { LocationResult, showDiff, getRequireFuncName, escapeIdent } from './index';

/**
 * Initialize cues-core at startup.
 * Loads cues-core once and stores in globalThis for instant (~0.3ms) lookups.
 * This eliminates the 575ms bash/node spawn overhead per lookup.
 */
export const writeCuesCoreInit = (
  oldFile: string,
  config: DynamicHighlightConfig = {}
): string | null => {
  const requireFuncName = getRequireFuncName(oldFile);

  // Find init injection point - try multiple patterns for compatibility
  let insertPos: number;

  // Pattern 1 (old esbuild): ;var X=(0,Y.Z)(  -- inject before it
  const initPattern1 = /;var ([$\w]+)=\(0,([$\w]+)\.\w+\)\(/;
  const initMatch1 = oldFile.match(initPattern1);

  if (initMatch1 && initMatch1.index !== undefined) {
    insertPos = initMatch1.index;
  } else {
    // Pattern 2 (new ESM): inject after the var statement that assigns the require function
    // e.g. var g6=Gt4(import.meta.url),vt4=...;
    // Must inject AFTER this statement so the require function (g6) is available
    const requireVarPattern = new RegExp(
      `var ${escapeIdent(requireFuncName)}=[$\\w]+\\(import\\.meta\\.url\\)`
    );
    const requireVarMatch = oldFile.match(requireVarPattern);

    if (!requireVarMatch || requireVarMatch.index === undefined) {
      console.error('patch: dynamicHighlight: failed to find require var statement for cues-core init injection');
      return null;
    }

    // Find the end of the var statement (semicolon at depth 0)
    let depth = 0;
    let scanPos = requireVarMatch.index;
    while (scanPos < oldFile.length) {
      const ch = oldFile[scanPos];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
      else if (ch === ';' && depth === 0) break;
      scanPos++;
    }

    insertPos = scanPos + 1; // after the semicolon
  }

  // Initialize cues-core at startup
  // Load the module, parse tips file, and build a hash map for O(1) lookups
  // Uses cues-core's buildLookupMap() - no inline map building needed
  const cuesCoreInitCode = `
;(function(){
if(globalThis._localCueMap&&globalThis._cueResolver)return;
if(!globalThis._localCueMap){
try{
var _cuesPath=(process.env.HOME||"~")+"/.claude/node_modules/cues-core";
var _cues=${requireFuncName}(_cuesPath);
var _tipsPath=(process.env.HOME||"~")+"/.claude/claude-code-tips.json";
var _tipsContent=${requireFuncName}("fs").readFileSync(_tipsPath,"utf8");
var _localCueData=_cues.parseLocalCueFile(_tipsContent);
globalThis._cuesCore=_cues;
globalThis._localCueData=_localCueData;
globalThis._localCueMap=_cues.buildLookupMap(_localCueData);
}catch(_e){
globalThis._cuesCore=null;
globalThis._localCueData=null;
globalThis._localCueMap=null;
}
}
// Load config files from project root: cues.md, blanks.md, controls.md (each optional)
if(globalThis._cuesCore&&!globalThis._cuesMdLoaded){
try{
var _fs=${requireFuncName}("fs");var _cwd=process.cwd();
var _ignoreWords=[];
// cues.md (aliases: hints.md, tips.md) — tips + prompt config
var _cuesPath=null;
["cues.md","hints.md","tips.md"].some(function(f){var p=_cwd+"/"+f;if(_fs.existsSync(p)){_cuesPath=p;return true;}});
if(_cuesPath){
var _cuesCfg=globalThis._cuesCore.parseCuesMd(_fs.readFileSync(_cuesPath,"utf8"));
if(_cuesCfg.tips&&globalThis._localCueMap){var _m=globalThis._cuesCore.buildLookupMap(_cuesCfg.tips);_m.forEach(function(v,k){globalThis._localCueMap.set(k,v);});}
if(_cuesCfg.promptConfig){
globalThis._cuesPromptConfig=_cuesCfg.promptConfig;
var _gramSrc=_cuesCfg.promptConfig.sources&&_cuesCfg.promptConfig.sources.grammar;
if(_gramSrc&&_gramSrc.promptText){globalThis._cuesPromptInstructions=_gramSrc.promptText;}
}
if(_cuesCfg.ignore){_ignoreWords=_ignoreWords.concat(_cuesCfg.ignore);}
}
// controls.md — cue-actions
var _ctrlPath=_cwd+"/controls.md";
if(_fs.existsSync(_ctrlPath)){
var _ctrlCfg=globalThis._cuesCore.parseCuesMd(_fs.readFileSync(_ctrlPath,"utf8"));
if(_ctrlCfg.actions){globalThis._cueActionOverrides=Object.assign(globalThis._cueActionOverrides||{},_ctrlCfg.actions);}
if(_ctrlCfg.ignore){_ignoreWords=_ignoreWords.concat(_ctrlCfg.ignore);}
}
// blanks.md — ignore list + blank-fill prompt config (opt-in: blanks only work if file exists)
var _blankPath=_cwd+"/blanks.md";
if(_fs.existsSync(_blankPath)){
var _blankCfg=globalThis._cuesCore.parseCuesMd(_fs.readFileSync(_blankPath,"utf8"));
if(_blankCfg.ignore){_ignoreWords=_ignoreWords.concat(_blankCfg.ignore);}
if(_blankCfg.promptConfig){
globalThis._blanksPromptConfig=_blankCfg.promptConfig;
var _defaultMdMod=_blankCfg.promptConfig.model||"openai/gpt-oss-120b";
var _blankModes=globalThis._cuesCore.buildBlankModes(_blankCfg.promptConfig.sources,_defaultMdMod);
globalThis._blankModes=_blankModes;
var _classifierSrc=_blankCfg.promptConfig.sources.classifier;
globalThis._blanksEnabled=true;
}
}
if(_ignoreWords.length>0){globalThis._cuesIgnoreWords=new Set(_ignoreWords.map(function(w){return w.toLowerCase();}));}
globalThis._cuesMdLoaded=true;
}catch(_e1){}
}
// Periodic status line refresh when a cue-action word is selected
// Writes cueTip directly to the JSON export file — no re-render, no flicker
if(!globalThis._cueActionStatusInterval){
globalThis._cueActionStatusInterval=setInterval(function(){
if(!(globalThis._hlState&&globalThis._hlState.active&&globalThis._hlState.wordIndex!=null))return;
if(!globalThis._cueActionTip)return;
var _ws=(globalThis._hlText||"").split(/\s+/).filter(function(w){return w;});
var _wrd=_ws[globalThis._hlState.wordIndex]||"";
if(!globalThis._isCueAction||!globalThis._isCueAction(_wrd))return;
try{
var _ep="/tmp/claude-highlight-state-"+process.pid+".json";
var _fs=${requireFuncName}("fs");
var _ex=JSON.parse(_fs.readFileSync(_ep,"utf8"));
if(_ex.cueTip!==globalThis._cueActionTip){_ex.cueTip=globalThis._cueActionTip;_ex.timestamp=Date.now();_fs.writeFileSync(_ep,JSON.stringify(_ex));}
}catch(_ei){}
},200);
}
// HTTPS keep-alive agent for inline LLM calls
// NodeHttpAdapter: keep-alive + Groq provider config (reasoning_effort, max_tokens)
if(!globalThis._httpAdapter){
try{
var _NodeHttpAdapter=${requireFuncName}((process.env.HOME||"~")+"/.claude/node_modules/cues-core/node-http-adapter").NodeHttpAdapter;
globalThis._httpAdapter=new _NodeHttpAdapter({
maxSockets:2,
timeout:30000,
providerOverrides:{"api.groq.com":{reasoning_effort:"low",max_tokens:800}}
});
// Warm connection pool on startup
if(process.env.GROQ_API_KEY){
setTimeout(function(){globalThis._httpAdapter.warmup("https://api.groq.com/openai/v1/models",{Authorization:"Bearer "+process.env.GROQ_API_KEY});},1000);
}
}catch(_e2){}
}
// CueResolver: unified pipeline for all modes (tips + grammar + math + factual)
if(!globalThis._cueResolver&&globalThis._cuesCore&&process.env.GROQ_API_KEY){
try{
var _apiKey=process.env.GROQ_API_KEY;
var _ep="https://api.groq.com/openai/v1/chat/completions";
var _pc=globalThis._cuesPromptConfig||{};
var _bpc=globalThis._blanksPromptConfig||{};
var _defaultMod=_pc.model||_bpc.model||"openai/gpt-oss-120b";
var _ha=globalThis._httpAdapter;
var _ps=globalThis._cuesPromptInstructions||undefined;
var _srcs=_pc.sources||{};
var _srcCfg=function(n){return _srcs[n]||{};};
var _resolverSources=[];
// Grammar source for synonym cycling (non-blank words)
if(_srcCfg("grammar").enabled!==false){_resolverSources.push(new globalThis._cuesCore.GrammarSource({httpAdapter:_ha,endpoint:_ep,apiKey:_apiKey,model:_srcCfg("grammar").model||_defaultMod,priority:_srcCfg("grammar").priority||50,promptSuffix:_ps,blankPrompt:null}));}
// BlankSource — only if blanks.md present and modes defined
if(globalThis._blanksEnabled&&globalThis._blankModes&&globalThis._blankModes.length>0){
var _bClassifierCfg={httpAdapter:_ha,endpoint:_ep,apiKey:_apiKey,model:_defaultMod};
var _classifierSrcCfg=(_bpc.sources||{}).classifier;
if(_classifierSrcCfg&&_classifierSrcCfg.promptText){_bClassifierCfg.prompt=_classifierSrcCfg.promptText;}
var _blankClassifier=new globalThis._cuesCore.BlankClassifier(_bClassifierCfg,globalThis._blankModes);
_resolverSources.push(new globalThis._cuesCore.BlankSource({httpAdapter:_ha,endpoint:_ep,apiKey:_apiKey,defaultModel:_defaultMod,modes:globalThis._blankModes,classifier:_blankClassifier}));
}
globalThis._cueResolver=globalThis._cuesCore.createResolver(_resolverSources,{parallel:false,timeout:30000,continueOnError:true});
}catch(_e6){globalThis._cueResolver=null;}
}
// Cue-action check: returns true for words with built-in cycling behavior
// (numbers increment/decrement, custom actions run scripts) — these bypass alt cycling and tips
globalThis._isCueAction=function(_w){
var _numPat=/^-?\\d+(\\.\\d+)?$/;
return _numPat.test(_w)||!!(globalThis._cueActionOverrides||{})[_w.toLowerCase()];
};
// Shared cycling function: handles cue-actions, alt cycling, linked words, spans, underscore re-analysis
// dir=1 for Up (next alt), dir=-1 for Down (prev alt)
globalThis._cycleAlt=function(_dir,_IZClass,_IZVar,_cfgVar,_reqFn){
if(!globalThis._hlState||!globalThis._hlState.active||globalThis._hlState.wordIndex==null)return null;
var _allW=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
var _hlIdx=globalThis._hlState.wordIndex;
if(_hlIdx<0||_hlIdx>=_allW.length)return null;
var _curWord=_allW[_hlIdx];
// === Cue-actions: words with built-in cycling behavior (no tips, no LLM alts) ===
// Custom cue-actions: run external scripts (e.g. volume.sh)
var _actOvr=globalThis._cueActionOverrides||{};
var _wLower=_curWord.toLowerCase();
if(_actOvr[_wLower]){
var _ad=_actOvr[_wLower];
var _home=process.env.HOME||"/home/"+(process.env.USER||"root");
var _rawScript=_ad.script||_ad.scriptPath||(_home+"/.claude/actions/"+_ad.action+".sh");
var _script=_rawScript.replace(/^~/,_home);
var _args=["bash",_script].concat(_dir>0?_ad.upArgs||["up"]:_ad.downArgs||["down"]);
// In-memory state: no file I/O on hot path after first press
var _stateFile="/tmp/cue-action-"+_ad.action+".txt";
var _dynTip=_ad.tip||_ad.action;
if(!globalThis._cueActionValues)globalThis._cueActionValues={};
var _curVal=globalThis._cueActionValues[_ad.action];
if(_curVal==null){try{_curVal=parseInt(_reqFn("fs").readFileSync(_stateFile,"utf8").trim(),10);}catch(_e3){}}
if(typeof _curVal==="number"&&!isNaN(_curVal)){
var _dirArgs=_dir>0?(_ad.upArgs||["up","10"]):(_ad.downArgs||["down","10"]);
var _amt=parseInt(_dirArgs[_dirArgs.length-1],10)||10;
var _newVal=_dir>0?Math.min(100,_curVal+_amt):Math.max(0,_curVal-_amt);
globalThis._cueActionValues[_ad.action]=_newVal;
globalThis._cueActionTip=_dynTip;
}else{globalThis._cueActionTip=_dynTip;}
// Debounce spawn: rapid presses only fire script once with final value
if(!globalThis._cueActionTimers)globalThis._cueActionTimers={};
if(globalThis._cueActionTimers[_ad.action])clearTimeout(globalThis._cueActionTimers[_ad.action]);
var _spawnArgs=_args.slice(0);
globalThis._cueActionTimers[_ad.action]=setTimeout(function(){try{_reqFn("child_process").spawn(_spawnArgs[0],_spawnArgs.slice(1),{detached:true,stdio:"ignore"}).unref();}catch(_e){}},50);
return{refresh:true};
}
// Built-in cue-action: number increment/decrement
// Skip if this position has dynamic alternatives (e.g. blank fill-in result) — let alt cycling handle it
var _numPat=/^-?\\d+(\\.\\d+)?$/;
var _hasAltsCycle=globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.find(function(w){return w.index===_hlIdx&&w.alts&&w.alts.length>1;});
if(_numPat.test(_curWord)&&!_hasAltsCycle){
if(!globalThis._hlState.originalNumbers)globalThis._hlState.originalNumbers={};
var _num=parseFloat(_curWord);
if(globalThis._hlState.originalNumbers[_hlIdx]===undefined)globalThis._hlState.originalNumbers[_hlIdx]=_num;
var _newNum=_num+_dir;
if(_dir<0){var _orig=globalThis._hlState.originalNumbers[_hlIdx];if(_newNum<_orig)_newNum=_orig;}
var _isInt=_curWord.indexOf(".")<0;
var _newWord=_isInt?String(Math.round(_newNum)):String(_newNum);
var _text=globalThis._hlText;
var _wordPos=0;
for(var _wi=0;_wi<_hlIdx;_wi++){_wordPos=_text.indexOf(_allW[_wi],_wordPos)+_allW[_wi].length;}
var _wStart=_text.indexOf(_curWord,_wordPos);
var _wEnd=_wStart+_curWord.length;
var _newText=_text.slice(0,_wStart)+_newWord+_text.slice(_wEnd);
globalThis._hlText=_newText;
globalThis._hlState.text=_newText;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
return{text:_newText,lenDiff:_newWord.length-_curWord.length,wStart:_wStart};
}
// Dynamic alt cycling
if(!globalThis._dynDefs)return null;
var _dWords=globalThis._dynDefs.words;
var _dIdx=_hlIdx;
var _span=globalThis._dynSpans&&globalThis._dynSpans[_dIdx];
if(_span){_dIdx=_span.originalIndex;}
var _dWord=_dWords.find(function(w){return w.index===_dIdx;});
if(!_dWord||!_dWord.alts||_dWord.alts.length<=1)return null;
var _curIdx=typeof _dWord.currentAltIndex==='number'?_dWord.currentAltIndex:0;
var _nextAlt=(_curIdx+_dir+_dWord.alts.length)%_dWord.alts.length;
_dWord.currentAltIndex=_nextAlt;
var _newWord=_dWord.alts[_nextAlt];
if(_newWord==null)return null;
// Replace word in text (span-aware)
var _spanLen=_dWord.spanLength||1;
var _spanStart=_dIdx;
if(_spanStart<0||_spanStart>=_allW.length)return null;
var _oldWords=_allW.slice(_spanStart,_spanStart+_spanLen);
var _oldWord=_oldWords.join(" ");
_dWord.word=_newWord;
var _text=globalThis._hlText;
var _wordPos=0;
for(var _wi=0;_wi<_spanStart;_wi++){_wordPos=_text.indexOf(_allW[_wi],_wordPos)+_allW[_wi].length;}
var _wStart=_text.indexOf(_allW[_spanStart],_wordPos);
if(_wStart<0)return null;
var _wEnd=_wStart;
for(var _si=0;_si<_spanLen;_si++){var _swIdx=_text.indexOf(_allW[_spanStart+_si],_wEnd);if(_swIdx<0)break;_wEnd=_swIdx+_allW[_spanStart+_si].length;}
var _newText=_text.slice(0,_wStart)+_newWord+_text.slice(_wEnd);
// Update span tracking
var _nwc=_newWord.split(/\\s+/).length;
if(!globalThis._dynSpans)globalThis._dynSpans={};
if(_nwc>1){_dWord.spanLength=_nwc;for(var _spi=0;_spi<_nwc;_spi++){globalThis._dynSpans[_spanStart+_spi]={originalIndex:_spanStart,spanLength:_nwc};}}
else{delete _dWord.spanLength;for(var _sci=0;_sci<_spanLen;_sci++){delete globalThis._dynSpans[_spanStart+_sci];}}
// Handle linked words
var _updW={};_updW[_dIdx]=_newWord;
if(_dWord.linked&&_dWord.linked.length>0){
for(var _li=0;_li<_dWord.linked.length;_li++){
var _lIdx=_dWord.linked[_li];
if(_lIdx<0||_lIdx>=_allW.length)continue;
var _lDef=_dWords.find(function(w){return w.index===_lIdx;});
if(_lDef&&_lDef.alts&&_lDef.alts.length>_nextAlt){
_lDef.currentAltIndex=_nextAlt;
var _lNew=_lDef.alts[_nextAlt];
if(_lNew==null)continue;
var _lOld=_allW[_lIdx];
_lDef.word=_lNew;
var _lPos=0;
for(var _lwi=0;_lwi<_lIdx;_lwi++){var _sw=_updW[_lwi]||_allW[_lwi];var _sIdx=_newText.indexOf(_sw,_lPos);if(_sIdx<0)break;_lPos=_sIdx+_sw.length;}
var _lStart=_newText.indexOf(_lOld,_lPos);
if(_lStart>=0){_newText=_newText.slice(0,_lStart)+_lNew+_newText.slice(_lStart+_lOld.length);_updW[_lIdx]=_lNew;}
}}}
globalThis._hlText=_newText;
globalThis._hlState.text=_newText;
// Write highlight export immediately so status line has fresh data
try{var _cWords=_newText.split(/\\s+/).filter(function(w){return w});
var _cExp={active:true,highlightedWordIndex:_dIdx,highlightedWord:_dWord.alts[_nextAlt],wordCount:_cWords.length,cueTip:_dWord.cueTip||null,altCueTips:_dWord.altCueTips||null,alts:_dWord.alts,currentAltIndex:_nextAlt,timestamp:Date.now()};
_reqFn("fs").writeFileSync("/tmp/claude-highlight-state-"+process.pid+".json",JSON.stringify(_cExp));}catch(_we){}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
// Re-evaluate underscore if present
var _cw=_newText.split(/\\s+/).filter(function(w){return w;});
if(_cw.indexOf("_")>=0){var _ctx=_cw.filter(function(w){return w!=="_";}).join(" ");if(_ctx!==(globalThis._dynUnderscoreContext||"")){globalThis._dynUnderscoreQueued=true;if(!globalThis._dynPending&&globalThis._dynTriggerAnalysis){setTimeout(globalThis._dynTriggerAnalysis,100);}}}
return{text:_newText,lenDiff:_newWord.length-_oldWord.length,wStart:_wStart};
};
})();`;

  const newFile = oldFile.slice(0, insertPos) + cuesCoreInitCode + oldFile.slice(insertPos);

  showDiff(oldFile, newFile, cuesCoreInitCode, insertPos, insertPos);

  return newFile;
};

export interface DynamicHighlightConfig {
  enableDynamicHighlight?: boolean;
  dynamicHighlightDebounceMs?: number;  // Debounce delay in ms (default 0 = 50ms internal)
}

const DEFAULT_CONFIG: Required<DynamicHighlightConfig> = {
  enableDynamicHighlight: true,
  dynamicHighlightDebounceMs: 0,
};

/**
 * Find the input state handler location for injecting trigger detection.
 * Same pattern as wordHighlight.ts uses.
 */
const findInputStateHandlerLocation = (oldFile: string): LocationResult | null => {
  const funcPattern =
    /function ([$\w]+)\(\{value:([$\w]+),onChange:([$\w]+),[^}]+externalOffset:([$\w]+),onOffsetChange:([$\w]+)[^}]+\}\)\{[^}]*let ([$\w]+)=\4,([$\w]+)=\5,([$\w]+)=([$\w]+)\.fromText\(\2,([$\w]+),\6\)/;

  const match = oldFile.match(funcPattern);

  if (!match || match.index === undefined) {
    console.error('patch: dynamicHighlight: failed to find input state handler function pattern');
    return null;
  }

  // Find the return statement in the function
  const funcStart = match.index;
  const searchSection = oldFile.slice(funcStart, funcStart + 30000);

  const returnPattern = /return\{onInput:([$\w]+),renderedValue:/;
  const returnMatch = searchSection.match(returnPattern);

  if (!returnMatch || returnMatch.index === undefined) {
    console.error('patch: dynamicHighlight: failed to find return statement in input handler');
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
 * Write debounced auto-submit on new words.
 *
 * Instead of detecting "submit" trigger, this automatically analyzes text
 * when new words are added (debounced by 200ms).
 *
 * Features:
 * - Tracks previous words in globalThis._dynPrevWords
 * - Only triggers when NEW words are added (not edits to existing)
 * - 50ms debounce + word stability check
 * - Tips lookup first (local, ~0ms), then CueResolver for missing words
 * - Merges results with existing _dynDefs
 */
export const writeAutoSubmitDebounced = (
  oldFile: string,
  config: DynamicHighlightConfig = {}
): string | null => {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const location = findInputStateHandlerLocation(oldFile);
  if (!location) {
    return null;
  }

  const inputZoneVar = location.identifiers![7];  // R
  const inputZoneClass = location.identifiers![8]; // i5
  const configVar = location.identifiers![9];     // G
  const requireFuncName = getRequireFuncName(oldFile);

  // Auto-submit code with two-tier triggering:
  // Tier 1: Space-based (200ms) - when word count increases, previous word is complete
  // Tier 2: Final pause (2s) - catches last word when user stops typing
  const autoSubmitCode = `
(function(){
// Initialize ClaudeLog hints from config
var _dynText=globalThis._hlText||"";
var _curWords=_dynText.split(/\\s+/).filter(function(w){return w;});
var _lastAnalyzed=globalThis._dynLastAnalyzed||[];
var _prevWords=globalThis._dynPrevWords||[];
var _debugPath="/tmp/claude-auto-debug-"+process.pid+".txt";

// Debug: log state
try{${requireFuncName}("fs").appendFileSync(_debugPath,"["+Date.now()+"] text="+JSON.stringify(_dynText)+" cur="+_curWords.length+" last="+_lastAnalyzed.length+"\\n");}catch(_e){}

// Clear final pause timer on any text change
if(globalThis._dynFinalPauseTimer){
clearTimeout(globalThis._dynFinalPauseTimer);
globalThis._dynFinalPauseTimer=null;
}

// Tier 1: Space-based - word count increased means previous word is now complete
var _needsAnalysis=false;
if(_curWords.length>_prevWords.length&&_curWords.length>0){
// Word count increased (space typed)
// Check if the just-completed word differs from what we analyzed
var _completeIdx=_curWords.length-2;
if(_completeIdx>=0){
var _completedWord=_curWords[_completeIdx];
var _analyzedWord=_lastAnalyzed[_completeIdx]||"";
if(_completedWord!==_analyzedWord){
_needsAnalysis=true;
try{${requireFuncName}("fs").appendFileSync(_debugPath,"  space-trigger: idx="+_completeIdx+" '"+_completedWord+"' != '"+_analyzedWord+"'\\n");}catch(_e){}
}
}
// Also trigger if we have more words than ever analyzed
if(_curWords.length>_lastAnalyzed.length){
_needsAnalysis=true;
}
}

// Tier 3: Any word changed (editing mid-sentence) — check all positions
// Per-word clearing already nulled the alts; this triggers re-fetch
if(!_needsAnalysis&&_curWords.length===_lastAnalyzed.length&&_curWords.length>0){
for(var _ci=0;_ci<_curWords.length;_ci++){
if(_curWords[_ci]!==_lastAnalyzed[_ci]){
_needsAnalysis=true;
try{${requireFuncName}("fs").appendFileSync(_debugPath,"  edit-trigger: idx="+_ci+" '"+_curWords[_ci]+"' != '"+(_lastAnalyzed[_ci]||"")+"'\\n");}catch(_e){}
break;
}
}
}

// Underscore (blank) handling — only active when blanks.md is present
var _hasUnderscore=globalThis._blanksEnabled&&_curWords.indexOf("_")>=0;
if(_hasUnderscore){
// Get context (all words except underscore)
var _underscoreContext=_curWords.filter(function(w){return w!=="_";}).join(" ");
var _prevUnderscoreCtx=globalThis._dynUnderscoreContext||"";
var _contextChanged=_underscoreContext!==_prevUnderscoreCtx&&_prevUnderscoreCtx!=="";

// If context changed, INVALIDATE underscore's cached alternatives
// This ensures stale alts (e.g., "Sundar Pichai" for Google) aren't used after context change (to Microsoft)
if(_contextChanged&&globalThis._dynDefs&&globalThis._dynDefs.words){
for(var _ui=0;_ui<_curWords.length;_ui++){
if(_curWords[_ui]==="_"){
var _udef=globalThis._dynDefs.words.find(function(d){return d.index===_ui;});
if(_udef){_udef.alts=null;_udef.currentAltIndex=0;}
// Also clear any span info for this position
if(globalThis._dynSpans)delete globalThis._dynSpans[_ui];
}
}
try{${requireFuncName}("fs").appendFileSync(_debugPath,"  underscore-invalidate: context changed, cleared alts\\n");}catch(_e){}
}

if(globalThis._dynPending){
// Request in flight - queue re-analysis if context changed
if(_contextChanged){
globalThis._dynUnderscoreQueued=true;
try{${requireFuncName}("fs").appendFileSync(_debugPath,"  underscore-queued: context changed while pending\\n");}catch(_e){}
}
}else if(_contextChanged){
// Context changed and not pending - trigger analysis
_needsAnalysis=true;
try{${requireFuncName}("fs").appendFileSync(_debugPath,"  underscore-trigger: context changed\\n");}catch(_e){}
}
}

// Update previous words for next comparison
globalThis._dynPrevWords=_curWords.slice();

// Tier 2: Final pause timer (300ms) - for the last word without trailing space
// Always starts the timer (even if pending) — checks pending when it fires
var _lastWordIdx=_curWords.length-1;
if(_lastWordIdx>=0){
var _lastWord=_curWords[_lastWordIdx];
var _lastAnalyzedWord=_lastAnalyzed[_lastWordIdx]||"";
if(_lastWord!==_lastAnalyzedWord){
globalThis._dynFinalPauseTimer=setTimeout(function(){
if(!globalThis._dynPending&&globalThis._hlText){
var _curW=globalThis._hlText.split(/\\s+/).filter(function(w){return w;});
var _laW=globalThis._dynLastAnalyzed||[];
// Re-check that last word still differs
if(_curW.length>0&&_curW[_curW.length-1]!==(_laW[_curW.length-1]||"")){
try{${requireFuncName}("fs").appendFileSync(_debugPath,"["+Date.now()+"] final-pause-trigger\\n");}catch(_e){}
globalThis._dynTriggerAnalysis&&globalThis._dynTriggerAnalysis();
}
}
},300);
}
}

// Debug: log decision
try{${requireFuncName}("fs").appendFileSync(_debugPath,"  needsAnalysis="+_needsAnalysis+" pending="+globalThis._dynPending+"\\n");}catch(_e){}

// Define the analysis trigger function (used by both debounce and final pause)
if(!globalThis._dynTriggerAnalysis){
globalThis._dynTriggerAnalysis=function(){
if(globalThis._dynPending)return;
var _inputPath="/tmp/claude-llm-input-"+process.pid+".txt";
var _resultPath="/tmp/claude-llm-result-"+process.pid+".json";
var _scriptPath=(process.env.HOME||"~")+"/.claude/llm-analyze-auto.sh";
var _prevJson=globalThis._dynDefs?JSON.stringify(globalThis._dynDefs):"";
var _debugPath="/tmp/claude-auto-debug-"+process.pid+".txt";
// Capture the text we're actually sending (for accurate _dynLastAnalyzed)
var _sentText=globalThis._hlText||"";
var _sentWords=_sentText.split(/\\s+/).filter(function(w){return w;});
// Store underscore context when triggering
if(_sentWords.indexOf("_")>=0){
globalThis._dynUnderscoreContext=_sentWords.filter(function(w){return w!=="_";}).join(" ");
}

// LOCAL TIPS LOOKUP - uses cues-core functions for O(1) lookup
// Skip cue-actions (numbers, custom actions) — they have built-in cycling, not tips
var _lookup=globalThis._cuesCore&&globalThis._localCueMap?globalThis._cuesCore.lookupMultiple(_sentWords,globalThis._localCueMap,{skipPattern:/^_$/,skipFn:globalThis._isCueAction}):{found:[],missingIndices:_sentWords.map(function(_,i){return i;}).filter(function(i){return _sentWords[i]!=="_";})};

// If ALL non-underscore words matched tips, skip LLM entirely
if(_lookup.found.length>0&&_lookup.missingIndices.length===0&&_sentWords.indexOf("_")<0){
var _oldDefs=globalThis._dynDefs&&globalThis._dynDefs.words?globalThis._dynDefs.words:[];
var _newWords=globalThis._cuesCore.formatAsWordDefs(_lookup.found,_sentWords);
for(var _ndi=0;_ndi<_newWords.length;_ndi++){var _od=_oldDefs.find(function(d){return d.index===_newWords[_ndi].index;});if(_od&&typeof _od.currentAltIndex==="number"){_newWords[_ndi].currentAltIndex=_od.currentAltIndex;}}
globalThis._dynDefs={words:_newWords,_model:"tips-only",_timing:"0ms"};
globalThis._dynLastAnalyzed=_sentWords;
var _timingPath="/tmp/claude-llm-timing-"+process.pid+".txt";
try{${requireFuncName}("fs").writeFileSync(_timingPath,"0ms (tips-only) | "+_lookup.found.length+" words\\n",{flag:"a"});}catch(_te){}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
if(globalThis._forceInputRefresh)globalThis._forceInputRefresh();
return;
}

// Apply tips results to existing _dynDefs immediately (merge with any pending/existing)
if(_lookup.found.length>0){
if(!globalThis._dynDefs)globalThis._dynDefs={words:[]};
globalThis._dynDefs.words=globalThis._cuesCore.mergeWordDefs(globalThis._dynDefs.words,_lookup.found);
if(globalThis._forceInputRefresh)globalThis._forceInputRefresh();
}

// If no non-tips words AND no underscores, we're done
if(_lookup.missingIndices.length===0&&_sentWords.indexOf("_")<0){
globalThis._dynLastAnalyzed=_sentWords;
return;
}

// WORD STABILITY CHECK: re-read text and abort if it changed since trigger
// This prevents sending partial/incomplete words to the LLM
var _currentText=(globalThis._hlText||"").split(/\\s+/).filter(function(w){return w;});
if(_currentText.join(" ")!==_sentWords.join(" ")){
try{${requireFuncName}("fs").appendFileSync(_debugPath,"["+Date.now()+"] word-stability: text changed, aborting\\n");}catch(_e){}
return;
}

// TARGETED INDEX OPTIMIZATION:
// Blanks need full sentence context — skip targeted mode when underscores present
var _hasBlank=_sentWords.indexOf("_")>=0;
var _sendText;
if(_hasBlank){
// Blanks: send full sentence (LLM needs context to fill gaps)
_sendText=_sentText;
globalThis._dynIndexMap=null;
}else{
// No blanks: find which indices already have valid alts — only send missing ones
var _needLlmIndices=[];
var _ignSet=globalThis._cuesIgnoreWords;
for(var _si=0;_si<_sentWords.length;_si++){
// Skip ignored words (from cues.md ## Ignore)
var _sw=_sentWords[_si].toLowerCase();
if(_ignSet&&_ignSet.has(_sw))continue;
if(/^(the|a|an|to|is|was|of|and|in|on|at|for|it|its|be|am|are|were|been|has|had|have|do|did|does|not|but|or|if|so|no|my|we|he|she|me|us|them|this|that|with|from|by|as)$/.test(_sw))continue;
// Check if this index already has valid alts in _dynDefs
var _hasAlts=globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.find(function(d){return d.index===_si&&d.alts&&d.alts.length>1&&d.alts.indexOf(_sentWords[_si])>=0;});
// Also skip if tips already covered this word
var _tipsHandled=_lookup.found&&_lookup.found.find(function(f){return f.index===_si;});
if(!_hasAlts&&!_tipsHandled){
_needLlmIndices.push(_si);
}
}
// If nothing needs LLM, we're done
if(_needLlmIndices.length===0){
globalThis._dynLastAnalyzed=_sentWords;
return;
}
// Full-context mode: send entire sentence with original indices
// LLM gets "ONLY give alts for indices X,Y" instruction to limit output
_sendText=_sentText;
globalThis._dynIndexMap=null;
}

try{
var _debugPath2="/tmp/claude-auto-debug-"+process.pid+".txt";

// === UNIFIED CueResolver path for ALL modes ===
if(globalThis._cueResolver){
try{${requireFuncName}("fs").appendFileSync(_debugPath2,"["+Date.now()+"] resolver: "+(_hasBlank?"blank":"grammar")+" mode, "+(_hasBlank?_sentWords.length:_needLlmIndices.length)+"/"+_sentWords.length+" targets\\n");}catch(_e){}
globalThis._dynPending=true;
globalThis._dynPollStart=Date.now();
globalThis._dynSentWords=_sentWords;
var _ctx={text:_sentText,words:_sentWords,metadata:{targetIndices:_hasBlank?null:_needLlmIndices}};
globalThis._cueResolver.resolve(_ctx).then(function(_resolved){
try{
var _elapsed=Date.now()-globalThis._dynPollStart;
var _words=[];
for(var _ri=0;_ri<_resolved.results.length;_ri++){
var _r=_resolved.results[_ri];
if(_r.alternatives&&_r.alternatives.length>1){
var _filteredAlts=[];
for(var _fa=0;_fa<_r.alternatives.length;_fa++){
var _a=_r.alternatives[_fa].replace(/[.;:!?]+$/,"");
if(_a&&(_a==="_"||_a.length>1||_r.word==="_")&&_filteredAlts.indexOf(_a)<0)_filteredAlts.push(_a);
}
if(_filteredAlts.length>1){
_words.push({index:_r.wordIndex,word:_r.word,alts:_filteredAlts,linked:_r.linked||null,currentAltIndex:0,source:_r.source||"resolver"});
}
}
}
if(globalThis._dynDefs&&globalThis._dynDefs.words){
for(var _mi2=0;_mi2<_words.length;_mi2++){
var _nw2=_words[_mi2];
var _spanInfo2=globalThis._dynSpans&&globalThis._dynSpans[_nw2.index];
if(_spanInfo2&&_spanInfo2.originalIndex!==_nw2.index){_nw2.alts=null;continue;}
var _oldW2=globalThis._dynDefs.words.find(function(w){return w.index===_nw2.index;});
if(_oldW2&&_oldW2.alts){
if(_oldW2.spanLength)_nw2.spanLength=_oldW2.spanLength;
if(_nw2.alts){var _mg=_oldW2.alts.slice();for(var _ai3=0;_ai3<_nw2.alts.length;_ai3++){if(_mg.indexOf(_nw2.alts[_ai3])<0)_mg.push(_nw2.alts[_ai3]);}_nw2.alts=_mg;}
else{_nw2.alts=_oldW2.alts.slice();}
_nw2.currentAltIndex=_oldW2.currentAltIndex||0;
}
var _existIdx=globalThis._dynDefs.words.findIndex(function(d){return d.index===_nw2.index;});
if(_existIdx>=0){globalThis._dynDefs.words[_existIdx]=_nw2;}else{globalThis._dynDefs.words.push(_nw2);}
}
globalThis._dynDefs._model="resolver";
}else{
globalThis._dynDefs={words:_words,_model:"resolver",_auto:true};
}
globalThis._dynLastAnalyzed=globalThis._dynSentWords||[];
var _timingPath2="/tmp/claude-llm-timing-"+process.pid+".txt";
var _wAlts=_words.filter(function(w){return w.alts&&w.alts.length>1;}).length;
var _srcModel=(_resolved.metrics&&_resolved.metrics.length>0)?_resolved.metrics[_resolved.metrics.length-1].sourceId||"resolver":"resolver";
try{${requireFuncName}("fs").writeFileSync(_timingPath2,_elapsed+"ms (resolver) | "+_wAlts+" words | "+_srcModel+"\\n",{flag:"a"});}catch(_te2){}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
if(globalThis._forceInputRefresh)globalThis._forceInputRefresh();
}catch(_pe){
try{${requireFuncName}("fs").appendFileSync(_debugPath2,"["+Date.now()+"] resolver-parse-error: "+_pe.message+"\\n");}catch(_e3){}
}
globalThis._dynPending=false;
if(globalThis._dynUnderscoreQueued){
globalThis._dynUnderscoreQueued=false;
setTimeout(function(){if(!globalThis._dynPending&&globalThis._dynTriggerAnalysis){globalThis._dynTriggerAnalysis();}},100);
}
}).catch(function(_err){
globalThis._dynPending=false;
try{${requireFuncName}("fs").appendFileSync(_debugPath2,"["+Date.now()+"] resolver-error: "+_err.message+"\\n");}catch(_e4){}
});
}else{
// Fallback: no resolver/prompt available
try{${requireFuncName}("fs").appendFileSync(_debugPath2,"["+Date.now()+"] no-resolver: skipping LLM call\\n");}catch(_e5){}
}
}catch(_e){console.error("autoSubmit error:",_e);}
};
}

if(_needsAnalysis&&_curWords.length>0&&!globalThis._dynPending){
// Clear existing debounce timer
if(globalThis._dynDebounceTimer){
clearTimeout(globalThis._dynDebounceTimer);
}
// Set debounce timer (50ms - allows fast typing to settle)
// Then verify text hasn't changed before triggering
globalThis._dynDebounceTimer=setTimeout(function(){
// Re-check: if text changed since timer was set, skip (next keystroke will re-trigger)
var _nowText=(globalThis._hlText||"").split(/\\s+/).filter(function(w){return w;}).join(" ");
var _thenText=_curWords.join(" ");
if(_nowText!==_thenText){return;}
globalThis._dynTriggerAnalysis();
},50);
}
})();
`;

  const newFile =
    oldFile.slice(0, location.startIndex) +
    autoSubmitCode +
    oldFile.slice(location.endIndex);

  showDiff(
    oldFile,
    newFile,
    autoSubmitCode,
    location.startIndex,
    location.endIndex
  );

  return newFile;
};

/**
 * Find the key action dispatcher function.
 * Same pattern as wordHighlight.ts.
 */
const findKeyDispatcherLocation = (oldFile: string): LocationResult | null => {
  const funcPattern = /\bfunction ([$\w]+)\(([$\w]+)\)\{switch\(!0\)\{case \2\.escape:/;
  const match = oldFile.match(funcPattern);

  if (!match || match.index === undefined) {
    console.error('patch: dynamicHighlight: failed to find key dispatcher function');
    return null;
  }

  const switchStartPos = oldFile.indexOf('switch(!0){', match.index);
  if (switchStartPos === -1) {
    console.error('patch: dynamicHighlight: failed to find switch statement');
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
 * Modify the Up/Down key handlers to use dynamic JSON definitions when available.
 *
 * This patches the EXISTING wordHighlight Up/Down handlers by wrapping them
 * with dynamic definition checks. If globalThis._dynDefs exists and has
 * alternatives for the highlighted word, use JSON-based cycling instead.
 */
export const writeDynamicCycleHandlers = (
  oldFile: string,
  config: DynamicHighlightConfig = {}
): string | null => {
  // Find the existing Up arrow handler from wordHighlight
  // Pattern: case(keyParam.upArrow&&keyParam.ctrl&&(keyParam.meta||keyParam.option||keyParam.alt)):return()=>{
  const upPattern = /case\(([$\w]+)\.upArrow&&\1\.ctrl&&\(\1\.meta\|\|\1\.option\|\|\1\.alt\)\):return\(\)=>\{/;
  const upMatch = oldFile.match(upPattern);

  if (!upMatch || upMatch.index === undefined) {
    console.error('patch: dynamicHighlight: failed to find Up arrow handler');
    return null;
  }

  const keyParam = upMatch[1];

  // Find InputZone class and config var
  const fromTextPattern = /([$\w]+)=([$\w]+)\.fromText\(([$\w]+),([$\w]+),([$\w]+)\)/;
  const fromTextMatch = oldFile.match(fromTextPattern);
  if (!fromTextMatch) {
    console.error('patch: dynamicHighlight: failed to find InputZone.fromText pattern');
    return null;
  }
  const inputZoneVar = fromTextMatch[1];    // h (the InputZone instance)
  const inputZoneClass = fromTextMatch[2]; // i5
  const configVar = fromTextMatch[4];       // G

  // Get require function name for spawning action scripts
  const requireFuncName = getRequireFuncName(oldFile);

  // Insert dynamic handling code at the start of the Up arrow handler
  // After the opening brace of the return()=>{
  const upInsertPos = upMatch.index + upMatch[0].length;

  // Dynamic cycle Up — delegates to shared _cycleAlt(direction, ...)
  const dynUpCode = `
{var _r=globalThis._cycleAlt&&globalThis._cycleAlt(1,null,null,null,${requireFuncName});
if(_r&&_r.refresh){if(globalThis._forceInputRefresh)globalThis._forceInputRefresh();var _pv=globalThis._parentValue||"";return ${inputZoneClass}.fromText(${inputZoneVar}.text+(_pv.indexOf("\\u200B")>=0?"\\u200C":"\\u200B"),${configVar},${inputZoneVar}.offset);}
if(_r){var _off=_r.wStart<${inputZoneVar}.offset?${inputZoneVar}.offset+_r.lenDiff:${inputZoneVar}.offset;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}}
`;

  let newFile = oldFile.slice(0, upInsertPos) + dynUpCode + oldFile.slice(upInsertPos);

  // Now find and patch the Down arrow handler
  const downPattern = /case\(([$\w]+)\.downArrow&&\1\.ctrl&&\(\1\.meta\|\|\1\.option\|\|\1\.alt\)\):return\(\)=>\{/;
  const downMatch = newFile.match(downPattern);

  if (!downMatch || downMatch.index === undefined) {
    console.error('patch: dynamicHighlight: failed to find Down arrow handler');
    return null;
  }

  const downInsertPos = downMatch.index + downMatch[0].length;

  // Dynamic cycle Down — delegates to shared _cycleAlt(direction, ...)
  const dynDownCode = `
{var _r=globalThis._cycleAlt&&globalThis._cycleAlt(-1,null,null,null,${requireFuncName});
if(_r&&_r.refresh){if(globalThis._forceInputRefresh)globalThis._forceInputRefresh();var _pv=globalThis._parentValue||"";return ${inputZoneClass}.fromText(${inputZoneVar}.text+(_pv.indexOf("\\u200B")>=0?"\\u200C":"\\u200B"),${configVar},${inputZoneVar}.offset);}
if(_r){var _off=_r.wStart<${inputZoneVar}.offset?${inputZoneVar}.offset+_r.lenDiff:${inputZoneVar}.offset;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}}
`;

  newFile = newFile.slice(0, downInsertPos) + dynDownCode + newFile.slice(downInsertPos);

  return newFile;
};

/**
 * Modify the raw sequence Up/Down handlers for dynamic JSON support.
 * These are fallback handlers for terminals that don't set meta/option properties.
 */
export const writeDynamicRawSequenceHandlers = (
  oldFile: string,
  config: DynamicHighlightConfig = {}
): string | null => {
  // Find InputZone class and config var
  const fromTextPattern = /([$\w]+)=([$\w]+)\.fromText\(([$\w]+),([$\w]+),([$\w]+)\)/;
  const fromTextMatch = oldFile.match(fromTextPattern);
  if (!fromTextMatch) {
    console.error('patch: dynamicHighlight: failed to find InputZone.fromText pattern for raw sequence');
    return null;
  }
  const inputZoneVar = fromTextMatch[1];
  const inputZoneClass = fromTextMatch[2];
  const configVar = fromTextMatch[4];
  const requireFuncName = getRequireFuncName(oldFile);

  // Find raw sequence Up handler: case(wA==="\x1B[1;7A"):
  // In the file, \x1B is literal characters
  const rawUpPattern = /case\(([$\w]+)==="\\x1B\[1;7A"\):if\(!globalThis\._hlState/;
  const rawUpMatch = oldFile.match(rawUpPattern);

  if (!rawUpMatch || rawUpMatch.index === undefined) {
    console.error('patch: dynamicHighlight: failed to find raw sequence Up handler');
    return null;
  }

  // Insert at the start of the case (after the colon)
  const colonPos = oldFile.indexOf(':', rawUpMatch.index);
  const rawUpInsertPos = colonPos + 1;

  // Dynamic cycle Up — delegates to shared _cycleAlt
  const dynRawUpCode = `{var _r=globalThis._cycleAlt&&globalThis._cycleAlt(1,null,null,null,${requireFuncName});
if(_r&&_r.refresh){var _pv=globalThis._parentValue||"";return ${inputZoneClass}.fromText(${inputZoneVar}.text+(_pv.indexOf("\\u200B")>=0?"\\u200C":"\\u200B"),${configVar},${inputZoneVar}.offset);}
if(_r){var _off=_r.wStart<${inputZoneVar}.offset?${inputZoneVar}.offset+_r.lenDiff:${inputZoneVar}.offset;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}}`;
  let newFile = oldFile.slice(0, rawUpInsertPos) + dynRawUpCode + oldFile.slice(rawUpInsertPos);

  // Find raw sequence Down handler: case(wA==="\x1B[1;7B"):
  const rawDownPattern = /case\(([$\w]+)==="\\x1B\[1;7B"\):if\(!globalThis\._hlState/;
  const rawDownMatch = newFile.match(rawDownPattern);

  if (!rawDownMatch || rawDownMatch.index === undefined) {
    console.error('patch: dynamicHighlight: failed to find raw sequence Down handler');
    return null;
  }

  const downColonPos = newFile.indexOf(':', rawDownMatch.index);
  const rawDownInsertPos = downColonPos + 1;

  // Dynamic cycle Down — delegates to shared _cycleAlt
  const dynRawDownCode = `{var _r=globalThis._cycleAlt&&globalThis._cycleAlt(-1,null,null,null,${requireFuncName});
if(_r&&_r.refresh){var _pv=globalThis._parentValue||"";return ${inputZoneClass}.fromText(${inputZoneVar}.text+(_pv.indexOf("\\u200B")>=0?"\\u200C":"\\u200B"),${configVar},${inputZoneVar}.offset);}
if(_r){var _off=_r.wStart<${inputZoneVar}.offset?${inputZoneVar}.offset+_r.lenDiff:${inputZoneVar}.offset;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}}`;

  newFile = newFile.slice(0, rawDownInsertPos) + dynRawDownCode + newFile.slice(rawDownInsertPos);

  return newFile;
};

/**
 * writeActionOvrVariable is no longer needed — gender mode was removed,
 * so _rootPat no longer exists. The rendering code accesses
 * globalThis._cueActionOverrides directly.
 */
export const writeActionOvrVariable = (
  oldFile: string,
  _config: DynamicHighlightConfig = {}
): string | null => {
  return oldFile;
};

/**
 * Modify the rendering to show words with alts in gray (dim).
 * When dynamic defs are loaded, words with alternatives are dimmed to show they're navigable.
 *
 * Extends the _numRanges pattern to also dim action words and dynamic alt words.
 */
export const writeDynamicRendering = (
  oldFile: string,
  config: DynamicHighlightConfig = {}
): string | null => {
  // Find the _numRanges pattern (_numPat only)
  // Pattern: else if(_numPat.test(_w)){_numRanges.push({start:_wStart,end:_wStart+_w.length});}
  const numPattern = /else if\(_numPat\.test\(_w\)\)\{_numRanges\.push\(\{start:_wStart,end:_wStart\+_w\.length\}\);\}/;
  const numMatch = oldFile.match(numPattern);

  if (numMatch && numMatch.index !== undefined) {
    // Numbers mode: extend _numRanges to also dim action words and dynamic alt words
    const newNumCode = `else if(_numPat.test(_w)||(globalThis._cueActionOverrides||{})[_w.toLowerCase()]){_numRanges.push({start:_wStart,end:_wStart+_w.length});
}else if(globalThis._dynDefs&&globalThis._dynDefs.words){
var _dynDef=globalThis._dynDefs.words.find(function(d){return d.index===_ni&&d.alts&&d.alts.length>1&&d.alts.indexOf(_w)>=0;});
var _spanInfo=globalThis._dynSpans&&globalThis._dynSpans[_ni];
var _isInSpan=!!_spanInfo;
var _isInHighlightedSpan=_spanInfo&&_spanInfo.originalIndex===_hlWordIdx;
if((_dynDef||_isInSpan)&&_ni!==_hlWordIdx&&!_isInHighlightedSpan)_numRanges.push({start:_wStart,end:_wStart+_w.length});
}`;

    return oldFile.replace(numPattern, newNumCode);
  }

  console.error('patch: dynamicHighlight: failed to find dim/num ranges push pattern');
  return null;
};

/**
 * Clear dynamic definitions when text changes significantly.
 * This ensures stale definitions don't persist after user edits the text.
 */
export const writeDynamicClearOnChange = (
  oldFile: string,
  config: DynamicHighlightConfig = {}
): string | null => {
  // Find where _hlText is assigned (BEFORE the highlight-active check)
  // We insert per-word clearing here so it runs unconditionally
  const assignPattern = /globalThis\._hlText=_hlText;/;
  const assignMatch = oldFile.match(assignPattern);

  if (!assignMatch || assignMatch.index === undefined) {
    console.error('patch: dynamicHighlight: failed to find _hlText assignment pattern');
    return null;
  }

  const insertPos = assignMatch.index + assignMatch[0].length;

  // Per-word invalidation logic:
  // - For each word position, check if word changed
  // - If word is IN alts: update word/currentAltIndex (valid cycle)
  // - If word changed to something NOT in alts: clear alts (handles index shifts from insertion/deletion)
  // - New words (beyond old length): no alts yet
  // - Only preserves alts when word matches (valid cycle)
  const clearCode = `
if(_hlText!==_oldText&&globalThis._dynDefs&&globalThis._dynDefs.words){
var _oldW=_oldText.split(/\\s+/).filter(function(w){return w;});
var _newW=_hlText.split(/\\s+/).filter(function(w){return w;});
var _minLen=Math.min(_oldW.length,_newW.length);
// Check each position up to min length
for(var _wi=0;_wi<_minLen;_wi++){
if(_oldW[_wi]!==_newW[_wi]){
var _def=globalThis._dynDefs.words.find(function(d){return d.index===_wi;});
if(_def){
if(_def.alts&&_def.alts.indexOf(_newW[_wi])>=0){
// Word is in alts - valid cycle, update index
_def.word=_newW[_wi];
_def.currentAltIndex=_def.alts.indexOf(_newW[_wi]);
}else{
// Word changed to something NOT in alts - clear alts
// This handles mid-sentence insertion/deletion where indices shift
_def.word=_newW[_wi];
_def.alts=null;
_def.currentAltIndex=0;
if(globalThis._dynSpans)delete globalThis._dynSpans[_wi];
}
}
}
}
// Handle removed words (invalidate definitions for indices beyond new length)
if(_newW.length<_oldW.length){
for(var _ri=_newW.length;_ri<_oldW.length;_ri++){
var _rdef=globalThis._dynDefs.words.find(function(d){return d.index===_ri;});
if(_rdef){_rdef.alts=null;}
}
}
// Update _dynDefs word count marker
globalThis._dynDefs._wordCount=_newW.length;
}`;

  const newFile = oldFile.slice(0, insertPos) + clearCode + oldFile.slice(insertPos);

  showDiff(oldFile, newFile, clearCode, insertPos, insertPos);

  return newFile;
};

/**
 * Modify navigation to work with dynamic mode.
 * When JSON defs are active, allow navigating to any word with alts.
 */
export const writeDynamicNavigation = (
  oldFile: string,
  config: DynamicHighlightConfig = {}
): string | null => {
  // Find ALL forEach loops that populate _targetIdx (including _targetIdx2, etc.)
  // Pattern: _allW.forEach(function(w,i){if(condition)_targetIdx.push(i);});
  // Variable names may have suffixes like _allW2, _targetIdx2
  const forEachPattern = /([$\w]+)\.forEach\(function\(w,i\)\{if\(([^)]+(?:\([^)]*\)[^)]*)*)\)([$\w]+)\.push\(i\);\}\);/g;

  let newFile = oldFile;
  let match;
  let replaced = false;
  const matches: Array<{full: string, allW: string, condition: string, targetIdx: string}> = [];

  // Collect all matches first (to avoid regex state issues)
  while ((match = forEachPattern.exec(oldFile)) !== null) {
    // Only match _allW* and _targetIdx* patterns
    if (match[1].startsWith('_allW') && match[3].startsWith('_targetIdx')) {
      matches.push({
        full: match[0],
        allW: match[1],
        condition: match[2],
        targetIdx: match[3]
      });
    }
  }

  // Replace each match
  for (const m of matches) {
    // Skip if already patched
    if (m.condition.includes('_hasDynAlt')) {
      continue;
    }

    // Check: has alts AND current word is IN the alts array (allows recovery after partial typing)
    // Span-aware: Skip non-original span positions (don't navigate to "Pichai" separately)
    // Also: span originals are navigable even if current word isn't in alts (e.g., "Jeff" when alt is "Jeff Bezos")
    const newForEach = `${m.allW}.forEach(function(w,i){
var _hasDynAlt=globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.find(function(d){return d.index===i&&d.alts&&d.alts.length>1&&d.alts.indexOf(w)>=0;});
var _spanInfo=globalThis._dynSpans&&globalThis._dynSpans[i];
var _isNonOrigSpan=_spanInfo&&_spanInfo.originalIndex!==i;
var _isSpanOriginal=_spanInfo&&_spanInfo.originalIndex===i;
if(((${m.condition})||_hasDynAlt||_isSpanOriginal)&&!_isNonOrigSpan)${m.targetIdx}.push(i);
});`;

    newFile = newFile.replace(m.full, newForEach);
    replaced = true;
  }

  if (!replaced) {
    console.log('patch: dynamicHighlight: forEach modification skipped (pattern not found)');
    return oldFile;
  }

  return newFile;
};

/**
 * Apply all dynamic highlight patches.
 *
 * This should be called AFTER writeWordHighlight in index.ts.
 * Returns the final patched content or null if any critical patch fails.
 */
export const writeDynamicHighlight = (
  oldFile: string,
  config: DynamicHighlightConfig = {}
): string | null => {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let content = oldFile;
  let result: string | null;

  // 0. Initialize cues-core at startup for instant tips lookup (~0.3ms vs 575ms)
  result = writeCuesCoreInit(content, config);
  if (!result) {
    console.log('patch: dynamicHighlight: cues-core init failed (will fall back to shell script)');
    // Don't fail - shell script still works, just slower
  } else {
    content = result;
    console.log('patch: dynamicHighlight: cues-core initialized (instant tips lookup)');
  }

  // wink-pos-tagger removed — blank classification handled by cues-core's
  // looksLikeMath/looksLikeFactual in MathSource/FactualSource.supports()

  // 2. Apply trigger detection OR auto-submit based on config
  // Apply auto-submit: debounced analysis on new words
  result = writeAutoSubmitDebounced(content, config);
  if (!result) {
    console.error('patch: dynamicHighlight: failed to apply auto-submit patch');
    return null;
  }
  content = result;

  // 3. Apply dynamic cycle handlers (modify Up/Down to use JSON)
  result = writeDynamicCycleHandlers(content, config);
  if (!result) {
    console.error('patch: dynamicHighlight: failed to apply cycle handlers patch');
    return null;
  }
  content = result;

  // 4. Apply dynamic raw sequence handlers (fallback for terminals)
  result = writeDynamicRawSequenceHandlers(content, config);
  if (!result) {
    console.log('patch: dynamicHighlight: raw sequence handlers not applied (optional)');
    // Don't fail - this is optional
  } else {
    content = result;
  }

  // 5. Add _actOvr variable definition (required for rendering)
  result = writeActionOvrVariable(content, config);
  if (!result) {
    console.log('patch: dynamicHighlight: _actOvr variable not added (optional)');
  } else {
    content = result;
  }

  // 6. Apply dynamic rendering (show words with alts in cyan underline)
  result = writeDynamicRendering(content, config);
  if (!result) {
    console.log('patch: dynamicHighlight: rendering not applied (optional)');
    // Don't fail - this is optional
  } else {
    content = result;
  }

  // 7. Apply clear-on-change (clear defs when text changes)
  result = writeDynamicClearOnChange(content, config);
  if (!result) {
    console.log('patch: dynamicHighlight: clear-on-change not applied (optional)');
  } else {
    content = result;
  }

  // 8. Apply dynamic navigation (allow navigating to words with alts)
  result = writeDynamicNavigation(content, config);
  if (!result) {
    console.log('patch: dynamicHighlight: navigation modification not applied (optional)');
  } else {
    content = result;
  }

  return content;
};

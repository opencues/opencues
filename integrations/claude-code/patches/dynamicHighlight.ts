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
 * - ConfigSource (scope:words) — word alternatives from cues.md (grammar, legal, medical, etc.)
 * - ClassifiedSourceGroup (scope:blanks) — blank fill-in from blanks.md (math, factual, grammar)
 * - Tips lookup — instant O(1) from ~/.claude/claude-code-tips.json
 *
 * ## Cycling Priority
 *
 * When Up/Down pressed on highlighted word:
 * 1. Control word override → spawn external script, return
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
 * - globalThis._cycleAlt — shared cycling function (control words, alts, spans)
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
// Hot-reload config: track load timestamp and resolver generation counter
globalThis._configLoadedAt=globalThis._configLoadedAt||0;
globalThis._resolverGeneration=globalThis._resolverGeneration||0;
globalThis._configReloading=globalThis._configReloading||false;
// Load cues-core module once per process (not hot-reloadable)
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
// Config reload function: parses cues.md/blanks.md/controls.md + folder configs,
// rebuilds the resolver with new sources, and clears the analyzed-word cache.
// Called at startup and re-called after CONFIG_TTL_MS (2s) on the next analysis trigger.
globalThis._reloadCuesConfig=function(){
if(!globalThis._cuesCore)return;
globalThis._configReloading=true;
var _applied=false;
try{
var _rfs=${requireFuncName}("fs");var _rcwd=process.cwd();
var _ign=[],_newCuesMd=null,_newBlanksMd=null,_newCtrlOvr=Object.assign({},globalThis._staticCueControlOverrides||{});
// cues.md (aliases: hints.md, tips.md) — tips + prompt config
["cues.md","hints.md","tips.md"].some(function(f){var p=_rcwd+"/"+f;if(_rfs.existsSync(p)){var _c=globalThis._cuesCore.parseCuesMd(_rfs.readFileSync(p,"utf8"));_newCuesMd=_c;if(_c.ignore){_ign=_ign.concat(_c.ignore);}return true;}});
// controls.md — cue-controls (custom control overrides)
var _rCtrlPath=_rcwd+"/controls.md";
if(_rfs.existsSync(_rCtrlPath)){var _cc=globalThis._cuesCore.parseCuesMd(_rfs.readFileSync(_rCtrlPath,"utf8"));if(_cc.controls)Object.assign(_newCtrlOvr,_cc.controls);if(_cc.ignore){_ign=_ign.concat(_cc.ignore);}}
// blanks.md — blank-fill config
var _rBlankPath=_rcwd+"/blanks.md";
if(_rfs.existsSync(_rBlankPath)){var _bc=globalThis._cuesCore.parseCuesMd(_rfs.readFileSync(_rBlankPath,"utf8"));_newBlanksMd=_bc;if(_bc.ignore){_ign=_ign.concat(_bc.ignore);}}
// Folder-based config discovery (cues/, blanks/, controls/ directories)
if(globalThis._cuesCore.discoverFolderConfigs){
var _rFsAdp={readFile:function(p){try{return _rfs.readFileSync(p,"utf8");}catch(_e){return null;}},readDir:function(p){try{return _rfs.readdirSync(p,{withFileTypes:true}).map(function(d){return{name:d.name,isDirectory:d.isDirectory()};});}catch(_e){return null;}}};
var _rFolderCfgs=globalThis._cuesCore.discoverFolderConfigs({basePath:_rcwd,readFile:_rFsAdp.readFile,readDir:_rFsAdp.readDir});
var _rMono={cuesConfig:_newCuesMd||undefined,blanksConfig:_newBlanksMd||undefined,controlOverrides:Object.keys(_newCtrlOvr).length?_newCtrlOvr:undefined,ignoreWords:_ign.length?_ign:undefined};
var _rMerged=globalThis._cuesCore.mergeConfigs(_rMono,_rFolderCfgs);
_newCuesMd=_rMerged.cuesConfig||_newCuesMd;
_newBlanksMd=_rMerged.blanksConfig||_newBlanksMd;
if(_rMerged.controlOverrides)Object.assign(_newCtrlOvr,_rMerged.controlOverrides);
if(_rMerged.ignoreWords&&_rMerged.ignoreWords.length)_ign=_rMerged.ignoreWords;
}
// Apply merged config atomically (all assignments after all parsing)
globalThis._cuesMdParsed=_newCuesMd||null;
globalThis._blanksMdParsed=_newBlanksMd||null;
globalThis._cueControlOverrides=_newCtrlOvr;
// Build step patterns index for fast lookup during cycling
var _newStepPats=[];Object.values(_newCtrlOvr).forEach(function(_sc){
if(_sc.stepPattern){try{_newStepPats.push({re:new RegExp(_sc.stepPattern),ctrl:_sc});}catch(_e){}}
if(_sc.stepSuffixes&&_sc.stepSuffixes.length){_sc.stepSuffixes.forEach(function(_sf){var _escaped=_sf.replace(/[^a-zA-Z0-9]/g,'\\$&');try{_newStepPats.push({re:new RegExp('^-?\\\\d+(\\\\.\\\\d+)?'+_escaped+'$'),ctrl:Object.assign({},_sc,{stepSuffix:_sf,stepSuffixes:undefined})});}catch(_e){}});}
});globalThis._stepPatterns=_newStepPats;
globalThis._blanksEnabled=!!(globalThis._blanksMdParsed&&globalThis._blanksMdParsed.promptConfig);
// Rebuild localCueMap from scratch — ensures deleted tips are removed on reload
if(globalThis._localCueData){
var _newMap=globalThis._cuesCore.buildLookupMap(globalThis._localCueData);
if(globalThis._cuesMdParsed&&globalThis._cuesMdParsed.tips){var _tm=globalThis._cuesCore.buildLookupMap(globalThis._cuesMdParsed.tips);_tm.forEach(function(v,k){_newMap.set(k,v);});}
globalThis._localCueMap=_newMap;
}
// Rebuild ignore words set
if(_ign.length>0){globalThis._cuesIgnoreWords=new Set(_ign.map(function(w){return w.toLowerCase();}));}else{globalThis._cuesIgnoreWords=null;}
// Parse opencues.md for settings definitions (_openCuesSettings map)
var _ocPath=_rcwd+"/opencues.md";
try{
if(_rfs.existsSync(_ocPath)){
var _ocContent=_rfs.readFileSync(_ocPath,"utf8");
var _ocSettings={};var _ocCurrent={};var _ocTips={};var _ocSatTips={};var _ocVersion=1;
var _ocLines=_ocContent.split(/\\r?\\n/);
var _inSet=false;var _inFm=false;var _curSetKey=null;var _inValues=false;
for(var _oli=0;_oli<_ocLines.length;_oli++){
var _ol=_ocLines[_oli];var _olT=_ol.trim();
if(_olT==="---"){_inFm=!_inFm;continue;}
if(!_inFm)continue;
var _isIndented=_ol.length>0&&(_ol.charAt(0)===" "||_ol.charAt(0)==="\\t");
if(_olT==="settings:"){_inSet=true;_curSetKey=null;_inValues=false;continue;}
// Exit settings block on non-indented line
if(_inSet&&_olT&&!_isIndented){_inSet=false;_curSetKey=null;_inValues=false;}
if(_inSet&&_olT){
var _ci=_olT.indexOf(":");
if(_ci>0){var _sk=_olT.slice(0,_ci).trim();var _sv=_olT.slice(_ci+1).trim();
if(_sk==="tip"&&_sv&&_curSetKey){
// Selector tip
_ocTips[_curSetKey]=_sv;
}else if(_sk==="values"&&_curSetKey){
// Values sub-block opener
_inValues=true;
}else if(_inValues&&_curSetKey&&_sv){
// Value entry inside values: block
if(!_ocSettings[_curSetKey])_ocSettings[_curSetKey]=[];
_ocSettings[_curSetKey].push(_sk);
if(!_ocSatTips[_curSetKey])_ocSatTips[_curSetKey]={};
_ocSatTips[_curSetKey][_sk]=_sv;
}else if(!_sv){
// Setting name (key with no value after colon)
_curSetKey=_sk;_inValues=false;
}
}}else if(_olT&&!_isIndented){
// Top-level key:value → current values
var _ci2=_olT.indexOf(":");
if(_ci2>0){var _ck=_olT.slice(0,_ci2).trim();var _cv=_olT.slice(_ci2+1).trim();if(_ck==="version"){_ocVersion=parseInt(_cv,10)||1;}else if(_cv&&_ck!=="settings")_ocCurrent[_ck]=_cv;}
}
}
globalThis._openCuesSettings=_ocSettings;
globalThis._openCuesCurrent=_ocCurrent;
globalThis._openCuesTips=_ocTips;
globalThis._openCuesSatTips=_ocSatTips;
globalThis._openCuesVersion=_ocVersion;
}}catch(_oce){}
_applied=true;
globalThis._configLoadedAt=Date.now();
}catch(_ce){}
// Rebuild resolver only if config parse succeeded (keeps old resolver on parse error)
if(_applied&&process.env.GROQ_API_KEY){
try{
var _rApiKey=process.env.GROQ_API_KEY;
var _rEp="https://api.groq.com/openai/v1/chat/completions";
var _rCuesPc=(globalThis._cuesMdParsed&&globalThis._cuesMdParsed.promptConfig)||{};
var _rBlanksPc=(globalThis._blanksMdParsed&&globalThis._blanksMdParsed.promptConfig)||{};
var _rDefaultMod=_rCuesPc.model||_rBlanksPc.model||"openai/gpt-oss-120b";
var _rSources=globalThis._cuesCore.buildSourcesFromConfig(globalThis._cuesMdParsed,globalThis._blanksMdParsed,{httpAdapter:globalThis._httpAdapter,endpoint:_rEp,apiKey:_rApiKey,defaultModel:_rDefaultMod,controls:globalThis._cueControlOverrides,readControlState:function(_cn,_mkw,_ctx){var _ctrl=globalThis._cueControlOverrides&&globalThis._cueControlOverrides[_cn];var _bs2=_ctrl&&(_ctrl.blankScript||_ctrl.script);if(!_bs2)return null;var _bsHome=process.env.HOME||"/home/"+(process.env.USER||"root");var _bsArgs=["get"].concat(_mkw?[_mkw]:[]).concat(_ctx?_ctx.filter(function(w){return w!=="_"&&w.toLowerCase()!==(_mkw||"").toLowerCase();}):[]); var _bsEnv=Object.assign({},process.env);if(_ctrl.model)_bsEnv.CUES_MODEL=_ctrl.model;if(_ctrl.apiUrl)_bsEnv.CUES_API_URL=_ctrl.apiUrl;if(_ctrl.apiKeyEnv)_bsEnv.CUES_API_KEY_ENV=_ctrl.apiKeyEnv;if(_ctrl.altCount)_bsEnv.CUES_ALT_COUNT=String(_ctrl.altCount);if(_ctrl.includeOriginal!==undefined)_bsEnv.CUES_INCLUDE_ORIGINAL=String(_ctrl.includeOriginal);if(_ctrl.prompts){for(var _pk in _ctrl.prompts){_bsEnv["CUES_PROMPT_"+_pk.toUpperCase().replace(/[^A-Z0-9]/g,"_")]=_ctrl.prompts[_pk];}}try{var _bsOut=${requireFuncName}("child_process").execFileSync("bash",[_bs2.replace(/^~/,_bsHome)].concat(_bsArgs),{timeout:6000,encoding:"utf8",env:_bsEnv}).trim();return _bsOut||null;}catch(_e){return null;}}});
globalThis._cueResolver=globalThis._cuesCore.createResolver(_rSources,{parallel:false,timeout:30000,continueOnError:true});
globalThis._resolverGeneration=(globalThis._resolverGeneration||0)+1;
// Clear analyzed cache — all visible words re-analyze against the new config
globalThis._dynLastAnalyzed=[];
}catch(_re){}
}
globalThis._configReloading=false;
};
// TTS configuration (speak.sh path + speech rate; per-tip "speak" flag controls which tips are read)
globalThis._ttsRate=${config.ttsSpeed || 2};
globalThis._ttsScript=${config.ttsScript ? `"${config.ttsScript}"` : 'null'};
// Periodic status line refresh when a cue-control word is selected
// Writes cueTip directly to the JSON export file — no re-render, no flicker
if(!globalThis._cueControlStatusInterval){
globalThis._cueControlStatusInterval=setInterval(function(){
if(!(globalThis._hlState&&globalThis._hlState.active&&globalThis._hlState.wordIndex!=null))return;
if(!globalThis._cueControlTip)return;
var _ws=(globalThis._hlText||"").split(/\s+/).filter(function(w){return w;});
var _wrd=_ws[globalThis._hlState.wordIndex]||"";
if(!globalThis._isCueControl||!globalThis._isCueControl(_wrd))return;
try{
var _ep="/tmp/claude-highlight-state-"+process.pid+".json";
var _fs=${requireFuncName}("fs");
var _ex=JSON.parse(_fs.readFileSync(_ep,"utf8"));
if(_ex.cueTip!==globalThis._cueControlTip){_ex.cueTip=globalThis._cueControlTip;_ex.timestamp=Date.now();_fs.writeFileSync(_ep,JSON.stringify(_ex));if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();}
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
providerOverrides:{}
});
// Warm connection pool on startup
if(process.env.GROQ_API_KEY){
setTimeout(function(){globalThis._httpAdapter.warmup("https://api.groq.com/openai/v1/models",{Authorization:"Bearer "+process.env.GROQ_API_KEY});},1000);
}
}catch(_e2){}
}
// Run initial config load now that the HTTP adapter is ready
if(globalThis._cuesCore){globalThis._reloadCuesConfig();}
// Cue-control check: returns true for words with built-in cycling behavior
// (numbers increment/decrement, custom controls run scripts) — these bypass alt cycling and tips
globalThis._isCueControl=function(_w){
if(!!(globalThis._cueControlOverrides||{})[_w.toLowerCase()])return true;
var _sps=globalThis._stepPatterns||[];
for(var _spi=0;_spi<_sps.length;_spi++){if(_sps[_spi].re.test(_w))return true;}
return false;
};
// Shared cycling function: handles cue-controls, alt cycling, linked words, spans, underscore re-analysis
// dir=1 for Up (next alt), dir=-1 for Down (prev alt)
globalThis._cycleAlt=function(_dir,_IZClass,_IZVar,_cfgVar,_reqFn){
if(!globalThis._hlState||!globalThis._hlState.active||globalThis._hlState.wordIndex==null)return null;
var _allW=globalThis._hlText?globalThis._hlText.split(/\\s+/).filter(function(w){return w}):[];
var _hlIdx=globalThis._hlState.wordIndex;
if(_hlIdx<0||_hlIdx>=_allW.length)return null;
var _curWord=_allW[_hlIdx];
// === Cue-controls: words with built-in cycling behavior (no tips, no LLM alts) ===
// Custom cue-controls: spawn external scripts (e.g. volume.sh)
var _actOvr=globalThis._cueControlOverrides||{};
var _wLower=_curWord.toLowerCase();
if(_actOvr[_wLower]){
var _ad=_actOvr[_wLower];
var _home=process.env.HOME||"/home/"+(process.env.USER||"root");
var _rawScript=_ad.script||_ad.scriptPath||(_home+"/.claude/actions/"+_ad.control+".sh");
var _script=_rawScript.replace(/^~/,_home);
var _args=["bash",_script].concat(_dir>0?_ad.upArgs||["up"]:_ad.downArgs||["down"]);
var _dynTip=_ad.tip||_ad.control;
// Static tip fallback — live tip updated by script get after spawn
if(!globalThis._cueControlTip)globalThis._cueControlTip=_dynTip;
// Debounce spawn: rapid presses only fire script once with final value
if(!globalThis._cueControlTimers)globalThis._cueControlTimers={};
if(globalThis._cueControlTimers[_ad.control])clearTimeout(globalThis._cueControlTimers[_ad.control]);
var _spawnArgs=_args.slice(0);
var _tipScript=_script;
globalThis._cueControlTimers[_ad.control]=setTimeout(function(){
try{_reqFn("child_process").spawn(_spawnArgs[0],_spawnArgs.slice(1),{detached:true,stdio:"ignore"}).unref();}catch(_e){}
// After script applies the change, read live value and push directly to status line
setTimeout(function(){
try{
if(globalThis._cueControlTipWord===null)return;
var _lt=_reqFn("child_process").execSync("bash "+_tipScript+" get",{timeout:1000,encoding:"utf8"}).trim();
if(_lt){
globalThis._cueControlTip=_lt;
var _ep2="/tmp/claude-highlight-state-"+process.pid+".json";
var _fs2=_reqFn("fs");
var _ex2=JSON.parse(_fs2.readFileSync(_ep2,"utf8"));
_ex2.cueTip=_lt;_ex2.timestamp=Date.now();
_fs2.writeFileSync(_ep2,JSON.stringify(_ex2));
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
}
}catch(_e){}
},200);
},50);
return{refresh:true};
}
// Control-bound blank cycling: blank positions bound to a control via blankKeywords
if(globalThis._dynDefs&&globalThis._dynDefs.words){
var _cbDef=globalThis._dynDefs.words.find(function(w){return w.index===_hlIdx&&w.metadata&&w.metadata.controlName&&!w.metadata.listControl&&!w.metadata.selectorWord&&!w.metadata.satelliteWord;});
if(_cbDef){
var _cbMeta=_cbDef.metadata;
if(_cbMeta.blankReadOnly)return null;
if(_cbDef.cueTip)globalThis._cueControlTip=_cbDef.cueTip;
var _cbHome=process.env.HOME||"/home/"+(process.env.USER||"root");
var _cbRawScript=_cbMeta.blankScript||(_cbHome+"/.claude/actions/"+_cbMeta.controlName+".sh");
var _cbScript=_cbRawScript.replace(/^~/,_cbHome);
// Calculate target value, then call script with "set <value>" for exact control
var _cbStep=_cbMeta.blankStep||1;
var _cbRange=_cbMeta.blankRange||[0,100];
var _cbSuffix=_cbMeta.blankSuffix||"";
var _cbCurStr=_cbSuffix&&_curWord.endsWith(_cbSuffix)?_curWord.slice(0,_curWord.length-_cbSuffix.length):_curWord;
var _cbCur=parseFloat(_cbCurStr);if(isNaN(_cbCur))_cbCur=0;
var _cbTarget=_dir>0?Math.min(_cbRange[1],_cbCur+_cbStep):Math.max(_cbRange[0],_cbCur-_cbStep);
var _cbNumStr=String((_cbMeta.blankFormat||"integer")==="integer"?Math.round(_cbTarget):_cbTarget);
var _cbNewVal=_cbNumStr+_cbSuffix;
try{_reqFn("child_process").execSync("bash "+_cbScript+" set "+_cbNumStr,{timeout:3000,stdio:"ignore"});}catch(_e){}
var _cbText=globalThis._hlText;
var _cbWordPos=0;
for(var _cbWi=0;_cbWi<_hlIdx;_cbWi++){_cbWordPos=_cbText.indexOf(_allW[_cbWi],_cbWordPos)+_allW[_cbWi].length;}
var _cbWStart=_cbText.indexOf(_curWord,_cbWordPos);
var _cbWEnd=_cbWStart+_curWord.length;
var _cbNewText=_cbText.slice(0,_cbWStart)+_cbNewVal+_cbText.slice(_cbWEnd);
globalThis._hlText=_cbNewText;
globalThis._hlState.text=_cbNewText;
if(!globalThis._cueControlValues)globalThis._cueControlValues={};
var _cbFmt=_cbMeta.blankFormat||"integer";
globalThis._cueControlValues[_cbMeta.controlName]=_cbFmt==="string"?_cbNewVal:(_cbFmt==="float"?parseFloat(_cbNewVal)||0:parseInt(_cbNewVal,10)||0);
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
return{text:_cbNewText,lenDiff:_cbNewVal.length-_curWord.length,wStart:_cbWStart,newLen:_cbNewVal.length};
}
// Selector word: cycles setting names and updates satellite word (multi-word aware on both sides)
var _selDef=globalThis._dynDefs.words.find(function(w){return w.index===_hlIdx&&w.metadata&&w.metadata.selectorWord===true;});
if(_selDef){
var _ocSet=globalThis._openCuesSettings||{};
var _ocKeys=Object.keys(_ocSet);
if(_ocKeys.length===0)return null;
var _curSetIdx=_ocKeys.indexOf(_selDef.metadata.currentSetting||_selDef.word||_curWord);
var _nextSetIdx=(_curSetIdx+_dir+_ocKeys.length)%_ocKeys.length;
var _nextSet=_ocKeys[_nextSetIdx];
var _ocHome=process.env.HOME||"/home/"+(process.env.USER||"root");
var _ocScr=(_selDef.metadata.blankScript||"").replace(/^~/,_ocHome);
var _ocNewVal;
try{_ocNewVal=_reqFn("child_process").execFileSync("bash",[_ocScr,"get",_nextSet],{timeout:3000,encoding:"utf8"}).trim();}catch(_e){_ocNewVal=(_ocSet[_nextSet]||[])[0]||"";}
var _selText=globalThis._hlText;
var _selAllW=_selText.split(/\\s+/).filter(function(w){return w;});
// Old spans
var _selOldSpan=_selDef.spanLength||1;
var _satIdx=_selDef.metadata.childIndex;
var _satDef=globalThis._dynDefs.words.find(function(w){return w.index===_satIdx;});
var _satOldSpan=(_satDef&&_satDef.spanLength)||1;
// Walk to the selector's first word position
var _selPos=0;for(var _swi=0;_swi<_hlIdx;_swi++){if(_selAllW[_swi]==null)break;_selPos=_selText.indexOf(_selAllW[_swi],_selPos)+_selAllW[_swi].length;}
if(_selAllW[_hlIdx]==null)return null;
var _selWStart=_selText.indexOf(_selAllW[_hlIdx],_selPos);
if(_selWStart<0)return null;
// Walk through the selector's span
var _selWEnd=_selWStart+_selAllW[_hlIdx].length;
for(var _spk=1;_spk<_selOldSpan;_spk++){if(_selAllW[_hlIdx+_spk]==null)break;var _wp=_selText.indexOf(_selAllW[_hlIdx+_spk],_selWEnd);if(_wp<0)break;_selWEnd=_wp+_selAllW[_hlIdx+_spk].length;}
// Walk through the satellite's span starting from end of selector
var _satWEnd=_selWEnd;var _satWStartP=-1;
for(var _sak=0;_sak<_satOldSpan;_sak++){if(_selAllW[_satIdx+_sak]==null)break;var _wp2=_selText.indexOf(_selAllW[_satIdx+_sak],_satWEnd);if(_wp2<0)break;if(_sak===0)_satWStartP=_wp2;_satWEnd=_wp2+_selAllW[_satIdx+_sak].length;}
// Replace selector + separator + satellite with new selector + separator + new satellite
var _cycSep=_selDef.metadata.separator||" ";
var _newFullInsert=_nextSet+_cycSep+_ocNewVal;
var _newSelText;
if(_satWStartP>=0){
_newSelText=_selText.slice(0,_selWStart)+_newFullInsert+_selText.slice(_satWEnd);
}else{
// Satellite not found in text — only replace the selector span
_newSelText=_selText.slice(0,_selWStart)+_nextSet+_selText.slice(_selWEnd);
}
// Compute new word counts including separator tokens
var _newFullWords=_newFullInsert.split(/\\s+/).filter(function(w){return w;});
var _newSelWc=_nextSet.split(/\\s+/).filter(function(w){return w;}).length||1;
var _newSatWc=_ocNewVal?(_ocNewVal.split(/\\s+/).filter(function(w){return w;}).length||1):0;
var _newSepWc=_newFullWords.length-_newSelWc-_newSatWc;
// Old total includes any separator words between old selector and old satellite
var _oldSepWc=_satIdx-(_hlIdx+_selOldSpan);if(_oldSepWc<0)_oldSepWc=0;
var _oldEndIdx=_satIdx+_satOldSpan;
var _downShift=(_newSelWc+_newSepWc+_newSatWc)-(_selOldSpan+_oldSepWc+_satOldSpan);
if(_downShift!==0){
// Shift WordDef indices at >= _oldEndIdx (but skip the selector and satellite themselves)
globalThis._dynDefs.words.forEach(function(d){if(d.index>=_oldEndIdx&&d!==_selDef&&d!==_satDef)d.index+=_downShift;});
globalThis._dynDefs.words.forEach(function(d){if(d.metadata){if(d.metadata.childIndex!=null&&d.metadata.childIndex>=_oldEndIdx&&d!==_selDef)d.metadata.childIndex+=_downShift;if(d.metadata.parentIndex!=null&&d.metadata.parentIndex>=_oldEndIdx&&d!==_satDef)d.metadata.parentIndex+=_downShift;}});
}
// Clear old selector and satellite span entries
if(globalThis._dynSpans){
for(var _csi=0;_csi<_selOldSpan;_csi++)delete globalThis._dynSpans[_hlIdx+_csi];
for(var _cai=0;_cai<_satOldSpan;_cai++)delete globalThis._dynSpans[_satIdx+_cai];
// Shift remaining span entries at key >= _oldEndIdx
if(_downShift!==0){
var _nspsSel={};Object.keys(globalThis._dynSpans).forEach(function(k){var ki=parseInt(k,10);_nspsSel[ki>=_oldEndIdx?ki+_downShift:ki]=globalThis._dynSpans[k];});globalThis._dynSpans=_nspsSel;
}
}
// Update selector WordDef
_selDef.word=_nextSet;_selDef.metadata.currentSetting=_nextSet;
_selDef.cueTip=(globalThis._openCuesTips&&globalThis._openCuesTips[_nextSet])||null;delete _selDef.altCueTips;
var _newSatIdx=_hlIdx+_newSelWc+_newSepWc;
_selDef.metadata.childIndex=_newSatIdx;
if(_newSelWc>1){
_selDef.spanLength=_newSelWc;
if(!globalThis._dynSpans)globalThis._dynSpans={};
for(var _nsi2=0;_nsi2<_newSelWc;_nsi2++)globalThis._dynSpans[_hlIdx+_nsi2]={originalIndex:_hlIdx,spanLength:_newSelWc};
}else{delete _selDef.spanLength;}
// Update satellite WordDef (index moves if selector span changed length)
if(_satDef){
_satDef.index=_newSatIdx;
_satDef.word=_ocNewVal;
_satDef.alts=_ocSet[_nextSet]||[_ocNewVal];
_satDef.currentAltIndex=(_satDef.alts||[]).indexOf(_ocNewVal);
if(_satDef.currentAltIndex<0)_satDef.currentAltIndex=0;
_satDef.cueTip=(globalThis._openCuesSatTips&&globalThis._openCuesSatTips[_nextSet]&&globalThis._openCuesSatTips[_nextSet][_ocNewVal])||(globalThis._openCuesTips&&globalThis._openCuesTips[_nextSet])||null;delete _satDef.altCueTips;
if(_newSatWc>1){
_satDef.spanLength=_newSatWc;
if(!globalThis._dynSpans)globalThis._dynSpans={};
for(var _nsi3=0;_nsi3<_newSatWc;_nsi3++)globalThis._dynSpans[_newSatIdx+_nsi3]={originalIndex:_newSatIdx,spanLength:_newSatWc};
}else{delete _satDef.spanLength;}
}
globalThis._hlText=_newSelText;globalThis._hlState.text=_newSelText;
try{var _selExp={active:true,highlightedWordIndex:_hlIdx,highlightedWord:_nextSet,wordCount:_newSelText.split(/\\s+/).filter(function(w){return w;}).length,cueTip:_selDef.cueTip||null,cueControl:!!_selDef.cueTip,alts:_ocKeys,currentAltIndex:_nextSetIdx,timestamp:Date.now()};_reqFn("fs").writeFileSync("/tmp/claude-highlight-state-"+process.pid+".json",JSON.stringify(_selExp));}catch(_we){}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
return{text:_newSelText,lenDiff:_newSelText.length-_selText.length,wStart:_selWStart,newLen:_nextSet.length};
}
// Satellite word: cycles current setting values and writes back to opencues.md (multi-word aware)
var _satBound=globalThis._dynDefs.words.find(function(w){return w.index===_hlIdx&&w.metadata&&w.metadata.satelliteWord===true;});
if(_satBound){
var _pIdx=_satBound.metadata.parentIndex;
var _parDef=globalThis._dynDefs.words.find(function(w){return w.index===_pIdx;});
var _curSetting=_parDef?_parDef.metadata.currentSetting:null;
if(!_curSetting)return null;
var _satOcSet=globalThis._openCuesSettings||{};
var _satVals=_satOcSet[_curSetting]||[_satBound.word||_curWord];
// Use the WordDef's joined text to look up in alts (handles multi-word values)
var _satCurText=_satBound.word||_curWord;
var _satCurIdx=_satVals.indexOf(_satCurText);
if(_satCurIdx<0)_satCurIdx=0;
var _satNextIdx=(_satCurIdx+_dir+_satVals.length)%_satVals.length;
var _satNewVal=_satVals[_satNextIdx];
var _satOcHome=process.env.HOME||"/home/"+(process.env.USER||"root");
var _satOcScr=(_satBound.metadata.blankScript||"").replace(/^~/,_satOcHome);
try{_reqFn("child_process").execFileSync("bash",[_satOcScr,"set",_curSetting,_satNewVal],{timeout:3000,encoding:"utf8"});}catch(_se){}
if(!globalThis._openCuesCurrent)globalThis._openCuesCurrent={};
globalThis._openCuesCurrent[_curSetting]=_satNewVal;
var _satTxt=globalThis._hlText;
var _satAllW=_satTxt.split(/\\s+/).filter(function(w){return w;});
// Walk to satellite's origin position
var _satP=0;for(var _swi2=0;_swi2<_hlIdx;_swi2++){if(_satAllW[_swi2]==null)break;_satP=_satTxt.indexOf(_satAllW[_swi2],_satP)+_satAllW[_swi2].length;}
if(_satAllW[_hlIdx]==null)return null;
var _satWS=_satTxt.indexOf(_satAllW[_hlIdx],_satP);
if(_satWS<0)return null;
// Walk through the satellite's span to find its end
var _satOldSpan=_satBound.spanLength||1;
var _satWE=_satWS+_satAllW[_hlIdx].length;
for(var _sspk=1;_sspk<_satOldSpan;_sspk++){if(_satAllW[_hlIdx+_sspk]==null)break;var _swp=_satTxt.indexOf(_satAllW[_hlIdx+_sspk],_satWE);if(_swp<0)break;_satWE=_swp+_satAllW[_hlIdx+_sspk].length;}
var _satNewTxt=_satTxt.slice(0,_satWS)+_satNewVal+_satTxt.slice(_satWE);
// Compute new word count and shift downstream indices if changed
var _newSatWc=_satNewVal.split(/\\s+/).filter(function(w){return w;}).length||1;
var _satOldEndIdx=_hlIdx+_satOldSpan;
var _satDownShift=_newSatWc-_satOldSpan;
if(_satDownShift!==0){
globalThis._dynDefs.words.forEach(function(d){if(d.index>=_satOldEndIdx&&d!==_satBound)d.index+=_satDownShift;});
globalThis._dynDefs.words.forEach(function(d){if(d.metadata){if(d.metadata.childIndex!=null&&d.metadata.childIndex>=_satOldEndIdx&&d!==_satBound)d.metadata.childIndex+=_satDownShift;if(d.metadata.parentIndex!=null&&d.metadata.parentIndex>=_satOldEndIdx)d.metadata.parentIndex+=_satDownShift;}});
}
// Update satellite span tracking
if(globalThis._dynSpans){
for(var _csi2=0;_csi2<_satOldSpan;_csi2++)delete globalThis._dynSpans[_hlIdx+_csi2];
if(_satDownShift!==0){var _nspsSat={};Object.keys(globalThis._dynSpans).forEach(function(k){var ki=parseInt(k,10);_nspsSat[ki>=_satOldEndIdx?ki+_satDownShift:ki]=globalThis._dynSpans[k];});globalThis._dynSpans=_nspsSat;}
}
_satBound.word=_satNewVal;_satBound.currentAltIndex=_satNextIdx;
_satBound.cueTip=(globalThis._openCuesSatTips&&globalThis._openCuesSatTips[_curSetting]&&globalThis._openCuesSatTips[_curSetting][_satNewVal])||(globalThis._openCuesTips&&globalThis._openCuesTips[_curSetting])||null;delete _satBound.altCueTips;
if(_newSatWc>1){
_satBound.spanLength=_newSatWc;
if(!globalThis._dynSpans)globalThis._dynSpans={};
for(var _nsxi=0;_nsxi<_newSatWc;_nsxi++)globalThis._dynSpans[_hlIdx+_nsxi]={originalIndex:_hlIdx,spanLength:_newSatWc};
}else{delete _satBound.spanLength;}
globalThis._hlText=_satNewTxt;globalThis._hlState.text=_satNewTxt;
try{var _satExp={active:true,highlightedWordIndex:_hlIdx,highlightedWord:_satNewVal,wordCount:_satAllW.length,cueTip:_satBound.cueTip||null,cueControl:!!_satBound.cueTip,alts:_satVals,currentAltIndex:_satNextIdx,timestamp:Date.now()};_reqFn("fs").writeFileSync("/tmp/claude-highlight-state-"+process.pid+".json",JSON.stringify(_satExp));}catch(_we){}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
return{text:_satNewTxt,lenDiff:_satNewTxt.length-_satTxt.length,wStart:_satWS,newLen:_satNewVal.length};
}
}
// Step control: arithmetic or script-based increment/decrement for patterned values
// Skip if this position has dynamic alternatives (e.g. blank fill-in result) — let alt cycling handle it
var _hasAltsCycle=globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.find(function(w){return w.index===_hlIdx&&w.alts&&w.alts.length>1;});
var _stepCtrl=null;
var _spsC=globalThis._stepPatterns||[];
for(var _spiC=0;_spiC<_spsC.length;_spiC++){if(_spsC[_spiC].re.test(_curWord)){_stepCtrl=_spsC[_spiC].ctrl;break;}}
if(_stepCtrl&&!_hasAltsCycle){
var _stStep=(_stepCtrl.step!=null)?_stepCtrl.step:1;
var _stMin=(_stepCtrl.stepMin!=null)?_stepCtrl.stepMin:null;
var _stMax=(_stepCtrl.stepMax!=null)?_stepCtrl.stepMax:null;
var _stFmt=(_stepCtrl&&_stepCtrl.stepFormat)||null;
var _stSuffix=(_stepCtrl&&_stepCtrl.stepSuffix)||"";
var _stScript=(_stepCtrl&&_stepCtrl.stepScript)||null;
var _stNewWord;
if(_stScript){
var _stHome=process.env.HOME||"/home/"+(process.env.USER||"root");
var _stScriptPath=_stScript.replace(/^~/,_stHome);
try{_stNewWord=_reqFn("child_process").execFileSync("bash",[_stScriptPath,String(_curWord),String(_dir)],{timeout:3000,encoding:"utf8"}).trim()||_curWord;}catch(_e){_stNewWord=_curWord;}
}else{
var _stRaw=(_stSuffix&&_curWord.endsWith(_stSuffix))?_curWord.slice(0,-_stSuffix.length):_curWord;
var _stNum=parseFloat(_stRaw);
var _stResult=_stNum+(_stStep*_dir);
if(_stMin!=null&&_stResult<_stMin)_stResult=_stMin;
if(_stMax!=null&&_stResult>_stMax)_stResult=_stMax;
var _stFormatted;
if(_stFmt==="integer"){_stFormatted=String(Math.round(_stResult));}
else if(_stFmt==="float"){_stFormatted=String(_stResult);}
else{_stFormatted=String(_stResult);}
_stNewWord=_stFormatted+_stSuffix;
}
var _text=globalThis._hlText;
var _wordPos=0;
for(var _wi=0;_wi<_hlIdx;_wi++){_wordPos=_text.indexOf(_allW[_wi],_wordPos)+_allW[_wi].length;}
var _wStart=_text.indexOf(_curWord,_wordPos);
var _wEnd=_wStart+_curWord.length;
var _newText=_text.slice(0,_wStart)+_stNewWord+_text.slice(_wEnd);
globalThis._hlText=_newText;
globalThis._hlState.text=_newText;
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
return{text:_newText,lenDiff:_stNewWord.length-_curWord.length,wStart:_wStart,newLen:_stNewWord.length};
}
// Consume-all cycling: dedicated storage for multi-word results (e.g., prompt improver)
// Uses its own state so _dynDefs overwrites from tips/LLM analysis don't affect cycling
if(globalThis._consumeAllAlts){
var _ca=globalThis._consumeAllAlts;
var _caSpan=globalThis._dynSpans&&globalThis._dynSpans[_hlIdx];
var _caIdx=_caSpan?_caSpan.originalIndex:_hlIdx;
if(_caIdx===_ca.index){
var _caNext=(_ca.currentAltIndex+_dir+_ca.alts.length)%_ca.alts.length;
_ca.currentAltIndex=_caNext;
var _caNewWord=_ca.alts[_caNext];
if(_caNewWord==null)return null;
// Track dismissed blanks: cycling to "_" prevents auto-populate from re-firing
if(_caNewWord==="_"){if(!globalThis._dismissedBlanks)globalThis._dismissedBlanks={};globalThis._dismissedBlanks[_caIdx]=true;}
else{if(globalThis._dismissedBlanks)delete globalThis._dismissedBlanks[_caIdx];}
var _caOldSpan=_ca.spanLength||1;
var _caText=globalThis._hlText;
var _caPos=0;for(var _cawi=0;_cawi<_caIdx;_cawi++){_caPos=_caText.indexOf(_allW[_cawi],_caPos)+_allW[_cawi].length;}
var _caWS=_caText.indexOf(_allW[_caIdx],_caPos);if(_caWS<0)return null;
var _caWE=_caWS;for(var _casi=0;_casi<_caOldSpan;_casi++){var _caSwI=_caText.indexOf(_allW[_caIdx+_casi],_caWE);if(_caSwI<0)break;_caWE=_caSwI+_allW[_caIdx+_casi].length;}
var _caNewText=_caText.slice(0,_caWS)+_caNewWord+_caText.slice(_caWE);
var _caNewWc=_caNewWord.split(/\\s+/).length;
_ca.spanLength=_caNewWc;
if(!globalThis._dynSpans)globalThis._dynSpans={};
for(var _caSi=0;_caSi<_caOldSpan;_caSi++)delete globalThis._dynSpans[_caIdx+_caSi];
for(var _caSj=0;_caSj<_caNewWc;_caSj++){globalThis._dynSpans[_caIdx+_caSj]={originalIndex:_caIdx,spanLength:_caNewWc};}
globalThis._hlText=_caNewText;globalThis._hlState.text=_caNewText;
// Prevent re-analysis from firing (matches what auto-populate does)
var _caNewWords=_caNewText.split(/\\s+/).filter(function(w){return w;});
globalThis._dynLastAnalyzed=_caNewWords;globalThis._dynPrevWords=_caNewWords.slice();
// Keep highlight on span origin
globalThis._hlState.wordIndex=_caIdx;
try{var _caExp={active:true,highlightedWordIndex:_caIdx,highlightedWord:_caNewWord,wordCount:_caNewWords.length,cueTip:_ca.cueTip||null,alts:_ca.alts,currentAltIndex:_caNext,timestamp:Date.now()};_reqFn("fs").writeFileSync("/tmp/claude-highlight-state-"+process.pid+".json",JSON.stringify(_caExp));}catch(_we){}
if(globalThis._triggerStatusLineRefresh)globalThis._triggerStatusLineRefresh();
return{text:_caNewText,lenDiff:_caNewWord.length-(_caWE-_caWS),wStart:_caWS,newLen:_caNewWord.length};
}}
// Dynamic alt cycling
if(!globalThis._dynDefs)globalThis._dynDefs={words:[]};
var _dWords=globalThis._dynDefs.words;
var _dIdx=_hlIdx;
var _span=globalThis._dynSpans&&globalThis._dynSpans[_dIdx];
if(_span){_dIdx=_span.originalIndex;}
var _dWord=_dWords.find(function(w){return w.index===_dIdx;});
// Tip-lookup fallback: if word is navigable via _localCueMap but not yet in _dynDefs, resolve it now
if((!_dWord||!_dWord.alts||_dWord.alts.length<=1)&&globalThis._cuesCore&&globalThis._localCueMap){
var _tipResult=globalThis._localCueMap.get(_curWord.toLowerCase());
if(_tipResult&&_tipResult.alternatives&&_tipResult.alternatives.length>1){
var _tipDef={index:_dIdx,word:_curWord,alts:_tipResult.alternatives,cueTip:_tipResult.cueTip,altCueTips:_tipResult.altCueTips,speak:_tipResult.speak||false,source:"tips",linked:null,currentAltIndex:0};
if(_dWord){_dWord.alts=_tipResult.alternatives;_dWord.cueTip=_tipResult.cueTip;_dWord.altCueTips=_tipResult.altCueTips;_dWord.speak=_tipResult.speak||false;}
else{globalThis._dynDefs.words.push(_tipDef);_dWord=_tipDef;}
}
}
if(!_dWord||!_dWord.alts||_dWord.alts.length<=1)return null;
var _curIdx=typeof _dWord.currentAltIndex==='number'?_dWord.currentAltIndex:0;
var _nextAlt=(_curIdx+_dir+_dWord.alts.length)%_dWord.alts.length;
_dWord.currentAltIndex=_nextAlt;
var _newWord=_dWord.alts[_nextAlt];
if(_newWord==null)return null;
// Track dismissed blanks: when cycling to "_", prevent auto-populate from re-firing
if(_newWord==="_"){if(!globalThis._dismissedBlanks)globalThis._dismissedBlanks={};globalThis._dismissedBlanks[_dIdx]=true;}
else{if(globalThis._dismissedBlanks)delete globalThis._dismissedBlanks[_dIdx];}
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
// TTS: speak the alt tip when cycling (only for tips with speak:true)
if(_dWord.speak&&!(globalThis._openCuesCurrent&&globalThis._openCuesCurrent["voice-mode"]==="inactive")){
var _ttsTip=(_dWord.altCueTips&&_dWord.altCueTips[_dWord.alts[_nextAlt]])||_dWord.cueTip||null;
if(_ttsTip){
if(globalThis._ttsTimer)clearTimeout(globalThis._ttsTimer);
globalThis._ttsTimer=setTimeout(function(){
var _ttsHome=process.env.HOME||"/home/"+(process.env.USER||"root");
var _cp=_reqFn("child_process");
if(globalThis._ttsPid){try{process.kill(globalThis._ttsPid);}catch(_ke){}}
var _exePath=_ttsHome+"/.claude/actions/SpeakCtl.exe";
try{if(_reqFn("fs").existsSync(_exePath)){var _p=_cp.spawn(_exePath,[_ttsTip,String(globalThis._ttsRate||2)],{detached:true,stdio:"ignore"});globalThis._ttsPid=_p.pid;_p.unref();}
else{var _ttsScript=globalThis._ttsScript||(_ttsHome+"/.claude/actions/speak.sh");var _p2=_cp.spawn("bash",[_ttsScript,_ttsTip,String(globalThis._ttsRate||2)],{detached:true,stdio:"ignore"});globalThis._ttsPid=_p2.pid;_p2.unref();}}catch(_te){}
},80);
}}
// Re-evaluate underscore if present
var _cw=_newText.split(/\\s+/).filter(function(w){return w;});
if(_cw.indexOf("_")>=0){var _ctx=_cw.filter(function(w){return w!=="_";}).join(" ");var _ctxChanged=_ctx!==(globalThis._dynUnderscoreContext||"");
// Clear control-blank WordDefs when _ reappears — forces fresh value read
if(globalThis._dynDefs&&globalThis._dynDefs.words){for(var _ci=globalThis._dynDefs.words.length-1;_ci>=0;_ci--){if(globalThis._dynDefs.words[_ci].metadata&&globalThis._dynDefs.words[_ci].metadata.controlName){globalThis._dynDefs.words.splice(_ci,1);_ctxChanged=true;}}}
if(_ctxChanged){globalThis._dynUnderscoreContext=null;globalThis._dynUnderscoreQueued=true;if(!globalThis._dynPending&&globalThis._dynTriggerAnalysis){setTimeout(globalThis._dynTriggerAnalysis,100);}}}
return{text:_newText,lenDiff:_newWord.length-_oldWord.length,wStart:_wStart,newLen:_newWord.length};
};
})();`;

  const newFile = oldFile.slice(0, insertPos) + cuesCoreInitCode + oldFile.slice(insertPos);

  showDiff(oldFile, newFile, cuesCoreInitCode, insertPos, insertPos);

  return newFile;
};

export interface DynamicHighlightConfig {
  enableDynamicHighlight?: boolean;
  dynamicHighlightDebounceMs?: number;  // Debounce delay in ms (default 0 = 50ms internal)
  ttsSpeed?: number;         // SAPI speech rate, -10 to 10 (default 2)
  ttsScript?: string;        // Custom TTS script path (default ~/.claude/actions/speak.sh)
}

const DEFAULT_CONFIG: Required<DynamicHighlightConfig> = {
  enableDynamicHighlight: true,
  dynamicHighlightDebounceMs: 0,
  ttsSpeed: 2,
  ttsScript: '',
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
// Hot-reload: re-parse config files if TTL expired and no LLM request in flight
if(!globalThis._dynPending&&!globalThis._configReloading&&globalThis._reloadCuesConfig&&Date.now()-(globalThis._configLoadedAt||0)>2000){globalThis._reloadCuesConfig();}
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

// Inject step-controlled words into _dynDefs so they're highlighted and navigable
var _spsInj=globalThis._stepPatterns||[];
if(_spsInj.length>0){
if(!globalThis._dynDefs)globalThis._dynDefs={words:[]};
var _sentWords0=_sentText.split(/\\s+/).filter(function(w){return w;});
_sentWords0.forEach(function(_sw0,_si0){
for(var _spi0=0;_spi0<_spsInj.length;_spi0++){
if(_spsInj[_spi0].re.test(_sw0)){
var _existStep=globalThis._dynDefs.words.find(function(d){return d.index===_si0&&d.metadata&&d.metadata.stepControl;});
if(!_existStep){globalThis._dynDefs.words.push({index:_si0,word:_sw0,alts:[_sw0],currentAltIndex:0,metadata:{stepControl:true,stepCtrl:_spsInj[_spi0].ctrl},source:'step',linked:null});}
break;
}
}
});
}
// LOCAL TIPS LOOKUP - uses cues-core functions for O(1) lookup
// Skip cue-controls (numbers, custom controls) — they have built-in cycling, not tips
var _lookup=globalThis._cuesCore&&globalThis._localCueMap?globalThis._cuesCore.lookupMultiple(_sentWords,globalThis._localCueMap,{skipPattern:/^_$/,skipFn:globalThis._isCueControl}):{found:[],missingIndices:_sentWords.map(function(_,i){return i;}).filter(function(i){return _sentWords[i]!=="_";})};

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
// Skip cue-controls (numbers, step-pattern words) — they have built-in cycling, not LLM alts
if(globalThis._isCueControl&&globalThis._isCueControl(_sentWords[_si]))continue;
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
var _capturedGen=globalThis._resolverGeneration||0;
var _ctx={text:_sentText,words:_sentWords,metadata:{targetIndices:_hasBlank?null:_needLlmIndices}};
globalThis._cueResolver.resolve(_ctx).then(function(_resolved){
try{
// Discard stale results from a resolver that was rebuilt mid-flight
if((globalThis._resolverGeneration||0)!==_capturedGen)return;
var _elapsed=Date.now()-globalThis._dynPollStart;
var _words=[];
for(var _ri=0;_ri<_resolved.results.length;_ri++){
var _r=_resolved.results[_ri];
var _isControlBlank=_r.metadata&&_r.metadata.controlName;
if(_r.alternatives&&(_r.alternatives.length>1||_isControlBlank)){
var _filteredAlts=[];
for(var _fa=0;_fa<_r.alternatives.length;_fa++){
var _a=_r.alternatives[_fa].replace(/[.;:!?]+$/,"");
if(_a&&(_a==="_"||_a.length>1||_r.word==="_"||_isControlBlank)&&_filteredAlts.indexOf(_a)<0)_filteredAlts.push(_a);
}
if(_filteredAlts.length>0||_isControlBlank){
var _wdef={index:_r.wordIndex,word:_r.word,alts:_filteredAlts.length>0?_filteredAlts:null,linked:_r.linked||null,currentAltIndex:0,source:_r.source||"resolver"};
if(_r.cueTip)_wdef.cueTip=_r.cueTip;
if(_r.altCueTips)_wdef.altCueTips=_r.altCueTips;
if(_r.metadata)_wdef.metadata=_r.metadata;
_words.push(_wdef);
}
}
}
// Check current text to detect stale results (word changed during LLM call)
var _curTextWords=(globalThis._hlText||"").split(/\\s+/).filter(function(w){return w;});
if(globalThis._dynDefs&&globalThis._dynDefs.words){
for(var _mi2=0;_mi2<_words.length;_mi2++){
var _nw2=_words[_mi2];
// Skip stale results: if the word at this index no longer matches, discard
if(_nw2.index<_curTextWords.length&&_nw2.word!==_curTextWords[_nw2.index])continue;
var _spanInfo2=globalThis._dynSpans&&globalThis._dynSpans[_nw2.index];
if(_spanInfo2&&_spanInfo2.originalIndex!==_nw2.index){_nw2.alts=null;continue;}
var _oldW2=globalThis._dynDefs.words.find(function(w){return w.index===_nw2.index;});
// Skip LLM results for tip-sourced entries — tips are curated, don't mix
if(_oldW2&&_oldW2.source==="tips")continue;
// Skip grammar/LLM results for control-bound blank positions — but allow fresh control-blank results through
if(_oldW2&&_oldW2.metadata&&_oldW2.metadata.controlName&&!(_nw2.metadata&&_nw2.metadata.controlName))continue;
if(_oldW2&&_oldW2.alts){
if(_oldW2.spanLength)_nw2.spanLength=_oldW2.spanLength;
if(_nw2.alts){
// Merge: start with NEW alts, then add valid OLD alts
// Filter old alts: only keep those that are real words (not partial prefixes of the current word)
var _curW2=_curTextWords[_nw2.index]||_nw2.word;
var _mg=_nw2.alts.slice();
for(var _ai3=0;_ai3<_oldW2.alts.length;_ai3++){
var _oa=_oldW2.alts[_ai3];
if(_mg.indexOf(_oa)<0){
// Skip old alt if it's a strict prefix of the current word (stale partial)
if(_curW2&&_oa.length<_curW2.length&&_curW2.indexOf(_oa)===0)continue;
_mg.push(_oa);
}
}
_nw2.alts=_mg;
}
else{_nw2.alts=_oldW2.alts.slice();}
// Set currentAltIndex: prefer the current word's position in the alts list
var _curAltWord=_curTextWords[_nw2.index];
var _curAltIdx=_curAltWord&&_nw2.alts?_nw2.alts.indexOf(_curAltWord):-1;
_nw2.currentAltIndex=_curAltIdx>=0?_curAltIdx:(_oldW2.currentAltIndex||0);
if(_oldW2.speak)_nw2.speak=true;
}
var _existIdx=globalThis._dynDefs.words.findIndex(function(d){return d.index===_nw2.index;});
if(_existIdx>=0){globalThis._dynDefs.words[_existIdx]=_nw2;}else{globalThis._dynDefs.words.push(_nw2);}
}
globalThis._dynDefs._model="resolver";
}else{
globalThis._dynDefs={words:_words,_model:"resolver",_auto:true};
}
// Auto-populate: set pending flag for render-cycle pickup (fresh onChange)
for(var _api=0;_api<_words.length;_api++){
var _apw=_words[_api];
if(_apw.metadata&&_apw.metadata.controlName&&_apw.alts&&_apw.alts.length>0&&_apw.alts[0]!=="_"){
if(!(globalThis._dismissedBlanks&&globalThis._dismissedBlanks[_apw.index])){
globalThis._pendingAutoPopulate={index:_apw.index,value:_apw.alts[0],keywordExpansion:_apw.metadata.blankKeywordExpansion||null,satellite:_apw.metadata.satelliteValue||null,controlName:_apw.metadata.controlName||null,blankScript:_apw.metadata.blankScript||null,displaySeparator:_apw.metadata.displaySeparator||null,blankClearKeywords:_apw.metadata.blankClearKeywords||false,blankClearOnEdit:_apw.metadata.blankClearOnEdit||false,blankKeywordIndices:_apw.metadata.blankKeywordIndices||null,consumeAllAlts:_apw.alts.length>1?_apw.alts.slice():null,consumeAllTip:_apw.cueTip||null};
}}
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
// Re-trigger if text changed while we were pending (typing during LLM call)
var _postWords=(globalThis._hlText||"").split(/\\s+/).filter(function(w){return w;});
var _postChanged=_postWords.length!==globalThis._dynLastAnalyzed.length||_postWords.some(function(w,i){return w!==globalThis._dynLastAnalyzed[i];});
if(_postChanged||globalThis._dynUnderscoreQueued){
globalThis._dynUnderscoreQueued=false;
setTimeout(function(){if(!globalThis._dynPending&&globalThis._dynTriggerAnalysis){globalThis._dynTriggerAnalysis();}},100);
}
}).catch(function(_err){
globalThis._dynPending=false;
try{${requireFuncName}("fs").appendFileSync(_debugPath2,"["+Date.now()+"] resolver-error: "+_err.message+"\\n");}catch(_e4){}
var _errWords=(globalThis._hlText||"").split(/\\s+/).filter(function(w){return w;});
var _errChanged=_errWords.length!==globalThis._dynLastAnalyzed.length||_errWords.some(function(w,i){return w!==globalThis._dynLastAnalyzed[i];});
if(_errChanged){setTimeout(function(){if(!globalThis._dynPending&&globalThis._dynTriggerAnalysis){globalThis._dynTriggerAnalysis();}},100);}
});
}else{
// Fallback: no resolver/prompt available
try{${requireFuncName}("fs").appendFileSync(_debugPath2,"["+Date.now()+"] no-resolver: skipping LLM call\\n");}catch(_e5){}
}
}catch(_e){console.error("autoSubmit error:",_e);}
};
}

if(_needsAnalysis&&_curWords.length>0&&!globalThis._dynPending){
// EAGER TIPS LOOKUP: resolve tip words immediately on keystroke (before debounce)
// This ensures tip words dim in <5ms, not after 300ms pause + 50ms debounce + LLM round-trip
if(globalThis._cuesCore&&globalThis._localCueMap){
var _eagerLookup=globalThis._cuesCore.lookupMultiple(_curWords,globalThis._localCueMap,{skipPattern:/^_$/,skipFn:globalThis._isCueControl});
if(_eagerLookup.found.length>0){
if(!globalThis._dynDefs)globalThis._dynDefs={words:[]};
globalThis._dynDefs.words=globalThis._cuesCore.mergeWordDefs(globalThis._dynDefs.words,_eagerLookup.found);
if(globalThis._forceInputRefresh)globalThis._forceInputRefresh();
// If ALL words resolved from tips (no LLM needed), mark as analyzed and skip debounce
if(_eagerLookup.missingIndices.length===0&&_curWords.indexOf("_")<0){
globalThis._dynLastAnalyzed=_curWords;
var _tPath="/tmp/claude-llm-timing-"+process.pid+".txt";
try{${requireFuncName}("fs").writeFileSync(_tPath,"0ms (tips-eager) | "+_eagerLookup.found.length+" words\\n",{flag:"a"});}catch(_te){}
}
}
}
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

  // Get require function name for spawning control scripts
  const requireFuncName = getRequireFuncName(oldFile);

  // Insert dynamic handling code at the start of the Up arrow handler
  // After the opening brace of the return()=>{
  const upInsertPos = upMatch.index + upMatch[0].length;

  // Dynamic cycle Up — delegates to shared _cycleAlt(direction, ...)
  const dynUpCode = `
{var _r=globalThis._cycleAlt&&globalThis._cycleAlt(1,null,null,null,${requireFuncName});
if(_r&&_r.refresh){if(globalThis._forceInputRefresh)globalThis._forceInputRefresh();var _pv=globalThis._parentValue||"";return ${inputZoneClass}.fromText(${inputZoneVar}.text+(_pv.indexOf("\\u200B")>=0?"\\u200C":"\\u200B"),${configVar},${inputZoneVar}.offset);}
if(_r){if(globalThis._refreshTimer){clearTimeout(globalThis._refreshTimer);globalThis._refreshTimer=null;}var _c=${inputZoneVar}.offset;var _wE=_r.wStart+_r.newLen-_r.lenDiff;var _off=_c<=_r.wStart?_c:_c>=_wE?_c+_r.lenDiff:_r.wStart+_r.newLen;if(_off>_r.text.length)_off=_r.text.length;if(_off<0)_off=0;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}}
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
if(_r){if(globalThis._refreshTimer){clearTimeout(globalThis._refreshTimer);globalThis._refreshTimer=null;}var _c=${inputZoneVar}.offset;var _wE=_r.wStart+_r.newLen-_r.lenDiff;var _off=_c<=_r.wStart?_c:_c>=_wE?_c+_r.lenDiff:_r.wStart+_r.newLen;if(_off>_r.text.length)_off=_r.text.length;if(_off<0)_off=0;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}}
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
if(_r){if(globalThis._refreshTimer){clearTimeout(globalThis._refreshTimer);globalThis._refreshTimer=null;}var _c=${inputZoneVar}.offset;var _wE=_r.wStart+_r.newLen-_r.lenDiff;var _off=_c<=_r.wStart?_c:_c>=_wE?_c+_r.lenDiff:_r.wStart+_r.newLen;if(_off>_r.text.length)_off=_r.text.length;if(_off<0)_off=0;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}}`;
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
if(_r){if(globalThis._refreshTimer){clearTimeout(globalThis._refreshTimer);globalThis._refreshTimer=null;}var _c=${inputZoneVar}.offset;var _wE=_r.wStart+_r.newLen-_r.lenDiff;var _off=_c<=_r.wStart?_c:_c>=_wE?_c+_r.lenDiff:_r.wStart+_r.newLen;if(_off>_r.text.length)_off=_r.text.length;if(_off<0)_off=0;return ${inputZoneClass}.fromText(_r.text,${configVar},_off);}}`;

  newFile = newFile.slice(0, rawDownInsertPos) + dynRawDownCode + newFile.slice(rawDownInsertPos);

  return newFile;
};

/**
 * writeControlOvrVariable is no longer needed — gender mode was removed,
 * so _rootPat no longer exists. The rendering code accesses
 * globalThis._cueControlOverrides directly.
 */
export const writeControlOvrVariable = (
  oldFile: string,
  _config: DynamicHighlightConfig = {}
): string | null => {
  return oldFile;
};

/**
 * Modify the rendering to show words with alts in gray (dim).
 * When dynamic defs are loaded, words with alternatives are dimmed to show they're navigable.
 *
 * Extends the _numRanges pattern to also dim control words and dynamic alt words.
 */
export const writeDynamicRendering = (
  oldFile: string,
  config: DynamicHighlightConfig = {}
): string | null => {
  // Find the _numRanges pattern (step patterns check)
  // Pattern: else if((globalThis._stepPatterns||[]).some(function(s){return s.re.test(_w);})){_numRanges.push(...);}
  const numPattern = /else if\(\(globalThis\._stepPatterns\|\|\[\]\)\.some\(function\(s\)\{return s\.re\.test\(_w\);\}\)\)\{_numRanges\.push\(\{start:_wStart,end:_wStart\+_w\.length\}\);\}/;
  const numMatch = oldFile.match(numPattern);

  if (numMatch && numMatch.index !== undefined) {
    // Extend _numRanges to also dim control words, tips, and dynamic alt words
    // INSTANT TIPS: check _localCueMap directly in render — no waiting for analysis pipeline
    const newNumCode = `else if((function(){
// Keyword-context skip: while a selectorWord def is present, words to its left matching its control's blankKeywords are not dimmed (not shown as navigable)
var _isCtxKw=false;
if(globalThis._dynDefs&&globalThis._dynDefs.words){var _wL=_w.toLowerCase();for(var _cki=0;_cki<globalThis._dynDefs.words.length;_cki++){var _ckd=globalThis._dynDefs.words[_cki];if(_ckd&&_ckd.metadata&&_ckd.metadata.selectorWord&&_ni<_ckd.index){var _ckCtrl=(globalThis._cueControlOverrides||{})[_ckd.metadata.controlName];if(_ckCtrl&&_ckCtrl.blankKeywords){for(var _ckj=0;_ckj<_ckCtrl.blankKeywords.length;_ckj++){if(_ckCtrl.blankKeywords[_ckj]===_wL){_isCtxKw=true;break;}}if(_isCtxKw)break;}}}}
if(_isCtxKw)return false;
if((globalThis._stepPatterns||[]).some(function(s){return s.re.test(_w);})||(globalThis._cueControlOverrides||{})[_w.toLowerCase()]){_numRanges.push({start:_wStart,end:_wStart+_w.length});return true;}
if(globalThis._localCueMap&&globalThis._localCueMap.has(_w.toLowerCase())&&_ni!==_hlWordIdx){_numRanges.push({start:_wStart,end:_wStart+_w.length});return true;}
if(globalThis._dynDefs&&globalThis._dynDefs.words){
var _dynDef=globalThis._dynDefs.words.find(function(d){return d.index===_ni&&((d.alts&&d.alts.length>1&&d.alts.indexOf(_w)>=0)||(d.metadata&&d.metadata.controlName));});
var _spanInfo=globalThis._dynSpans&&globalThis._dynSpans[_ni];
var _isInSpan=!!_spanInfo;
var _isInHighlightedSpan=_spanInfo&&_spanInfo.originalIndex===_hlWordIdx;
if((_dynDef||_isInSpan)&&_ni!==_hlWordIdx&&!_isInHighlightedSpan){_numRanges.push({start:_wStart,end:_wStart+_w.length});return true;}
}
return false;
})()){}`;

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
// Skip positions covered by consume-all cycling (managed by _consumeAllAlts, not _dynDefs)
if(globalThis._consumeAllAlts){var _caS=globalThis._consumeAllAlts;if(_wi>=_caS.index&&_wi<_caS.index+(_caS.spanLength||1))continue;}
var _def=globalThis._dynDefs.words.find(function(d){return d.index===_wi;});
if(_def){
var _defSpan=_def.spanLength&&_def.spanLength>1?_def.spanLength:1;
var _effectiveNew=_defSpan>1?_newW.slice(_wi,_wi+_defSpan).join(" "):_newW[_wi];
if(_def.alts&&_def.alts.indexOf(_effectiveNew)>=0){
// Word is in alts - valid cycle, update index
_def.word=_effectiveNew;
_def.currentAltIndex=_def.alts.indexOf(_effectiveNew);
}else{
// Word changed to something NOT in alts - clear alts
// This handles mid-sentence insertion/deletion where indices shift
var _clearedMeta=_def.metadata;
_def.word=_newW[_wi];
_def.alts=null;
_def.currentAltIndex=0;
delete _def.metadata;
if(globalThis._dynSpans)delete globalThis._dynSpans[_wi];
// Selector/satellite pair: clearing one side must also clear its partner
if(_clearedMeta){
var _pIdx=null;
if(_clearedMeta.satelliteWord&&typeof _clearedMeta.parentIndex==="number")_pIdx=_clearedMeta.parentIndex;
else if(_clearedMeta.selectorWord&&typeof _clearedMeta.childIndex==="number")_pIdx=_clearedMeta.childIndex;
if(_pIdx!==null){var _pDef=globalThis._dynDefs.words.find(function(d){return d.index===_pIdx;});if(_pDef){_pDef.alts=null;_pDef.currentAltIndex=0;delete _pDef.metadata;if(globalThis._dynSpans)delete globalThis._dynSpans[_pIdx];}}
}
// blankClearOnEdit: schedule removal of spawned words from text
if(_clearedMeta&&_clearedMeta.blankClearOnEdit){
var _ceRemove=[_wi];
if(_pIdx!==null)_ceRemove.push(_pIdx);
// Include separator words between selector and satellite
if(_clearedMeta.selectorWord&&typeof _clearedMeta.childIndex==="number"){for(var _cei=_wi+1;_cei<_clearedMeta.childIndex;_cei++)_ceRemove.push(_cei);}
else if(_clearedMeta.satelliteWord&&typeof _clearedMeta.parentIndex==="number"){for(var _cei2=_clearedMeta.parentIndex+1;_cei2<_wi;_cei2++)_ceRemove.push(_cei2);}
_ceRemove.sort(function(a,b){return b-a;});
globalThis._pendingClearOnEdit=_ceRemove;
}
}
}
}
}
// Handle removed words (invalidate definitions for indices beyond new length)
if(_newW.length<_oldW.length){
for(var _ri=_newW.length;_ri<_oldW.length;_ri++){
var _rdef=globalThis._dynDefs.words.find(function(d){return d.index===_ri;});
if(_rdef){
var _rMeta=_rdef.metadata;
_rdef.alts=null;delete _rdef.metadata;
// Selector/satellite pair: removing one side clears its partner too
if(_rMeta){
var _rpIdx=null;
if(_rMeta.satelliteWord&&typeof _rMeta.parentIndex==="number")_rpIdx=_rMeta.parentIndex;
else if(_rMeta.selectorWord&&typeof _rMeta.childIndex==="number")_rpIdx=_rMeta.childIndex;
if(_rpIdx!==null){var _rpDef=globalThis._dynDefs.words.find(function(d){return d.index===_rpIdx;});if(_rpDef){_rpDef.alts=null;_rpDef.currentAltIndex=0;delete _rpDef.metadata;if(globalThis._dynSpans)delete globalThis._dynSpans[_rpIdx];}}
}
}
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
var _hasTipAlt=globalThis._localCueMap&&globalThis._localCueMap.has(w.toLowerCase());
var _wLow=w.toLowerCase();
var _hasDynAlt=globalThis._dynDefs&&globalThis._dynDefs.words&&globalThis._dynDefs.words.find(function(d){return d.index===i&&((d.alts&&d.alts.length>1&&(d.alts.indexOf(w)>=0||d.alts.some(function(a){return a.toLowerCase()===_wLow;})))||(d.metadata&&d.metadata.controlName));});
var _spanInfo=globalThis._dynSpans&&globalThis._dynSpans[i];
var _isNonOrigSpan=_spanInfo&&_spanInfo.originalIndex!==i;
var _isSpanOriginal=_spanInfo&&_spanInfo.originalIndex===i;
var _isInSpan=!!_spanInfo&&!_isNonOrigSpan;
// Keyword-context skip: while a selectorWord def exists, words to its left that match the control's blankKeywords are non-navigable
var _isCtxKw=false;
if(globalThis._dynDefs&&globalThis._dynDefs.words){for(var _cki=0;_cki<globalThis._dynDefs.words.length;_cki++){var _ckd=globalThis._dynDefs.words[_cki];if(_ckd&&_ckd.metadata&&_ckd.metadata.selectorWord&&i<_ckd.index){var _ckCtrl=(globalThis._cueControlOverrides||{})[_ckd.metadata.controlName];if(_ckCtrl&&_ckCtrl.blankKeywords){for(var _ckj=0;_ckj<_ckCtrl.blankKeywords.length;_ckj++){if(_ckCtrl.blankKeywords[_ckj]===_wLow){_isCtxKw=true;break;}}if(_isCtxKw)break;}}}}
if(((${m.condition})||_hasTipAlt||_hasDynAlt||_isSpanOriginal||_isInSpan)&&!_isNonOrigSpan&&!_isCtxKw)${m.targetIdx}.push(i);
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

  // wink-pos-tagger removed — blank classification handled by ClassifiedSourceGroup

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
  result = writeControlOvrVariable(content, config);
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

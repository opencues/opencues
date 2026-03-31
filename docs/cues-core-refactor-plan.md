# Plan: Move Remaining Cue Functions to cues-core

**STATUS: COMPLETE** (2026-03-24)
**Tests: 27/27 PASSED**

## Goal
Reduce tweakcc patch from ~60 lines to ~30 lines by moving reusable logic to cues-core.

---

## Functions to Add to cues-core

### 1. `lookupMultiple(words, map)`

**Current location:** dynamicHighlight.ts lines 578-592

**Current code (in patch):**
```javascript
var _tipsResults=[];
var _nonTipsIndices=[];
for(var _ti=0;_ti<_sentWords.length;_ti++){
  if(_sentWords[_ti]==="_")continue;
  var _tipResult=globalThis._tipsMap.get(_sentWords[_ti].toLowerCase());
  if(_tipResult){
    _tipsResults.push({index:_ti,word:_sentWords[_ti],alts:_tipResult.alternatives,...});
  }else{
    _nonTipsIndices.push(_ti);
  }
}
```

**New cues-core function:**
```typescript
interface WordDefResult {
  index: number;
  word: string;
  alts: string[] | null;
  tip?: string;
  altTips?: Record<string, string>;
  source: 'tips';
}

interface LookupMultipleResult {
  found: WordDefResult[];
  missingIndices: number[];
}

export function lookupMultiple(
  words: string[],
  map: Map<string, TipsLookupResult>,
  options?: { skipPattern?: RegExp }  // e.g., /^_$/ to skip blanks
): LookupMultipleResult
```

### 2. `formatAsWordDefs(results, allWords)`

**Current location:** dynamicHighlight.ts lines 597-608

**Current code (in patch):**
```javascript
var _tipsJson={words:[],_model:"tips-only",_timing:"0ms"};
for(var _tji=0;_tji<_sentWords.length;_tji++){
  var _found=_tipsResults.find(function(r){return r.index===_tji;});
  if(_found){
    _tipsJson.words.push({index:_tji,word:_found.word,alts:_found.alts,tip:_found.tip,
      altTips:_found.altTips,source:"tips",linked:null,currentAltIndex:0});
  }else{
    _tipsJson.words.push({index:_tji,word:_sentWords[_tji],alts:null,linked:null});
  }
}
```

**New cues-core function:**
```typescript
interface WordDef {
  index: number;
  word: string;
  alts: string[] | null;
  tip?: string;
  altTips?: Record<string, string>;
  source?: 'tips' | 'llm';
  linked?: number[] | null;
  currentAltIndex?: number;
}

export function formatAsWordDefs(
  found: WordDefResult[],
  allWords: string[]
): WordDef[]
```

### 3. `mergeWordDefs(existing, newDefs)`

**Current location:** dynamicHighlight.ts lines 617-631

**Current code (in patch):**
```javascript
for(var _tri=0;_tri<_tipsResults.length;_tri++){
  var _tipR=_tipsResults[_tri];
  var _existing=globalThis._dynDefs.words.find(function(w){return w.index===_tipR.index;});
  if(_existing){
    if(!_existing.alts)_existing.alts=_tipR.alts;
    if(!_existing.tip)_existing.tip=_tipR.tip;
    if(!_existing.altTips)_existing.altTips=_tipR.altTips;
    _existing.source="tips";
  }else{
    globalThis._dynDefs.words.push({...});
  }
}
```

**New cues-core function:**
```typescript
export function mergeWordDefs(
  existing: WordDef[],
  newDefs: WordDef[],
  options?: { preserveExisting?: boolean }
): WordDef[]
```

---

## Implementation Steps

### Step 1: Add types to cues-core
File: `/home/wilfred/cues-system/packages/cues-core/src/types.ts`
- Add `WordDef` interface
- Add `WordDefResult` interface
- Add `LookupMultipleResult` interface

### Step 2: Add functions to tips-file.ts
File: `/home/wilfred/cues-system/packages/cues-core/src/sources/tips-file.ts`
- Add `lookupMultiple()`
- Add `formatAsWordDefs()`
- Add `mergeWordDefs()`

### Step 3: Export from index.ts
File: `/home/wilfred/cues-system/packages/cues-core/src/index.ts`
- Export new functions and types

### Step 4: Build cues-core
```bash
cd /home/wilfred/cues-system/packages/cues-core
npm run build
cp -r dist/* ~/.claude/node_modules/cues-core/
```

### Step 5: Update tweakcc patch
File: `/home/wilfred/tweakcc-source/src/patches/dynamicHighlight.ts`
- Replace inline lookup loop with `_cues.lookupMultiple()`
- Replace formatting code with `_cues.formatAsWordDefs()`
- Replace merge code with `_cues.mergeWordDefs()`

### Step 6: Build and test tweakcc
```bash
cd /home/wilfred/tweakcc-source
npm run build
node dist/index.mjs --apply
node --check ~/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js
```

### Step 7: Run benchmark
```bash
node /home/wilfred/tweakcc/tests/benchmark-tips-lookup.js
```

---

## Expected Result

### Before (tweakcc patch)
```javascript
// 60 lines of inline code
var _tipsResults=[];
var _nonTipsIndices=[];
for(var _ti=0;_ti<_sentWords.length;_ti++){
  // ... 15 lines
}
if(_tipsResults.length>0&&_nonTipsIndices.length===0){
  // ... 15 lines
}
if(_tipsResults.length>0){
  // ... 15 lines
}
```

### After (tweakcc patch)
```javascript
// ~15 lines using cues-core functions
var _lookup=_cues.lookupMultiple(_sentWords,globalThis._tipsMap,{skipPattern:/^_$/});
if(_lookup.found.length>0&&_lookup.missingIndices.length===0&&_sentWords.indexOf("_")<0){
  globalThis._dynDefs={words:_cues.formatAsWordDefs(_lookup.found,_sentWords),_model:"tips-only"};
  // ... UI refresh (stays in patch)
  return;
}
if(_lookup.found.length>0){
  globalThis._dynDefs.words=_cues.mergeWordDefs(globalThis._dynDefs.words||[],_lookup.found);
  // ... UI refresh (stays in patch)
}
```

---

## Verification Checklist

- [x] `lookupMultiple()` returns correct found/missing split
- [x] `formatAsWordDefs()` includes all words (found + unfound)
- [x] `mergeWordDefs()` preserves existing alts when new is null
- [x] Benchmark shows same performance (~0.01ms lookups)
- [x] Tips-only sentences skip LLM (check timing log)
- [x] Mixed sentences merge tips + LLM results
- [x] UI highlighting still works
- [x] cli.js syntax valid after patching
- [x] All 4 cues-core functions called in patched cli.js

## Test Results (2026-03-24)

```
27 tests passed, 0 failed

Performance:
- Map build: 0.67ms (one-time)
- 10-word lookup: 0.0004ms
- Speedup: 106-178x vs linear scan
```

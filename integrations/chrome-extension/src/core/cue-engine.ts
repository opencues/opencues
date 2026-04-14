import {
  createResolver,
  buildSourcesFromConfig,
  lookupMultiple,
  mergeWordDefs,
  convertCueResultsToWordDefs,
  type CueResolver,
  type WordDef,
  type CueSource,
  type ResolverResult,
} from 'cues-core';
import { FetchHttpAdapter } from '../adapters/fetch-http-adapter';
import { parseConfig, type ParsedConfig, type OpenCuesState } from './config-loader';
import { createControls, type BrowserControl } from '../controls';
import type { StoredConfig } from '../types';

/** Multi-word span tracking (equivalent to globalThis._dynSpans) */
export interface SpanInfo {
  originalIndex: number;
  spanLength: number;
}

/** Consume-all state — isolated from words[] (gotcha #46) */
export interface ConsumeAllState {
  index: number;
  alts: string[];
  currentAltIndex: number;
  spanLength: number;
  cueTip: string | null;
  controlName: string | null;
}

/**
 * CueEngine — central orchestrator for the Chrome extension.
 *
 * Manages the LLM resolver, tips lookup, word analysis lifecycle,
 * cycling with linked words, multi-word spans, selector/satellite pairs,
 * consume-all blanks, and browser-native controls.
 *
 * Browser equivalent of dynamicHighlight.ts's init + analysis logic.
 */
export class CueEngine {
  private config: ParsedConfig | null = null;
  private resolver: CueResolver | null = null;
  private httpAdapter = new FetchHttpAdapter();
  private pending = false;
  private resolverGeneration = 0;

  /** Current word definitions (equivalent to globalThis._dynDefs.words) */
  words: WordDef[] = [];

  /** Multi-word span tracking */
  spans: Record<number, SpanInfo> = {};

  /** Consume-all cycling state — separate from words[] (gotcha #46) */
  consumeAllAlts: ConsumeAllState | null = null;

  /** Last analyzed word list */
  private lastAnalyzed: string[] = [];

  /** Text that arrived while LLM was pending (post-pending re-trigger) */
  private pendingRetriggerText: string | null = null;

  /** Ignore words set (from cues.md ignore config) */
  private ignoreWords: Set<string> | null = null;

  /** Browser-native controls */
  controls: Map<string, BrowserControl> = new Map();

  /** Blank positions dismissed by user cycling to "_" (gotcha #19) */
  dismissedBlanks: Set<number> = new Set();

  /** Word indices queued for blankClearOnEdit removal */
  pendingClearOnEdit: number[] | null = null;

  /** OpenCues settings state (from opencues.md) */
  openCues: OpenCuesState = { settings: {}, current: {}, tips: {}, satTips: {} };

  /** Callbacks for when analysis completes */
  private listeners: Array<(words: WordDef[]) => void> = [];

  /** Step patterns for number cycling */
  stepPatterns: Array<{ re: RegExp; ctrl: StepControl }> = [];

  // ─── Configuration ─────────────────────────────────────────────

  configure(stored: StoredConfig): void {
    this.config = parseConfig(stored);
    this.openCues = this.config.openCues;

    // Build ignore set
    if (this.config.cuesMd?.ignore?.length) {
      this.ignoreWords = new Set(this.config.cuesMd.ignore.map(w => w.toLowerCase()));
    } else {
      this.ignoreWords = null;
    }

    // Build step patterns from controls
    this.stepPatterns = [];
    if (this.config.cuesMd?.controls) {
      for (const ctrl of Object.values(this.config.cuesMd.controls)) {
        const sc = ctrl as any;
        if (sc.stepPattern) {
          try { this.stepPatterns.push({ re: new RegExp(sc.stepPattern), ctrl: sc }); } catch { /* skip */ }
        }
        if (sc.stepSuffixes?.length) {
          for (const sf of sc.stepSuffixes) {
            const escaped = sf.replace(/[^a-zA-Z0-9]/g, '\\$&');
            try {
              this.stepPatterns.push({
                re: new RegExp(`^-?\\d+(\\.\\d+)?${escaped}$`),
                ctrl: { ...sc, stepSuffix: sf },
              });
            } catch { /* skip */ }
          }
        }
      }
    }

    // Initialize browser-native controls (including prompt improver with LLM config)
    this.controls = createControls({
      finnhubApiKey: stored.finnhubApiKey,
      llmConfig: this.config.apiKey ? {
        apiUrl: this.config.apiUrl,
        apiKey: this.config.apiKey,
        model: this.config.model,
      } : undefined,
    });

    if (!this.config.apiKey) {
      this.resolver = null;
      return;
    }

    // Build sources from parsed cues.md + blanks.md config
    // Pass controls for control-bound blank sources (cues-core handles ControlBlankSource)
    const controls = this.config.cuesMd?.controls;
    const sources: CueSource[] = buildSourcesFromConfig(
      this.config.cuesMd,
      this.config.blanksMd ?? undefined,
      {
        httpAdapter: this.httpAdapter,
        endpoint: this.config.apiUrl,
        apiKey: this.config.apiKey,
        defaultModel: this.config.model,
        controls: controls || undefined,
        // readControlState: browser controls handle get/set via BrowserControl interface
        // cues-core's ControlBlankSource uses this for bash scripts; we provide browser-native
        // controls separately via this.controls Map
      },
    );

    console.log('[OpenCues] Built', sources.length, 'sources from config');

    this.resolver = createResolver(sources, {
      parallel: false,
      timeout: 30000,
      continueOnError: true,
    });

    this.resolverGeneration++;
    this.lastAnalyzed = [];
  }

  /** Invalidate any in-flight LLM call and update lastAnalyzed.
   *  Call after blank auto-populate to prevent stale results from overwriting control-blank defs. */
  invalidateAnalysis(newWords: string[]): void {
    this.resolverGeneration++;
    this.lastAnalyzed = newWords;
    this.pending = false;
    this.pendingRetriggerText = null;
  }

  onUpdate(fn: (words: WordDef[]) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this.words);
  }

  /** Check if a word is navigable */
  isNavigable(word: string, index: number): boolean {
    const def = this.words.find(w => w.index === index);
    if (def?.alts && def.alts.length > 1) return true;
    // Consume-all at this index
    if (this.consumeAllAlts?.index === index) return true;
    // Step pattern
    for (const sp of this.stepPatterns) {
      if (sp.re.test(word)) return true;
    }
    return false;
  }

  /** Check voice-mode gate — returns true if TTS should be silenced */
  isVoiceMuted(): boolean {
    return this.openCues.current['voice-mode'] === 'inactive';
  }

  /** Synchronous instant tips lookup — call directly on input for zero-delay dimming */
  lookupTipsSync(text: string): boolean {
    if (!this.config || this.config.tipsMap.size === 0) return false;
    const curWords = text.split(/\s+/).filter(w => w);
    if (curWords.length === 0) return false;

    const skipWords = new Set<string>();
    if (this.ignoreWords) this.ignoreWords.forEach(w => skipWords.add(w));
    for (const def of this.words) {
      if ((def.alts && def.alts.length > 0) || def.metadata?.controlName) {
        skipWords.add(curWords[def.index]?.toLowerCase());
      }
    }

    const tipsResult = lookupMultiple(curWords, this.config.tipsMap,
      skipWords.size > 0 ? { skipFn: (w: string) => skipWords.has(w.toLowerCase()) } : undefined,
    );
    if (tipsResult.found.length > 0) {
      this.words = mergeWordDefs(this.words, tipsResult.found);
      this.notify();
      return true;
    }
    return false;
  }

  // ─── Analysis ──────────────────────────────────────────────────

  async analyze(text: string): Promise<void> {
    if (!this.config) return;
    if (this.pending) {
      this.pendingRetriggerText = text;
      return;
    }

    const curWords = text.split(/\s+/).filter(w => w);

    // Clear dismissed blanks on text change (gotcha #19)
    if (curWords.join(' ') !== this.lastAnalyzed.join(' ')) {
      this.dismissedBlanks.clear();
    }

    // Unconditional consume-all cleanup on text change (gotcha #46 — outside hlState guard)
    if (this.consumeAllAlts && curWords.join(' ') !== this.lastAnalyzed.join(' ')) {
      const ca = this.consumeAllAlts;
      for (let i = 0; i < (ca.spanLength || 1); i++) delete this.spans[ca.index + i];
      this.words = this.words.filter(d => d.index < ca.index || d.index >= ca.index + (ca.spanLength || 1));
      this.consumeAllAlts = null;
    }

    if (curWords.length === 0) {
      this.words = [];
      this.lastAnalyzed = [];
      this.notify();
      return;
    }

    // Per-word invalidation — matches Claude Code (dynamicHighlight.ts lines 1421-1467)
    // If word is IN alts: keep def, update word/currentAltIndex (valid cycle)
    // If word changed to something NOT in alts: clear alts (actual edit)
    let needsAnalysis = false;
    if (curWords.length !== this.lastAnalyzed.length) {
      needsAnalysis = true;
    }
    const minLen = Math.min(curWords.length, this.lastAnalyzed.length);
    for (let i = 0; i < minLen; i++) {
      if (curWords[i] !== this.lastAnalyzed[i]) {
        needsAnalysis = true;
        // Skip consume-all positions
        if (this.consumeAllAlts) {
          const ca = this.consumeAllAlts;
          if (i >= ca.index && i < ca.index + (ca.spanLength || 1)) continue;
        }
        const def = this.words.find(w => w.index === i);
        if (def) {
          // Check spans: for multi-word alts, join the span words
          const spanLen = (def as any).spanLength || 1;
          const effectiveNew = spanLen > 1
            ? curWords.slice(i, i + spanLen).join(' ')
            : curWords[i];

          if (def.alts && def.alts.includes(effectiveNew)) {
            // Word is in alts — valid cycle, keep def, update index
            def.word = effectiveNew;
            def.currentAltIndex = def.alts.indexOf(effectiveNew);
          } else {
            // Word NOT in alts — actual edit, clear this def
            const clearedMeta = def.metadata;
            def.word = curWords[i];
            def.alts = null;
            def.currentAltIndex = 0;
            delete def.metadata;
            delete this.spans[i];

            // Pair cleanup: clear selector↔satellite partner
            if (clearedMeta) {
              let partnerIdx: number | null = null;
              if ((clearedMeta as any).satelliteWord && typeof (clearedMeta as any).parentIndex === 'number')
                partnerIdx = (clearedMeta as any).parentIndex;
              else if ((clearedMeta as any).selectorWord && typeof (clearedMeta as any).childIndex === 'number')
                partnerIdx = (clearedMeta as any).childIndex;
              if (partnerIdx != null) {
                const partner = this.words.find(w => w.index === partnerIdx);
                if (partner) { partner.alts = null; partner.currentAltIndex = 0; delete partner.metadata; delete this.spans[partnerIdx!]; }
              }
              // blankClearOnEdit
              if ((clearedMeta as any).blankClearOnEdit) {
                this.scheduleClearOnEdit(i, { ...def, metadata: clearedMeta });
              }
            }
          }
        }
      }
    }
    // Prune defs beyond current word count
    if (curWords.length < this.lastAnalyzed.length) {
      this.words = this.words.filter(w => w.index < curWords.length);
    }
    if (!needsAnalysis && curWords.length > 0) {
      const lastIdx = curWords.length - 1;
      if (curWords[lastIdx] !== (this.lastAnalyzed[lastIdx] || '')) needsAnalysis = true;
    }

    if (!needsAnalysis) return;

    // Tips lookup (O(1)) — only for words that don't already have defs
    console.log('[OpenCues] analyze:', curWords.length, 'words, tipsMap:', this.config.tipsMap.size, 'resolver:', !!this.resolver);

    if (this.config.tipsMap.size > 0) {
      // Build skip set: words that already have valid defs don't need tips re-lookup
      const skipWords = new Set<string>();
      if (this.ignoreWords) this.ignoreWords.forEach(w => skipWords.add(w));
      for (const def of this.words) {
        if ((def.alts && def.alts.length > 0) || def.metadata?.controlName) {
          skipWords.add(curWords[def.index]?.toLowerCase());
        }
      }
      const tipsResult = lookupMultiple(curWords, this.config.tipsMap,
        skipWords.size > 0 ? { skipFn: (w: string) => skipWords.has(w.toLowerCase()) } : undefined,
      );
      console.log('[OpenCues] tips lookup:', tipsResult.found.length, 'found,', tipsResult.missingIndices.length, 'missing');
      if (tipsResult.found.length > 0) {
        this.words = mergeWordDefs(this.words, tipsResult.found);
        this.notify();
      }
    }

    if (!this.resolver) { this.lastAnalyzed = curWords; return; }

    // Match Claude Code's needLlmIndices logic (dynamicHighlight.ts lines 978-993)
    const FUNC_WORDS = /^(the|a|an|to|is|was|of|and|in|on|at|for|it|its|be|am|are|were|been|has|had|have|do|did|does|not|but|or|if|so|no|my|we|he|she|me|us|them|this|that|with|from|by|as)$/;
    const needLlm: number[] = [];
    for (let i = 0; i < curWords.length; i++) {
      const lower = curWords[i].toLowerCase();
      if (this.ignoreWords?.has(lower)) continue;
      if (FUNC_WORDS.test(lower)) continue;
      // Skip cue-controls (step-pattern words)
      if (this.isNavigable(curWords[i], i) && !this.words.find(w => w.index === i)?.alts) {
        // It's navigable via step pattern but has no alts — skip LLM
        for (const sp of this.stepPatterns) {
          if (sp.re.test(curWords[i])) { continue; }
        }
      }
      // Skip if already has valid alts AND current word is in the alts list
      const existing = this.words.find(w => w.index === i);
      if (existing?.alts && existing.alts.length > 1 && existing.alts.includes(curWords[i])) continue;
      // Skip selector/satellite words — they cycle via opencues.md settings, not LLM
      if (existing?.metadata && ((existing.metadata as any).selectorWord || (existing.metadata as any).satelliteWord)) continue;
      // Skip control-bound words (managed by browser controls, not LLM)
      if (existing?.metadata?.controlName) continue;
      // Skip span-covered positions — non-origin words in a span don't need individual LLM alts
      const spanInfo = this.spans[i];
      if (spanInfo && spanInfo.originalIndex !== i) continue;
      // Skip tips-handled words
      if (existing?.source === 'tips') continue;
      needLlm.push(i);
    }

    if (needLlm.length === 0) { this.lastAnalyzed = curWords; return; }

    this.pending = true;
    const capturedGen = this.resolverGeneration;

    try {
      console.log('[OpenCues] LLM resolving', needLlm.length, 'words, text:', JSON.stringify(text), 'words:', curWords);
      const result: ResolverResult = await this.resolver.resolve({
        text,
        words: curWords,
      });

      console.log('[OpenCues] LLM result:', result.results.length, 'results,', result.errors.length, 'errors, took', result.totalTime + 'ms');
      console.log('[OpenCues] Raw CueResults:', result.results.map(r => `idx${r.wordIndex}(${r.word})→[${r.alternatives.join(',')}]`));
      if (result.errors.length > 0) console.warn('[OpenCues] LLM errors:', result.errors);

      if (this.resolverGeneration !== capturedGen) return;

      // Convert CueResult[] → WordDef[] with alt cleaning (cues-core utility)
      const newDefs = convertCueResultsToWordDefs(result.results);
      console.log('[OpenCues] WordDefs created:', newDefs.length, newDefs.map(d => `${d.word}→[${d.alts?.join(',')}]`));

      // Merge like Claude Code: replace-at-index, not append-alts.
      // Check current text to detect stale results (word changed during LLM call).
      const curTextWords = (this.lastAnalyzed.length > 0 ? this.lastAnalyzed : curWords);
      for (const nw of newDefs) {
        // Stale result: word at this index no longer matches — discard
        if (nw.index < curTextWords.length && nw.word !== curTextWords[nw.index]) continue;
        // Skip span-covered positions
        const spanInfo = this.spans[nw.index];
        if (spanInfo && spanInfo.originalIndex !== nw.index) continue;

        const existing = this.words.find(w => w.index === nw.index);
        // Protect tips and control-blanks
        if (existing?.source === 'tips') continue;
        if (existing?.metadata?.controlName && !nw.metadata?.controlName) continue;

        if (existing) {
          // Preserve cycling state
          const curWord = curTextWords[nw.index];
          const curAltIdx = curWord && nw.alts ? nw.alts.indexOf(curWord) : -1;
          nw.currentAltIndex = curAltIdx >= 0 ? curAltIdx : (existing.currentAltIndex || 0);
          if (existing.speak) nw.speak = true;
          // Replace at index (NOT merge alts — matches Claude Code behavior)
          const idx = this.words.indexOf(existing);
          this.words[idx] = nw;
        } else {
          const curWord = curTextWords[nw.index];
          const curAltIdx = curWord && nw.alts ? nw.alts.indexOf(curWord) : -1;
          nw.currentAltIndex = curAltIdx >= 0 ? curAltIdx : 0;
          this.words.push(nw);
        }
      }

      this.lastAnalyzed = curWords;
      this.notify();
    } catch (e) { console.error('[OpenCues] LLM error:', e); } finally {
      this.pending = false;
      if (this.pendingRetriggerText && this.pendingRetriggerText !== text) {
        const rt = this.pendingRetriggerText;
        this.pendingRetriggerText = null;
        setTimeout(() => this.analyze(rt), 100);
      }
      this.pendingRetriggerText = null;
    }
  }

  // ─── blankClearOnEdit ──────────────────────────────────────────

  /**
   * Schedule removal of control-blank pair words when user edits over them.
   * Ported from dynamicHighlight.ts lines 1455-1464.
   */
  private scheduleClearOnEdit(editedIndex: number, def: WordDef): void {
    const meta = def.metadata as any;
    if (!meta) return;

    const remove = [editedIndex];

    if (meta.selectorWord && typeof meta.childIndex === 'number') {
      // Include separator + satellite words
      for (let i = editedIndex + 1; i <= meta.childIndex; i++) remove.push(i);
    } else if (meta.satelliteWord && typeof meta.parentIndex === 'number') {
      // Include selector + separator words
      for (let i = meta.parentIndex; i < editedIndex; i++) remove.push(i);
    }

    remove.sort((a, b) => b - a); // descending for safe removal
    this.pendingClearOnEdit = remove;
  }

  /**
   * Execute pending blankClearOnEdit removal.
   * Called by content.ts on text change, OUTSIDE highlight state guard.
   * Returns new text if words were removed, null otherwise.
   */
  executeClearOnEdit(text: string): string | null {
    if (!this.pendingClearOnEdit) return null;
    const indices = this.pendingClearOnEdit;
    this.pendingClearOnEdit = null;

    let result = text;
    const words = result.split(/\s+/).filter(w => w);

    for (const idx of indices) {
      if (idx >= words.length) continue;
      // Find word position
      let pos = 0;
      for (let j = 0; j < idx; j++) {
        pos = result.indexOf(words[j], pos) + words[j].length;
      }
      let wStart = result.indexOf(words[idx], pos);
      let wEnd = wStart + words[idx].length;
      // Remove adjacent whitespace
      if (wEnd < result.length && result[wEnd] === ' ') wEnd++;
      else if (wStart > 0 && result[wStart - 1] === ' ') wStart--;

      result = result.slice(0, wStart) + result.slice(wEnd);
      words.splice(idx, 1);

      // Clean up spans and defs for removed word
      delete this.spans[idx];
      this.words = this.words.filter(w => w.index !== idx);
    }

    if (result !== text) {
      // Shift downstream indices after removals.
      // Count how many removed indices are BELOW each position for correct shift.
      const removedSet = new Set(indices);
      const shiftForIndex = (idx: number): number => {
        let shift = 0;
        for (const ri of indices) { if (ri < idx) shift++; }
        return idx - shift;
      };
      for (const d of this.words) {
        d.index = shiftForIndex(d.index);
        const dm = d.metadata as any;
        if (dm?.childIndex != null) dm.childIndex = shiftForIndex(dm.childIndex);
        if (dm?.parentIndex != null) dm.parentIndex = shiftForIndex(dm.parentIndex);
      }
      // Rebuild spans with shifted keys
      const newSpans: Record<number, SpanInfo> = {};
      for (const [k, v] of Object.entries(this.spans)) {
        const ki = parseInt(k, 10);
        if (!removedSet.has(ki)) {
          newSpans[shiftForIndex(ki)] = v;
        }
      }
      this.spans = newSpans;

      this.lastAnalyzed = result.split(/\s+/).filter(w => w);
      return result;
    }
    return null;
  }

  // ─── Cycling ───────────────────────────────────────────────────

  /**
   * Master cycle function. Priority order (gotcha #14):
   *   1. Control-bound blanks (browser controls)
   *   2. Selector word cycling (opencues.md)
   *   3. Satellite word cycling (opencues.md)
   *   4. Consume-all cycling
   *   5. Step number cycling
   *   6. Dynamic alt cycling (LLM/tips)
   */
  cycle(wordIndex: number, direction: 1 | -1, fullText: string): CycleResult | null {
    const allWords = fullText.split(/\s+/).filter(w => w);
    if (wordIndex < 0 || wordIndex >= allWords.length) return null;

    // 1. Control-bound blanks — handled by word-navigator via controlAction()

    // 2. Selector word cycling
    const selResult = this.cycleSelector(wordIndex, direction, fullText, allWords);
    if (selResult) return this.afterCycle(selResult);

    // 3. Satellite word cycling
    const satResult = this.cycleSatellite(wordIndex, direction, fullText, allWords);
    if (satResult) return this.afterCycle(satResult);

    // 4. Consume-all cycling
    const caResult = this.cycleConsumeAll(wordIndex, direction, fullText, allWords);
    if (caResult) return this.afterCycle(caResult);

    // 5. Step number cycling
    const stepResult = this.cycleStep(wordIndex, direction, allWords[wordIndex], fullText, allWords);
    if (stepResult) return this.afterCycle(stepResult);

    // 6. Dynamic alt cycling
    const altResult = this.cycleAlts(wordIndex, direction, fullText, allWords);
    if (altResult) return this.afterCycle(altResult);

    return null;
  }

  /** Update lastAnalyzed after any cycling so next analyze() knows the current text */
  private afterCycle(result: CycleResult): CycleResult {
    this.lastAnalyzed = result.newText.split(/\s+/).filter(w => w);
    return result;
  }

  /** Selector cycling — cycles through opencues.md setting names */
  private cycleSelector(
    wordIndex: number, direction: 1 | -1, fullText: string, allWords: string[],
  ): CycleResult | null {
    const def = this.words.find(w => w.index === wordIndex && (w.metadata as any)?.selectorWord);
    if (!def) return null;

    const meta = def.metadata as any;
    const keys = Object.keys(this.openCues.settings);
    if (keys.length === 0) return null;

    const curIdx = keys.indexOf(meta.currentSetting || def.word);
    const nextIdx = (curIdx + direction + keys.length) % keys.length;
    const nextSet = keys[nextIdx];

    // Get satellite value for new setting
    const vals = this.openCues.settings[nextSet] || [];
    const newSatVal = this.openCues.current[nextSet] || vals[0] || '';

    // Find selector position (span-aware)
    const selSpan = (def as any).spanLength || 1;
    const satIdx = meta.childIndex as number;
    const satDef = this.words.find(w => w.index === satIdx);
    const satSpan = (satDef as any)?.spanLength || 1;

    let pos = 0;
    for (let i = 0; i < wordIndex; i++) { pos = fullText.indexOf(allWords[i], pos) + allWords[i].length; }
    const selStart = fullText.indexOf(allWords[wordIndex], pos);
    if (selStart < 0) return null;

    let selEnd = selStart;
    for (let i = 0; i < selSpan; i++) {
      const wp = fullText.indexOf(allWords[wordIndex + i], selEnd);
      if (wp < 0) break;
      selEnd = wp + allWords[wordIndex + i].length;
    }

    // Find satellite span end
    let satEnd = selEnd;
    for (let i = 0; i < satSpan; i++) {
      if (satIdx + i >= allWords.length) break;
      const wp = fullText.indexOf(allWords[satIdx + i], satEnd);
      if (wp < 0) break;
      satEnd = wp + allWords[satIdx + i].length;
    }

    const sep = meta.separator || ' ';
    const fullInsert = nextSet + sep + newSatVal;
    const newText = fullText.slice(0, selStart) + fullInsert + fullText.slice(satEnd);

    // Update defs
    meta.currentSetting = nextSet;
    def.word = nextSet;

    // Shift downstream indices
    const newSelWc = nextSet.split(/\s+/).filter(w => w).length;
    const newSatWc = newSatVal ? newSatVal.split(/\s+/).filter(w => w).length : 0;
    const newSepWc = fullInsert.split(/\s+/).filter(w => w).length - newSelWc - newSatWc;
    const oldEndIdx = satIdx + satSpan;
    const downShift = (newSelWc + newSepWc + newSatWc) - (selSpan + (satIdx - (wordIndex + selSpan)) + satSpan);

    if (downShift !== 0) {
      for (const d of this.words) {
        if (d.index >= oldEndIdx && d !== def && d !== satDef) d.index += downShift;
        const dm = d.metadata as any;
        if (dm?.childIndex != null && dm.childIndex >= oldEndIdx && d !== def) dm.childIndex += downShift;
        if (dm?.parentIndex != null && dm.parentIndex >= oldEndIdx && d !== satDef) dm.parentIndex += downShift;
      }
    }

    // Update satellite def
    if (satDef) {
      satDef.word = newSatVal;
      satDef.alts = vals.length > 0 ? vals : [newSatVal];
      satDef.currentAltIndex = Math.max(0, vals.indexOf(newSatVal));
      satDef.cueTip = this.openCues.satTips[nextSet]?.[newSatVal] || this.openCues.tips[nextSet] || undefined;
    }

    // Update current state (in-memory, immediate — gotcha #23)
    this.openCues.current[nextSet] = newSatVal;

    return { newText, wStart: selStart, lenDiff: newText.length - fullText.length, wordDef: def };
  }

  /** Satellite cycling — cycles values for current setting */
  private cycleSatellite(
    wordIndex: number, direction: 1 | -1, fullText: string, allWords: string[],
  ): CycleResult | null {
    const def = this.words.find(w => w.index === wordIndex && (w.metadata as any)?.satelliteWord);
    if (!def) return null;

    const meta = def.metadata as any;
    const parentDef = this.words.find(w => w.index === meta.parentIndex);
    const curSetting = (parentDef?.metadata as any)?.currentSetting;
    if (!curSetting) return null;

    const vals = this.openCues.settings[curSetting] || [def.word || allWords[wordIndex]];
    const curIdx = vals.indexOf(def.word || allWords[wordIndex]);
    const nextIdx = ((curIdx < 0 ? 0 : curIdx) + direction + vals.length) % vals.length;
    const newVal = vals[nextIdx];

    // Find satellite position (span-aware)
    const oldSpan = (def as any).spanLength || 1;
    let pos = 0;
    for (let i = 0; i < wordIndex; i++) { pos = fullText.indexOf(allWords[i], pos) + allWords[i].length; }
    const wStart = fullText.indexOf(allWords[wordIndex], pos);
    if (wStart < 0) return null;

    let wEnd = wStart;
    for (let i = 0; i < oldSpan; i++) {
      if (wordIndex + i >= allWords.length) break;
      const wp = fullText.indexOf(allWords[wordIndex + i], wEnd);
      if (wp < 0) break;
      wEnd = wp + allWords[wordIndex + i].length;
    }

    const newText = fullText.slice(0, wStart) + newVal + fullText.slice(wEnd);

    // Shift downstream indices
    const newWc = newVal.split(/\s+/).filter(w => w).length;
    const downShift = newWc - oldSpan;
    if (downShift !== 0) {
      const oldEnd = wordIndex + oldSpan;
      for (const d of this.words) {
        if (d.index >= oldEnd && d !== def) d.index += downShift;
        const dm = d.metadata as any;
        if (dm?.childIndex != null && dm.childIndex >= oldEnd) dm.childIndex += downShift;
        if (dm?.parentIndex != null && dm.parentIndex >= oldEnd) dm.parentIndex += downShift;
      }
    }

    // Update span tracking
    for (let i = 0; i < oldSpan; i++) delete this.spans[wordIndex + i];
    if (newWc > 1) {
      (def as any).spanLength = newWc;
      for (let i = 0; i < newWc; i++) this.spans[wordIndex + i] = { originalIndex: wordIndex, spanLength: newWc };
    } else {
      delete (def as any).spanLength;
    }

    def.word = newVal;
    def.currentAltIndex = nextIdx;
    def.cueTip = this.openCues.satTips[curSetting]?.[newVal] || this.openCues.tips[curSetting] || undefined;

    // Update current state (in-memory, immediate — gotcha #23)
    this.openCues.current[curSetting] = newVal;

    return { newText, wStart, lenDiff: newText.length - fullText.length, wordDef: def };
  }

  /** Consume-all cycling — dedicated state separate from words[] (gotcha #46) */
  private cycleConsumeAll(
    wordIndex: number, direction: 1 | -1, fullText: string, allWords: string[],
  ): CycleResult | null {
    if (!this.consumeAllAlts) return null;
    const ca = this.consumeAllAlts;

    // Resolve index via span tracking
    const span = this.spans[wordIndex];
    const caIdx = span ? span.originalIndex : wordIndex;
    if (caIdx !== ca.index) return null;

    const nextIdx = (ca.currentAltIndex + direction + ca.alts.length) % ca.alts.length;
    ca.currentAltIndex = nextIdx;
    const newWord = ca.alts[nextIdx];
    if (newWord == null) return null;

    // Track dismissed blanks
    if (newWord === '_') this.dismissedBlanks.add(caIdx);
    else this.dismissedBlanks.delete(caIdx);

    // Replace text (span-aware)
    const oldSpan = ca.spanLength || 1;
    let pos = 0;
    for (let i = 0; i < caIdx; i++) { pos = fullText.indexOf(allWords[i], pos) + allWords[i].length; }
    const wStart = fullText.indexOf(allWords[caIdx], pos);
    if (wStart < 0) return null;

    let wEnd = wStart;
    for (let i = 0; i < oldSpan; i++) {
      if (caIdx + i >= allWords.length) break;
      const wp = fullText.indexOf(allWords[caIdx + i], wEnd);
      if (wp < 0) break;
      wEnd = wp + allWords[caIdx + i].length;
    }

    const newText = fullText.slice(0, wStart) + newWord + fullText.slice(wEnd);
    const newWc = newWord.split(/\s+/).length;
    ca.spanLength = newWc;

    // Update span tracking
    for (let i = 0; i < oldSpan; i++) delete this.spans[caIdx + i];
    for (let i = 0; i < newWc; i++) this.spans[caIdx + i] = { originalIndex: caIdx, spanLength: newWc };

    // Shift downstream indices if span length changed (BUG M)
    const caShift = newWc - oldSpan;
    if (caShift !== 0) {
      const oldEnd = caIdx + oldSpan;
      for (const d of this.words) {
        if (d.index >= oldEnd) d.index += caShift;
        const dm = d.metadata as any;
        if (dm?.childIndex != null && dm.childIndex >= oldEnd) dm.childIndex += caShift;
        if (dm?.parentIndex != null && dm.parentIndex >= oldEnd) dm.parentIndex += caShift;
      }
    }

    this.lastAnalyzed = newText.split(/\s+/).filter(w => w);

    return { newText, wStart, lenDiff: newText.length - fullText.length, wordDef: null };
  }

  /** Step number cycling */
  private cycleStep(
    wordIndex: number, direction: 1 | -1, curWord: string, fullText: string, allWords: string[],
  ): CycleResult | null {
    // Don't step if word has dynamic alternatives
    if (this.words.find(w => w.index === wordIndex && w.alts && w.alts.length > 1)) return null;

    let stepCtrl: StepControl | null = null;
    for (const sp of this.stepPatterns) {
      if (sp.re.test(curWord)) { stepCtrl = sp.ctrl; break; }
    }
    if (!stepCtrl) return null;

    const step = stepCtrl.step ?? 1;
    const min = stepCtrl.stepMin ?? null;
    const max = stepCtrl.stepMax ?? null;
    const fmt = stepCtrl.stepFormat ?? null;
    const suffix = stepCtrl.stepSuffix ?? '';

    const raw = suffix && curWord.endsWith(suffix) ? curWord.slice(0, -suffix.length) : curWord;
    const num = parseFloat(raw);
    if (isNaN(num)) return null;

    let result = num + (step * direction);
    if (min != null && result < min) result = min;
    if (max != null && result > max) result = max;

    const formatted = fmt === 'integer' ? String(Math.round(result)) : String(result);
    const newWord = formatted + suffix;

    let wPos = 0;
    for (let i = 0; i < wordIndex; i++) { wPos = fullText.indexOf(allWords[i], wPos) + allWords[i].length; }
    const wStart = fullText.indexOf(curWord, wPos);
    if (wStart < 0) return null;

    const newText = fullText.slice(0, wStart) + newWord + fullText.slice(wStart + curWord.length);
    return { newText, wStart, lenDiff: newWord.length - curWord.length, wordDef: null };
  }

  /** Dynamic alt cycling with linked words and spans */
  private cycleAlts(
    wordIndex: number, direction: 1 | -1, fullText: string, allWords: string[],
  ): CycleResult | null {
    const def = this.words.find(w => w.index === wordIndex);
    if (!def?.alts || def.alts.length <= 1) return null;
    console.log(`[OpenCues] cycleAlts: idx=${wordIndex}, word="${allWords[wordIndex]}", def.word="${def.word}", alts=[${def.alts}], curAlt=${def.currentAltIndex}`);

    const currentIdx = typeof def.currentAltIndex === 'number' ? def.currentAltIndex : 0;
    const nextIdx = (currentIdx + direction + def.alts.length) % def.alts.length;
    def.currentAltIndex = nextIdx;
    const newWord = def.alts[nextIdx];
    if (newWord == null) return null;

    def.word = newWord;

    if (newWord === '_') this.dismissedBlanks.add(wordIndex);
    else this.dismissedBlanks.delete(wordIndex);

    // Replace (span-aware)
    const spanLen = (def as any).spanLength || 1;
    let wPos = 0;
    for (let i = 0; i < wordIndex; i++) { wPos = fullText.indexOf(allWords[i], wPos) + allWords[i].length; }
    const wStart = fullText.indexOf(allWords[wordIndex], wPos);
    if (wStart < 0) return null;

    let wEnd = wStart;
    for (let i = 0; i < spanLen; i++) {
      const idx = fullText.indexOf(allWords[wordIndex + i], wEnd);
      if (idx < 0) break;
      wEnd = idx + allWords[wordIndex + i].length;
    }

    let newText = fullText.slice(0, wStart) + newWord + fullText.slice(wEnd);

    // Update span tracking + shift downstream indices if word count changed
    const nwc = newWord.split(/\s+/).length;
    const spanShift = nwc - spanLen;

    if (nwc > 1) {
      (def as any).spanLength = nwc;
      for (let i = 0; i < nwc; i++) this.spans[wordIndex + i] = { originalIndex: wordIndex, spanLength: nwc };
    } else {
      delete (def as any).spanLength;
      for (let i = 0; i < spanLen; i++) delete this.spans[wordIndex + i];
    }

    // Shift downstream WordDef indices if word count changed (gotcha #10)
    if (spanShift !== 0) {
      const oldEnd = wordIndex + spanLen;
      for (const d of this.words) {
        if (d !== def && d.index >= oldEnd) d.index += spanShift;
        const dm = d.metadata as any;
        if (dm?.childIndex != null && dm.childIndex >= oldEnd) dm.childIndex += spanShift;
        if (dm?.parentIndex != null && dm.parentIndex >= oldEnd) dm.parentIndex += spanShift;
      }
      // Shift linked indices too
      if (def.linked) {
        def.linked = def.linked.map(li => li >= oldEnd ? li + spanShift : li);
      }
    }

    // Linked words (atomic update — gotcha #29)
    const updatedWords: Record<number, string> = { [wordIndex]: newWord };
    if (def.linked?.length) {
      for (const lIdx of def.linked) {
        if (lIdx < 0 || lIdx >= allWords.length) continue;
        const lDef = this.words.find(w => w.index === lIdx);
        if (lDef?.alts && lDef.alts.length > nextIdx) {
          lDef.currentAltIndex = nextIdx;
          const lNew = lDef.alts[nextIdx];
          if (lNew == null) continue;
          lDef.word = lNew;
          let lPos = 0;
          for (let i = 0; i < lIdx; i++) {
            const sw = updatedWords[i] || allWords[i];
            const sIdx = newText.indexOf(sw, lPos);
            if (sIdx < 0) break;
            lPos = sIdx + sw.length;
          }
          const lStart = newText.indexOf(allWords[lIdx], lPos);
          if (lStart >= 0) {
            newText = newText.slice(0, lStart) + lNew + newText.slice(lStart + allWords[lIdx].length);
            updatedWords[lIdx] = lNew;
          }
        }
      }
    }

    return { newText, wStart, lenDiff: newText.length - fullText.length, wordDef: def };
  }

  // ─── Control helpers ───────────────────────────────────────────

  getWordDef(index: number): WordDef | undefined {
    return this.words.find(w => w.index === index);
  }

  async controlAction(controlName: string, direction: 1 | -1): Promise<string | null> {
    const control = this.controls.get(controlName);
    if (!control || control.readOnly) return null;
    return direction > 0 ? control.up?.() ?? null : control.down?.() ?? null;
  }

  async controlGet(controlName: string, keyword?: string, context?: string[]): Promise<string | null> {
    const control = this.controls.get(controlName);
    if (!control) return null;
    return control.get(keyword, context);
  }

  clear(): void {
    this.words = [];
    this.spans = {};
    this.consumeAllAlts = null;
    this.dismissedBlanks.clear();
    this.pendingClearOnEdit = null;
    this.lastAnalyzed = [];
    this.pending = false;
    this.notify();
  }
}

export interface CycleResult {
  newText: string;
  wStart: number;
  lenDiff: number;
  wordDef: WordDef | null;
}

export interface StepControl {
  step?: number;
  stepMin?: number;
  stepMax?: number;
  stepFormat?: 'integer' | 'float';
  stepSuffix?: string;
  stepPattern?: string;
  stepSuffixes?: string[];
  stepTip?: string;
}

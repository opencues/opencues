// ConfigLoader — Phase 3 minimum slice.
//
// Reads the static cue tips JSON via the adapter's file-read capability
// and exposes a lowercased lookup map (word → LocalCueLookupResult).
// Phase 3 only wires this to Cycling for up/down navigation.
//
// Future phases will extend ConfigLoader with:
//   - cues.md / blanks.md / controls.md frontmatter parsing
//   - Folder-based cue discovery (needs adapter.readDir)
//   - Hot-reload with debounce
//   - opencues.md state writeback

import type { HostAdapter } from '../adapter';
import {
  buildLookupMap,
  parseLocalCueFile,
  type LocalCueLookupResult,
} from 'cues-core';

export interface ConfigLoaderOptions {
  /** Absolute path to the tips JSON file. Typically ~/.claude/claude-code-tips.json. */
  readonly tipsPath: string;
}

export class ConfigLoader {
  private _cueMap = new Map<string, LocalCueLookupResult>();
  private _loaded = false;

  constructor(
    private adapter: HostAdapter,
    private options: ConfigLoaderOptions,
  ) {}

  /** The lookup map. Empty until load() resolves. */
  get cueMap(): ReadonlyMap<string, LocalCueLookupResult> {
    return this._cueMap;
  }

  get loaded(): boolean {
    return this._loaded;
  }

  /**
   * Read the tips JSON and populate the cue map. Resolves even on failure —
   * logs and leaves the map empty so downstream modules gracefully degrade.
   */
  async load(): Promise<void> {
    if (!this.adapter.capabilities.includes('file-read')) {
      this.adapter.log('warn', 'ConfigLoader: file-read capability missing, cue map stays empty');
      this._loaded = true;
      return;
    }
    let content: string | null;
    try {
      content = await this.adapter.readFile(this.options.tipsPath);
    } catch (err) {
      this.adapter.log('error', 'ConfigLoader: readFile threw', err);
      this._loaded = true;
      return;
    }
    if (content === null) {
      this.adapter.log('info', `ConfigLoader: no tips file at ${this.options.tipsPath}`);
      this._loaded = true;
      return;
    }
    try {
      const data = parseLocalCueFile(content);
      this._cueMap = buildLookupMap(data);
      this.adapter.log('info', `ConfigLoader: loaded ${this._cueMap.size} cue entries`);
    } catch (err) {
      this.adapter.log('error', 'ConfigLoader: parse failed', err);
    }
    this._loaded = true;
  }

  /**
   * Case-insensitive lookup. Returns null if no entry.
   */
  lookup(word: string): LocalCueLookupResult | null {
    return this._cueMap.get(word.toLowerCase()) ?? null;
  }
}

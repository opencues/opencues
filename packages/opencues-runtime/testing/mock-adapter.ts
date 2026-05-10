import {
  AdapterUnsupportedError,
  HOST_ADAPTER_INTERFACE_VERSION,
  type Capability,
  type BlankInvokeSpec,
  type HostAdapter,
  type KeyEvent,
  type KeyFilter,
  type LogLevel,
  type Modifiers,
  type ProcessHandle,
  type ProcessResult,
  type ProcessSpec,
  type Range,
  type RenderContext,
  type RenderDirectives,
  type TextChangeEvent,
  type Unsubscribe,
} from '../src/adapter';

export interface MockAdapterOptions {
  hostName?: string;
  hostVersion?: string;
  capabilities?: readonly Capability[];
  /** If set, setText fires onTextChange synchronously (before returning). Default true. */
  syncTextChange?: boolean;
  cwd?: string;
  /** Seed filesystem (path -> content). Writes go here too. */
  files?: Record<string, string>;
}

interface KeySub {
  filter: KeyFilter | null;
  handler: (e: KeyEvent) => boolean;
}
interface TextSub {
  handler: (e: TextChangeEvent) => void;
}
interface RenderSub {
  handler: (ctx: RenderContext) => RenderDirectives | null;
}

const DEFAULT_CAPS: readonly Capability[] = [
  'shimmer',
  'render-override',
  'dim-ranges',
  'highlight-range',
  'selection',
  'spawn-process',
  'file-read',
  'file-write',
  'force-render',
  'change-source',
];

export interface LogEntry {
  level: LogLevel;
  msg: string;
  data?: unknown;
}

export class MockAdapter implements HostAdapter {
  readonly interfaceVersion = HOST_ADAPTER_INTERFACE_VERSION;
  readonly hostName: string;
  readonly hostVersion: string;
  readonly capabilities: readonly Capability[];
  readonly cwd: string;

  private _text = '';
  private _offset = 0;
  private _selection: Range | null = null;
  private _externalHighlights: readonly RenderContext['externalHighlights'][number][] = [];
  private _files = new Map<string, string>();
  private _disposed = false;
  private _syncTextChange: boolean;

  private _keySubs: KeySub[] = [];
  private _textSubs: TextSub[] = [];
  private _renderSubs: RenderSub[] = [];

  readonly logs: LogEntry[] = [];
  readonly setTextCalls: string[] = [];
  readonly setCursorCalls: number[] = [];
  forceRenderCalls = 0;
  /** Captured blankInvoke specs for assertions. */
  readonly blankInvokeCalls: BlankInvokeSpec[] = [];
  /**
   * Per-blank mock returns. Set via stubBlankInvoke; when set, the
   * matching spec resolves to the supplied stdout. blankName + action
   * pair is the lookup key (e.g. "volume:up", "weather:get").
   */
  private _blankInvokeStubs = new Map<string, string>();

  constructor(opts: MockAdapterOptions = {}) {
    this.hostName = opts.hostName ?? 'mock';
    this.hostVersion = opts.hostVersion ?? '0.0.0';
    this.capabilities = opts.capabilities ?? DEFAULT_CAPS;
    this.cwd = opts.cwd ?? '/mock';
    this._syncTextChange = opts.syncTextChange ?? true;
    for (const [path, content] of Object.entries(opts.files ?? {})) {
      this._files.set(path, content);
    }
  }

  getText(): string { return this._text; }
  getCursorOffset(): number { return this._offset; }
  getSelection(): Range | null {
    if (!this.capabilities.includes('selection')) return null;
    return this._selection;
  }

  setText(text: string): void {
    if (this._disposed) return;
    this.setTextCalls.push(text);
    const prev = this._text;
    this._text = text;
    if (this._offset > text.length) this._offset = text.length;
    const event: TextChangeEvent = {
      text,
      cursorOffset: this._offset,
      previousText: prev,
      source: this.capabilities.includes('change-source') ? 'runtime' : 'unknown',
    };
    if (this._syncTextChange) {
      this._dispatchTextChange(event);
    } else {
      queueMicrotask(() => this._dispatchTextChange(event));
    }
  }

  setCursorOffset(offset: number): void {
    if (this._disposed) return;
    const clamped = Math.max(0, Math.min(offset, this._text.length));
    this.setCursorCalls.push(clamped);
    this._offset = clamped;
  }

  forceRender(): void {
    if (this._disposed) return;
    if (!this.capabilities.includes('force-render')) return;
    this.forceRenderCalls += 1;
    this.fireRender();
  }

  onKey(filter: KeyFilter | null, handler: (e: KeyEvent) => boolean): Unsubscribe {
    const sub: KeySub = { filter, handler };
    this._keySubs.push(sub);
    return () => {
      this._keySubs = this._keySubs.filter(s => s !== sub);
    };
  }
  onTextChange(handler: (e: TextChangeEvent) => void): Unsubscribe {
    const sub: TextSub = { handler };
    this._textSubs.push(sub);
    return () => {
      this._textSubs = this._textSubs.filter(s => s !== sub);
    };
  }
  onRender(handler: (ctx: RenderContext) => RenderDirectives | null): Unsubscribe {
    const sub: RenderSub = { handler };
    this._renderSubs.push(sub);
    return () => {
      this._renderSubs = this._renderSubs.filter(s => s !== sub);
    };
  }

  spawnProcess(spec: ProcessSpec): ProcessHandle {
    if (!this.capabilities.includes('spawn-process')) {
      return {
        result: Promise.reject(new AdapterUnsupportedError('spawn-process')),
        kill: () => {},
      };
    }
    const result: ProcessResult = {
      stdout: `mock(${spec.command} ${spec.args.join(' ')})`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
    return { result: Promise.resolve(result), kill: () => {} };
  }

  /**
   * Register a stub return for a blankInvoke call. Matched on
   * `${blankName}:${action}`. Use `*:action` to match any blank,
   * `blankName:*` to match any action. Tests that don't stub get
   * blankInvoke=undefined behaviour (BlankFill/Cycling fall through
   * to spawnProcess as if blankInvoke wasn't implemented).
   */
  stubBlankInvoke(key: string, stdout: string): void {
    this._blankInvokeStubs.set(key, stdout);
  }

  blankInvoke(spec: BlankInvokeSpec): ProcessHandle | null {
    this.blankInvokeCalls.push(spec);
    if (this._blankInvokeStubs.size === 0) return null;
    const exact = `${spec.blankName}:${spec.action}`;
    const match = this._blankInvokeStubs.get(exact)
      ?? this._blankInvokeStubs.get(`*:${spec.action}`)
      ?? this._blankInvokeStubs.get(`${spec.blankName}:*`);
    if (match === undefined) return null;
    return {
      result: Promise.resolve({ stdout: match, stderr: '', exitCode: 0, timedOut: false }),
      kill: () => {},
    };
  }

  async readFile(path: string): Promise<string | null> {
    if (!this.capabilities.includes('file-read')) return null;
    return this._files.has(path) ? (this._files.get(path) ?? null) : null;
  }

  async readDir(path: string): Promise<readonly { name: string; isDirectory: boolean }[] | null> {
    if (!this.capabilities.includes('file-read')) return null;
    const prefix = path.endsWith('/') ? path : path + '/';
    const direct = new Map<string, boolean>(); // name → isDirectory
    for (const filePath of this._files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        direct.set(rest.slice(0, slash), true);
      } else {
        direct.set(rest, false);
      }
    }
    if (direct.size === 0) return null;
    return [...direct.entries()].map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.capabilities.includes('file-write')) {
      throw new AdapterUnsupportedError('file-write');
    }
    this._files.set(path, content);
  }

  log(level: LogLevel, msg: string, data?: unknown): void {
    this.logs.push({ level, msg, data });
  }

  /** Records of emitted structured events. Tests assert on these to
   *  verify modules publish lifecycle events at the right boundaries. */
  readonly events: Array<{ type: string; body?: Record<string, unknown> }> = [];
  emitEvent(type: string, body?: Record<string, unknown>): void {
    this.events.push({ type, body });
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._keySubs = [];
    this._textSubs = [];
    this._renderSubs = [];
  }

  get disposed(): boolean { return this._disposed; }

  // ─── Test driver helpers ────────────────────────────────────────────────

  fireKey(key: string, modifiers: Partial<Modifiers> = {}): boolean {
    const fullMods: Modifiers = {
      ctrl: !!modifiers.ctrl,
      alt: !!modifiers.alt,
      shift: !!modifiers.shift,
      meta: !!modifiers.meta,
    };
    const event: KeyEvent = {
      key,
      modifiers: fullMods,
      text: this._text,
      cursorOffset: this._offset,
    };
    for (const sub of [...this._keySubs]) {
      if (!keyMatchesFilter(event, sub.filter)) continue;
      let consumed: boolean;
      try {
        consumed = sub.handler(event);
      } catch (err) {
        this.log('error', 'onKey handler threw', err);
        consumed = false;
      }
      if (consumed) return true;
    }
    return false;
  }

  /** Simulate a user edit: updates buffer AND fires onTextChange with source 'user'. */
  pushText(text: string, cursorOffset?: number): void {
    const prev = this._text;
    this._text = text;
    if (cursorOffset !== undefined) this._offset = Math.max(0, Math.min(cursorOffset, text.length));
    else if (this._offset > text.length) this._offset = text.length;
    const event: TextChangeEvent = {
      text,
      cursorOffset: this._offset,
      previousText: prev,
      source: this.capabilities.includes('change-source') ? 'user' : 'unknown',
    };
    this._dispatchTextChange(event);
  }

  fireRender(): RenderDirectives[] {
    const ctx: RenderContext = {
      text: this._text,
      cursor: this._offset,
      externalHighlights: this.capabilities.includes('shimmer') ? this._externalHighlights : [],
    };
    const results: RenderDirectives[] = [];
    for (const sub of [...this._renderSubs]) {
      try {
        const r = sub.handler(ctx);
        if (r) results.push(r);
      } catch (err) {
        this.log('error', 'onRender handler threw', err);
      }
    }
    return results;
  }

  setSelection(range: Range | null): void {
    this._selection = range;
  }

  setExternalHighlights(h: readonly RenderContext['externalHighlights'][number][]): void {
    this._externalHighlights = h;
  }

  private _dispatchTextChange(event: TextChangeEvent): void {
    for (const sub of [...this._textSubs]) {
      try {
        sub.handler(event);
      } catch (err) {
        this.log('error', 'onTextChange handler threw', err);
      }
    }
  }
}

function keyMatchesFilter(event: KeyEvent, filter: KeyFilter | null): boolean {
  if (!filter) return true;
  if (filter.keys && !filter.keys.includes(event.key)) return false;
  if (filter.requireModifiers) {
    for (const m of filter.requireModifiers) {
      if (!event.modifiers[m]) return false;
    }
  }
  if (filter.forbidModifiers) {
    for (const m of filter.forbidModifiers) {
      if (event.modifiers[m]) return false;
    }
  }
  return true;
}

/**
 * Wrap a tips-data JSON object as a minimal CUES.md so ConfigLoader's
 * existing parser flow loads it via its `## Tips` block — no separate
 * `/tips.json` file needed. Test fixture for the post-refactor world
 * where tips come exclusively from CUES.md.
 */
export function wrapTipsAsCuesMd(
  tipsData: unknown,
  frontmatter?: Record<string, string>,
): string {
  const fm = frontmatter
    ? `---\n${Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n`
    : '';
  return `${fm}# tips fixture\n\n## Tips\n\`\`\`json\n${JSON.stringify(tipsData)}\n\`\`\`\n`;
}

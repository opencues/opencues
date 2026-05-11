// Typings for user-shipped JS blanks (`impl: ./blank.js`).
//
// Reference from your blank.js via a JSDoc comment so editors give
// you autocomplete on `ctx` and shape-check your default export:
//
//   /// <reference path="../../user-blank.d.ts" />
//   /** @type {import('./user-blank').UserBlankModule} */
//   export default {
//     async get(ctx, args) { ... return value; },
//   };
//
// Or copy this file next to your blank.js and reference it directly.
//
// The .d.ts has no runtime — the host loads your blank in a
// capability-constrained context (vm.Context on Node, Web Worker in
// chrome) and synthesizes `ctx` at invocation time based on the
// frontmatter declarations in BLANK.md.

/** Capabilities the host injects into `ctx` based on frontmatter. */
export interface BlankContext {
  /**
   * Fetch a URL. Only present when BLANK.md declared `network: [...]`.
   *
   * Throws when:
   *   - the URL's hostname isn't in the declared list (exact match,
   *     no wildcards in v1)
   *   - the protocol isn't http(s)
   *   - the URL is malformed
   */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;

  /**
   * Send a prompt to the runtime's configured LLM. Only present when
   * BLANK.md declared `llm: <provider>`. The provider is fixed at
   * frontmatter time — your code can't pick endpoints, only `model`.
   *
   * Returns the LLM's response text (the `choices[0].message.content`
   * field for OpenAI-shape providers).
   */
  llm?: (opts: {
    prompt: string;
    /** Provider-specific model name. Defaults to the provider's stock model. */
    model?: string;
    /** Hard cap on completion tokens. Default 1024. */
    maxTokens?: number;
  }) => Promise<string>;

  /**
   * Read/write persistent state scoped to this blank's namespace.
   * Only present when BLANK.md declared `storage: <namespace>`.
   *
   * Storage survives across host restarts. Other blanks cannot read
   * this namespace. Values are strings; serialise objects with
   * JSON.stringify / JSON.parse yourself.
   */
  storage?: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
  };

  /** Current time (milliseconds since epoch). Always available. */
  now: () => number;

  /**
   * Append a line to the host's per-blank log. Always available.
   * Levels: 'info' (default), 'warn', 'error'.
   */
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

/** What your default export must look like. */
export interface UserBlankModule {
  /**
   * Fill the `_` slot when the user types your blank's keyword.
   *
   * @param ctx Capability surface (see BlankContext).
   * @param args [keyword, ...contextWords] — same shape built-in
   *             impl: classes receive. For `weather _ paris`, args
   *             is `['weather', 'paris']`.
   * @returns The string to display in the `_`.
   */
  get(ctx: BlankContext, args: readonly string[]): Promise<string> | string;

  /**
   * Apply a value back to the world. Optional — only blanks that
   * cycle through user-typeable values (Ctrl+Alt+Up/Down) need this.
   */
  set?(ctx: BlankContext, value: string, args: readonly string[]): Promise<void> | void;

  /** Cycle to the next value. Optional. */
  up?(ctx: BlankContext): Promise<string> | string;

  /** Cycle to the previous value. Optional. */
  down?(ctx: BlankContext): Promise<string> | string;

  /**
   * When true, set/up/down are ignored even if defined. Renders the
   * blank as display-only (no cycling). Useful for blanks that
   * compute a value but shouldn't be "settable" by the user.
   */
  readOnly?: boolean;
}

// Re-export under both names so JSDoc users can import either.
export type Blank = UserBlankModule;

// User-shipped blank contract — TS/JS modules that ship inside a
// user's `~/.cues/blanks/<name>/blank.js` and run inside a capability-
// constrained context provided by the runtime.
//
// Threat model: a cue pack can put `impl: ./blank.js` in BLANK.md
// and ship its own JS. The runtime loads that JS in an isolated
// context (vm.Context on Node, Web Worker in chrome) and gives it
// only the capabilities the pack DECLARED in frontmatter. Anything
// not declared is `undefined` — `ctx.fetch` won't even exist unless
// the pack asked for `network: [...]`.
//
// Compare:
//   - Figma plugins: same model — iframe + postMessage bridge +
//     allowed_domains in manifest. Best fit for our threat model.
//   - VS Code / Obsidian: NO sandbox; full Node access. Trust comes
//     from a reviewed marketplace.
//   - Chrome extensions: declared permissions, V8 isolate per
//     extension.
//
// We chose Figma's shape because cue packs are not curated and we
// can't rely on marketplace review.

// ─── Frontmatter capability declaration ─────────────────────────────────
//
// In BLANK.md:
//
//   impl: ./blank.js
//   capabilities:
//     network: [api.github.com, hnrss.org]
//     llm: groq
//     storage: github-issues
//
// Each capability the pack does NOT declare is unavailable to the
// blank's code (`ctx.fetch === undefined`, etc.). Authors must list
// EVERY hostname they fetch — wildcards are not allowed in v1.

export interface BlankCapabilities {
  /** Hostnames the blank may fetch from. No wildcards in v1. */
  readonly network?: readonly string[];
  /** When set, ctx.llm() is available and routes through the runtime's
   *  configured LLM client. Value is the provider name (groq, etc.) —
   *  the pack can't pick endpoints, only providers. */
  readonly llm?: string;
  /** When set, ctx.storage.{get,set} are available. The value is the
   *  storage namespace; the blank can't read other namespaces. */
  readonly storage?: string;
}

// ─── BlankContext — the API the user's code sees ────────────────────────

export interface BlankContext {
  /** Fetch a URL. Throws when:
   *   - network capability not declared
   *   - URL's hostname not in the declared allow-list
   *   - URL is not http(s) */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;

  /** Send a prompt to the runtime's configured LLM. The provider was
   *  fixed at frontmatter time; the pack can't override it. */
  llm?: (opts: { prompt: string; model?: string; maxTokens?: number }) => Promise<string>;

  /** Read/write namespaced storage (`<namespace>:<key>`). Persistence
   *  is host-dependent (chrome.storage.local on chrome,
   *  ~/.cues/.user-blank-state/<namespace>.json on native hosts). */
  storage?: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
  };

  /** Current time (ms since epoch). Exposed because Date may be
   *  mocked or unstable inside the isolation context. */
  now: () => number;

  /** Append a line to the per-blank debug log. Routed through the
   *  runtime's logger (level 'info' or 'warn'). */
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

// ─── The blank module contract ──────────────────────────────────────────
//
// User's blank.js looks like:
//
//   export default {
//     async get(ctx, args) { ... return string },
//     async set(ctx, value) { ... }  // optional
//   };
//
// `args` carries the keyword + context words from the user's text
// (the same way the runtime calls the existing impl: classes).
// The function MUST return a string (or a Promise of one).

export interface UserBlankModule {
  /** Auto-populate the `_` slot. Required. */
  readonly get: (ctx: BlankContext, args: readonly string[]) => Promise<string> | string;
  /** Apply a value back to the world. Optional — only blanks that
   *  cycle through values (Ctrl+Alt+Up/Down) need this. */
  readonly set?: (ctx: BlankContext, value: string, args: readonly string[]) => Promise<void> | void;
  /** Cycle to the next value. Optional. */
  readonly up?: (ctx: BlankContext) => Promise<string> | string;
  /** Cycle to the previous value. Optional. */
  readonly down?: (ctx: BlankContext) => Promise<string> | string;
  /** When true, set/up/down are ignored even if defined (display-only). */
  readonly readOnly?: boolean;
}

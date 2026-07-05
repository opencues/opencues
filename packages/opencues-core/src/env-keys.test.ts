/**
 * Tests for existing-key detection (env-keys.ts).
 * Run: node --test dist/env-keys.test.js
 *
 * Hermeticity: every test that touches HOME or a provider env var
 * redirects HOME to a mkdtemp dir and saves/restores the real values —
 * no test may read or write the real ~/.cues/.env or leak env-var
 * mutations (see scripts/check-test-hermeticity.sh).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseEnvFileContent,
  cuesEnvFilePath,
  readCuesEnvFile,
  augmentApiKeysFromEnv,
  buildBootApiKeys,
  detectProviderKeys,
} from './env-keys';
import { listProviders } from './llm-provider';

// Every env var the module can read — cleared before each test, restored after.
const ALL_ENV_KEYS = listProviders().map((p) => p.envKeyName).filter(Boolean);

let tmpHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-env-keys-'));
  savedEnv.HOME = process.env.HOME;
  savedEnv.USERPROFILE = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  delete process.env.USERPROFILE;
  for (const k of ALL_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeEnvFile(content: string): void {
  const dir = path.join(tmpHome, '.cues');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), content, { mode: 0o600 });
}

describe('parseEnvFileContent', () => {
  it('parses KEY=value lines, skipping comments and blanks', () => {
    const parsed = parseEnvFileContent('# comment\n\nGROQ_API_KEY=gsk_abc\nCEREBRAS_API_KEY=csk_def\n');
    assert.deepStrictEqual(parsed, { GROQ_API_KEY: 'gsk_abc', CEREBRAS_API_KEY: 'csk_def' });
  });

  it('accepts export-prefixed lines (users are told they may `source` the file)', () => {
    assert.deepStrictEqual(parseEnvFileContent('export GROQ_API_KEY=gsk_abc'), { GROQ_API_KEY: 'gsk_abc' });
  });

  it('strips matched single/double quotes around the value', () => {
    const parsed = parseEnvFileContent('A="v1"\nB=\'v2\'\nC="unmatched\n');
    assert.deepStrictEqual(parsed, { A: 'v1', B: 'v2', C: '"unmatched' });
  });

  it('handles CRLF line endings', () => {
    assert.deepStrictEqual(parseEnvFileContent('A=1\r\nB=2\r\n'), { A: '1', B: '2' });
  });

  it('ignores lines that are not KEY=value', () => {
    assert.deepStrictEqual(parseEnvFileContent('not a kv line\n=nokey\n1BAD=x\n'), {});
  });
});

describe('cuesEnvFilePath / readCuesEnvFile', () => {
  it('resolves under HOME', () => {
    assert.strictEqual(cuesEnvFilePath(), `${tmpHome}/.cues/.env`);
  });

  it('returns {} when the file is missing', () => {
    assert.deepStrictEqual(readCuesEnvFile(), {});
  });

  it('reads and parses the file when present', () => {
    writeEnvFile('GROQ_API_KEY=gsk_fromfile\n');
    assert.deepStrictEqual(readCuesEnvFile(), { GROQ_API_KEY: 'gsk_fromfile' });
  });
});

describe('augmentApiKeysFromEnv — precedence', () => {
  it('never overwrites an existing bag entry (host keys win)', () => {
    process.env.GROQ_API_KEY = 'gsk_shell';
    const bag: Record<string, string | undefined> = { GROQ_API_KEY: 'gsk_host' };
    const filled = augmentApiKeysFromEnv(bag);
    assert.strictEqual(bag.GROQ_API_KEY, 'gsk_host');
    assert.deepStrictEqual(filled, []);
  });

  it('shell env wins over ~/.cues/.env for the same key', () => {
    process.env.GROQ_API_KEY = 'gsk_shell';
    writeEnvFile('GROQ_API_KEY=gsk_file\n');
    const bag: Record<string, string | undefined> = {};
    const filled = augmentApiKeysFromEnv(bag);
    assert.strictEqual(bag.GROQ_API_KEY, 'gsk_shell');
    assert.deepStrictEqual(filled, [{ envKeyName: 'GROQ_API_KEY', source: 'shell-env' }]);
  });

  it('fills from ~/.cues/.env when the shell env lacks the key', () => {
    writeEnvFile('CEREBRAS_API_KEY=csk_file\n');
    const bag: Record<string, string | undefined> = {};
    const filled = augmentApiKeysFromEnv(bag);
    assert.strictEqual(bag.CEREBRAS_API_KEY, 'csk_file');
    assert.deepStrictEqual(filled, [{ envKeyName: 'CEREBRAS_API_KEY', source: 'env-file' }]);
  });

  it('only fills registry env-key names — unrelated file entries stay out of the bag', () => {
    writeEnvFile('SOME_RANDOM_SECRET=leakme\nGROQ_API_KEY=gsk_file\n');
    const bag: Record<string, string | undefined> = {};
    augmentApiKeysFromEnv(bag);
    assert.strictEqual(bag.SOME_RANDOM_SECRET, undefined);
    assert.strictEqual(bag.GROQ_API_KEY, 'gsk_file');
  });

  it('treats an undefined bag entry as absent (host bootstraps pass undefined for unset vars)', () => {
    writeEnvFile('GROQ_API_KEY=gsk_file\n');
    const bag: Record<string, string | undefined> = { GROQ_API_KEY: undefined };
    augmentApiKeysFromEnv(bag);
    assert.strictEqual(bag.GROQ_API_KEY, 'gsk_file');
  });
});

describe('buildBootApiKeys', () => {
  it('maps the legacy single llmApiKey to GROQ_API_KEY when unset', () => {
    const bag = buildBootApiKeys(undefined, 'gsk_legacy');
    assert.strictEqual(bag.GROQ_API_KEY, 'gsk_legacy');
  });

  it('host llmApiKeys entry beats the legacy key', () => {
    const bag = buildBootApiKeys({ GROQ_API_KEY: 'gsk_host' }, 'gsk_legacy');
    assert.strictEqual(bag.GROQ_API_KEY, 'gsk_host');
  });

  it('logs one summary line naming vars + sources, never values', () => {
    process.env.GROQ_API_KEY = 'gsk_shell_secret';
    writeEnvFile('CEREBRAS_API_KEY=csk_file_secret\n');
    const lines: string[] = [];
    buildBootApiKeys(undefined, undefined, (m) => lines.push(m));
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /GROQ_API_KEY \(shell env\)/);
    assert.match(lines[0], /CEREBRAS_API_KEY \(~\/\.cues\/\.env\)/);
    assert.ok(!lines[0].includes('secret'), 'log line must never contain key material');
  });

  it('stays silent when nothing was augmented', () => {
    const lines: string[] = [];
    buildBootApiKeys({ GROQ_API_KEY: 'gsk_host' }, undefined, (m) => lines.push(m));
    assert.deepStrictEqual(lines, []);
  });
});

describe('detectProviderKeys', () => {
  it('reports one row per env-keyed provider, excluding CLI-transport providers', () => {
    const rows = detectProviderKeys();
    const ids = rows.map((r) => r.providerId);
    assert.ok(ids.includes('groq'));
    assert.ok(ids.includes('cerebras'));
    assert.ok(!ids.includes('claude-code-cli'), 'CLI-transport providers have no env key to detect');
    assert.ok(!ids.includes('openai-subscription'));
  });

  it('labels sources: shell-env beats env-file; unset is null', () => {
    process.env.GROQ_API_KEY = 'gsk_shell';
    writeEnvFile('GROQ_API_KEY=gsk_file\nCEREBRAS_API_KEY=csk_file\n');
    const bySource = Object.fromEntries(detectProviderKeys().map((r) => [r.providerId, r.source]));
    assert.strictEqual(bySource.groq, 'shell-env');
    assert.strictEqual(bySource.cerebras, 'env-file');
    assert.strictEqual(bySource.openai, null);
  });
});

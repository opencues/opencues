import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendAuditLog } from './spawn-sandbox';

describe('appendAuditLog', () => {
  let tmpBase: string;
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-audit-'));
  });
  afterEach(() => { try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* */ } });

  it('writes to the first root when it exists', () => {
    const root = path.join(tmpBase, 'home', '.cues');
    fs.mkdirSync(root, { recursive: true });
    appendAuditLog('opencode', { command: 'bash', args: ['/x.sh', 'get'] }, { exitCode: 0 }, [root]);
    const log = fs.readFileSync(path.join(root, '.opencues-log'), 'utf8');
    expect(log).toMatch(/\topencode\tbash\t\/x\.sh,get\texit=0/);
  });

  it('falls through to the next root when the first does not exist', () => {
    // Mirrors opencode/gemini-cli's getCuesRoots(): cwd-derived path
    // (often non-existent — the fork dir has no `.cues/`) ahead of
    // ~/.cues. Without the fallthrough, log writes silently ENOENT and
    // the security-push SHOULD 4 (log every blankScript invocation)
    // goes unmet on those hosts.
    const missing = path.join(tmpBase, 'opencode-fork', '.cues');
    const real = path.join(tmpBase, 'home', '.cues');
    fs.mkdirSync(real, { recursive: true });
    appendAuditLog('opencode', { command: 'bash', args: ['/x.sh'] }, { exitCode: 0 }, [missing, real]);
    expect(fs.existsSync(path.join(missing, '.opencues-log'))).toBe(false);
    const log = fs.readFileSync(path.join(real, '.opencues-log'), 'utf8');
    expect(log).toContain('opencode');
  });

  it('no-ops silently when no roots exist', () => {
    const missing1 = path.join(tmpBase, 'nope1', '.cues');
    const missing2 = path.join(tmpBase, 'nope2', '.cues');
    expect(() => appendAuditLog('cc', { command: 'bash', args: [] }, { exitCode: 1 }, [missing1, missing2])).not.toThrow();
  });

  it('no-ops silently on empty roots array', () => {
    expect(() => appendAuditLog('cc', { command: 'bash', args: [] }, { exitCode: 1 }, [])).not.toThrow();
  });

  it('records timedOut + durationMs when provided', () => {
    const root = path.join(tmpBase, 'home', '.cues');
    fs.mkdirSync(root, { recursive: true });
    appendAuditLog('cc', { command: 'bash', args: ['/x.sh'] }, { exitCode: 124, timedOut: true }, [root], 5000);
    const log = fs.readFileSync(path.join(root, '.opencues-log'), 'utf8');
    expect(log).toContain('ms=5000');
    expect(log).toContain('timedOut=true');
  });
});

/**
 * locateNewestCCTranscript — the CC boot band's producer-kick locator.
 *
 * CC writes each session to ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl,
 * slug = cwd with every non-alphanumeric char → `-`. This is what lets the CC
 * boot band kick the Stage-A producer directly (like OpenCode/Gemini) instead
 * of depending on the opt-in statusline trigger.
 *
 * Hermetic per the PR #41 pattern: mkdtemp HOME, restored in afterEach.
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { locateNewestCCTranscript } from './boot-common';

let tmpHome = '';
let savedHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencues-cc-loc-'));
  savedHome = process.env['HOME'];
  process.env['HOME'] = tmpHome;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const CWD = '/home/u/proj';
const SLUG = '-home-u-proj';   // CWD with every non-alphanumeric → '-'

function projDir(slug = SLUG): string {
  const d = path.join(tmpHome, '.claude', 'projects', slug);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** Write a .jsonl with a specific mtime (ms since epoch). */
function writeJsonl(dir: string, name: string, ageMs = 0): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

describe('locateNewestCCTranscript', () => {
  it('slugifies the cwd correctly and finds the session transcript', () => {
    const d = projDir();
    const p = writeJsonl(d, 'session-a.jsonl');
    expect(locateNewestCCTranscript(CWD)).toBe(p);
  });

  it('picks the most-recently-modified transcript when several exist', () => {
    const d = projDir();
    writeJsonl(d, 'old.jsonl', 5 * 60_000);       // 5 min ago
    const newest = writeJsonl(d, 'active.jsonl', 1_000);  // 1 s ago
    expect(locateNewestCCTranscript(CWD)).toBe(newest);
  });

  it('skips subagent shards in per-session subdirs (top-level .jsonl only)', () => {
    const d = projDir();
    const main = writeJsonl(d, 'main.jsonl', 2_000);
    const subDir = path.join(d, 'session-x', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    writeJsonl(subDir, 'agent-1.jsonl', 0);        // newer, but in a subdir → ignored
    expect(locateNewestCCTranscript(CWD)).toBe(main);
  });

  it('returns null when the transcript is stale (outside maxAgeMs)', () => {
    const d = projDir();
    writeJsonl(d, 'stale.jsonl', 20 * 60_000);     // 20 min ago > 10 min default
    expect(locateNewestCCTranscript(CWD)).toBeNull();
  });

  it('returns null when the project dir does not exist or no cwd', () => {
    expect(locateNewestCCTranscript(CWD)).toBeNull();   // no dir created
    expect(locateNewestCCTranscript(undefined)).toBeNull();
    expect(locateNewestCCTranscript('')).toBeNull();
  });

  it('scopes to the cwd — a different project dir is not picked', () => {
    const other = projDir('-home-u-other');
    writeJsonl(other, 'other.jsonl', 0);
    expect(locateNewestCCTranscript(CWD)).toBeNull();   // CWD's own dir is empty
  });

  it('ignores non-.jsonl files', () => {
    const d = projDir();
    writeJsonl(d, 'notes.txt', 0);
    fs.writeFileSync(path.join(d, 'x.json'), '{}');
    expect(locateNewestCCTranscript(CWD)).toBeNull();
  });
});

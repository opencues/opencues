import { describe, it, expect } from 'vitest';
import {
  buildSessionCommitmentsSnapshot,
  extractTranscriptTurns,
  extractGeminiTranscriptTurns,
  renderTranscriptForExtraction,
  renderSessionCommitmentsCatalog,
  sessionCommitmentsKey,
  MAX_COMMITMENTS,
  MAX_STATEMENT_LEN,
} from './session-commitments';

describe('buildSessionCommitmentsSnapshot', () => {
  it('assigns stable c<N> ids, overriding producer ids', () => {
    const snap = buildSessionCommitmentsSnapshot([
      { id: 'zzz', category: 'stack', statement: 'Runtime is Bun, not Node' },
      { category: 'constraint', statement: 'Do not add new npm deps' },
    ]);
    expect(snap.commitments.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(snap.commitments[0].category).toBe('stack');
  });

  it('drops empty / non-string / whitespace-only statements', () => {
    const snap = buildSessionCommitmentsSnapshot([
      { statement: '' },
      { statement: '   ' },
      // @ts-expect-error deliberately malformed
      { statement: 42 },
      { statement: 'Keep the plan in CLAUDE.md' },
    ]);
    expect(snap.commitments).toHaveLength(1);
    expect(snap.commitments[0].id).toBe('c1');
  });

  it('normalizes internal whitespace and defaults category to decision', () => {
    const snap = buildSessionCommitmentsSnapshot([{ statement: 'ship\n  behind   a flag' }]);
    expect(snap.commitments[0].statement).toBe('ship behind a flag');
    expect(snap.commitments[0].category).toBe('decision');
  });

  it('drops over-long statements and caps the count', () => {
    const long = 'x'.repeat(MAX_STATEMENT_LEN + 1);
    const many = Array.from({ length: MAX_COMMITMENTS + 5 }, (_, i) => ({ statement: `decision ${i}` }));
    expect(buildSessionCommitmentsSnapshot([{ statement: long }]).commitments).toHaveLength(0);
    expect(buildSessionCommitmentsSnapshot(many).commitments).toHaveLength(MAX_COMMITMENTS);
  });

  it('carries meta through', () => {
    const snap = buildSessionCommitmentsSnapshot([{ statement: 'x' }], { ingestedAt: '2026-08-03T00:00:00Z', sessionId: 'sess1' });
    expect(snap.ingestedAt).toBe('2026-08-03T00:00:00Z');
    expect(snap.sessionId).toBe('sess1');
  });
});

describe('extractTranscriptTurns', () => {
  it('keeps only text blocks from user + assistant, dropping tool noise', () => {
    const jsonl = [
      JSON.stringify({ type: 'summary', summary: 'ignored' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: "let's use Bun" } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'secret reasoning' },
        { type: 'text', text: 'Bun it is.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } },
      ] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', content: 'API_KEY=sk-secret-123' },
        { type: 'text', text: 'now add tests' },
      ] } }),
      'not json at all',
    ].join('\n');
    const turns = extractTranscriptTurns(jsonl);
    expect(turns).toEqual([
      { role: 'user', text: "let's use Bun" },
      { role: 'assistant', text: 'Bun it is.' },
      { role: 'user', text: 'now add tests' },
    ]);
    // no secret / tool payload leaked into any turn
    const all = turns.map((t) => t.text).join(' ');
    expect(all).not.toContain('sk-secret');
    expect(all).not.toContain('rm -rf');
    expect(all).not.toContain('secret reasoning');
  });

  it('is tolerant of empty / malformed input', () => {
    expect(extractTranscriptTurns('')).toEqual([]);
    expect(extractTranscriptTurns('{bad\n{"type":"user"}')).toEqual([]);
  });

  it('strips CC harness framing (slash-command scaffolding, system-reminders)', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-caveat>Caveat: DO NOT respond to this.</local-command-caveat>\n<command-name>/clear</command-name>' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'use Deno <system-reminder>ignore me, injected context</system-reminder> not Node' } }),
    ].join('\n');
    const turns = extractTranscriptTurns(jsonl);
    // The pure-framing turn is dropped entirely; the mixed one keeps only prose.
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe('use Deno not Node');
    const joined = turns.map((t) => t.text).join(' ');
    expect(joined).not.toContain('command-name');
    expect(joined).not.toContain('system-reminder');
    expect(joined).not.toContain('DO NOT respond');
  });
});

describe('extractGeminiTranscriptTurns', () => {
  it('parses JSONL, maps type:gemini→assistant, skips control + non-message lines', () => {
    const jsonl = [
      JSON.stringify({ sessionId: 'x', projectHash: 'y' }),                       // metadata → skip
      JSON.stringify({ type: 'user', content: "let's use Deno" }),                // string content
      JSON.stringify({ $set: { model: 'gemini-3' } }),                            // control → skip
      JSON.stringify({ type: 'gemini', content: [{ text: 'Deno it is.' }] }),     // parts → assistant
      JSON.stringify({ type: 'info', content: 'system note' }),                   // info → skip
      JSON.stringify({ $rewindTo: 'abc' }),                                       // control → skip
    ].join('\n');
    expect(extractGeminiTranscriptTurns(jsonl)).toEqual([
      { role: 'user', text: "let's use Deno" },
      { role: 'assistant', text: 'Deno it is.' },
    ]);
  });
  it('parses the older single-object {messages:[…]} form too', () => {
    const obj = JSON.stringify({ sessionId: 's', messages: [
      { type: 'user', content: 'hello' },
      { type: 'gemini', content: 'hi there' },
    ] });
    expect(extractGeminiTranscriptTurns(obj)).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ]);
  });
});

describe('renderTranscriptForExtraction', () => {
  it('keeps the tail under the char budget', () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({ role: 'user' as const, text: `turn ${i} ${'.'.repeat(100)}` }));
    const out = renderTranscriptForExtraction(turns, 500);
    expect(out.length).toBeLessThanOrEqual(600);
    // the most-recent turn survives; an early one is dropped
    expect(out).toContain('turn 49');
    expect(out).not.toContain('turn 0 ');
  });
});

describe('renderSessionCommitmentsCatalog', () => {
  const snap = buildSessionCommitmentsSnapshot([
    { category: 'stack', statement: 'Runtime is Bun, not Node' },
  ]);

  it('returns empty string when off or empty', () => {
    expect(renderSessionCommitmentsCatalog(snap, 'off')).toBe('');
    expect(renderSessionCommitmentsCatalog(buildSessionCommitmentsSnapshot([]), 'on')).toBe('');
    expect(renderSessionCommitmentsCatalog(undefined, 'on')).toBe('');
  });

  it('renders id + category + statement when on', () => {
    const out = renderSessionCommitmentsCatalog(snap, 'on');
    expect(out).toContain('SESSION COMMITMENTS');
    expect(out).toContain('- c1 [stack]: Runtime is Bun, not Node');
  });
});

describe('sessionCommitmentsKey', () => {
  it('slugifies a cwd path into a filesystem-safe key', () => {
    expect(sessionCommitmentsKey('/home/wilfred/opencues')).toBe('home-wilfred-opencues');
  });

  it('maps distinct cwds to distinct keys (no cross-session clobber)', () => {
    const a = sessionCommitmentsKey('/home/w/projectA');
    const b = sessionCommitmentsKey('/home/w/projectB');
    expect(a).not.toBe(b);
  });

  it('is stable for the same cwd', () => {
    const p = '/tmp/some/repo';
    expect(sessionCommitmentsKey(p)).toBe(sessionCommitmentsKey(p));
  });

  it('falls back to _default for empty/undefined cwd', () => {
    expect(sessionCommitmentsKey(undefined)).toBe('_default');
    expect(sessionCommitmentsKey('')).toBe('_default');
    expect(sessionCommitmentsKey('///')).toBe('_default');
  });

  it('caps key length at 120 chars', () => {
    const long = '/' + 'a'.repeat(500);
    expect(sessionCommitmentsKey(long).length).toBeLessThanOrEqual(120);
  });

  it('collapses non-alphanumeric runs and trims edge separators', () => {
    expect(sessionCommitmentsKey('/foo//bar__baz')).toBe('foo-bar-baz');
  });
});

import {
  mergeSessionCommitments,
  normalizeCommitmentStatement,
  parseSupersededResult,
} from './session-commitments';

describe('mergeSessionCommitments (incremental distillation)', () => {
  const c = (statement: string, category = 'decision') => ({ category, statement });

  it('preserves prior decisions that fell out of the fresh tail (the recall fix)', () => {
    const prior = [c('Runtime is Bun, not Node'), c('Do not add new npm dependencies')];
    const fresh = [c('Ship behind an off-by-default flag')];   // tail only saw recent turns
    const m = mergeSessionCommitments(prior, fresh, []);
    const stmts = m.map((x) => x.statement);
    expect(stmts).toContain('Runtime is Bun, not Node');       // early decision survives
    expect(stmts).toContain('Do not add new npm dependencies');
    expect(stmts).toContain('Ship behind an off-by-default flag');
    expect(m).toHaveLength(3);
  });

  it('dedups restatements (fresh phrasing wins) so accumulation does not bloat', () => {
    const prior = [c('Use Bun.')];
    const fresh = [c('Use Bun', 'stack')];
    const m = mergeSessionCommitments(prior, fresh, []);
    expect(m).toHaveLength(1);
    expect(m[0].category).toBe('stack');   // fresh wins on the dup
  });

  it('drops a superseded prior decision so the matcher cannot false-alarm on the new one', () => {
    const prior = [c('Use Postgres for the store'), c('Log to stdout')];
    const fresh = [c('Switch the store to SQLite')];
    const m = mergeSessionCommitments(prior, fresh, ['Use Postgres for the store']);
    const stmts = m.map((x) => x.statement);
    expect(stmts).not.toContain('Use Postgres for the store');  // superseded → gone
    expect(stmts).toContain('Switch the store to SQLite');       // replacement kept
    expect(stmts).toContain('Log to stdout');                    // unrelated preserved
  });

  it('supersession matching is normalization-tolerant', () => {
    const prior = [c('Use Postgres for the store.')];
    const fresh = [c('Move to SQLite')];
    const m = mergeSessionCommitments(prior, fresh, ['use postgres for the store']);
    expect(m.map((x) => x.statement)).not.toContain('Use Postgres for the store.');
  });

  it('an empty fresh tick preserves the whole prior watchlist (no wipe)', () => {
    const prior = [c('Runtime is Bun, not Node'), c('Only touch the cache module')];
    expect(mergeSessionCommitments(prior, [], [])).toHaveLength(2);
  });

  it('caps at MAX_COMMITMENTS, keeping fresh (newest) first', () => {
    const prior = Array.from({ length: 24 }, (_, i) => c(`old decision ${i}`));
    const fresh = [c('brand new decision')];
    const m = mergeSessionCommitments(prior, fresh, []);
    expect(m.length).toBe(24);
    expect(m[0].statement).toBe('brand new decision');   // fresh survives the cap
  });
});

describe('normalizeCommitmentStatement', () => {
  it('collapses case/punctuation/whitespace', () => {
    expect(normalizeCommitmentStatement('Use  Bun, not Node.')).toBe('use bun not node');
    expect(normalizeCommitmentStatement('use bun not node')).toBe('use bun not node');
  });
});

describe('parseSupersededResult', () => {
  it('parses {superseded:[…]} and bare arrays; tolerates junk', () => {
    expect(parseSupersededResult('{"superseded":["a","b"]}')).toEqual(['a', 'b']);
    expect(parseSupersededResult('here: ["x"]')).toEqual(['x']);
    expect(parseSupersededResult('no json')).toEqual([]);
    expect(parseSupersededResult('')).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  buildSessionCommitmentsSnapshot,
  extractTranscriptTurns,
  renderTranscriptForExtraction,
  renderSessionCommitmentsCatalog,
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

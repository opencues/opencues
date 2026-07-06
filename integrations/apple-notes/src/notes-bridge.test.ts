import { describe, expect, it } from 'vitest';
import { NotesBridge, classifyError, type RunOutcome, type Runner } from './notes-bridge';

const outcome = (partial: Partial<RunOutcome>): RunOutcome => ({
  code: 0, stdout: '', stderr: '', timedOut: false, ...partial,
});

const stubRunner = (result: RunOutcome, calls?: Array<{ script: string; args: readonly string[]; stdin?: string }>): Runner =>
  async (scriptPath, args, stdinData) => {
    calls?.push({ script: scriptPath, args, stdin: stdinData });
    return result;
  };

describe('classifyError', () => {
  it('maps -1743 to permission-denied', () => {
    expect(classifyError(outcome({ code: 1, stderr: 'execution error: Error: An error occurred. (-1743)' })))
      .toBe('permission-denied');
  });
  it('maps -1728 to not-found', () => {
    expect(classifyError(outcome({ code: 1, stderr: "Can't get object. (-1728)" }))).toBe('not-found');
  });
  it('maps kills to timeout', () => {
    expect(classifyError(outcome({ code: null, timedOut: true }))).toBe('timeout');
  });
  it('everything else is osascript-failed', () => {
    expect(classifyError(outcome({ code: 1, stderr: 'SyntaxError' }))).toBe('osascript-failed');
  });
});

describe('NotesBridge', () => {
  it('parses JSON stdout on success', async () => {
    const bridge = new NotesBridge('/jxa', stubRunner(outcome({ stdout: '{"running":true}\n' })));
    const res = await bridge.status();
    expect(res).toEqual({ ok: true, value: { running: true } });
  });

  it('classifies a cached TCC deny', async () => {
    const bridge = new NotesBridge('/jxa', stubRunner(outcome({ code: 1, stderr: '(-1743)' })));
    const res = await bridge.listNotes();
    expect(res).toMatchObject({ ok: false, kind: 'permission-denied' });
  });

  it('flags unparseable stdout instead of throwing', async () => {
    const bridge = new NotesBridge('/jxa', stubRunner(outcome({ stdout: 'not json' })));
    const res = await bridge.status();
    expect(res).toMatchObject({ ok: false, kind: 'osascript-failed' });
  });

  it('sends fill payloads over stdin, not argv', async () => {
    const calls: Array<{ script: string; args: readonly string[]; stdin?: string }> = [];
    const bridge = new NotesBridge('/jxa', stubRunner(outcome({ stdout: '{"ok":true,"plaintext":"x"}' }), calls));
    await bridge.fillNote({ noteId: 'n1', expectedBody: '<div>a</div>', newBody: '<div>b</div>' });
    expect(calls[0].script).toContain('fill-note.js');
    expect(calls[0].args).toEqual([]);
    expect(JSON.parse(calls[0].stdin!)).toMatchObject({ noteId: 'n1' });
  });

  it('passes id lists as a single JSON argv to fetch-plaintexts', async () => {
    const calls: Array<{ script: string; args: readonly string[] }> = [];
    const bridge = new NotesBridge('/jxa', stubRunner(outcome({ stdout: '{"notes":[]}' }), calls));
    await bridge.fetchPlaintexts(['a', 'b']);
    expect(calls[0].args).toEqual(['["a","b"]']);
  });
});

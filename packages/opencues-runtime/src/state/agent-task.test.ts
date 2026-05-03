import { describe, it, expect } from 'vitest';
import { AgentTaskState, hashWordText } from './agent-task';

describe('AgentTaskState', () => {
  it('starts unarmed', () => {
    const s = new AgentTaskState();
    expect(s.armed).toBe(false);
    expect(s.taskId).toBeNull();
    expect(s.prompt).toBe('');
  });

  it('arm() sets prompt and generates a taskId', () => {
    const s = new AgentTaskState();
    s.arm('correct spelling');
    expect(s.armed).toBe(true);
    expect(s.prompt).toBe('correct spelling');
    expect(s.taskId).toBeTruthy();
  });

  it('arm() trims whitespace', () => {
    const s = new AgentTaskState();
    s.arm('  correct spelling  ');
    expect(s.prompt).toBe('correct spelling');
  });

  it('appendToPrompt() joins with " AND "', () => {
    const s = new AgentTaskState();
    s.arm('correct spelling');
    s.appendToPrompt('fix humour');
    expect(s.prompt).toBe('correct spelling AND fix humour');
  });

  it('appendToPrompt() is no-op when no task armed', () => {
    const s = new AgentTaskState();
    s.appendToPrompt('fix humour');
    expect(s.armed).toBe(false);
    expect(s.prompt).toBe('');
  });

  it('appendToPrompt() generates a new taskId', () => {
    const s = new AgentTaskState();
    s.arm('correct spelling');
    const id1 = s.taskId;
    s.appendToPrompt('fix humour');
    const id2 = s.taskId;
    expect(id1).not.toBe(id2);
  });

  it('stop() resets everything', () => {
    const s = new AgentTaskState();
    s.arm('correct spelling');
    s.recordEvaluation(0, 'hash');
    s.stop();
    expect(s.armed).toBe(false);
    expect(s.taskId).toBeNull();
    expect(s.prompt).toBe('');
    expect(s.evaluationCount()).toBe(0);
  });

  describe('per-task evaluation invalidation', () => {
    it('records and recalls evaluations under the current task', () => {
      const s = new AgentTaskState();
      s.arm('correct spelling');
      s.recordEvaluation(0, 'aaa');
      expect(s.isEvaluated(0, 'aaa')).toBe(true);
    });

    it('rejects evaluations when text hash differs', () => {
      const s = new AgentTaskState();
      s.arm('correct spelling');
      s.recordEvaluation(0, 'aaa');
      expect(s.isEvaluated(0, 'bbb')).toBe(false);
    });

    it('arm() clears all evaluations even if the prompt is the same', () => {
      const s = new AgentTaskState();
      s.arm('correct spelling');
      s.recordEvaluation(0, 'aaa');
      s.arm('correct spelling');  // re-arm with same prompt
      expect(s.isEvaluated(0, 'aaa')).toBe(false);
      expect(s.evaluationCount()).toBe(0);
    });

    it('appendToPrompt() invalidates all prior evaluations (taskId changed)', () => {
      const s = new AgentTaskState();
      s.arm('correct spelling');
      s.recordEvaluation(0, 'aaa');
      s.recordEvaluation(1, 'bbb');
      s.recordEvaluation(2, 'ccc');
      expect(s.evaluationCount()).toBe(3);

      s.appendToPrompt('fix humour');

      // taskId regenerated → all old evaluations stale → cache cleared
      expect(s.isEvaluated(0, 'aaa')).toBe(false);
      expect(s.isEvaluated(1, 'bbb')).toBe(false);
      expect(s.isEvaluated(2, 'ccc')).toBe(false);
      expect(s.evaluationCount()).toBe(0);
    });

    it('isEvaluated returns false when no task is armed', () => {
      const s = new AgentTaskState();
      expect(s.isEvaluated(0, 'aaa')).toBe(false);
    });

    it('recordEvaluation is no-op when no task is armed', () => {
      const s = new AgentTaskState();
      s.recordEvaluation(0, 'aaa');
      expect(s.evaluationCount()).toBe(0);
    });

    it('forgetEvaluation drops a single entry', () => {
      const s = new AgentTaskState();
      s.arm('correct spelling');
      s.recordEvaluation(0, 'aaa');
      s.recordEvaluation(1, 'bbb');
      s.forgetEvaluation(0);
      expect(s.isEvaluated(0, 'aaa')).toBe(false);
      expect(s.isEvaluated(1, 'bbb')).toBe(true);
    });
  });

  describe('hashWordText', () => {
    it('same text produces same hash', () => {
      expect(hashWordText('hello')).toBe(hashWordText('hello'));
    });

    it('different text produces different hash', () => {
      expect(hashWordText('hello')).not.toBe(hashWordText('world'));
    });

    it('case-sensitive', () => {
      expect(hashWordText('Hello')).not.toBe(hashWordText('hello'));
    });

    it('handles empty string', () => {
      expect(hashWordText('')).toBeTruthy();
    });
  });
});

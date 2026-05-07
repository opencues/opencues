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

  describe('anti-oscillation: edit signatures', () => {
    it('records a signature; the SAME signature is detected as a non-inversion', () => {
      const s = new AgentTaskState();
      s.arm('any');
      s.recordEditSignature('Later', 'Later,');
      // Same direction is NOT an inversion of itself.
      expect(s.wouldInvertRecent('Later', 'Later,')).toBe(false);
    });

    it('detects an inverse edit (the comma flip-flop)', () => {
      const s = new AgentTaskState();
      s.arm('any');
      s.recordEditSignature('Later', 'Later,');
      // Inverse direction is flagged.
      expect(s.wouldInvertRecent('Later,', 'Later')).toBe(true);
    });

    it('non-inverse edits are NOT flagged (different originalWord)', () => {
      const s = new AgentTaskState();
      s.arm('any');
      s.recordEditSignature('Later', 'Later,');
      // Unrelated word — no inversion.
      expect(s.wouldInvertRecent('Hello', 'Hi')).toBe(false);
    });

    it('non-inverse edits with same originalWord but different editedWord NOT flagged', () => {
      const s = new AgentTaskState();
      s.arm('any');
      s.recordEditSignature('Later', 'Later,');
      // originalWord matches but editedWord doesn't.
      expect(s.wouldInvertRecent('Later,', 'Soon')).toBe(false);
    });

    it('arm() clears signatures (a fresh task is allowed to undo prior decisions)', () => {
      const s = new AgentTaskState();
      s.arm('any');
      s.recordEditSignature('Later', 'Later,');
      s.arm('totally different task');
      expect(s.wouldInvertRecent('Later,', 'Later')).toBe(false);
    });

    it('appendToPrompt() KEEPS signatures (oscillation often happens across ADD)', () => {
      // The whole point of the guard: ADD freshens the cache so the LLM
      // re-evaluates settled words and may flip its prior verdict. The
      // signatures must survive the ADD to catch that flip.
      const s = new AgentTaskState();
      s.arm('correct spelling');
      s.recordEditSignature('Later', 'Later,');
      s.appendToPrompt('fix punctuation');
      expect(s.wouldInvertRecent('Later,', 'Later')).toBe(true);
    });

    it('stop() clears signatures', () => {
      const s = new AgentTaskState();
      s.arm('any');
      s.recordEditSignature('Later', 'Later,');
      s.stop();
      // Even if a new task is armed later, prior signatures don't carry over.
      s.arm('new task');
      expect(s.wouldInvertRecent('Later,', 'Later')).toBe(false);
    });

    it('DELETE edits (editedWord === "") are NOT recorded as signatures', () => {
      const s = new AgentTaskState();
      s.arm('any');
      s.recordEditSignature('the', '');
      // Inverse would be inserting "the" — never an LLM-emitted edit.
      // Confirm we didn't accidentally record the DELETE direction.
      expect(s.wouldInvertRecent('', 'the')).toBe(false);
    });

    it('wouldInvertRecent ignores DELETE edits as proposed edit too', () => {
      const s = new AgentTaskState();
      s.arm('any');
      s.recordEditSignature('the', 'a');
      // A proposed DELETE of 'a' → '' is not an inversion of 'the' → 'a'.
      expect(s.wouldInvertRecent('a', '')).toBe(false);
    });

    it('recordEditSignature is no-op when no task is armed', () => {
      const s = new AgentTaskState();
      s.recordEditSignature('Later', 'Later,');
      expect(s.wouldInvertRecent('Later,', 'Later')).toBe(false);
    });

    it('multi-word originalWord/editedWord (range edits) work the same way', () => {
      const s = new AgentTaskState();
      s.arm('any');
      s.recordEditSignature('any way', 'anyway');
      expect(s.wouldInvertRecent('anyway', 'any way')).toBe(true);
      expect(s.wouldInvertRecent('any way', 'anyway')).toBe(false);   // same direction
    });

    it('signature buffer is bounded; oldest entries drop on overflow', () => {
      const s = new AgentTaskState();
      s.arm('any');
      // Fill buffer with 64 unique signatures
      for (let i = 0; i < 64; i += 1) {
        s.recordEditSignature(`word${i}`, `edit${i}`);
      }
      // The first signature still detects.
      expect(s.wouldInvertRecent('edit0', 'word0')).toBe(true);
      // Add one more — should evict word0's signature.
      s.recordEditSignature('newWord', 'newEdit');
      expect(s.wouldInvertRecent('edit0', 'word0')).toBe(false);
      // The just-added one is detectable.
      expect(s.wouldInvertRecent('newEdit', 'newWord')).toBe(true);
    });

    it('duplicate recordEditSignature calls do not double-fill the buffer', () => {
      const s = new AgentTaskState();
      s.arm('any');
      // Same edit applied twice in a row (e.g. retry mode + apply).
      s.recordEditSignature('Later', 'Later,');
      s.recordEditSignature('Later', 'Later,');
      // Add 63 unique others — Later→Later, should still be detectable
      // because dedupe didn't allow it to count twice.
      for (let i = 0; i < 63; i += 1) {
        s.recordEditSignature(`w${i}`, `e${i}`);
      }
      expect(s.wouldInvertRecent('Later,', 'Later')).toBe(true);
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

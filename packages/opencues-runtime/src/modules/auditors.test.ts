/**
 * Tests for auditor composition: ConfigLoader.composeAuditorPrompts()
 * runs the priority sort + disable filter, and AgentRewrite hands the
 * composed list to the LLM as one concatenated system prompt.
 */
import { describe, it, expect } from 'vitest';
import { ConfigLoader } from './config-loader';
import { MockAdapter } from '../../testing/mock-adapter';

describe('ConfigLoader.composeAuditorPrompts', () => {
  it('returns enabled auditors sorted by priority desc, alphabetical for ties', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/.cues/auditors/grammar/AUDITOR.md':
          `---\nname: grammar\npriority: 50\n---\n\nGrammar prompt.`,
        '/proj/.cues/auditors/clarity/AUDITOR.md':
          `---\nname: clarity\npriority: 60\n---\n\nClarity prompt.`,
        '/proj/.cues/auditors/jargon/AUDITOR.md':
          `---\nname: jargon\npriority: 50\n---\n\nJargon prompt.`,
      },
    });
    const loader = new ConfigLoader(adapter, { configSearchPaths: ['/proj/.cues'] });
    await loader.load();
    const composed = loader.composeAuditorPrompts();
    // clarity (priority 60) first, then grammar + jargon tied at 50 — alphabetical for ties.
    expect(composed.map(a => a.name)).toEqual(['clarity', 'grammar', 'jargon']);
  });

  it('skips auditors with enabled: false', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/.cues/auditors/grammar/AUDITOR.md':
          `---\nname: grammar\n---\n\nGrammar prompt.`,
        '/proj/.cues/auditors/disabled/AUDITOR.md':
          `---\nname: disabled\nenabled: false\n---\n\nDisabled prompt.`,
      },
    });
    const loader = new ConfigLoader(adapter, { configSearchPaths: ['/proj/.cues'] });
    await loader.load();
    const composed = loader.composeAuditorPrompts();
    expect(composed.map(a => a.name)).toEqual(['grammar']);
  });

  it('skips auditors named in AUDITORS.md disable: list', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/.cues/AUDITORS.md':
          `---\nname: project-auditors\ndisable: [grammar]\n---\n`,
        '/proj/.cues/auditors/grammar/AUDITOR.md':
          `---\nname: grammar\n---\n\nGrammar prompt.`,
        '/proj/.cues/auditors/clarity/AUDITOR.md':
          `---\nname: clarity\n---\n\nClarity prompt.`,
      },
    });
    const loader = new ConfigLoader(adapter, { configSearchPaths: ['/proj/.cues'] });
    await loader.load();
    const composed = loader.composeAuditorPrompts();
    // grammar is disabled at this layer; clarity remains.
    expect(composed.map(a => a.name)).toEqual(['clarity']);
  });

  it('returns empty list when no auditors are present', async () => {
    const adapter = new MockAdapter({ cwd: '/proj', files: {} });
    const loader = new ConfigLoader(adapter, { configSearchPaths: ['/proj/.cues'] });
    await loader.load();
    expect(loader.composeAuditorPrompts()).toEqual([]);
  });

  it('exposes the body verbatim as promptText', async () => {
    const body = `Body line 1.\n\nBody line 2 with more detail.`;
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/.cues/auditors/x/AUDITOR.md': `---\nname: x\n---\n\n${body}`,
      },
    });
    const loader = new ConfigLoader(adapter, { configSearchPaths: ['/proj/.cues'] });
    await loader.load();
    const composed = loader.composeAuditorPrompts();
    expect(composed[0].promptText.trim()).toBe(body);
  });
});

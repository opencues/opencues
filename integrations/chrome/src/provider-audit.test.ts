import { describe, expect, it } from 'vitest';
import { llmProviderDirectives } from './provider-audit';

describe('llmProviderDirectives', () => {
  it('reads the chat provider lines and leaves decisions-provider out', () => {
    const fm = ['llm-provider: zorbai', 'cues-llm-provider: inherit', 'decisions-provider: typesafe', 'voice-mode: inactive'].join('\n');
    expect(llmProviderDirectives(fm)).toEqual([
      { feature: 'llm', provider: 'zorbai' },
      { feature: 'cues-llm', provider: 'inherit' },
    ]);
  });
  it('a bare provider: line is the global one', () => {
    expect(llmProviderDirectives('provider: zorbai')).toEqual([{ feature: 'global', provider: 'zorbai' }]);
  });
});

import { describe, expect, it } from 'vitest';
import { ConfigLoader } from './config-loader';
import { MockAdapter } from '../../testing/mock-adapter';

const SAMPLE_TIPS = JSON.stringify({
  domain: 'test',
  version: 1,
  concepts: [
    {
      id: 'greetings',
      words: {
        hello: { tip: 'say hi', alts: ['hi', 'hey', 'howdy'] },
        fast: { tip: 'moving quickly', alts: ['quick', 'rapid', 'swift'] },
      },
    },
  ],
});

describe('ConfigLoader', () => {
  it('loads tips JSON and builds a case-insensitive lookup', async () => {
    const adapter = new MockAdapter({ files: { '/tips.json': SAMPLE_TIPS } });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();

    expect(loader.loaded).toBe(true);
    expect(loader.cueMap.size).toBeGreaterThan(0);

    const hello = loader.lookup('hello');
    expect(hello).not.toBeNull();
    expect(hello!.alternatives).toContain('hi');

    // Case-insensitive
    expect(loader.lookup('HELLO')).not.toBeNull();
    expect(loader.lookup('Fast')?.alternatives).toContain('quick');
  });

  it('resolves gracefully when tips file is missing', async () => {
    const adapter = new MockAdapter({ files: {} });
    const loader = new ConfigLoader(adapter, { tipsPath: '/missing.json' });
    await loader.load();
    expect(loader.loaded).toBe(true);
    expect(loader.cueMap.size).toBe(0);
    expect(loader.lookup('hello')).toBeNull();
    expect(adapter.logs.some(l => /no tips file/.test(l.msg))).toBe(true);
  });

  it('leaves map empty on parse failure, logs error', async () => {
    const adapter = new MockAdapter({ files: { '/bad.json': 'not valid json{{{' } });
    const loader = new ConfigLoader(adapter, { tipsPath: '/bad.json' });
    await loader.load();
    expect(loader.loaded).toBe(true);
    expect(loader.cueMap.size).toBe(0);
    expect(adapter.logs.some(l => l.level === 'error' && /parse failed/.test(l.msg))).toBe(true);
  });

  it('returns null from lookup when file-read capability absent', async () => {
    const adapter = new MockAdapter({ capabilities: [] });
    const loader = new ConfigLoader(adapter, { tipsPath: '/tips.json' });
    await loader.load();
    expect(loader.cueMap.size).toBe(0);
    expect(adapter.logs.some(l => /file-read capability missing/.test(l.msg))).toBe(true);
  });
});

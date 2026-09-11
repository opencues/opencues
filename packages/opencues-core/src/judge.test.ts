import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CompletenessJudge } from './judge';
import { getProvider } from './llm-provider';
import type { HttpAdapter } from './types';

function adapter(reply: string | Error) {
  let calls = 0;
  const http: HttpAdapter = { post: async () => { calls++; if (reply instanceof Error) throw reply; return JSON.stringify({ choices: [{ message: { content: reply } }] }); } };
  return { http, calls: () => calls };
}
const base = { provider: getProvider('groq')!, apiKey: 'k', model: 'm' };

describe('CompletenessJudge — one tiny call, cached on the trimmed text, fails open', () => {
  it('YES / NO are read from the first word; the verdict is cached on the trimmed text', async () => {
    const { http, calls } = adapter('NO');
    const j = new CompletenessJudge({ ...base, httpAdapter: http });
    assert.strictEqual(await j.judge('the zorb is'), false);
    assert.strictEqual(await j.judge('the zorb is  '), false);   // trailing whitespace: same key
    assert.strictEqual(calls(), 1);
    assert.deepStrictEqual({ calls: j.stats.calls, hits: j.stats.hits }, { calls: 1, hits: 1 });
  });
  it('an unreadable answer or an error is a YES — the fan-out runs, a cue is never lost to the judge', async () => {
    const odd = new CompletenessJudge({ ...base, httpAdapter: adapter('maybe').http });
    assert.strictEqual(await odd.judge('zorb'), true);
    const down = new CompletenessJudge({ ...base, httpAdapter: adapter(new Error('network down')).http });
    assert.strictEqual(await down.judge('zorb'), true);
    assert.strictEqual(down.stats.errors, 1);
  });
  it('an empty draft is NO without a call; a repeated in-flight draft shares one call', async () => {
    const { http, calls } = adapter('YES');
    const j = new CompletenessJudge({ ...base, httpAdapter: http });
    assert.strictEqual(await j.judge('   '), false);
    const [a, b] = await Promise.all([j.judge('the zorb'), j.judge('the zorb')]);
    assert.deepStrictEqual([a, b, calls()], [true, true, 1]);
  });
});

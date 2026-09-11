import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { SentenceCallCache } from './sentence-call-cache';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SentenceCallCache — per-sentence answers reused, in-flight calls joined, never aborted while wanted', () => {
  it('a completed answer is reused on the exact key; another key dispatches; an empty answer is cached too', async () => {
    const c = new SentenceCallCache<string[] | null>();
    let runs = 0;
    const run = async () => { runs++; return runs === 1 ? ['ALT-ONE'] : null; };
    assert.deepStrictEqual(await c.get('zorb one', undefined, run), ['ALT-ONE']);
    assert.deepStrictEqual(await c.get('zorb one', undefined, run), ['ALT-ONE']);
    assert.strictEqual(runs, 1);
    assert.strictEqual(await c.get('zorb two', undefined, run), null);
    assert.strictEqual(await c.get('zorb two', undefined, run), null);   // null is an answer, not a miss
    assert.strictEqual(runs, 2);
    assert.deepStrictEqual(c.takeStats(), { hits: 2, joined: 0, dispatched: 2 });
  });
  it('an error is never cached — the next pass asks again', async () => {
    const c = new SentenceCallCache<string>();
    let runs = 0;
    const run = async () => { runs++; if (runs === 1) throw new Error('network down'); return 'ok'; };
    await assert.rejects(c.get('k', undefined, run), /network down/);
    assert.strictEqual(await c.get('k', undefined, run), 'ok');
    assert.strictEqual(runs, 2);
  });
  it('a superseding pass JOINS the in-flight call; the first pass aborting does not abort the call', async () => {
    const c = new SentenceCallCache<string>();
    let seenSignal: AbortSignal | undefined; let resolveRun!: (v: string) => void;
    const run = (signal: AbortSignal) => { seenSignal = signal; return new Promise<string>((r) => { resolveRun = r; }); };
    const pass1 = new AbortController(), pass2 = new AbortController();
    const p1 = c.get('k', pass1.signal, run);
    await tick();
    const p2 = c.get('k', pass2.signal, run);   // joins
    await tick();
    pass1.abort();
    await assert.rejects(p1, { name: 'AbortError' });
    assert.strictEqual(seenSignal!.aborted, false);      // pass 2 still wants it
    resolveRun('ALT-ONE');
    assert.strictEqual(await p2, 'ALT-ONE');
    assert.deepStrictEqual(c.takeStats(), { hits: 0, joined: 1, dispatched: 1 });
    assert.strictEqual(await c.get('k', undefined, run), 'ALT-ONE');   // and it was cached
  });
  it('the call IS aborted once no pass wants it, and nothing is cached', async () => {
    const c = new SentenceCallCache<string>();
    let seenSignal: AbortSignal | undefined;
    const run = (signal: AbortSignal) => { seenSignal = signal; return new Promise<string>((_, rej) => { signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }); };
    const pass = new AbortController();
    const p = c.get('k', pass.signal, run);
    await tick();
    pass.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.strictEqual(seenSignal!.aborted, true);
    await tick();
    assert.strictEqual(c.size, 0);
  });
  it('is bounded: the oldest key is evicted past the cap', async () => {
    const c = new SentenceCallCache<number>(2);
    await c.get('a', undefined, async () => 1); await c.get('b', undefined, async () => 2); await c.get('c', undefined, async () => 3);
    assert.strictEqual(c.size, 2);
    let runs = 0;
    await c.get('a', undefined, async () => { runs++; return 1; });
    assert.strictEqual(runs, 1);   // 'a' was evicted
  });
});

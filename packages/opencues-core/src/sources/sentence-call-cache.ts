/**
 * Per-sentence LLM call cache with in-flight sharing.
 *
 * The resolver re-runs every sentence-scope source on the whole buffer at
 * each pause and aborts the previous pass's calls. On a multi-sentence draft
 * that re-sends every sentence that did not change (a third of all sentence
 * calls in the 2026-09 log) and throws away calls for sentences the person
 * has finished. This cache does two things, both keyed on the EXACT LLM
 * input so any change to the system prompt or the sentence is a miss:
 *
 *  - a completed answer is reused (LRU, positive AND empty answers — an
 *    error is never stored, the same rule as `RoutedWordSourceGroup`);
 *  - an in-flight call is JOINED by a later pass instead of aborted; the
 *    call is aborted only when no pass still wants it.
 *
 * Lifetime is the source instance — the resolver rebuilds sources on any
 * config change, which drops the cache with them.
 */
export class SentenceCallCache<T> {
  private readonly done = new Map<string, T>();
  private readonly inflight = new Map<string, { promise: Promise<T>; controller: AbortController; waiters: number }>();
  readonly stats = { hits: 0, joined: 0, dispatched: 0 };
  constructor(private readonly max = 128) {}

  /** Snapshot-and-reset the counters (for a per-pass log line). */
  takeStats(): { hits: number; joined: number; dispatched: number } {
    const s = { ...this.stats };
    this.stats.hits = 0; this.stats.joined = 0; this.stats.dispatched = 0;
    return s;
  }

  get size(): number { return this.done.size; }

  async get(key: string, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.done.has(key)) {
      const v = this.done.get(key) as T;
      this.done.delete(key); this.done.set(key, v);   // LRU recency
      this.stats.hits++;
      return v;
    }
    if (signal?.aborted) throw abortError();
    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = run(controller.signal).then((v) => { this.done.set(key, v); this.trim(); return v; });
      promise.catch(() => { /* observed by the waiters that are still attached; a fully-abandoned call must not be an unhandled rejection */ });
      void promise.finally(() => { this.inflight.delete(key); }).catch(() => { /* same */ });
      entry = { promise, controller, waiters: 0 };
      this.inflight.set(key, entry);
      this.stats.dispatched++;
    } else {
      this.stats.joined++;
    }
    const e = entry;
    e.waiters++;
    let detached = false;
    const detach = () => { if (detached) return; detached = true; e.waiters--; if (e.waiters <= 0) e.controller.abort(); };
    if (!signal) { try { return await e.promise; } finally { detached = true; e.waiters--; } }
    // Race the shared call against THIS pass's abort: when the pass is
    // superseded the caller returns at once; the call itself lives on while
    // another pass still wants it.
    const abortP = new Promise<never>((_, reject) => { signal.addEventListener('abort', () => { detach(); reject(abortError()); }, { once: true }); });
    try {
      return await Promise.race([e.promise, abortP]);
    } finally {
      if (!detached) { detached = true; e.waiters--; }
    }
  }

  private trim(): void {
    while (this.done.size > this.max) {
      const oldest = this.done.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.done.delete(oldest);
    }
  }
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

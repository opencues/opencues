/**
 * Refresh scheduler — ONE system tick that asks every registered
 * refreshable resource "are you due?" and refreshes the ones that are.
 *
 * The inversion this exists for (July 2026, Wilfred's framing): nothing
 * "calls" a sync — resources DECLARE themselves refreshable with a due
 * predicate, and the system owns the cadence. Calendar feeds are the
 * first resource (15-min TTL, due-ness read from the shared snapshot's
 * own `ingestedAt` so concurrent hosts self-deduplicate); the snapshot
 * file re-read is the second. The world-data caches (bank holidays /
 * weather / TfL) and blank-context prewarm are natural future migrations
 * onto the same tick.
 *
 * Guarantees:
 *   - the tick NEVER runs in the keystroke path (interval timer only,
 *     unref'd so it never keeps a host process alive);
 *   - one in-flight refresh per resource (a slow refresh skips ticks
 *     rather than stacking);
 *   - per-resource jitter (fixed per process lifetime) staggers
 *     multi-host herds without any cross-process coordination;
 *   - a throwing/rejecting refresh is logged and retried on the next
 *     due tick — it can never take the scheduler down.
 */

export interface RefreshableResource {
  /** Stable id for logs. */
  readonly id: string;
  /** Is a refresh warranted right now? Cheap — called every tick. */
  due(now: number): boolean;
  /** Perform the refresh. May be async; failures are logged + retried. */
  refresh(): void | Promise<void>;
  /** Random extra delay budget (ms) applied once per process to this
   *  resource's due-ness, staggering multi-host herds. Default 0. */
  readonly jitterMs?: number;
}

export interface RefreshScheduler {
  register(resource: RefreshableResource): void;
  /** Run one tick immediately (boot + tests). */
  tickNow(): void;
  stop(): void;
}

export function createRefreshScheduler(
  log: (msg: string) => void,
  opts: { tickMs?: number; now?: () => number } = {},
): RefreshScheduler {
  const tickMs = opts.tickMs ?? 30_000;
  const now = opts.now ?? Date.now;
  interface Entry { r: RefreshableResource; inFlight: boolean; notBefore: number }
  const entries: Entry[] = [];
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | null = null;

  const runOne = (e: Entry): void => {
    e.inFlight = true;
    let result: void | Promise<void>;
    try {
      result = e.r.refresh();
    } catch (err) {
      log(`refresh[${e.r.id}]: failed (${(err as Error)?.message ?? err}) — will retry when next due`);
      e.inFlight = false;
      return;
    }
    // Sync refreshes complete synchronously (deterministic for callers +
    // tests); only genuine promises hold the in-flight guard open.
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>)
        .catch(err => log(`refresh[${e.r.id}]: failed (${(err as Error)?.message ?? err}) — will retry when next due`))
        .finally(() => { e.inFlight = false; });
    } else {
      e.inFlight = false;
    }
  };

  const tick = (): void => {
    if (stopped) return;
    const t = now();
    for (const e of entries) {
      if (e.inFlight || t < e.notBefore) continue;
      try {
        if (e.r.due(t)) runOne(e);
      } catch (err) {
        log(`refresh[${e.r.id}]: due() threw (${(err as Error)?.message ?? err})`);
      }
    }
  };

  const loop = (): void => {
    if (stopped) return;
    tick();
    handle = setTimeout(loop, tickMs);
    (handle as { unref?: () => void }).unref?.();
  };
  handle = setTimeout(loop, tickMs);
  (handle as { unref?: () => void }).unref?.();

  return {
    register(resource: RefreshableResource): void {
      const jitter = resource.jitterMs ? Math.floor(Math.random() * resource.jitterMs) : 0;
      entries.push({ r: resource, inFlight: false, notBefore: now() + jitter });
    },
    tickNow(): void { tick(); },
    stop(): void {
      stopped = true;
      if (handle) { clearTimeout(handle); handle = null; }
    },
  };
}

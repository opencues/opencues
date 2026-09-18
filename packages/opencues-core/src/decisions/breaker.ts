/**
 * DecisionBreaker — the circuit breaker every decision leg shares.
 *
 * A failed decision request (overloaded after its retry, transport, budget,
 * auth) marks the provider down for a window; while down, a leg runs its
 * chat path with no decision call at all, so an outage costs one failed
 * request per window, not one per leg per event. Auth failures are not
 * transient: a longer window, and a log line naming it.
 *
 * One class, used by the session rail (`SessionCueSource`) and the `_`
 * router (runtime resolver) — the same guard on two paths is one function,
 * never two copies (CLAUDE.md § common drift-bug patterns).
 */
export const DECISIONS_BREAKER_MS = 30_000;
export const DECISIONS_BREAKER_AUTH_MS = 10 * 60_000;

export class DecisionBreaker {
  private downUntil = 0;

  constructor(private readonly log: (line: string) => void = () => {}, private readonly who = 'decisions') {}

  /** True while no failure window is open. */
  readonly healthy = (): boolean => Date.now() >= this.downUntil;

  /** Open a window sized by the failure kind; logs once per trip. */
  trip(err: { kind?: string; message?: string } | undefined): void {
    const ms = err?.kind === 'auth' ? DECISIONS_BREAKER_AUTH_MS : DECISIONS_BREAKER_MS;
    this.downUntil = Date.now() + ms;
    this.log(`${this.who}: decision provider down for ${Math.round(ms / 1000)}s (${err?.kind ?? 'error'}: ${err?.message}) — chat path meanwhile`);
  }
}

/**
 * Tiny event-subscription helper used by adapter boot.ts files.
 *
 * Each adapter band exposes 4+ runtime events (key, textChange,
 * cursorChange, render) — without this helper each event needs its
 * own handlers array, register/unregister wrapper, and emit loop.
 * The pattern is identical across hosts; centralising it kills the
 * per-event boilerplate without introducing real abstraction.
 *
 * Two emit shapes:
 *   - emit(event, onError) — fan-out, returns nothing.
 *   - emitUntilConsumed(event, onError) — fan-out, stops at the first
 *     handler whose return value is truthy. Used for key dispatch
 *     where one handler "consuming" the event blocks the rest.
 *   - collect(event, onError) — fan-out, returns the array of handler
 *     return values (filtered by truthy). Used for render where
 *     multiple modules contribute directives.
 */
export class EventEmitter<E, R = void> {
  private _handlers: Array<(e: E) => R> = [];

  /** Add a handler. Returns an unsubscribe function. */
  subscribe(handler: (e: E) => R): () => void {
    this._handlers.push(handler);
    return () => {
      const i = this._handlers.indexOf(handler);
      if (i >= 0) this._handlers.splice(i, 1);
    };
  }

  /** Fan-out emit. Errors are reported to onError; one handler's
   *  failure does not block the rest. */
  emit(event: E, onError: (err: unknown) => void): void {
    for (const h of this._handlers) {
      try { h(event); } catch (err) { onError(err); }
    }
  }

  /** Fan-out until a handler returns truthy. Returns whether any
   *  handler consumed the event. Used for key dispatch. */
  emitUntilConsumed(event: E, onError: (err: unknown) => void): boolean {
    for (const h of this._handlers) {
      try {
        if (h(event)) return true;
      } catch (err) {
        onError(err);
      }
    }
    return false;
  }

  /** Fan-out, return the array of truthy results. Used for render
   *  where multiple modules contribute directives. Falsy returns
   *  (null/undefined) are filtered out so the result is narrowed to
   *  non-nullable. */
  collect(event: E, onError: (err: unknown) => void): NonNullable<R>[] {
    const out: NonNullable<R>[] = [];
    for (const h of this._handlers) {
      try {
        const r = h(event);
        if (r) out.push(r as NonNullable<R>);
      } catch (err) { onError(err); }
    }
    return out;
  }

  /** Drop all handlers. Called from boot.dispose. */
  clear(): void {
    this._handlers.length = 0;
  }

  get size(): number { return this._handlers.length; }
}

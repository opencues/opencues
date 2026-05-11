// Per-blank quota enforcement. Wraps the BlankContext's capability
// functions with rate-limit + size-cap checks so a runaway or
// malicious blank can't hammer external APIs or fill the user's
// disk.
//
// Each quota is a per-blank counter. Rate limits use a sliding
// 60-second window — newer + cheaper than the alternative of
// piggy-backing on setInterval timers. Storage size is checked on
// every `set` against the running total.
//
// Authors override defaults in frontmatter (`max-fetches-per-minute`,
// `max-llm-per-minute`, `max-storage-bytes`). Defaults are generous
// but cap the worst-case: 120 fetches/min, 30 LLM calls/min, 1MB
// storage. Power-user blanks raise the cap explicitly; a malicious
// pack declaring 100,000/min still gets the cap (validate warns).

export interface QuotaConfig {
  /** Sliding-60s fetch cap. Default 120. */
  readonly maxFetchesPerMinute?: number;
  /** Sliding-60s LLM-call cap. Default 30. */
  readonly maxLlmPerMinute?: number;
  /** Storage byte cap (key + value lengths summed). Default 1 MB. */
  readonly maxStorageBytes?: number;
}

const DEFAULTS = {
  maxFetchesPerMinute: 120,
  maxLlmPerMinute: 30,
  maxStorageBytes: 1024 * 1024,
} as const;

// Hard ceilings — even if the blank declares a higher cap, the
// runtime refuses to grant more. Prevents a malicious frontmatter
// from disabling quotas by declaring max-fetches-per-minute: 999999.
const HARD_CEILING = {
  maxFetchesPerMinute: 600,    // 10/sec sustained
  maxLlmPerMinute: 120,        // 2/sec sustained (already $$$)
  maxStorageBytes: 10 * 1024 * 1024, // 10 MB
} as const;

export interface QuotaTracker {
  /** Throws if the blank has exceeded its fetch budget; otherwise
   *  records the call. */
  recordFetch(): void;
  recordLlm(): void;
  /** Throws if the new storage value would push the namespace over
   *  budget. `currentBytes` is the existing namespace size + the
   *  size of the value about to be written. */
  checkStorageBytes(currentBytes: number): void;
  /** Exposed for tests / diagnostics. */
  inspect(): { fetches: number; llm: number; maxFetches: number; maxLlm: number; maxStorage: number };
}

export function createQuotaTracker(cfg: QuotaConfig = {}): QuotaTracker {
  const maxFetches = Math.min(cfg.maxFetchesPerMinute ?? DEFAULTS.maxFetchesPerMinute, HARD_CEILING.maxFetchesPerMinute);
  const maxLlm = Math.min(cfg.maxLlmPerMinute ?? DEFAULTS.maxLlmPerMinute, HARD_CEILING.maxLlmPerMinute);
  const maxStorage = Math.min(cfg.maxStorageBytes ?? DEFAULTS.maxStorageBytes, HARD_CEILING.maxStorageBytes);

  // Sliding window: array of millis-since-epoch. On each call we
  // shift out entries older than 60s and check the remaining count.
  const fetches: number[] = [];
  const llm: number[] = [];

  function prune(arr: number[], now: number): void {
    const cutoff = now - 60_000;
    while (arr.length > 0 && arr[0] < cutoff) arr.shift();
  }

  return {
    recordFetch(): void {
      const now = Date.now();
      prune(fetches, now);
      if (fetches.length >= maxFetches) {
        throw new Error(
          `quota: fetch rate-limit exceeded (${maxFetches}/min); ` +
          `bump max-fetches-per-minute in BLANK.md or pace your calls`,
        );
      }
      fetches.push(now);
    },
    recordLlm(): void {
      const now = Date.now();
      prune(llm, now);
      if (llm.length >= maxLlm) {
        throw new Error(
          `quota: llm rate-limit exceeded (${maxLlm}/min); ` +
          `bump max-llm-per-minute in BLANK.md or pace your calls`,
        );
      }
      llm.push(now);
    },
    checkStorageBytes(currentBytes: number): void {
      if (currentBytes > maxStorage) {
        throw new Error(
          `quota: storage size ${currentBytes}b exceeds cap ${maxStorage}b; ` +
          `bump max-storage-bytes in BLANK.md or trim your namespace`,
        );
      }
    },
    inspect(): { fetches: number; llm: number; maxFetches: number; maxLlm: number; maxStorage: number } {
      const now = Date.now();
      prune(fetches, now);
      prune(llm, now);
      return { fetches: fetches.length, llm: llm.length, maxFetches, maxLlm, maxStorage };
    },
  };
}

// ModelBlank — "what's my model? _" / "list models _" answered from the
// SAME effective-routing walk dispatch uses (@opencues/core's
// resolveEffectiveRouting → resolveLLMTuple → the code inside
// resolveLLM). The blank can therefore never report a provider/model
// that differs from what a real dispatch would send — that guarantee is
// the whole point; do NOT reimplement any precedence logic here.
//
// Trigger phrases (shape-gated — see defaults/blanks/model/BLANK.md):
//   "model _" / "whats my model _" / "what model am i using _"
//   "model for cues _"          → single-bucket answer
//   "models _" / "list models _" → provider/model catalog
//
// Read-only, no cycling REQUIRED (runs on no-cycling hosts) — but the
// multi-line return synthesizes cycling alts on hosts that support it
// (same pattern as claude-status): Up surfaces the per-bucket
// breakdown, then source attribution.
//
// Scalars are re-read from OPENCUES.md on every invocation (the file
// IO comes from the host's opencuesMdIO binding), so a settings change
// is reflected on the next `_` without any cache-invalidation wiring.

import type { Blank } from './types';
import {
  LLM_BUCKETS,
  buildBootApiKeys,
  listProviders,
  resolveEffectiveRouting,
  type EffectiveBucketRouting,
  type EffectiveRouting,
  type LlmBucket,
} from '@opencues/core';
import { parseOpenCuesMd } from '../modules/config-loader';

export interface ModelBlankOptions {
  /** Read the user's OPENCUES.md (host's opencuesMdIO.readFile). */
  readonly readSettingsFile: () => Promise<string | null>;
  /**
   * Live LLM API-key bag keyed by env-var name. Chrome passes a thunk
   * over its storage-fed bag (keys arrive async post-boot and mutate
   * live — a boot-time snapshot would go stale). Native hosts can omit
   * it: the default reads the same shell-env + ~/.cues/.env bag the
   * boot path builds (`buildBootApiKeys`).
   */
  readonly getApiKeys?: () => Readonly<Record<string, string | undefined>>;
}

/** Native-host default key bag. Browser-safe: no `process` → empty bag
 *  (chrome supplies its own thunk; without one the blank degrades to
 *  "configured scalars only" — auto-routing needs keys to inspect). */
function defaultApiKeys(): Readonly<Record<string, string | undefined>> {
  if (typeof process === 'undefined' || !process.versions?.node) return {};
  try {
    return buildBootApiKeys();
  } catch {
    return {};
  }
}

const PROVIDER_SOURCE_LABEL: Record<string, (bucket: LlmBucket) => string> = {
  bucket: (b) => `${b}-llm-provider`,
  global: () => 'llm-provider',
  'auto-key': () => 'auto (env key)',
  'auto-subscription': () => 'auto (subscription CLI)',
};

const MODEL_SOURCE_LABEL: Record<string, (bucket: LlmBucket) => string> = {
  bucket: (b) => `${b}-llm-model`,
  global: () => 'llm-model',
  'provider-default': () => 'provider default',
};

export class ModelBlank implements Blank {
  readonly name = 'model';
  readonly readOnly = true;
  private readonly _readSettingsFile: () => Promise<string | null>;
  private readonly _getApiKeys: () => Readonly<Record<string, string | undefined>>;

  constructor(opts: ModelBlankOptions) {
    this._readSettingsFile = opts.readSettingsFile;
    this._getApiKeys = opts.getApiKeys ?? defaultApiKeys;
  }

  async get(keyword?: string, context?: string[]): Promise<string> {
    const routing = await this.resolveRouting();
    if (keyword?.trim().toLowerCase() === 'models') {
      return this.formatModelList(routing);
    }
    const bucket = (context ?? [])
      .map((w) => w.trim().toLowerCase())
      .find((w): w is LlmBucket => (LLM_BUCKETS as readonly string[]).includes(w));
    return bucket ? this.formatBucket(routing[bucket]) : this.formatCurrent(routing);
  }

  private async resolveRouting(): Promise<EffectiveRouting> {
    const content = (await this._readSettingsFile()) ?? '';
    const settings = parseOpenCuesMd(content).settings;
    return resolveEffectiveRouting({
      scalars: (name) => settings.get(name),
      apiKeys: this._getApiKeys(),
    });
  }

  // ── "what's my model?" ─────────────────────────────────────────────

  private formatCurrent(routing: EffectiveRouting): string {
    const rows = LLM_BUCKETS.map((b) => routing[b]);
    if (rows.every((r) => r.providerSource === 'none')) {
      return 'no LLM configured — add a key (opencues set-key) or set llm-provider: in ~/.cues/OPENCUES.md';
    }
    const agree = rows.every(
      (r) => r.providerId === rows[0].providerId && r.model === rows[0].model,
    );
    // The blanks bucket is the primary answer — the `_` the user just
    // typed IS a blanks-bucket surface. Alts (Up) widen the view.
    const primary = agree
      ? formatRow(routing.blanks)
      : `${formatRow(routing.blanks)} (blanks bucket — buckets differ)`;
    const breakdown = LLM_BUCKETS
      .map((b) => `${b}: ${formatRow(routing[b])}`)
      .join(' | ');
    return [primary, breakdown, `source: ${formatSources(routing.blanks)}`].join('\n');
  }

  private formatBucket(row: EffectiveBucketRouting): string {
    return [
      `${row.bucket}: ${formatRow(row)}`,
      `source: ${formatSources(row)}`,
    ].join('\n');
  }

  // ── "list models" ──────────────────────────────────────────────────

  private formatModelList(routing: EffectiveRouting): string {
    const current = routing.blanks;
    const keys = this._getApiKeys();
    const adapters = listProviders();
    const usable = (a: (typeof adapters)[number]): boolean =>
      a.transport === 'cli' || !!a.optionalAuth || !!(a.envKeyName && keys[a.envKeyName]);
    // Current provider first, then dispatchable providers, then the rest.
    const ordered = [...adapters].sort((a, b) => {
      const rank = (x: typeof a): number =>
        x.id === current.providerId ? 0 : usable(x) ? 1 : 2;
      return rank(a) - rank(b);
    });
    const lines = ordered.map((a) => {
      const models = (a.knownModels ?? [a.defaultModel])
        .map((m) => (a.id === current.providerId && m === current.model ? `${m}*` : m))
        .join(', ');
      const tag = a.id === current.providerId
        ? 'current'
        : a.transport === 'cli'
          ? 'subscription CLI'
          : a.optionalAuth
            ? 'no key needed'
            : a.envKeyName && keys[a.envKeyName]
              ? 'key set'
              : 'no key';
      return `${a.id} (${tag}): ${models}`;
    });
    return lines.join('\n');
  }
}

function formatRow(row: EffectiveBucketRouting): string {
  if (row.providerSource === 'none') return 'no LLM configured';
  if (!row.provider) return `${row.providerId ?? '?'} (unknown provider — calls disabled)`;
  const notes: string[] = [];
  if (!row.keyPresent) notes.push('key missing');
  if (row.trainsOnInputBlocked) notes.push('refused — provider trains on input');
  return `${row.providerId} · ${row.model}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

function formatSources(row: EffectiveBucketRouting): string {
  if (row.providerSource === 'none' || !row.provider) return 'not configured';
  const p = PROVIDER_SOURCE_LABEL[row.providerSource]?.(row.bucket) ?? row.providerSource;
  const m = row.modelSource ? MODEL_SOURCE_LABEL[row.modelSource]?.(row.bucket) ?? row.modelSource : '?';
  return `provider from ${p} · model from ${m}`;
}

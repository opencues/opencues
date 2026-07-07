/**
 * Existing-key detection — fill the boot-time API-key bag from key
 * sources the user already has, so a key stored once (a shell export
 * OR `opencues set-key` → `~/.cues/.env`) reaches every native host
 * with no per-host enumeration and no shell-rc surgery.
 *
 * Precedence per env-var name (first hit wins):
 *   1. host-supplied bag entries (chrome storage push, patch bootstraps)
 *   2. `process.env` — an explicit shell export always wins over the file
 *   3. `~/.cues/.env` — written by `opencues set-key` (chmod 0600)
 *
 * Browser-safe: every `process` / `node:fs` access is guarded, so in a
 * chrome content script this module augments nothing (chrome's keys
 * arrive pre-merged via the storage push — see
 * docs/architecture/chrome-llm-keys.md).
 *
 * Scope: LLM provider keys only (the registry's `envKeyName`s). Non-LLM
 * service keys (FINNHUB_API_KEY) and scripted-blank `secrets:` bindings
 * still read `process.env` — the bag never feeds child-process env, and
 * `.env`-sourced values are never written back into `process.env`
 * (deliberate: keys must not leak into every spawned blank script's
 * inheritable environment).
 *
 * Freshness: the bag is built once at host boot. A key stored while a
 * host is running needs a host restart (chrome instead gets live pushes
 * from the native-messaging host, which watches the file).
 */

import { listProviders } from './llm-provider';

/** Where a detected key value came from. */
export type KeySource = 'host' | 'shell-env' | 'env-file';

/** One provider row from {@link detectProviderKeys} — CLI reporting shape. */
export interface DetectedProviderKey {
  readonly providerId: string;
  readonly envKeyName: string;
  /** null = no value found anywhere. */
  readonly source: KeySource | null;
}

/**
 * Parse `.env`-style content: `KEY=value` lines, `#` comments, blank
 * lines, optional `export ` prefix (users are told they can
 * `source` the file, so hand-edited export-form lines must parse),
 * optional single/double quotes around the value. Superset of the
 * chrome native-messaging host's parser (integrations/chrome/host/
 * host.cjs:loadEnvFile) — keep the two accepting the same core shape.
 */
export function parseEnvFileContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Absolute path of the user-level key store, or null when not on Node
 * (browser) or when no home dir is resolvable. Matches `opencues
 * set-key` / `check-keys`: always `~/.cues/.env` (deliberately NOT
 * `$OPENCUES_HOME` — credentials are user-level, not config-tree-level).
 */
export function cuesEnvFilePath(): string | null {
  if (typeof process === 'undefined' || !process.versions?.node) return null;
  const home = process.env.HOME || process.env.USERPROFILE; // BROWSER-SAFE-ALLOW: guarded by typeof process above
  if (!home) return null;
  return `${home}/.cues/.env`;
}

/** Read + parse `~/.cues/.env`. `{}` in a browser, on a missing file, or on any error. */
export function readCuesEnvFile(): Record<string, string> {
  const file = cuesEnvFilePath();
  if (!file) return {};
  try {
    // Lazy require — `node:fs` is external in the chrome bundle and this
    // call is unreachable there (cuesEnvFilePath() already returned null).
    const fs = require('node:fs') as typeof import('node:fs');
    if (!fs.existsSync(file)) return {};
    return parseEnvFileContent(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Fill every registry `envKeyName` missing from `bag` from
 * `process.env`, then from `~/.cues/.env`. Mutates and returns `bag`.
 * Returns the list of entries it filled (env-var name + source) so the
 * caller can log what was picked up — detection must never be silent
 * (the chrome silent-degrade lesson generalises: a key source that
 * feeds dispatch invisibly is undebuggable).
 */
export function augmentApiKeysFromEnv(
  bag: Record<string, string | undefined>,
): Array<{ envKeyName: string; source: Exclude<KeySource, 'host'> }> {
  if (typeof process === 'undefined' || !process.versions?.node) return [];
  const filled: Array<{ envKeyName: string; source: Exclude<KeySource, 'host'> }> = [];
  const fileEnv = readCuesEnvFile();
  for (const adapter of listProviders()) {
    const name = adapter.envKeyName;
    if (!name || bag[name]) continue;
    const fromShell = process.env[name]; // BROWSER-SAFE-ALLOW: guarded by typeof process above
    if (fromShell) {
      bag[name] = fromShell;
      filled.push({ envKeyName: name, source: 'shell-env' });
    } else if (fileEnv[name]) {
      bag[name] = fileEnv[name];
      filled.push({ envKeyName: name, source: 'env-file' });
    }
  }
  return filled;
}

/**
 * Build the boot-time API-key bag every adapter band hands to
 * Cycling / the Resolver. One call replaces the per-band two-liner
 * (`{ ...host.llmApiKeys }` + legacy `llmApiKey` → GROQ_API_KEY) and
 * adds the shell-env / `~/.cues/.env` augmentation behind it.
 *
 * `log`, when supplied, receives ONE summary line naming which env vars
 * were picked up from where — never the values.
 */
export function buildBootApiKeys(
  hostKeys?: Readonly<Record<string, string | undefined>>,
  legacyGroqKey?: string,
  log?: (message: string) => void,
): Record<string, string | undefined> {
  const bag: Record<string, string | undefined> = { ...(hostKeys ?? {}) };
  if (legacyGroqKey && !bag.GROQ_API_KEY) bag.GROQ_API_KEY = legacyGroqKey;
  const filled = augmentApiKeysFromEnv(bag);
  if (filled.length > 0 && log) {
    const summary = filled
      .map((f) => `${f.envKeyName} (${f.source === 'env-file' ? '~/.cues/.env' : 'shell env'})`)
      .join(', ');
    log(`LLM keys detected: ${summary}`);
  }
  return bag;
}

/**
 * Detection report for CLI surfaces (`opencues install` / `doctor`):
 * one row per env-keyed LLM provider, saying where (if anywhere) its
 * key was found. CLI-transport providers (claude-code-cli,
 * openai-subscription) have no env key and don't appear — callers probe
 * their binaries separately (core doesn't shell out).
 */
export function detectProviderKeys(): DetectedProviderKey[] {
  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  const fileEnv = isNode ? readCuesEnvFile() : {};
  return listProviders()
    .filter((p) => p.envKeyName && p.transport !== 'cli')
    .map((p) => {
      const fromShell = isNode ? process.env[p.envKeyName] : undefined; // BROWSER-SAFE-ALLOW: guarded by isNode above
      const source: KeySource | null = fromShell ? 'shell-env' : fileEnv[p.envKeyName] ? 'env-file' : null;
      return { providerId: p.id, envKeyName: p.envKeyName, source };
    });
}

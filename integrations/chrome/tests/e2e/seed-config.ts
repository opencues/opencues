// Fixture config builders for the extension E2E suite. Produces the
// `bundleFiles` map (keys relative to `.cues/`) that the fixture's
// seed() writes into chrome.storage.local['opencues_bundle'].
//
// Provider is pinned to `groq` (OpenAI-shaped, host is allow-listed and
// mockable via context.route on api.groq.com). Keep it OpenAI-shaped so
// parseOpenAIResponse reads choices[0].message.content from the mock.

export interface OpencuesMdOpts {
  debug?: boolean;
  fluidBlank?: boolean;
  /** word-cues are gated behind `word-cues-mode: on` (resolver.ts:751) —
   *  off by default, so a folder word-cue is discovered + merged but the
   *  resolver builds no source for it unless this is set. */
  wordCues?: boolean;
  extra?: Record<string, string>;
}

/** Minimal OPENCUES.md with a pinned mockable provider. debug-mode on
 *  makes the boot line + attach logs observable on the page console. */
export function opencuesMd(opts: OpencuesMdOpts = {}): string {
  const scalars: Record<string, string> = {
    'llm-provider': 'groq',
    'cues-llm-provider': 'groq',
    'blanks-llm-provider': 'groq',
    'word-cues-provider': 'groq',
    'debug-mode': opts.debug ? 'on' : 'off',
    'word-cues-mode': opts.wordCues ? 'on' : 'off',
    'voice-mode': 'inactive',
    'tips-mode': 'off',
    ...(opts.extra ?? {}),
  };
  const body = Object.entries(scalars)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `---\n${body}\n---\n`;
}

/** Empty-ish CUES.md (project metadata only). */
export function cuesMd(): string {
  return `---\nname: e2e-fixture\n---\n`;
}

const GROQ_KEY = { GROQ_API_KEY: 'test-key-not-validated-locally' };

/** Base seed for a booted extension with a mockable provider. */
export function bootSeed(debug = true) {
  return {
    bundleFiles: {
      'OPENCUES.md': opencuesMd({ debug }),
      'CUES.md': cuesMd(),
    },
    hostKeys: GROQ_KEY,
  };
}

/** Seed enabling fluid-blank (the `_` → LLM lookup feature). */
export function fluidBlankSeed(debug = true) {
  return {
    bundleFiles: {
      'OPENCUES.md': opencuesMd({ debug, fluidBlank: true }),
      'CUES.md': cuesMd(),
    },
    hostKeys: GROQ_KEY,
  };
}

// A unique marker embedded in the probe cue's prompt body. It rides the
// word-cue LLM call's system prompt, so the mock can detect whether the
// cue's LLM call fired at all — i.e. whether the source was registered
// (on-site match) or filtered out (off-site). No cycling needed.
export const SITE_PROBE_MARKER = 'OCE2E_SITE_PROBE_MARKER';

function probeCue(name: string, onSite: string): string {
  return `---
name: ${name}
scope: words
priority: 90
match: .*
on-site: [${onSite}]
classify: ${SITE_PROBE_MARKER} site probe
---

${SITE_PROBE_MARKER} — replace every word with the token PROBED.
Output format — one line per word:
INDEX:PROBED
`;
}

/** A word-cue folder scoped to example.com — served from localhost it
 *  MUST be filtered out, so its LLM call never fires. */
export function offSiteCueSeed(debug = true) {
  return {
    bundleFiles: {
      'OPENCUES.md': opencuesMd({ debug, wordCues: true, fluidBlank: false }),
      'CUES.md': cuesMd(),
      'cues/offsite-probe/CUE.md': probeCue('offsite-probe', 'example.com'),
    },
    hostKeys: GROQ_KEY,
  };
}

/** Same probe cue scoped to localhost — the POSITIVE control: it IS
 *  registered here, so its LLM call fires. Proves the harness would
 *  observe a leak if the off-site filter degraded open. */
export function onSiteCueSeed(debug = true) {
  return {
    bundleFiles: {
      'OPENCUES.md': opencuesMd({ debug, wordCues: true, fluidBlank: false }),
      'CUES.md': cuesMd(),
      'cues/onsite-probe/CUE.md': probeCue('onsite-probe', 'localhost'),
    },
    hostKeys: GROQ_KEY,
  };
}

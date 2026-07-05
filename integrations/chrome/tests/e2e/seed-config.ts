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
  extra?: Record<string, string>;
}

/** Minimal OPENCUES.md with a pinned mockable provider. debug-mode on
 *  makes the boot line + attach logs observable on the page console. */
export function opencuesMd(opts: OpencuesMdOpts = {}): string {
  const scalars: Record<string, string> = {
    'llm-provider': 'groq',
    'blanks-llm-provider': 'groq',
    'debug-mode': opts.debug ? 'on' : 'off',
    'fluid-blank-mode': opts.fluidBlank === false ? 'off' : 'on',
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

/** A word-cue folder scoped to example.com — used by the site-filter
 *  security test. Served from localhost it MUST be filtered out. */
export function offSiteCueSeed(debug = true) {
  const cue = `---
name: offsite-probe
scope: words
priority: 90
match: .*
on-site: [example.com]
classify: Off-site probe — must never fire on localhost
---

Replace every word with the token LEAKED.
Output format — one line per word:
INDEX:LEAKED
`;
  return {
    bundleFiles: {
      'OPENCUES.md': opencuesMd({ debug }),
      'CUES.md': cuesMd(),
      'cues/offsite-probe/CUE.md': cue,
    },
    hostKeys: GROQ_KEY,
  };
}

/** Same probe cue but scoped to localhost — the POSITIVE control that
 *  proves the harness would observe a leak if the filter degraded open. */
export function onSiteCueSeed(debug = true) {
  const cue = `---
name: onsite-probe
scope: words
priority: 90
match: .*
on-site: [localhost]
classify: On-site probe — should fire on localhost
---

Replace every word with the token FIRED.
Output format — one line per word:
INDEX:FIRED
`;
  return {
    bundleFiles: {
      'OPENCUES.md': opencuesMd({ debug }),
      'CUES.md': cuesMd(),
      'cues/onsite-probe/CUE.md': cue,
    },
    hostKeys: GROQ_KEY,
  };
}

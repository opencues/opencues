// Harness for the highlight-glimmer engine — real-Chromium unit tests.
// jsdom has no Highlight / CSS.highlights, so the vitest suite
// structurally CANNOT touch this module; that gap is how the engine
// shipped with the single-text-node zero-chars bug. This harness
// exposes the raw engine API to the pw suite where the real Highlight
// registry exists and can be asserted against directly (same world —
// no isolated-world visibility caveat like the extension e2e has).

import { createHighlightGlimmer, supportsHighlightGlimmer } from '../../src/highlight-glimmer';

(window as unknown as { __OCG: unknown }).__OCG = {
  createHighlightGlimmer,
  supportsHighlightGlimmer,
  /** Registry probe: [name, memberCount] for every glimmer highlight. */
  glimmerRegistry(): [string, number][] {
    const out: [string, number][] = [];
    for (const [name, h] of (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights) {
      if (name.startsWith('oc-glimmer-')) out.push([name, h.size]);
    }
    return out;
  },
};

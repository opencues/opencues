// Bundle-level site-compat filter. Drops files whose frontmatter
// scopes them off the current location.
//
// Used by opencues-bootstrap.ts when reading the live native-messaging
// bundle out of browser.storage.local. Re-applied on SPA navigation
// (popstate + monkey-patched pushState/replaceState).
//
// inferSiteCompat does the actual scope evaluation (in @opencues/core);
// this module's job is just to extract the on-site / not-on-site
// frontmatter fields from each MD file and call inferSiteCompat with
// the right context. Pure functions — easy to test in isolation.

import { inferSiteCompat, type SiteCompatContext } from '@opencues/core';

export interface SiteFrontmatter {
  onSite?: string[];
  notOnSite?: string[];
}

/** Extract on-site / not-on-site (or camelCase aliases) from MD frontmatter.
 *  Files without a `---`-delimited frontmatter block return {}. */
export function extractSiteFrontmatter(content: string): SiteFrontmatter {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = m[1];

  const grab = (key: string): string[] | undefined => {
    // Allow `key:` and `key :`. Anchor to start-of-line. Value is the
    // rest of that line (frontmatter is one-line-per-field).
    const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm');
    const match = fm.match(re);
    if (!match) return undefined;
    return parseListValue(match[1]);
  };

  return {
    onSite: grab('on-site') ?? grab('onSite'),
    notOnSite: grab('not-on-site') ?? grab('notOnSite'),
  };
}

/** Apply the site-compat filter to a bundle's files map. */
export function applySiteCompatFilter(
  files: Record<string, string>,
  ctx: SiteCompatContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, content] of Object.entries(files)) {
    const fm = extractSiteFrontmatter(content);
    if (inferSiteCompat(fm, ctx)) out[rel] = content;
  }
  return out;
}

// ─── List-value parser ───────────────────────────────────────────────────
//
// Accepts:
//   [a, b, c]              — YAML-array (unquoted, JSON-array, single-quoted)
//   a, b, c                — bare comma-separated
//   a                      — single value
// Strips surrounding ['"] from each item. Empty values filtered out.
//
// Mirrors @opencues/core's parseHostList (which we don't import here
// to keep this module dependency-light for tests).
export function parseListValue(raw: string): string[] {
  let v = raw.trim();
  if (!v) return [];
  if (v.startsWith('[') && v.endsWith(']')) {
    try {
      const parsed = JSON.parse(v.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through to bracket-strip + comma-split */ }
    v = v.slice(1, -1).trim();
  }
  return v
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(s => s.length > 0);
}

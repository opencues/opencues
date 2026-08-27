// RoiConcerns — CUE.md-shaped READING CONCERNS, the config overlap with the
// OpenCues open standard. A concern is one markdown doc: frontmatter
// (name, scope: reading, priority, on-site, not-on-site, model, disabled)
// plus the LLM prompt as the body. The shipped insight-finder is just the
// default concern; users add their own in the popup — a jargon explainer, a
// claim checker, a bias flag are each one doc, zero code.
//
// Follows the standard's conventions deliberately:
//   - KNOWN_SCOPES allowlist: docs with an unknown scope: are DROPPED, not
//     misread — the parser forward-compat rule from cues-md.ts.
//   - on-site / not-on-site site scoping: hostname, *.wildcard,
//     host/path-prefix. Exclusion wins; no on-site means every site.
//   - name-keyed override: a user concern with a built-in's name replaces it.
//
// ONE concern is active per page: the highest-priority doc whose site scope
// matches. Loaded before content.js; consumed via window.RoiConcerns.
(() => {
  'use strict';
  if (window.RoiConcerns) return;

  const KNOWN_SCOPES = ['reading'];
  // the newest spec whose file shapes this reader understands — files
  // declaring a NEWER `spec:` are refused, never misread (the standard's
  // spec-too-new rule; omitting `spec:` is always accepted)
  const READER_SPEC = { major: 0, minor: 11 };

  const DEFAULT_DOCS = [
    `---
name: insight
scope: reading
priority: 50
---
You spot insights. Given a passage, reply with ONE short, non-obvious insight, implication, or connection a careful reader might miss. Under 18 words. Plain text only: no quotes, no preamble, no markdown.`,
  ];

  function parseList(v) {
    v = v.trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }

  // one doc -> { concern } | { skip, name, scope } | { error }
  function parse(doc) {
    const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(doc.trim());
    if (!m) return { error: 'missing frontmatter (--- … ---)' };
    const fm = {};
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line.trim());
      if (kv) fm[kv[1].toLowerCase()] = kv[2].trim();
    }
    const body = m[2].trim();
    if (!fm.name) return { error: 'missing name:' };
    if (fm.spec) {
      const sp = /^opencues\/(\d+)\.(\d+)/.exec(fm.spec);
      if (!sp) return { error: `concern "${fm.name}": malformed spec: "${fm.spec}"` };
      const major = +sp[1], minor = +sp[2];
      if (major > READER_SPEC.major || (major === READER_SPEC.major && minor > READER_SPEC.minor)) {
        return { skip: true, name: fm.name, scope: fm.scope,
                 tooNew: `spec "${fm.spec}" newer than reader's opencues/${READER_SPEC.major}.${READER_SPEC.minor}` };
      }
    }
    if (fm.disabled === 'true') return { skip: true, name: fm.name, scope: fm.scope, disabled: true };
    if (!KNOWN_SCOPES.includes(fm.scope)) return { skip: true, name: fm.name, scope: fm.scope || '(none)' };
    if (!body) return { error: `concern "${fm.name}": empty prompt body` };
    return {
      concern: {
        name: fm.name,
        priority: Number(fm.priority) || 50,
        model: fm.model || null,
        onSite: fm['on-site'] ? parseList(fm['on-site']) : null,
        notOnSite: fm['not-on-site'] ? parseList(fm['not-on-site']) : null,
        prompt: body,
      },
    };
  }

  // multiple docs in one blob, separated by a line of ===
  function splitDocs(blob) {
    return String(blob || '').split(/\n===+\s*\n/).map(s => s.trim()).filter(Boolean);
  }

  // matches core's inferSiteCompat semantics EXACTLY (host-compat.ts):
  //   'reddit.com'            → hostname === 'reddit.com' (exact, no subdomains)
  //   '*.reddit.com'          → subdomains AND the bare domain
  //   'reddit.com/r/claudeai' → hostname match + lowercased path prefix
  //   'chrome'                → platform name; glimmer IS a browser, so true
  const PLATFORM_NAMES = new Set(['chrome']);
  function matchHostname(pattern, hostname) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return hostname === suffix || hostname.endsWith('.' + suffix);
    }
    return pattern === hostname;
  }
  function matchSite(pattern, host, path) {
    const e = String(pattern).trim().toLowerCase();
    if (!e) return false;
    if (e.includes('/')) {
      const slash = e.indexOf('/');
      if (!matchHostname(e.slice(0, slash), host)) return false;
      return String(path).toLowerCase().startsWith(e.slice(slash));
    }
    if (PLATFORM_NAMES.has(e)) return true;
    return matchHostname(e, host);
  }

  function siteAllowed(c, host, path) {
    if (c.notOnSite && c.notOnSite.some(p => matchSite(p, host, path))) return false;
    if (c.onSite && c.onSite.length) return c.onSite.some(p => matchSite(p, host, path));
    return true;
  }

  // defaults first, user docs override by name (the project-beats-user rule)
  function effective(userDocs) {
    const byName = new Map();
    for (const doc of DEFAULT_DOCS) {
      const r = parse(doc);
      if (r.concern) byName.set(r.concern.name, r.concern);
    }
    for (const doc of userDocs || []) {
      const r = parse(doc);
      if (r.concern) byName.set(r.concern.name, r.concern);
      else if (r.skip) byName.delete(r.name);   // disabled/unknown-scope user doc retires the name
    }
    return [...byName.values()];
  }

  function pickActive(concerns, host, path) {
    let best = null;
    for (const c of concerns) {
      if (!siteAllowed(c, host, path)) continue;
      if (!best || c.priority > best.priority) best = c;
    }
    return best;
  }

  window.RoiConcerns = { parse, splitDocs, matchSite, siteAllowed, effective, pickActive, DEFAULT_DOCS, KNOWN_SCOPES };
})();

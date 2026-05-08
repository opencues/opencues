/**
 * Tests for AUDITOR.md / AUDITORS.md parsing and folder discovery.
 *
 * Run with: node --test dist/auditors.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseSingleAuditorMd, parseAuditorsMaster } from './cues-md';
import { discoverFolderConfigs, type DirEntry } from './discover';

describe('parseSingleAuditorMd', () => {
  it('parses frontmatter + body into AuditorConfig', () => {
    const content = `---
name: grammar
description: Fix grammar errors
priority: 60
---

You are checking for grammar errors. Rewrite ONLY clear errors.`;
    const config = parseSingleAuditorMd(content, '/auditors/grammar', 'grammar');
    const auditor = config.auditors?.['grammar'];
    assert.ok(auditor, 'expected auditors[grammar] to be set');
    assert.strictEqual(auditor!.name, 'grammar');
    assert.strictEqual(auditor!.description, 'Fix grammar errors');
    assert.strictEqual(auditor!.priority, 60);
    assert.match(auditor!.promptText, /grammar errors/);
    assert.strictEqual(auditor!.enabled, true); // default
  });

  it('falls back to nameOverride when frontmatter omits name', () => {
    const content = `---\ndescription: anonymous auditor\n---\n\nbody text.`;
    const config = parseSingleAuditorMd(content, '/auditors/clarity', 'clarity');
    assert.ok(config.auditors?.['clarity']);
    assert.strictEqual(config.auditors!['clarity'].name, 'clarity');
  });

  it('respects enabled: false', () => {
    const content = `---\nname: x\nenabled: false\n---\n\nbody.`;
    const config = parseSingleAuditorMd(content, '/auditors/x', 'x');
    assert.strictEqual(config.auditors!['x'].enabled, false);
  });

  it('defaults priority to undefined when not set (caller defaults to 50)', () => {
    const content = `---\nname: x\n---\n\nbody.`;
    const config = parseSingleAuditorMd(content, '/auditors/x', 'x');
    assert.strictEqual(config.auditors!['x'].priority, undefined);
  });

  it('reads on-host / not-on-host', () => {
    const content = `---\nname: x\non-host: [chrome, opencode]\nnot-on-host: claude-code\n---\n\nbody.`;
    const config = parseSingleAuditorMd(content, '/auditors/x', 'x');
    assert.deepStrictEqual(config.auditors!['x'].onHost, ['chrome', 'opencode']);
    assert.deepStrictEqual(config.auditors!['x'].notOnHost, ['claude-code']);
  });
});

describe('parseAuditorsMaster', () => {
  it('reads disable: list from frontmatter', () => {
    const content = `---\nname: project-auditors\ndisable: [grammar, clarity]\n---\n\nbody is documentation.`;
    const config = parseAuditorsMaster(content);
    assert.deepStrictEqual(config.disableAuditors, ['grammar', 'clarity']);
  });

  it('handles empty disable: list', () => {
    const content = `---\nname: project-auditors\ndisable: []\n---\n`;
    const config = parseAuditorsMaster(content);
    assert.deepStrictEqual(config.disableAuditors, []);
  });

  it('omits disableAuditors when frontmatter has no disable: key', () => {
    const content = `---\nname: project-auditors\n---\n`;
    const config = parseAuditorsMaster(content);
    assert.strictEqual(config.disableAuditors, undefined);
  });
});

// ============================================================================
// Discovery — discoverFolderConfigs walks auditors/<name>/AUDITOR.md
// ============================================================================

function mkDiscoverOpts(files: Record<string, string>) {
  return {
    basePath: '/root',
    readFile: (p: string): string | null => files[p] ?? null,
    readDir: (p: string): DirEntry[] | null => {
      const prefix = p + '/';
      const seen = new Set<string>();
      const entries: DirEntry[] = [];
      for (const k of Object.keys(files)) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const top = rest.split('/')[0];
        if (seen.has(top)) continue;
        seen.add(top);
        const isDirectory = rest.includes('/');
        entries.push({ name: top, isDirectory });
      }
      return entries.length === 0 ? null : entries;
    },
  };
}

describe('discoverFolderConfigs — auditors/', () => {
  it('discovers auditor folders and exposes them via auditorOverrides', () => {
    const files = {
      '/root/auditors/grammar/AUDITOR.md': `---\nname: grammar\npriority: 50\n---\n\nGrammar prompt body.`,
      '/root/auditors/clarity/AUDITOR.md': `---\nname: clarity\npriority: 40\n---\n\nClarity prompt body.`,
    };
    const result = discoverFolderConfigs(mkDiscoverOpts(files));
    assert.ok(result.auditorOverrides);
    assert.deepStrictEqual(Object.keys(result.auditorOverrides!).sort(), ['clarity', 'grammar']);
    assert.strictEqual(result.auditorOverrides!.grammar.priority, 50);
    assert.match(result.auditorOverrides!.grammar.promptText, /Grammar prompt body/);
  });

  it('returns no auditorOverrides when auditors/ is empty', () => {
    const result = discoverFolderConfigs(mkDiscoverOpts({}));
    assert.strictEqual(result.auditorOverrides, undefined);
  });

  it('skips folders missing an AUDITOR.md', () => {
    const files = {
      '/root/auditors/grammar/AUDITOR.md': `---\nname: grammar\n---\n\nbody.`,
      '/root/auditors/orphan/notes.md': 'no AUDITOR.md here',
    };
    const result = discoverFolderConfigs(mkDiscoverOpts(files));
    assert.deepStrictEqual(Object.keys(result.auditorOverrides!), ['grammar']);
  });
});

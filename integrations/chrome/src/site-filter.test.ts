// Tests for the bundle-level site-compat filter.
//
// Spot-test the frontmatter parser (especially the YAML-array
// bracket-strip path that bit us once already) and the
// applySiteCompatFilter integration.

import { describe, it, expect } from 'vitest';
import {
  extractSiteFrontmatter,
  applySiteCompatFilter,
  parseListValue,
} from './site-filter';

describe('parseListValue', () => {
  it('returns [] for empty input', () => {
    expect(parseListValue('')).toEqual([]);
    expect(parseListValue('   ')).toEqual([]);
  });

  it('parses single bare value', () => {
    expect(parseListValue('chrome')).toEqual(['chrome']);
  });

  it('parses comma-separated bare values', () => {
    expect(parseListValue('chrome, reddit.com, claude.ai'))
      .toEqual(['chrome', 'reddit.com', 'claude.ai']);
  });

  it('parses JSON-array (quoted)', () => {
    expect(parseListValue('["chrome", "reddit.com"]'))
      .toEqual(['chrome', 'reddit.com']);
  });

  it('parses YAML-style unquoted bracket list (the previously broken path)', () => {
    expect(parseListValue('[claude.ai]')).toEqual(['claude.ai']);
    expect(parseListValue('[chrome, reddit.com]')).toEqual(['chrome', 'reddit.com']);
  });

  it('parses single-quoted JSON-array', () => {
    expect(parseListValue("['chrome', 'reddit.com']"))
      .toEqual(['chrome', 'reddit.com']);
  });

  it('strips surrounding quotes from each item', () => {
    expect(parseListValue('"chrome", "reddit.com"'))
      .toEqual(['chrome', 'reddit.com']);
  });

  it('drops empty entries', () => {
    expect(parseListValue('chrome,, reddit.com,'))
      .toEqual(['chrome', 'reddit.com']);
  });
});

describe('extractSiteFrontmatter', () => {
  it('returns {} for content without frontmatter', () => {
    expect(extractSiteFrontmatter('no frontmatter here')).toEqual({});
    expect(extractSiteFrontmatter('---\nbut no closer')).toEqual({});
  });

  it('returns {} for frontmatter without site fields', () => {
    expect(extractSiteFrontmatter('---\nname: foo\ntype: blank\n---\nbody'))
      .toEqual({});
  });

  it('extracts on-site (hyphenated)', () => {
    const md = '---\nname: foo\non-site: [reddit.com]\n---\n';
    expect(extractSiteFrontmatter(md)).toEqual({ onSite: ['reddit.com'] });
  });

  it('extracts not-on-site (hyphenated)', () => {
    const md = '---\nname: foo\nnot-on-site: [claude.ai]\n---\n';
    expect(extractSiteFrontmatter(md)).toEqual({ notOnSite: ['claude.ai'] });
  });

  it('extracts camelCase onSite / notOnSite', () => {
    const md = '---\nonSite: chrome\nnotOnSite: [evil.com]\n---\n';
    expect(extractSiteFrontmatter(md)).toEqual({
      onSite: ['chrome'],
      notOnSite: ['evil.com'],
    });
  });

  it('extracts both directives + multi-value', () => {
    const md =
      '---\n' +
      'name: foo\n' +
      'on-site: [reddit.com, *.reddit.com, claude.ai/chat]\n' +
      'not-on-site: [evil.example]\n' +
      '---\n';
    expect(extractSiteFrontmatter(md)).toEqual({
      onSite: ['reddit.com', '*.reddit.com', 'claude.ai/chat'],
      notOnSite: ['evil.example'],
    });
  });

  it('handles trailing whitespace around colon', () => {
    const md = '---\non-site : [reddit.com]\n---\n';
    expect(extractSiteFrontmatter(md)).toEqual({ onSite: ['reddit.com'] });
  });

  it('extracts from inner field even when other fields share substrings', () => {
    const md = '---\nname: on-site-helper\non-site: [reddit.com]\n---\n';
    expect(extractSiteFrontmatter(md)).toEqual({ onSite: ['reddit.com'] });
  });
});

describe('applySiteCompatFilter', () => {
  const chromeOnReddit = {
    hostName: 'chrome' as const,
    hostname: 'reddit.com',
    path: '/r/x',
  };
  const chromeOnClaude = {
    hostName: 'chrome' as const,
    hostname: 'claude.ai',
    path: '/chat/abc',
  };

  it('passes files without site frontmatter through unchanged', () => {
    const files = {
      'blanks/foo/BLANK.md': '---\nname: foo\n---\n',
    };
    expect(applySiteCompatFilter(files, chromeOnReddit)).toEqual(files);
  });

  it('drops files whose on-site list does not match the current location', () => {
    const files = {
      'blanks/x/BLANK.md': '---\nname: x\non-site: [claude.ai]\n---\n',
      'blanks/y/BLANK.md': '---\nname: y\n---\n',
    };
    const out = applySiteCompatFilter(files, chromeOnReddit);
    expect(Object.keys(out)).toEqual(['blanks/y/BLANK.md']);
  });

  it('drops files whose not-on-site matches the current location', () => {
    const files = {
      'blanks/volume/BLANK.md':
        '---\nname: volume\nnot-on-site: [claude.ai]\n---\n',
    };
    expect(applySiteCompatFilter(files, chromeOnClaude)).toEqual({});
    expect(Object.keys(applySiteCompatFilter(files, chromeOnReddit)))
      .toEqual(['blanks/volume/BLANK.md']);
  });

  it('honours path-prefix entries', () => {
    const files = {
      'cues/a/CUE.md': '---\non-site: [reddit.com/r/claudeai]\n---\n',
    };
    const onReddit = { hostName: 'chrome' as const, hostname: 'reddit.com', path: '/r/claudeai/comments/123' };
    const onRedditOther = { hostName: 'chrome' as const, hostname: 'reddit.com', path: '/r/other' };
    expect(Object.keys(applySiteCompatFilter(files, onReddit))).toEqual(['cues/a/CUE.md']);
    expect(applySiteCompatFilter(files, onRedditOther)).toEqual({});
  });

  it('honours wildcard hostnames', () => {
    const files = {
      'cues/a/CUE.md': '---\non-site: [*.reddit.com]\n---\n',
    };
    const onWww = { hostName: 'chrome' as const, hostname: 'www.reddit.com', path: '/' };
    expect(Object.keys(applySiteCompatFilter(files, onWww))).toEqual(['cues/a/CUE.md']);
  });

  it('passes everything on a native host with platform-name entries', () => {
    const files = {
      'blanks/x/BLANK.md': '---\non-site: [claude-code]\n---\n',
      'blanks/y/BLANK.md': '---\non-site: [chrome]\n---\n',
    };
    const onCC = { hostName: 'claude-code' as const, hostname: null, path: null };
    expect(Object.keys(applySiteCompatFilter(files, onCC))).toEqual(['blanks/x/BLANK.md']);
  });

  it('regression: YAML-array form [claude.ai] (unquoted) was previously parsed as ["[claude.ai]"]', () => {
    // This is the bug the user caught: the bracket-strip fallback was
    // missing in the chrome bootstrap's inline parser. The single
    // entry `[claude.ai]` was treated as the literal string with
    // brackets, never matching the real hostname.
    const files = {
      'blanks/volume/BLANK.md':
        '---\nname: volume\nnot-on-site: [claude.ai]\n---\n',
    };
    expect(applySiteCompatFilter(files, chromeOnClaude)).toEqual({});
  });
});

/**
 * Tests for discover.ts — folder-based config discovery
 *
 * Run with: node --test dist/discover.test.js
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseSingleCueMd } from './cues-md';
import { discoverFolderConfigs, mergeConfigs, type DiscoverOptions, type DirEntry } from './discover';

// ============================================================================
// parseSingleCueMd
// ============================================================================

describe('parseSingleCueMd: prompt type', () => {
  it('should parse frontmatter into SourceConfig', () => {
    const content = `---
name: math
scope: blanks
parser: math
priority: 90
match: \\d+\\s*[+\\-*/]\\s*\\d+
keywords: factorial, average
---

Solve the math expression. Output ONLY: COMPUTE=expression
`;
    const config = parseSingleCueMd(content, '/test/blanks/math');
    assert.ok(config.promptConfig);
    const source = config.promptConfig!.sources['math'];
    assert.ok(source);
    assert.strictEqual(source.name, 'math');
    assert.strictEqual(source.scope, 'blanks');
    assert.strictEqual(source.parser, 'math');
    assert.strictEqual(source.priority, 90);
    assert.ok(source.match);
    assert.ok(source.keywords);
    assert.ok(source.promptText?.includes('COMPUTE=expression'));
  });

  it('should default type to prompt', () => {
    const content = `---
name: grammar
priority: 50
---

Give word alternatives.
`;
    const config = parseSingleCueMd(content, '/test');
    assert.ok(config.promptConfig);
    assert.ok(config.promptConfig!.sources['grammar']);
  });

  it('should resolve relative promptPath', () => {
    const content = `---
name: legal
promptPath: ./legal-terms.txt
---
`;
    const config = parseSingleCueMd(content, '/project/cues/legal');
    const source = config.promptConfig!.sources['legal'];
    assert.strictEqual(source.promptPath, '/project/cues/legal/legal-terms.txt');
  });

  it('should keep absolute promptPath unchanged', () => {
    const content = `---
name: legal
promptPath: /opt/prompts/legal.txt
---
`;
    const config = parseSingleCueMd(content, '/project/cues/legal');
    const source = config.promptConfig!.sources['legal'];
    assert.strictEqual(source.promptPath, '/opt/prompts/legal.txt');
  });
});

describe('parseSingleCueMd: tips type', () => {
  it('should parse tips JSON from body', () => {
    const content = `---
name: extended-thinking
type: tips
---

\`\`\`json
[{ "id": "thinking", "words": { "ultrathink": { "tip": "Max reasoning", "alts": ["think harder"] } } }]
\`\`\`
`;
    const config = parseSingleCueMd(content, '/test');
    assert.ok(config.tips);
    assert.strictEqual(config.tips!.length, 1);
    assert.strictEqual(config.tips![0].id, 'thinking');
  });

  it('should return no promptConfig for tips type', () => {
    const content = `---
name: tips
type: tips
---

\`\`\`json
[{ "id": "t", "words": {} }]
\`\`\`
`;
    const config = parseSingleCueMd(content, '/test');
    assert.strictEqual(config.promptConfig, undefined);
  });
});

describe('parseSingleCueMd: control type', () => {
  it('should parse control config from frontmatter', () => {
    const content = `---
name: volume
type: control
control: volume
tip: system volume control
script: ./volume.sh
upArgs: ["up", "6"]
downArgs: ["down", "6"]
---
`;
    const config = parseSingleCueMd(content, '/project/blanks/volume');
    assert.ok(config.controls);
    const ctrl = config.controls!['volume'];
    assert.ok(ctrl);
    assert.strictEqual(ctrl.control, 'volume');
    assert.strictEqual(ctrl.tip, 'system volume control');
    assert.strictEqual(ctrl.script, '/project/blanks/volume/volume.sh');
    assert.deepStrictEqual(ctrl.upArgs, ['up', '6']);
    assert.deepStrictEqual(ctrl.downArgs, ['down', '6']);
  });

  it('should resolve relative script path', () => {
    const content = `---
name: speak
type: control
control: speak
script: ./speak.sh
---
`;
    const config = parseSingleCueMd(content, '/project/blanks/speak');
    assert.strictEqual(config.controls!['speak'].script, '/project/blanks/speak/speak.sh');
  });

  it('should keep absolute script path unchanged', () => {
    const content = `---
name: custom
type: control
control: custom
script: /opt/scripts/custom.sh
---
`;
    const config = parseSingleCueMd(content, '/project/blanks/custom');
    assert.strictEqual(config.controls!['custom'].script, '/opt/scripts/custom.sh');
  });
});

describe('parseSingleCueMd: ignore section', () => {
  it('should parse ## Ignore from body', () => {
    const content = `---
name: grammar
---

Give alternatives.

## Ignore
Claude
Anthropic
OpenCues
`;
    const config = parseSingleCueMd(content, '/test');
    assert.ok(config.ignore);
    assert.ok(config.ignore!.includes('Claude'));
    assert.ok(config.ignore!.includes('Anthropic'));
  });
});

// ============================================================================
// discoverFolderConfigs
// ============================================================================

function mockFs(files: Record<string, string>): DiscoverOptions {
  const dirs: Record<string, DirEntry[]> = {};

  // Build directory listings from file paths
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/');
      const entryName = parts[i];
      const isDir = i < parts.length - 1;
      if (!dirs[dirPath]) dirs[dirPath] = [];
      if (!dirs[dirPath].some(e => e.name === entryName)) {
        dirs[dirPath].push({ name: entryName, isDirectory: isDir });
      }
    }
  }

  return {
    basePath: '/project',
    readFile: (p) => files[p] ?? null,
    readDir: (p) => dirs[p] ?? null,
  };
}

describe('discoverFolderConfigs', () => {
  it('should discover blanks from blanks/ directory', () => {
    const opts = mockFs({
      '/project/blanks/math/cue.md': `---
name: math
scope: blanks
parser: math
priority: 90
---

Solve math.
`,
      '/project/blanks/factual/cue.md': `---
name: factual
scope: blanks
parser: answer
priority: 90
---

Answer factual questions.
`,
    });

    const result = discoverFolderConfigs(opts);
    assert.ok(result.blanksConfig);
    assert.ok(result.blanksConfig!.promptConfig);
    const sources = result.blanksConfig!.promptConfig!.sources;
    assert.ok(sources['math']);
    assert.ok(sources['factual']);
    assert.strictEqual(sources['math'].parser, 'math');
    assert.strictEqual(sources['factual'].parser, 'answer');
  });

  it('should discover controls with resolved script paths', () => {
    const opts = mockFs({
      '/project/blanks/volume/cue.md': `---
name: volume
type: control
control: volume
tip: volume control
script: ./volume.sh
upArgs: ["up", "5"]
downArgs: ["down", "5"]
---
`,
    });

    const result = discoverFolderConfigs(opts);
    assert.ok(result.controlOverrides);
    assert.ok(result.controlOverrides!['volume']);
    assert.strictEqual(
      result.controlOverrides!['volume'].script,
      '/project/blanks/volume/volume.sh'
    );
  });

  it('should discover cues from cues/ directory', () => {
    const opts = mockFs({
      '/project/cues/grammar/cue.md': `---
name: grammar
scope: words
priority: 50
---

Give alternatives.
`,
    });

    const result = discoverFolderConfigs(opts);
    assert.ok(result.cuesConfig);
    assert.ok(result.cuesConfig!.promptConfig!.sources['grammar']);
  });

  it('should return empty when no folders exist', () => {
    const opts: DiscoverOptions = {
      basePath: '/empty',
      readFile: () => null,
      readDir: () => null,
    };

    const result = discoverFolderConfigs(opts);
    assert.strictEqual(result.cuesConfig, undefined);
    assert.strictEqual(result.blanksConfig, undefined);
    assert.strictEqual(result.controlOverrides, undefined);
  });

  it('should skip directories without cue.md', () => {
    const opts = mockFs({
      '/project/blanks/math/cue.md': `---
name: math
parser: math
---

Solve.
`,
      '/project/blanks/readme.txt': 'not a cue',
    });

    const result = discoverFolderConfigs(opts);
    const sources = result.blanksConfig!.promptConfig!.sources;
    assert.strictEqual(Object.keys(sources).length, 1);
    assert.ok(sources['math']);
  });

  it('should default name to folder name when frontmatter has no name', () => {
    const opts = mockFs({
      '/project/blanks/custom-mode/cue.md': `---
parser: answer
priority: 80
---

Answer questions.
`,
    });

    const result = discoverFolderConfigs(opts);
    const sources = result.blanksConfig!.promptConfig!.sources;
    assert.ok(sources['custom-mode']);
    assert.strictEqual(sources['custom-mode'].name, 'custom-mode');
  });

  it('should collect ignore words from folder cue.md files', () => {
    const opts = mockFs({
      '/project/cues/grammar/cue.md': `---
name: grammar
---

Give alts.

## Ignore
Claude
Anthropic
`,
    });

    const result = discoverFolderConfigs(opts);
    assert.ok(result.ignoreWords);
    assert.ok(result.ignoreWords!.includes('Claude'));
    assert.ok(result.ignoreWords!.includes('Anthropic'));
  });
});

// ============================================================================
// mergeConfigs
// ============================================================================

describe('mergeConfigs', () => {
  it('should return monolithic when no folders', () => {
    const mono: ReturnType<typeof discoverFolderConfigs> = {
      cuesConfig: { frontmatter: {}, sections: {}, promptConfig: { sources: { grammar: { name: 'grammar', promptText: 'mono' } } } },
    };
    const result = mergeConfigs(mono, {});
    assert.strictEqual(result.cuesConfig!.promptConfig!.sources['grammar'].promptText, 'mono');
  });

  it('should return folders when no monolithic', () => {
    const folders: ReturnType<typeof discoverFolderConfigs> = {
      blanksConfig: { frontmatter: {}, sections: {}, promptConfig: { sources: { math: { name: 'math', parser: 'math' } } } },
    };
    const result = mergeConfigs({}, folders);
    assert.strictEqual(result.blanksConfig!.promptConfig!.sources['math'].parser, 'math');
  });

  it('should let folder override monolithic source by name', () => {
    const mono: ReturnType<typeof discoverFolderConfigs> = {
      cuesConfig: { frontmatter: {}, sections: {}, promptConfig: { sources: { grammar: { name: 'grammar', promptText: 'old' } } } },
    };
    const folders: ReturnType<typeof discoverFolderConfigs> = {
      cuesConfig: { frontmatter: {}, sections: {}, promptConfig: { sources: { grammar: { name: 'grammar', promptText: 'new' } } } },
    };
    const result = mergeConfigs(mono, folders);
    assert.strictEqual(result.cuesConfig!.promptConfig!.sources['grammar'].promptText, 'new');
  });

  it('should keep non-overlapping sources from both', () => {
    const mono: ReturnType<typeof discoverFolderConfigs> = {
      cuesConfig: { frontmatter: {}, sections: {}, promptConfig: { sources: { grammar: { name: 'grammar' } } } },
    };
    const folders: ReturnType<typeof discoverFolderConfigs> = {
      cuesConfig: { frontmatter: {}, sections: {}, promptConfig: { sources: { legal: { name: 'legal' } } } },
    };
    const result = mergeConfigs(mono, folders);
    assert.ok(result.cuesConfig!.promptConfig!.sources['grammar']);
    assert.ok(result.cuesConfig!.promptConfig!.sources['legal']);
  });

  it('should concatenate tips from both', () => {
    const mono: ReturnType<typeof discoverFolderConfigs> = {
      cuesConfig: { frontmatter: {}, sections: {}, tips: [{ id: 'a', words: {} }] },
    };
    const folders: ReturnType<typeof discoverFolderConfigs> = {
      cuesConfig: { frontmatter: {}, sections: {}, tips: [{ id: 'b', words: {} }] },
    };
    const result = mergeConfigs(mono, folders);
    assert.strictEqual(result.cuesConfig!.tips!.length, 2);
    assert.strictEqual(result.cuesConfig!.tips![0].id, 'a');
    assert.strictEqual(result.cuesConfig!.tips![1].id, 'b');
  });

  it('should merge control overrides with folder winning', () => {
    const mono: ReturnType<typeof discoverFolderConfigs> = {
      controlOverrides: { volume: { control: 'volume', tip: 'old' } },
    };
    const folders: ReturnType<typeof discoverFolderConfigs> = {
      controlOverrides: { volume: { control: 'volume', tip: 'new' } },
    };
    const result = mergeConfigs(mono, folders);
    assert.strictEqual(result.controlOverrides!['volume'].tip, 'new');
  });

  it('should union ignore words', () => {
    const mono: ReturnType<typeof discoverFolderConfigs> = {
      ignoreWords: ['claude', 'anthropic'],
    };
    const folders: ReturnType<typeof discoverFolderConfigs> = {
      ignoreWords: ['anthropic', 'opencues'],
    };
    const result = mergeConfigs(mono, folders);
    assert.strictEqual(result.ignoreWords!.length, 3);
    assert.ok(result.ignoreWords!.includes('claude'));
    assert.ok(result.ignoreWords!.includes('opencues'));
  });
});

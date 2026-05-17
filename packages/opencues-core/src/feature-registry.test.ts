import { describe, it, expect } from 'vitest';
import {
  CORE_CONFIG_FILES,
  CORE_TEMPLATES,
  FEATURES,
  findFeature,
  chromeHostFileList,
  allConfigFileBasenames,
  seedableOptionalFiles,
} from './feature-registry';

describe('feature-registry shape', () => {
  it('every feature has a scalar, camelCase, values, default, description', () => {
    for (const f of FEATURES) {
      expect(f.scalar).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(f.camelCase).toMatch(/^[a-z][a-zA-Z0-9]*$/);
      expect(f.values.length).toBeGreaterThan(0);
      expect(f.description.length).toBeGreaterThan(0);
    }
  });

  it('scalar names are unique', () => {
    const scalars = FEATURES.map(f => f.scalar);
    expect(new Set(scalars).size).toBe(scalars.length);
  });

  it('camelCase names are unique', () => {
    const names = FEATURES.map(f => f.camelCase);
    expect(new Set(names).size).toBe(names.length);
  });

  it('camelCase form matches scalar (kebab→camel)', () => {
    for (const f of FEATURES) {
      const derived = f.scalar.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      expect(f.camelCase, `feature ${f.scalar}`).toBe(derived);
    }
  });
});

describe('feature-registry lookups', () => {
  it('findFeature returns the right entry', () => {
    expect(findFeature('user-context-mode')?.camelCase).toBe('userContextMode');
    expect(findFeature('does-not-exist')).toBeUndefined();
  });

  it('chromeHostFileList includes core files + chrome-host-pushed feature files', () => {
    const list = chromeHostFileList();
    for (const f of CORE_CONFIG_FILES) expect(list).toContain(f);
    // user-context-mode declares pushedBy chrome-host → USER.md must be in the list
    expect(list).toContain('USER.md');
  });

  it('chromeHostFileList does NOT include native-only or non-pushed files', () => {
    const list = chromeHostFileList();
    // Hypothetical: a feature with prereqFile but no pushedBy should NOT
    // appear. None today, but the lookup logic should be correct.
    const nonPushed = FEATURES.filter(f => f.prereqFile && !f.pushedBy?.includes('chrome-host'));
    for (const f of nonPushed) {
      expect(list).not.toContain(f.prereqFile!.basename);
    }
  });

  it('allConfigFileBasenames is a superset of chromeHostFileList', () => {
    const all = new Set(allConfigFileBasenames());
    for (const f of chromeHostFileList()) {
      expect(all.has(f)).toBe(true);
    }
  });
});

describe('feature-registry — seedable files', () => {
  it('includes every core file with a template', () => {
    const seeds = seedableOptionalFiles();
    for (const [basename, template] of Object.entries(CORE_TEMPLATES)) {
      const entry = seeds.find(s => s.basename === basename);
      expect(entry, `core file ${basename} missing from seedables`).toBeDefined();
      expect(entry?.template).toBe(template);
    }
  });

  it('includes every feature with prereqFile.template', () => {
    const seeds = seedableOptionalFiles();
    for (const f of FEATURES) {
      if (!f.prereqFile?.template) continue;
      const entry = seeds.find(s => s.basename === f.prereqFile!.basename);
      expect(entry, `feature ${f.scalar} prereq ${f.prereqFile.basename} missing`).toBeDefined();
      expect(entry?.template).toBe(f.prereqFile.template);
      expect(entry?.mustHavePopulatedFields).toBe(f.prereqFile.mustHavePopulatedFields);
    }
  });

  it('contains AUDITORS.md (core) + USER.md (feature)', () => {
    const seeds = seedableOptionalFiles().map(s => s.basename);
    expect(seeds).toContain('AUDITORS.md');
    expect(seeds).toContain('USER.md');
  });
});

describe('feature-registry — the canonical features must exist', () => {
  // These are the features wired into the runtime today. If any one is
  // removed from FEATURES, ConfigLoader / FluidBlankSource / chrome-host
  // wiring breaks silently. This test pins the floor.
  const canonical = [
    'fluid-blank-mode',
    'word-cues-mode',
    'tips-mode',
    'voice-mode',
    'cursor-navigate',
    'debug-mode',
    'ambient-context-mode',
    'user-context-mode',
  ];

  for (const scalar of canonical) {
    it(`${scalar} is in the registry`, () => {
      expect(findFeature(scalar), `missing canonical feature ${scalar}`).toBeDefined();
    });
  }
});

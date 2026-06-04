import { describe, it, expect } from 'vitest';
import {
  CORE_CONFIG_FILES,
  CORE_TEMPLATES,
  FEATURES,
  findFeature,
  chromeHostFileList,
  allConfigFileBasenames,
  seedableOptionalFiles,
  getMenuDefinitions,
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
    expect(findFeature('identity-context-mode')?.camelCase).toBe('identityContextMode');
    expect(findFeature('does-not-exist')).toBeUndefined();
  });

  it('chromeHostFileList includes core files + chrome-host-pushed feature files', () => {
    const list = chromeHostFileList();
    for (const f of CORE_CONFIG_FILES) expect(list).toContain(f);
    // identity-context-mode declares pushedBy chrome-host → IDENTITY.md must be in the list
    expect(list).toContain('IDENTITY.md');
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

  it('contains AUDITORS.md (core) + IDENTITY.md (feature)', () => {
    const seeds = seedableOptionalFiles().map(s => s.basename);
    expect(seeds).toContain('AUDITORS.md');
    expect(seeds).toContain('IDENTITY.md');
  });
});

describe('feature-registry — valuesProvider for *-llm-model scalars', () => {
  // The three `*-llm-model` features derive their cyclable values from
  // the sibling provider's `knownModels`. Without these tests, a refactor
  // could silently make the model menu show stale, empty, or wrong
  // model lists — invalid (provider, model) pairs would land in
  // OPENCUES.md, then 400-error at LLM dispatch time.

  it('every *-llm-model feature has a valuesProvider', () => {
    const modelFeatures = FEATURES.filter(f => /-llm-model$/.test(f.scalar));
    expect(modelFeatures.length, 'expected 3 model-bucket FEATURES (cues/auditors/blanks)').toBe(3);
    for (const f of modelFeatures) {
      expect(f.valuesProvider, `${f.scalar} must declare valuesProvider`).toBeDefined();
    }
  });

  it('default is always the first cyclable value (so reset-to-default is one Up press)', () => {
    for (const f of FEATURES.filter(x => x.valuesProvider)) {
      const values = f.valuesProvider!(new Map([['cues-llm-provider', 'anthropic'], ['auditors-llm-provider', 'anthropic'], ['blanks-llm-provider', 'anthropic']]));
      expect(values[0]?.id, `${f.scalar} first value should be 'default'`).toBe('default');
    }
  });

  it('auditors-llm-model with auditors-llm-provider=anthropic enumerates anthropic\'s knownModels', () => {
    const auditors = findFeature('auditors-llm-model');
    expect(auditors?.valuesProvider).toBeDefined();
    const settings = new Map([['auditors-llm-provider', 'anthropic']]);
    const values = auditors!.valuesProvider!(settings);
    const ids = values.map(v => v.id);
    expect(ids).toContain('default');
    // anthropic.knownModels is currently [haiku, sonnet, opus]. The
    // specific model ids change with the catalogue but the count should
    // be >1 — otherwise the menu can't cycle anywhere.
    expect(ids.length, 'anthropic should have ≥2 known models').toBeGreaterThanOrEqual(2);
    expect(ids.some(id => id.includes('claude')), 'expected at least one claude-* model id').toBe(true);
  });

  it('switching the provider reshapes the model menu', () => {
    const blanks = findFeature('blanks-llm-model');
    const anthropicValues = blanks!.valuesProvider!(new Map([['blanks-llm-provider', 'anthropic']]));
    const groqValues = blanks!.valuesProvider!(new Map([['blanks-llm-provider', 'groq']]));
    const anthropicIds = anthropicValues.map(v => v.id);
    const groqIds = groqValues.map(v => v.id);
    // The two menus should be visibly different — no overlap except 'default'.
    const overlap = anthropicIds.filter(id => groqIds.includes(id) && id !== 'default');
    expect(overlap, `expected disjoint model lists for anthropic vs groq, got overlap: ${overlap.join(',')}`).toHaveLength(0);
  });

  it('unknown provider falls through cleanly to default-only menu (no crash)', () => {
    const cues = findFeature('cues-llm-model');
    const values = cues!.valuesProvider!(new Map([['cues-llm-provider', 'not-a-real-provider']]));
    // With no resolvable provider, we still get at least `default` so
    // the menu is non-empty and cycling.ts doesn't see a 0-length list.
    expect(values.length).toBeGreaterThanOrEqual(1);
    expect(values[0]?.id).toBe('default');
  });

  it('inherit provider resolves to global llm-provider for model menu', () => {
    const cues = findFeature('cues-llm-model');
    // cues-llm-provider = inherit means "use global llm-provider".
    // The valuesProvider should follow that fallback so the model menu
    // reflects what the resolver will actually dispatch to.
    const inheritOnly = cues!.valuesProvider!(new Map([['cues-llm-provider', 'inherit']]));
    const withGlobal = cues!.valuesProvider!(new Map([['cues-llm-provider', 'inherit'], ['llm-provider', 'openai']]));
    // With no global fallback, default-only.
    expect(inheritOnly.length).toBeGreaterThanOrEqual(1);
    expect(inheritOnly[0]?.id).toBe('default');
    // With global=openai, the menu enumerates openai's knownModels.
    const ids = withGlobal.map(v => v.id);
    expect(ids.some(id => id.includes('gpt')), `expected openai gpt-* model id, got ${ids.join(',')}`).toBe(true);
  });
});

describe('getMenuDefinitions — settings-aware', () => {
  it('with no settings argument, dynamic features fall back to default-only', () => {
    const menu = getMenuDefinitions();
    const auditorsModel = menu.get('auditors-llm-model');
    expect(auditorsModel).toBeDefined();
    expect(auditorsModel!.valueOrder[0]).toBe('default');
  });

  it('with settings naming a provider, the model menu reflects that provider', () => {
    const settings = new Map([['blanks-llm-provider', 'gemini']]);
    const menu = getMenuDefinitions(undefined, settings);
    const blanksModel = menu.get('blanks-llm-model');
    expect(blanksModel).toBeDefined();
    expect(blanksModel!.valueOrder.some(v => v.includes('gemini')), `expected gemini-* model in menu`).toBe(true);
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
    'identity-context-mode',
  ];

  for (const scalar of canonical) {
    it(`${scalar} is in the registry`, () => {
      expect(findFeature(scalar), `missing canonical feature ${scalar}`).toBeDefined();
    });
  }
});

/**
 * Conformance runner — exercises @opencues/core against the spec/conformance/
 * fixture tree. Reference implementation must pass its own spec.
 *
 * Vitest-style test. Add to vitest.config.ts include glob to run with
 * `vitest run` from packages/opencues-core/.
 *
 * What this runner DOES:
 *
 *   - valid/: every CUE.md / BLANK.md / AUDITOR.md / master file parses
 *     without throwing and produces the expected structural shape.
 *   - invalid/: every fixture trips a structural check the reference impl
 *     can detect today, including all `core.md` lint rules
 *     (cue-missing-name, cue-missing-trigger, cue-empty-body, unknown-host,
 *     spec-too-new, blank-missing-name, blank-missing-keywords,
 *     blank-multiple-bindings, blank-no-binding, blank-script-missing,
 *     auditor-missing-name, auditor-empty-body). Some are exercised via
 *     structural absence checks on the parsed config rather than
 *     parser-emitted rule codes (the parsers themselves don't yet emit
 *     rule codes — that's an `opencues validate` CLI concern).
 *   - wire/parser-alternatives.json: parseAlternatives output structurally
 *     matches expected for every case.
 *   - routing/*.json: scenarios exercise the spec's routing algorithm. The
 *     algorithm itself is implemented inline here (the runtime's
 *     RoutedWordSourceGroup lives in @opencues/runtime); a future runtime-
 *     side runner SHOULD exercise the same fixtures against the runtime's
 *     dispatcher.
 *
 * What this runner does NOT do:
 *
 *   - Wire it to the runtime's full surface — that requires an
 *     @opencues/runtime test that imports HostAdapter, instantiates
 *     RoutedWordSourceGroup, etc. Out of scope for the core's runner.
 *   - Exercise auditor composition (isolated vs composed mode) — runtime
 *     concern.
 *   - Test hot-reload, cycling, span machinery — all runtime.
 */

import { describe, it, expect, test } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseSingleCueMd, parseSingleAuditorMd, parseCuesMaster, parseBlanksMaster, parseAuditorsMaster, type SingleCueFrontmatter } from './cues-md';
import { parseAlternatives } from './sources/parsers';
import { unknownHostNames } from './host-compat';

// Path to spec/conformance/, resolved from this file's location at
// packages/opencues-core/src/conformance.test.ts
const ROOT = join(__dirname, '..', '..', '..', 'spec', 'conformance');

// ─── valid/ fixtures — MUST be accepted ─────────────────────────────────────

describe('valid/cue/*.md', () => {
  const dir = join(ROOT, 'valid', 'cue');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    it(`${file} parses without throwing`, () => {
      const content = readFileSync(join(dir, file), 'utf8');
      const config = parseSingleCueMd(content, dir, file.replace('.md', ''));
      // Must produce frontmatter
      expect(config.frontmatter).toBeDefined();
      expect(config.frontmatter.name).toBeTruthy();
      // Must produce at least one behaviour: tips (static) OR promptConfig (LLM)
      const hasTips = config.tips && config.tips.length > 0;
      const hasPrompt = config.promptConfig && Object.keys(config.promptConfig.sources).length > 0;
      expect(hasTips || hasPrompt).toBe(true);
    });
  }
});

describe('valid/blank/*.md', () => {
  const dir = join(ROOT, 'valid', 'blank');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    it(`${file} parses without throwing`, () => {
      const content = readFileSync(join(dir, file), 'utf8');
      const config = parseSingleCueMd(content, dir, file.replace('.md', ''));
      expect(config.frontmatter).toBeDefined();
      expect(config.frontmatter.name).toBeTruthy();
      // Blanks land under config.blanks
      expect(config.blanks).toBeDefined();
      const blankNames = Object.keys(config.blanks ?? {});
      expect(blankNames.length).toBeGreaterThan(0);
    });
  }
});

describe('valid/auditor/*.md', () => {
  const dir = join(ROOT, 'valid', 'auditor');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    it(`${file} parses without throwing`, () => {
      const content = readFileSync(join(dir, file), 'utf8');
      const config = parseSingleAuditorMd(content, dir, file.replace('.md', ''));
      expect(config.frontmatter).toBeDefined();
      expect(config.frontmatter.name).toBeTruthy();
      expect(config.auditors).toBeDefined();
      const auditorNames = Object.keys(config.auditors ?? {});
      expect(auditorNames.length).toBeGreaterThan(0);
    });
  }
});

describe('valid/masters/*.md', () => {
  const dir = join(ROOT, 'valid', 'masters');
  it('CUES.md parses without throwing', () => {
    const content = readFileSync(join(dir, 'CUES.md'), 'utf8');
    expect(() => parseCuesMaster(content)).not.toThrow();
  });
  it('BLANKS.md parses without throwing', () => {
    const content = readFileSync(join(dir, 'BLANKS.md'), 'utf8');
    expect(() => parseBlanksMaster(content)).not.toThrow();
  });
  it('AUDITORS.md parses without throwing', () => {
    const content = readFileSync(join(dir, 'AUDITORS.md'), 'utf8');
    expect(() => parseAuditorsMaster(content)).not.toThrow();
  });
  // OPENCUES.md is non-normative (lives outside spec/) — we don't parse
  // it through the spec parsers. The fixture exists for runtime tests
  // that want a canonical example.
});

// ─── invalid/ fixtures — MUST be rejected (with the expected rule code) ─────

type ExpectedRejection = { rule: string; severity: 'error' | 'warn'; summary: string };

function loadInvalid(surface: 'cue' | 'blank' | 'auditor'): Array<{ file: string; content: string; expected: ExpectedRejection }> {
  const dir = join(ROOT, 'invalid', surface);
  const out: Array<{ file: string; content: string; expected: ExpectedRejection }> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const expectedFile = file.replace('.md', '.expected.json');
    out.push({
      file,
      content: readFileSync(join(dir, file), 'utf8'),
      expected: JSON.parse(readFileSync(join(dir, expectedFile), 'utf8')),
    });
  }
  return out;
}

describe('invalid/cue/*.md', () => {
  for (const { file, content, expected } of loadInvalid('cue')) {
    // The reference impl's parsers don't emit linter rule codes today —
    // validation lives in `opencues validate` (the CLI) rather than in
    // parseSingleCueMd. The runner here checks the STRUCTURAL gap that
    // each rule would surface; full rule-code emission is a parser-side
    // gap the conformance suite makes visible.
    switch (expected.rule) {
      case 'cue-missing-trigger': {
        it(`${file} has no match or keywords`, () => {
          const config = parseSingleCueMd(content, ROOT, 'invalid');
          // The trigger lives on the parsed SourceConfig under promptConfig.sources
          const src = config.promptConfig?.sources && Object.values(config.promptConfig.sources)[0];
          const hasTrigger = !!(src?.match || src?.keywords);
          expect(hasTrigger).toBe(false);
        });
        break;
      }
      case 'cue-empty-body': {
        it(`${file} produces neither tips nor a non-empty prompt`, () => {
          const config = parseSingleCueMd(content, ROOT, 'invalid');
          const hasTips = config.tips && config.tips.length > 0;
          const src = config.promptConfig?.sources && Object.values(config.promptConfig.sources)[0];
          const hasPromptText = !!(src?.promptText && src.promptText.trim().length > 0);
          expect(hasTips || hasPromptText).toBeFalsy();
        });
        break;
      }
      case 'unknown-host': {
        it(`${file} on-host lists an unknown host name`, () => {
          const config = parseSingleCueMd(content, ROOT, 'invalid');
          // parseSingleCueMd uses parseExtendedFrontmatter under the hood,
          // which populates SingleCueFrontmatter (a superset of
          // CuesMdFrontmatter that includes onHost). The static type on
          // config.frontmatter is the narrower base; cast to read the
          // extended field.
          const fm = config.frontmatter as { onHost?: string[] };
          expect(fm.onHost).toBeDefined();
          const unknown = unknownHostNames(fm.onHost ?? []);
          expect(unknown.length).toBeGreaterThan(0);
        });
        break;
      }
      case 'cue-missing-name': {
        it(`${file} has no name in frontmatter`, () => {
          const config = parseSingleCueMd(content, ROOT, 'invalid');
          // The third arg supplies a nameOverride for the runtime-resolved
          // name, but config.frontmatter.name reflects what the YAML
          // actually declared (undefined when omitted).
          expect(config.frontmatter.name).toBeFalsy();
        });
        break;
      }
      case 'spec-too-new': {
        it(`${file} is REFUSED by parseSingleCueMd via the spec-version gate`, () => {
          // Actually exercise the runtime. The parser MUST populate
          // `specError` on too-new files and leave the rest of the
          // config empty so callers skip the source. This pins the
          // SPEC.md § Version policy "MUST refuse newer" rule to
          // executable behaviour, not just fixture shape.
          const config = parseSingleCueMd(content, ROOT, file.replace('.md', ''));
          expect(config.specError).toBeTruthy();
          // The refusal reason MUST mention the offending version so
          // log readers can identify the source.
          const m = content.match(/^\s*spec\s*:\s*(opencues\/\S+)/m);
          expect(m).toBeTruthy();
          expect(config.specError!).toContain(m![1]);
          // Defence-in-depth: when refused, the parser MUST NOT have
          // populated any sources / blanks / auditors — a too-new
          // file is invisible to the runtime, not partially loaded.
          expect(config.promptConfig?.sources ?? {}).toEqual({});
          expect(config.blanks ?? {}).toEqual({});
          expect(config.auditors ?? {}).toEqual({});
        });
        break;
      }
      default: {
        test.todo(`${file} — unhandled rule code '${expected.rule}' in conformance runner`);
      }
    }
  }
});

describe('invalid/blank/*.md', () => {
  for (const { file, content, expected } of loadInvalid('blank')) {
    switch (expected.rule) {
      case 'blank-missing-keywords': {
        it(`${file} has no blankKeywords`, () => {
          const config = parseSingleCueMd(content, ROOT, 'invalid');
          const blank = config.blanks && Object.values(config.blanks)[0];
          // Either the parser produced no blank, or the blank has no keywords
          const hasKeywords = !!(blank?.blankKeywords && blank.blankKeywords.length > 0);
          expect(hasKeywords).toBe(false);
        });
        break;
      }
      case 'blank-multiple-bindings': {
        it(`${file} declares more than one binding profile`, () => {
          // Read frontmatter directly — the parser's preference rules
          // would collapse multi-bindings into one; we want to detect
          // the structural conflict in the source.
          const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          expect(fmMatch).toBeTruthy();
          const fm = fmMatch![1];
          const profiles = [
            /^\s*stepValues\s*:/m.test(fm),
            /^\s*blankScript\s*:/m.test(fm),
            /^\s*impl\s*:/m.test(fm),
          ].filter(Boolean).length;
          expect(profiles).toBeGreaterThan(1);
        });
        break;
      }
      case 'blank-missing-name': {
        it(`${file} has no name in frontmatter`, () => {
          const config = parseSingleCueMd(content, ROOT, 'invalid');
          expect(config.frontmatter.name).toBeFalsy();
        });
        break;
      }
      case 'blank-no-binding': {
        it(`${file} declares none of stepValues / blankScript / impl`, () => {
          const config = parseSingleCueMd(content, ROOT, 'invalid');
          const fm = config.frontmatter as SingleCueFrontmatter;
          const profiles = [fm.stepValues, fm.blankScript, fm.impl]
            .filter(p => p !== undefined).length;
          expect(profiles).toBe(0);
        });
        break;
      }
      case 'blank-script-missing': {
        it(`${file} blankScript references a path that does not exist on disk`, () => {
          const config = parseSingleCueMd(content, ROOT, 'invalid');
          const rawPath = (config.frontmatter as SingleCueFrontmatter).blankScript;
          expect(rawPath).toBeTruthy();
          // Resolve relative to the fixture's folder (invalid/blank/)
          const fixtureDir = join(ROOT, 'invalid', 'blank');
          const resolved = rawPath!.startsWith('./')
            ? join(fixtureDir, rawPath!.slice(2))
            : join(fixtureDir, rawPath!);
          expect(existsSync(resolved)).toBe(false);
        });
        break;
      }
      default: {
        test.todo(`${file} — unhandled rule code '${expected.rule}' in conformance runner`);
      }
    }
  }
});

describe('invalid/auditor/*.md', () => {
  for (const { file, content, expected } of loadInvalid('auditor')) {
    switch (expected.rule) {
      case 'auditor-empty-body': {
        it(`${file} has empty body`, () => {
          const config = parseSingleAuditorMd(content, ROOT, 'invalid');
          const auditor = config.auditors && Object.values(config.auditors)[0];
          // AuditorConfig stores the body in `promptText`, not `prompt`.
          const hasBody = !!(auditor?.promptText && auditor.promptText.trim().length > 0);
          expect(hasBody).toBe(false);
        });
        break;
      }
      case 'auditor-missing-name': {
        it(`${file} has no name in frontmatter`, () => {
          const config = parseSingleAuditorMd(content, ROOT, 'invalid');
          expect(config.frontmatter.name).toBeFalsy();
        });
        break;
      }
      default: {
        test.todo(`${file} — unhandled rule code '${expected.rule}' in conformance runner`);
      }
    }
  }
});

// ─── wire/parser-alternatives.json ──────────────────────────────────────────

describe('wire/parser-alternatives.json', () => {
  type WireCase = { description: string; input: string; words?: string[]; expected: Array<{ wordIndex: number; alts: string[] }> };
  const cases: WireCase[] = JSON.parse(
    readFileSync(join(ROOT, 'wire', 'parser-alternatives.json'), 'utf8'),
  );

  for (const { description, input, words, expected } of cases) {
    it(description, () => {
      // Synthesize a words[] array if the fixture didn't pin one. Must
      // be long enough to cover the highest index referenced in `input`.
      const maxIdx = Math.max(0, ...expected.map(e => e.wordIndex), ...input.split('\n').map(l => {
        const m = l.match(/^\s*(\d+)/);
        return m ? parseInt(m[1], 10) : 0;
      }));
      const synth = Array.from({ length: maxIdx + 1 }, (_, i) => `word${i}`);
      const wordsArr = words ?? synth;

      const actual = parseAlternatives(input, wordsArr);

      // Normalise actual → array of {wordIndex, alts} where alts = alternatives[1..]
      // (alternatives[0] is the original word per spec § Alternatives invariant,
      // injected by the parser; wire fixtures omit it.)
      const actualNormalised = actual.map(r => ({
        wordIndex: r.wordIndex,
        alts: r.alternatives.slice(1),
      }));

      expect(actualNormalised).toEqual(expected);
    });
  }
});

// ─── routing/*.json ─────────────────────────────────────────────────────────

/**
 * Spec routing algorithm (per core.md § Routing): every source MUST declare
 * `match:` or `keywords:`; among those that match the word, the highest
 * `priority:` wins; ties resolve in declaration order. Catch-all behaviour
 * is expressed as `match: .*` at a low priority — there is no implicit
 * DEFAULT-via-field-absence. Sources without a trigger are rejected at
 * construction time (see build-sources.ts and the `cue-missing-trigger`
 * lint rule); this routing function never sees them.
 *
 * Implemented inline here because the reference RUNTIME's
 * RoutedWordSourceGroup lives in @opencues/runtime, not core. A second
 * runner (in opencues-runtime) SHOULD exercise the same routing fixtures
 * against the runtime's actual dispatcher to prove the runtime implements
 * the spec algorithm; this runner proves the algorithm itself is
 * unambiguous and the fixtures self-consistent.
 */
function routeWord(sources: Array<{ name: string; priority?: number; match?: string; keywords?: string | string[] }>, word: string): string | null {
  const matching = sources.filter(s => {
    if (s.match) {
      try {
        return new RegExp(`^(${s.match})$`, 'i').test(word);
      } catch {
        return false;
      }
    }
    if (s.keywords) {
      const list = Array.isArray(s.keywords) ? s.keywords : s.keywords.split(',').map(k => k.trim());
      return list.map(k => k.toLowerCase()).includes(word.toLowerCase());
    }
    // Sources without match/keywords would be rejected at construction time
    // upstream; defensively drop here too.
    return false;
  });

  if (matching.length === 0) return null;

  // Sort by priority descending; stable sort preserves declaration order on ties.
  const sorted = [...matching].sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));
  return sorted[0].name;
}

/**
 * Spec blank routing algorithm — LINE-SCOPED shapes. A blank claims a `_`
 * when one of its keywords (or an explicit `blankShapes` pattern) leads the
 * LINE containing `_`, with `_` at the trailing edge. Keywords desugar to
 * the standard shape `^<kw>( <args>)? _$`. A command must lead its line;
 * prose that merely mentions a keyword mid-line does not fire. Mirrors
 * `matchBlankShape` + `synthesizeKeywordShapes` in the reference runtime.
 * Implemented inline so this runner validates the fixtures self-consistently;
 * a second runner SHOULD exercise the same fixtures against its dispatcher.
 */
function routeBlank(blanks: Array<{ name: string; blankKeywords?: string[]; blankShapes?: Array<{ pattern: string }> }>, text: string): string | null {
  const us = text.lastIndexOf('_');
  if (us === -1) return null;
  const start = text.lastIndexOf('\n', us) + 1;
  let end = text.indexOf('\n', us);
  if (end === -1) end = text.length;
  const line = text.slice(start, end).trim().toLowerCase();
  if (!line.endsWith('_')) return null;

  for (const blank of blanks) {
    // Explicit shapes win.
    for (const shape of blank.blankShapes ?? []) {
      try { if (new RegExp(shape.pattern, 'i').test(line)) return blank.name; } catch { /* skip bad pattern */ }
    }
    // Synthesized keyword shapes: keyword leads the line, `_` at the end.
    for (const kw of blank.blankKeywords ?? []) {
      const k = kw.toLowerCase();
      if (line === `${k} _` || (line.startsWith(`${k} `) && line.endsWith(' _'))) return blank.name;
    }
  }
  return null;
}

describe('routing/*.json', () => {
  const dir = join(ROOT, 'routing');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const scenario = JSON.parse(readFileSync(join(dir, file), 'utf8'));

    describe(`${file}: ${scenario.description}`, () => {
      for (const exp of scenario.expectations) {
        if ('word' in exp) {
          // Cue routing
          it(`'${exp.word}' routes to ${exp.routesTo}`, () => {
            const actual = routeWord(scenario.sources ?? [], exp.word);
            expect(actual).toBe(exp.routesTo);
          });
        } else if ('text' in exp) {
          // Blank routing
          it(`'${exp.text}' routes to ${exp.routesTo}`, () => {
            const actual = routeBlank(scenario.blanks ?? [], exp.text);
            expect(actual).toBe(exp.routesTo);
          });
        }
      }
    });
  }
});

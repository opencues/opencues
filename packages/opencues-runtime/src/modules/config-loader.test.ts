import { describe, expect, it, vi } from 'vitest';
import { ConfigLoader, parseOpenCuesMd } from './config-loader';
import { MockAdapter, wrapTipsAsCuesMd } from '../../testing/mock-adapter';

const SAMPLE_TIPS = wrapTipsAsCuesMd({
  domain: 'test',
  version: 1,
  concepts: [
    {
      id: 'greetings',
      words: {
        hello: { tip: 'say hi', alts: ['hi', 'hey', 'howdy'] },
        fast: { tip: 'moving quickly', alts: ['quick', 'rapid', 'swift'] },
      },
    },
  ],
});

describe('ConfigLoader', () => {
  it('loads tips from CUES.md ## Tips and builds a case-insensitive lookup', async () => {
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': SAMPLE_TIPS } });
    const loader = new ConfigLoader(adapter);
    await loader.load();

    expect(loader.loaded).toBe(true);
    expect(loader.cueMap.size).toBeGreaterThan(0);

    const hello = loader.lookup('hello');
    expect(hello).not.toBeNull();
    expect(hello!.alternatives).toContain('hi');

    // Case-insensitive
    expect(loader.lookup('HELLO')).not.toBeNull();
    expect(loader.lookup('Fast')?.alternatives).toContain('quick');
  });

  it('resolves gracefully when CUES.md is missing', async () => {
    const adapter = new MockAdapter({ files: {} });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    expect(loader.loaded).toBe(true);
    expect(loader.cueMap.size).toBe(0);
    expect(loader.lookup('hello')).toBeNull();
  });

  it('leaves map empty when ## Tips JSON is malformed', async () => {
    const malformedCuesMd = `# malformed\n\n## Tips\n\`\`\`json\nnot valid json{{{\n\`\`\`\n`;
    const adapter = new MockAdapter({ files: { '/mock/CUES.md': malformedCuesMd } });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    expect(loader.loaded).toBe(true);
    expect(loader.cueMap.size).toBe(0);
  });

  it('returns null from lookup when file-read capability absent', async () => {
    const adapter = new MockAdapter({ capabilities: [] });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    expect(loader.cueMap.size).toBe(0);
    expect(loader.lookup('hello')).toBeNull();
  });
});

describe('parseOpenCuesMd', () => {
  it('extracts top-level scalar settings, defaults the rest', () => {
    const md = `---
version: 1
voice-mode: inactive
debug-mode: on
tips-mode: off
cursor-navigate: active
output-format: rich markdown
display mode: split pane
settings:
  voice-mode:
    tip: ignored nested block
    values:
      active: x
---

# CUES.md
some prose
`;
    const state = parseOpenCuesMd(md);
    expect(state.voiceMode).toBe('inactive');
    expect(state.debugMode).toBe('on');
    expect(state.tipsMode).toBe('off');
    expect(state.cursorNavigate).toBe('active');
    expect(state.settings.get('output-format')).toBe('rich markdown');
    expect(state.settings.get('display mode')).toBe('split pane');
    expect(state.settings.has('settings')).toBe(false); // empty value skipped
    expect(state.settings.has('tip')).toBe(false); // indented = not top-level
  });

  it('returns defaults when no frontmatter', () => {
    const state = parseOpenCuesMd('# just markdown, no frontmatter');
    expect(state.voiceMode).toBe('active');
    expect(state.tipsMode).toBe('on');
    expect(state.debugMode).toBe('off');
    expect(state.cursorNavigate).toBe('inactive');
    expect(state.ambientContextMode).toBe('off');
  });

  it('ambient-context-mode defaults to off and only flips on explicit "on"', () => {
    // OFF by default — the entire security model leans on this default.
    // If anyone refactors and accidentally inverts the polarity, this
    // test fails. See docs/architecture/ambient-context.md.
    expect(parseOpenCuesMd('---\n---').ambientContextMode).toBe('off');
    expect(parseOpenCuesMd('---\nambient-context-mode: off\n---').ambientContextMode).toBe('off');
    // Anything ≠ exact "on" stays off — typos / unexpected values fail
    // closed.
    expect(parseOpenCuesMd('---\nambient-context-mode: yes\n---').ambientContextMode).toBe('off');
    expect(parseOpenCuesMd('---\nambient-context-mode: true\n---').ambientContextMode).toBe('off');
    expect(parseOpenCuesMd('---\nambient-context-mode: enabled\n---').ambientContextMode).toBe('off');
    expect(parseOpenCuesMd('---\nambient-context-mode: 1\n---').ambientContextMode).toBe('off');
    // Only the exact string "on" enables it.
    expect(parseOpenCuesMd('---\nambient-context-mode: on\n---').ambientContextMode).toBe('on');
  });

  it('identity-context-mode: absent → safe (new default June 2026), explicit invalid → off (fail-closed)', () => {
    // Two-tier semantics:
    //   ABSENT key             → `safe` (shipped-seed default; tokens-only,
    //                            no PII leak, no-op for users without IDENTITY.md).
    //   Explicit valid value   → use it.
    //   Explicit invalid value → `off` (fail-closed — the privacy gate must
    //                            not silently flip on a typo).
    // See docs/architecture/identity-context.md.
    expect(parseOpenCuesMd('---\n---').identityContextMode).toBe('safe');
    expect(parseOpenCuesMd('---\nidentity-context-mode: off\n---').identityContextMode).toBe('off');
    expect(parseOpenCuesMd('---\nidentity-context-mode: safe\n---').identityContextMode).toBe('safe');
    expect(parseOpenCuesMd('---\nidentity-context-mode: raw\n---').identityContextMode).toBe('raw');
    // Case-insensitive.
    expect(parseOpenCuesMd('---\nidentity-context-mode: SAFE\n---').identityContextMode).toBe('safe');
    expect(parseOpenCuesMd('---\nidentity-context-mode: Raw\n---').identityContextMode).toBe('raw');
    // Anything else fails closed to off — typos / unexpected values must
    // not silently flip the gate to safe (the new default).
    expect(parseOpenCuesMd('---\nidentity-context-mode: on\n---').identityContextMode).toBe('off');
    expect(parseOpenCuesMd('---\nidentity-context-mode: yes\n---').identityContextMode).toBe('off');
    expect(parseOpenCuesMd('---\nidentity-context-mode: true\n---').identityContextMode).toBe('off');
    expect(parseOpenCuesMd('---\nidentity-context-mode: enabled\n---').identityContextMode).toBe('off');
  });

  it('sentinel-language: absent → bare (default), only explicit `typed` opts in', () => {
    // Fail-safe default: every existing user stays on the flat [TOKEN] path
    // unless they explicitly write `typed`. Unrecognised values → bare (no
    // behavioural change on a typo).
    expect(parseOpenCuesMd('---\n---').sentinelLanguage).toBe('bare');
    expect(parseOpenCuesMd('---\nsentinel-language: bare\n---').sentinelLanguage).toBe('bare');
    expect(parseOpenCuesMd('---\nsentinel-language: typed\n---').sentinelLanguage).toBe('typed');
    expect(parseOpenCuesMd('---\nsentinel-language: TYPED\n---').sentinelLanguage).toBe('typed'); // case-insensitive
    expect(parseOpenCuesMd('---\nsentinel-language: parameterized\n---').sentinelLanguage).toBe('bare'); // unknown → bare
    expect(parseOpenCuesMd('---\nsentinel-language: on\n---').sentinelLanguage).toBe('bare');
  });

  it('nav-keymap defaults to auto and only accepts ctrl-alt / ctrl-shift', () => {
    expect(parseOpenCuesMd('---\n---').navKeymap).toBe('auto');
    expect(parseOpenCuesMd('---\nnav-keymap: auto\n---').navKeymap).toBe('auto');
    expect(parseOpenCuesMd('---\nnav-keymap: ctrl-alt\n---').navKeymap).toBe('ctrl-alt');
    expect(parseOpenCuesMd('---\nnav-keymap: ctrl-shift\n---').navKeymap).toBe('ctrl-shift');
    // Case-insensitive.
    expect(parseOpenCuesMd('---\nnav-keymap: Ctrl-Shift\n---').navKeymap).toBe('ctrl-shift');
    // Anything else stays auto — typos / unexpected values fall back
    // to the host-aware default rather than disabling navigation.
    expect(parseOpenCuesMd('---\nnav-keymap: meta-arrow\n---').navKeymap).toBe('auto');
    expect(parseOpenCuesMd('---\nnav-keymap: shift\n---').navKeymap).toBe('auto');
  });

  it('clamps unknown values to safe defaults', () => {
    const md = `---
voice-mode: muted
tips-mode: maybe
---`;
    const state = parseOpenCuesMd(md);
    expect(state.voiceMode).toBe('active'); // anything ≠ 'inactive' = active
    expect(state.tipsMode).toBe('on');      // anything ≠ 'off' = on
  });

  it('parses nested settings: block into definitions', () => {
    const md = `---
voice-mode: active
debug-mode: off
settings:
  voice-mode:
    tip: Gates TTS globally
    values:
      active: TTS reads tips aloud
      inactive: TTS is silenced
  debug-mode:
    tip: Enable debug logging
    values:
      on: Debug output emitted
      off: Debug logging suppressed
---`;
    const state = parseOpenCuesMd(md);
    expect(state.definitions.size).toBe(2);
    const vm = state.definitions.get('voice-mode');
    expect(vm?.tip).toBe('Gates TTS globally');
    expect(vm?.valueOrder).toEqual(['active', 'inactive']);
    expect(vm?.valueTips.get('active')).toBe('TTS reads tips aloud');
    expect(vm?.valueTips.get('inactive')).toBe('TTS is silenced');
    const dm = state.definitions.get('debug-mode');
    expect(dm?.valueOrder).toEqual(['on', 'off']);
  });

  it('missing settings: block falls back to registry-derived definitions', () => {
    // Post-May-2026: the parser ships registry defaults from
    // @opencues/core's FEATURES + MENU_TUNABLES when the user's file
    // has no settings: block. Previously this returned an empty Map;
    // now it returns the full set of cyclable defaults. Users who
    // want a custom menu still ship their own block (file wins).
    const md = `---
voice-mode: active
---`;
    const state = parseOpenCuesMd(md);
    expect(state.definitions.size).toBeGreaterThan(0);
    // Canonical features the registry covers
    expect(state.definitions.has('voice-mode')).toBe(true);
    // Renamed June 2026 from `identity-context-mode` to `identity-context-mode`.
    expect(state.definitions.has('identity-context-mode')).toBe(true);
    // Tunables from MENU_TUNABLES
    expect(state.definitions.has('agent-debounce-ms')).toBe(true);
  });

  it('parses quoted numeric value keys (agent-debounce-ms / max-concurrent-auditors)', () => {
    // YAML quotes numeric keys to keep them string-typed. The parser must
    // strip surrounding quotes; otherwise selector+satellite cycling lands
    // on the setting with an empty valueOrder, and the satellite
    // populates as empty.
    const md = `---
agent-debounce-ms: 1000
max-concurrent-auditors: 0
settings:
  agent-debounce-ms:
    tip: Debounce ms
    values:
      "500": Aggressive
      "1000": Default
      "2000": Relaxed
  max-concurrent-auditors:
    tip: Cap on parallel auditor calls
    values:
      "0": Uncapped
      "3": Top-3
      "5": Top-5
---`;
    const state = parseOpenCuesMd(md);
    const ad = state.definitions.get('agent-debounce-ms');
    expect(ad?.valueOrder).toEqual(['500', '1000', '2000']);
    expect(ad?.valueTips.get('1000')).toBe('Default');
    const mca = state.definitions.get('max-concurrent-auditors');
    expect(mca?.valueOrder).toEqual(['0', '3', '5']);
    expect(mca?.valueTips.get('3')).toBe('Top-3');
  });
});

describe('ConfigLoader expanded — cwd .md files', () => {
  const TIPS = JSON.stringify({
    domain: 't', version: 1,
    concepts: [{ id: 'a', words: { hello: { tip: 'hi', alts: ['hi'] } } }],
  });

  it('parses CUES.md / BLANKS.md frontmatter from cwd', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/tips.json': TIPS,
        '/proj/CUES.md': '---\nname: my-cues\ndomain: test\nversion: 1\n---\n',
        '/proj/BLANKS.md': '---\nname: my-blanks\nversion: 1\n---\n',
      },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    expect(loader.cuesConfig?.frontmatter.name).toBe('my-cues');
    expect(loader.blanksConfig?.frontmatter.name).toBe('my-blanks');
  });

  it('reads OPENCUES.md state when present', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/tips.json': TIPS,
        '/proj/.cues/OPENCUES.md': '---\nvoice-mode: inactive\ntips-mode: off\n---\n',
      },
    });
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/.cues/OPENCUES.md' });
    await loader.load();
    expect(loader.opencuesState.voiceMode).toBe('inactive');
    expect(loader.opencuesState.tipsMode).toBe('off');
  });

  it('opencuesState is the default when OPENCUES.md is missing', async () => {
    const adapter = new MockAdapter({ cwd: '/proj', files: { '/tips.json': TIPS } });
    const loader = new ConfigLoader(adapter, { settingsFile: '/proj/.cues/OPENCUES.md' });
    await loader.load();
    expect(loader.opencuesState.voiceMode).toBe('active');
    expect(loader.opencuesState.tipsMode).toBe('on');
  });

  // Regression: when ConfigLoader._discoverFolders' pre-walk only matched
  // files literally named `cue.md`, the new flat <name>.md shape was
  // invisible, ConfigLoader logged "loaded 0 cue entries", and every
  // BlankSource match (weather, hn, prompt, …) silently fell through
  // to FluidBlank. discover.test.ts in @opencues/core covered the flat
  // shape end-to-end, but its tests bypassed the runtime pre-walk —
  // the bug only existed in the pre-walk's filename filter.
  it('discovers tips from a folder cues/<name>/CUE.md', async () => {
    const cueMd = `---\nname: tips\n---\n\n` +
      '```json\n' +
      JSON.stringify([{ id: 'g', words: { howdy: { tip: 'a greeting', alts: ['hello'] } } }]) +
      '\n```\n';
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/.cues/cues/tips/CUE.md': cueMd,
      },
    });
    const loader = new ConfigLoader(adapter, { configSearchPaths: ['/proj/.cues'] });
    await loader.load();
    expect(loader.cueMap.size).toBeGreaterThan(0);
    expect(loader.lookup('howdy')?.cueTip).toBe('a greeting');
  });

  it('continues loading other files when one .md file is malformed', async () => {
    const adapter = new MockAdapter({
      cwd: '/proj',
      files: {
        '/proj/CUES.md': 'no frontmatter at all',
        '/proj/BLANKS.md': '---\nname: ok\nversion: 1\n---\n',
      },
    });
    const loader = new ConfigLoader(adapter);
    await loader.load();
    // BLANKS.md still parses fine even though CUES.md was odd.
    // cueMap is empty because CUES.md (the sole tips source post-refactor)
    // didn't yield a valid ## Tips block.
    expect(loader.blanksConfig?.frontmatter.name).toBe('ok');
    expect(loader.cueMap.size).toBe(0);
  });

});

describe('ConfigLoader hot-reload', () => {
  it('maybeReload skips inside the debounce window', async () => {
    const adapter = new MockAdapter({ files: { '/tips.json': '{"concepts":[]}' } });
    const loader = new ConfigLoader(adapter, { reloadDebounceMs: 1000 });
    await loader.load();
    const initial = adapter.logs.length;
    await loader.maybeReload();
    await loader.maybeReload();
    // No reload happened — log count unchanged.
    expect(adapter.logs.length).toBe(initial);
  });

  it('maybeReload does reload when debounce elapsed', async () => {
    const adapter = new MockAdapter({ files: { '/tips.json': '{"concepts":[]}' } });
    const loader = new ConfigLoader(adapter, { reloadDebounceMs: 0 });
    await loader.load();
    const initial = adapter.logs.length;
    await loader.maybeReload();
    expect(adapter.logs.length).toBeGreaterThan(initial);
  });

  it('subscribe wires onTextChange → maybeReload', async () => {
    const adapter = new MockAdapter({ files: { '/tips.json': '{"concepts":[]}' } });
    const loader = new ConfigLoader(adapter, { reloadDebounceMs: 0 });
    await loader.load();
    loader.subscribe();
    const initial = adapter.logs.length;
    adapter.pushText('triggered');
    // pushText fires onTextChange synchronously; maybeReload is async.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(adapter.logs.length).toBeGreaterThan(initial);
  });

  it('applyOpenCuesScalar suppresses the next maybeReload (write-race guard)', async () => {
    // Regression guard: cycling a satellite calls applyOpenCuesScalar
    // (in-memory update) followed by an ASYNC blankInvoke set that
    // writes the file. Cycling.ts then calls setText → onTextChange →
    // maybeReload. If maybeReload reads the file BEFORE the async
    // write lands, the in-memory update is reverted to the stale
    // file value. applyOpenCuesScalar arms a 2.5s suppression window
    // so the write has time to land.
    const FILE_INACTIVE = `---\nvoice-mode: inactive\n---\n`;
    const adapter = new MockAdapter({
      files: { '/tips.json': '{"concepts":[]}', '/proj/.cues/OPENCUES.md': FILE_INACTIVE },
      cwd: '/proj',
    });
    const loader = new ConfigLoader(adapter, {
      reloadDebounceMs: 0,
      settingsFile: '/proj/.cues/OPENCUES.md',
    });
    await loader.load();
    expect(loader.opencuesState.voiceMode).toBe('inactive');
    // User cycles satellite → applyOpenCuesScalar fires.
    loader.applyOpenCuesScalar('voice-mode', 'active');
    expect(loader.opencuesState.voiceMode).toBe('active');
    // Cycling.ts then calls setText → onTextChange → maybeReload.
    // The async write hasn't landed yet, so file still says inactive.
    // Without the suppression, maybeReload would read inactive and
    // overwrite our in-memory 'active'.
    await loader.maybeReload();
    expect(loader.opencuesState.voiceMode).toBe('active');
  });

  it('overlay after applyOpenCuesScalar keeps a file-driven value list but refreshes live descriptions', async () => {
    // Two contracts on the post-apply overlay (July 2026 regression pin):
    //   1. File-override-wins: a `settings:` block's value LIST + order
    //      for a valuesProvider-backed scalar survives the overlay —
    //      clobbering it back to the registry shape changed the
    //      satellite walk order mid-cycle.
    //   2. Live text still refreshes on the user's list: the `inherit`
    //      entry's description names the current global llm-provider.
    const FILE = `---
llm-provider: cerebras
blanks-llm-provider: inherit
settings:
  blanks-llm-provider:
    tip: Provider for blank-class sources.
    values:
      inherit: Default
      groq: Groq
      cerebras: Cerebras
---
`;
    const adapter = new MockAdapter({
      files: { '/tips.json': '{"concepts":[]}', '/proj/.cues/OPENCUES.md': FILE },
      cwd: '/proj',
    });
    const loader = new ConfigLoader(adapter, {
      reloadDebounceMs: 0,
      settingsFile: '/proj/.cues/OPENCUES.md',
    });
    await loader.load();
    const fileOrder = ['inherit', 'groq', 'cerebras'];
    expect([...loader.opencuesState.definitions.get('blanks-llm-provider')!.valueOrder]).toEqual(fileOrder);

    loader.applyOpenCuesScalar('blanks-llm-provider', 'groq');
    const def = loader.opencuesState.definitions.get('blanks-llm-provider')!;
    // 1. The user's list + order survives (NOT the registry's
    //    inherit/opencode-zen/cerebras/... shape).
    expect([...def.valueOrder]).toEqual(fileOrder);
    // 2. The inherit description was refreshed with the live resolution.
    expect(def.valueTips.get('inherit')).toContain('currently cerebras');
  });

  it('applyOpenCuesScalar preserves identity-context two-tier defaults (no silent downgrade)', async () => {
    // SECURITY-LOAD-BEARING pin: the inline re-parse inside
    // applyOpenCuesScalar used to default identity-context-mode /
    // blank-context-mode to 'off' while parseOpenCuesMd defaults an
    // ABSENT key to 'safe'. Cycling ANY satellite scalar (voice-mode
    // here) on a config without the explicit key then silently
    // downgraded the in-memory mode to 'off' — and buffer dehydration
    // (the outbound PII scrub) rides 'safe', so the scrub would have
    // turned off without a trace.
    const FILE = `---\nvoice-mode: inactive\n---\n`; // no identity-context-mode key
    const adapter = new MockAdapter({
      files: { '/tips.json': '{"concepts":[]}', '/proj/.cues/OPENCUES.md': FILE },
      cwd: '/proj',
    });
    const loader = new ConfigLoader(adapter, {
      reloadDebounceMs: 0,
      settingsFile: '/proj/.cues/OPENCUES.md',
    });
    await loader.load();
    expect(loader.opencuesState.identityContextMode).toBe('safe');
    expect(loader.opencuesState.blankContextMode).toBe('safe');
    // Cycle an unrelated satellite scalar.
    loader.applyOpenCuesScalar('voice-mode', 'active');
    expect(loader.opencuesState.voiceMode).toBe('active');
    // The modes must survive the inline re-parse.
    expect(loader.opencuesState.identityContextMode).toBe('safe');
    expect(loader.opencuesState.blankContextMode).toBe('safe');
    // Explicit values still respected (off stays off; invalid fails closed).
    loader.applyOpenCuesScalar('identity-context-mode', 'off');
    expect(loader.opencuesState.identityContextMode).toBe('off');
    loader.applyOpenCuesScalar('identity-context-mode', 'enabled');
    expect(loader.opencuesState.identityContextMode).toBe('off');
  });

  it('reload resumes after the suppression window expires', async () => {
    // The suppression is bounded — once the write has had time to
    // land, hot-reload picks back up so future file edits propagate.
    const FILE = `---\nvoice-mode: inactive\n---\n`;
    const adapter = new MockAdapter({
      files: { '/tips.json': '{"concepts":[]}', '/proj/.cues/OPENCUES.md': FILE },
      cwd: '/proj',
    });
    const loader = new ConfigLoader(adapter, {
      reloadDebounceMs: 0,
      settingsFile: '/proj/.cues/OPENCUES.md',
    });
    await loader.load();
    loader.applyOpenCuesScalar('voice-mode', 'active');
    // Simulate the file write completing + the user editing the file
    // independently to a new value AFTER the suppression window.
    await new Promise(r => setImmediate(r));
    // Bypass time by reaching into the private field — wall-clock
    // sleep would slow the test suite. Equivalent to "2.6s elapsed".
    (loader as unknown as { _suppressReloadUntil: number })._suppressReloadUntil = Date.now() - 1;
    await adapter.writeFile('/proj/.cues/OPENCUES.md', `---\nvoice-mode: inactive\n---\n`);
    await loader.maybeReload();
    // File-driven reload took precedence post-suppression.
    expect(loader.opencuesState.voiceMode).toBe('inactive');
  });

  it('identity-context-mode hot-reloads from OPENCUES.md edits', async () => {
    // Same load-bearing contract as ambient — flipping the scalar
    // in OPENCUES.md must take effect on the NEXT keystroke without
    // a host restart. Off → safe → raw → off all need to round-trip.
    const initial = `---\nidentity-context-mode: off\n---\n`;
    const adapter = new MockAdapter({
      files: { '/tips.json': '{"concepts":[]}', '/proj/.cues/OPENCUES.md': initial },
      cwd: '/proj',
    });
    const loader = new ConfigLoader(adapter, {
      reloadDebounceMs: 0,
      settingsFile: '/proj/.cues/OPENCUES.md',
    });
    await loader.load();
    expect(loader.opencuesState.identityContextMode).toBe('off');

    await adapter.writeFile('/proj/.cues/OPENCUES.md', `---\nidentity-context-mode: safe\n---\n`);
    await loader.maybeReload();
    expect(loader.opencuesState.identityContextMode).toBe('safe');

    await adapter.writeFile('/proj/.cues/OPENCUES.md', `---\nidentity-context-mode: raw\n---\n`);
    await loader.maybeReload();
    expect(loader.opencuesState.identityContextMode).toBe('raw');

    await adapter.writeFile('/proj/.cues/OPENCUES.md', `---\nidentity-context-mode: off\n---\n`);
    await loader.maybeReload();
    expect(loader.opencuesState.identityContextMode).toBe('off');
  });

  it('ambient-context-mode hot-reloads from OPENCUES.md edits', async () => {
    // The runtime gates ambient gathering on opencuesState.ambientContextMode.
    // When the user flips the scalar in OPENCUES.md, the NEXT keystroke's
    // resolve must see the new value — otherwise opting in/out requires
    // a host restart. Mirror of the voice-mode reload test above, scoped
    // to ambient so the property is pinned independently.
    const initial = `---\nambient-context-mode: off\n---\n`;
    const adapter = new MockAdapter({
      files: { '/tips.json': '{"concepts":[]}', '/proj/.cues/OPENCUES.md': initial },
      cwd: '/proj',
    });
    const loader = new ConfigLoader(adapter, {
      reloadDebounceMs: 0,
      settingsFile: '/proj/.cues/OPENCUES.md',
    });
    await loader.load();
    expect(loader.opencuesState.ambientContextMode).toBe('off');

    // User edits OPENCUES.md (or another host writes the scalar via
    // applyOpenCuesScalar + flush). We simulate the file-driven path
    // since that's the load-bearing one: a user opening the file in
    // their editor and changing the value MUST propagate.
    await adapter.writeFile(
      '/proj/.cues/OPENCUES.md',
      `---\nambient-context-mode: on\n---\n`,
    );
    await loader.maybeReload();
    expect(loader.opencuesState.ambientContextMode).toBe('on');

    // Flip back off — the same path must turn it off as cleanly as
    // it turned it on so a security-conscious user can disable mid-session.
    await adapter.writeFile(
      '/proj/.cues/OPENCUES.md',
      `---\nambient-context-mode: off\n---\n`,
    );
    await loader.maybeReload();
    expect(loader.opencuesState.ambientContextMode).toBe('off');
  });
});

describe('bucket scalars (three-bucket simplification)', () => {
  it('parses cues/auditors/blanks-llm-provider as typed fields', () => {
    const state = parseOpenCuesMd(
      `---\ncues-llm-provider: cerebras\nauditors-llm-provider: anthropic\nblanks-llm-provider: opencode-zen\n---\n`,
    );
    expect(state.cuesLlmProvider).toBe('cerebras');
    expect(state.auditorsLlmProvider).toBe('anthropic');
    expect(state.blanksLlmProvider).toBe('opencode-zen');
  });

  it('defaults every bucket scalar to inherit when frontmatter is empty', () => {
    const state = parseOpenCuesMd(`---\nvoice-mode: active\n---\n`);
    expect(state.cuesLlmProvider).toBe('inherit');
    expect(state.auditorsLlmProvider).toBe('inherit');
    expect(state.blanksLlmProvider).toBe('inherit');
  });

  it('reads legacy `blank-llm-provider:` (singular) into blanksLlmProvider when the new name is absent', () => {
    const state = parseOpenCuesMd(`---\nblank-llm-provider: cerebras\n---\n`);
    expect(state.blanksLlmProvider).toBe('cerebras');
  });

  it('prefers the new `blanks-llm-provider:` over the legacy singular when both are present', () => {
    const state = parseOpenCuesMd(
      `---\nblank-llm-provider: groq\nblanks-llm-provider: anthropic\n---\n`,
    );
    expect(state.blanksLlmProvider).toBe('anthropic');
  });

  it('sanitises unknown provider ids back to inherit (typo protection)', () => {
    const state = parseOpenCuesMd(
      `---\ncues-llm-provider: not-a-real-provider\nblanks-llm-provider: also-not-real\n---\n`,
    );
    expect(state.cuesLlmProvider).toBe('inherit');
    expect(state.blanksLlmProvider).toBe('inherit');
  });
});

describe('background-poll hot reload (June 2026)', () => {
  // The keystroke-driven onTextChange path is well-tested above. This
  // suite pins the background timer path that fires `maybeReload` even
  // when the host stays idle. Closes the "I changed OPENCUES.md but
  // nothing happened until I typed" surprise.

  it('subscribe() creates a polling interval when backgroundPollMs > 0', async () => {
    const adapter = new MockAdapter({ files: {} });
    const loader = new ConfigLoader(adapter, { backgroundPollMs: 100 });
    await loader.load();
    loader.subscribe();
    // Reflect on the private field via the same cast pattern the rest
    // of the file uses for white-box state checks.
    const inner = loader as unknown as { _pollTimer: unknown };
    expect(inner._pollTimer).not.toBeNull();
    loader.unsubscribe();
    expect(inner._pollTimer).toBeNull();
  });

  it('subscribe() with backgroundPollMs: 0 skips the timer entirely', async () => {
    const adapter = new MockAdapter({ files: {} });
    const loader = new ConfigLoader(adapter, { backgroundPollMs: 0 });
    await loader.load();
    loader.subscribe();
    const inner = loader as unknown as { _pollTimer: unknown };
    expect(inner._pollTimer).toBeNull();
    loader.unsubscribe();
  });

  it('poll fires maybeReload at the configured cadence (debounce permitting)', async () => {
    // Use vi.useFakeTimers so we can advance virtually without waiting.
    // Inspect reload count via white-box access to `_lastLoadAt` — that
    // timestamp updates on every `load()` call (which is what
    // `maybeReload` triggers). A change in `_lastLoadAt` between
    // subscribe-time and after-3-poll-ticks proves the timer fired
    // through `maybeReload` and into `load()`.
    vi.useFakeTimers();
    try {
      const adapter = new MockAdapter({ files: {} });
      // Disable debounce so each poll tick reloads (debounce gate would
      // otherwise swallow polls within 2s of last load).
      const loader = new ConfigLoader(adapter, { backgroundPollMs: 100, reloadDebounceMs: 0 });
      await loader.load();
      const inner = loader as unknown as { _lastLoadAt: number };
      const before = inner._lastLoadAt;
      loader.subscribe();
      // Advance through 3 poll intervals + a microtask flush so the
      // async `load()` chain inside `maybeReload` resolves.
      await vi.advanceTimersByTimeAsync(350);
      const after = inner._lastLoadAt;
      expect(after).toBeGreaterThan(before);
      loader.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});

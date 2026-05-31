import { describe, expect, it } from 'vitest';
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

  it('sentinels-mode defaults to off and only accepts safe/raw', () => {
    // Same fail-closed contract as ambient-context-mode — the privacy
    // model leans on `off` being the default + on unrecognised values
    // not silently flipping the gate. See docs/architecture/sentinels.md.
    expect(parseOpenCuesMd('---\n---').sentinelsMode).toBe('off');
    expect(parseOpenCuesMd('---\nsentinels-mode: off\n---').sentinelsMode).toBe('off');
    expect(parseOpenCuesMd('---\nsentinels-mode: safe\n---').sentinelsMode).toBe('safe');
    expect(parseOpenCuesMd('---\nsentinels-mode: raw\n---').sentinelsMode).toBe('raw');
    // Case-insensitive.
    expect(parseOpenCuesMd('---\nsentinels-mode: SAFE\n---').sentinelsMode).toBe('safe');
    expect(parseOpenCuesMd('---\nsentinels-mode: Raw\n---').sentinelsMode).toBe('raw');
    // Anything else stays off — typos / unexpected values fail closed.
    expect(parseOpenCuesMd('---\nsentinels-mode: on\n---').sentinelsMode).toBe('off');
    expect(parseOpenCuesMd('---\nsentinels-mode: yes\n---').sentinelsMode).toBe('off');
    expect(parseOpenCuesMd('---\nsentinels-mode: true\n---').sentinelsMode).toBe('off');
    expect(parseOpenCuesMd('---\nsentinels-mode: enabled\n---').sentinelsMode).toBe('off');
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
    expect(state.definitions.has('sentinels-mode')).toBe(true);
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

  it('sentinels-mode hot-reloads from OPENCUES.md edits', async () => {
    // Same load-bearing contract as ambient — flipping the scalar
    // in OPENCUES.md must take effect on the NEXT keystroke without
    // a host restart. Off → safe → raw → off all need to round-trip.
    const initial = `---\nsentinels-mode: off\n---\n`;
    const adapter = new MockAdapter({
      files: { '/tips.json': '{"concepts":[]}', '/proj/.cues/OPENCUES.md': initial },
      cwd: '/proj',
    });
    const loader = new ConfigLoader(adapter, {
      reloadDebounceMs: 0,
      settingsFile: '/proj/.cues/OPENCUES.md',
    });
    await loader.load();
    expect(loader.opencuesState.sentinelsMode).toBe('off');

    await adapter.writeFile('/proj/.cues/OPENCUES.md', `---\nsentinels-mode: safe\n---\n`);
    await loader.maybeReload();
    expect(loader.opencuesState.sentinelsMode).toBe('safe');

    await adapter.writeFile('/proj/.cues/OPENCUES.md', `---\nsentinels-mode: raw\n---\n`);
    await loader.maybeReload();
    expect(loader.opencuesState.sentinelsMode).toBe('raw');

    await adapter.writeFile('/proj/.cues/OPENCUES.md', `---\nsentinels-mode: off\n---\n`);
    await loader.maybeReload();
    expect(loader.opencuesState.sentinelsMode).toBe('off');
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

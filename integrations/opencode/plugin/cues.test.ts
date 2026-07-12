// Tests for the OpenCode cues plugin (plugin/cues.ts).
//
// Scope: the pure/mockable logic — model-spec parsing, part-text
// extraction, cues-content-fence stripping, project-file read/write,
// conversation-context building, and the end-to-end `chat.message`
// hook (including its own-session recursion guard and error
// swallowing). We do NOT test OpenCode's actual SDK wiring — `input`
// and its `client` are mocked throughout.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseModel,
  extractUserText,
  extractAssistantText,
  extractCuesContent,
  existingCuesMd,
  writeCuesMd,
  buildContext,
} from './cues';

// cues.ts computes SKILL_LOCATIONS once at module load using
// os.homedir() — the `cuesPlugin` end-to-end tests further down need
// a homedir they control (so a real cues.SKILL.md placed in a temp
// dir is actually found), while the tests above only exercise pure
// functions that never touch SKILL_LOCATIONS. vi.hoisted keeps this
// mutable cell safe from the vi.mock-hoisted-above-imports TDZ trap;
// it defaults to the real os.homedir() so the static import above is
// unaffected.
const { getFakeHomedir, setFakeHomedir } = vi.hoisted(() => {
  let fakeHomedir: string | null = null;
  return {
    getFakeHomedir: () => fakeHomedir,
    setFakeHomedir: (v: string | null) => { fakeHomedir = v; },
  };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => getFakeHomedir() ?? actual.homedir() };
});

describe('parseModel', () => {
  it('splits provider/model on the first slash', () => {
    expect(parseModel('anthropic/claude-haiku-4-5')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
    });
  });

  it('defaults to anthropic when there is no slash', () => {
    expect(parseModel('claude-haiku-4-5')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
    });
  });

  it('keeps everything after the FIRST slash as the model id (nested slashes)', () => {
    expect(parseModel('openrouter/meta/llama-3')).toEqual({
      providerID: 'openrouter',
      modelID: 'meta/llama-3',
    });
  });

  it('handles an empty string', () => {
    expect(parseModel('')).toEqual({ providerID: 'anthropic', modelID: '' });
  });

  it('handles a spec that is only a slash', () => {
    expect(parseModel('/')).toEqual({ providerID: '', modelID: '' });
  });
});

describe('extractUserText', () => {
  it('joins text parts with newlines and trims', () => {
    const parts = [
      { type: 'text', text: '  hello ' },
      { type: 'text', text: 'world' },
    ];
    expect(extractUserText(parts)).toBe('hello \nworld');
  });

  it('filters out non-text parts', () => {
    const parts = [
      { type: 'tool-use', text: 'ignored' },
      { type: 'text', text: 'kept' },
    ];
    expect(extractUserText(parts)).toBe('kept');
  });

  it('filters out parts whose text is not a string', () => {
    const parts = [
      { type: 'text', text: 42 },
      { type: 'text', text: 'kept' },
    ];
    expect(extractUserText(parts)).toBe('kept');
  });

  it('returns empty string for an empty array', () => {
    expect(extractUserText([])).toBe('');
  });

  it('tolerates null/undefined entries in the array', () => {
    const parts = [null, undefined, { type: 'text', text: 'ok' }] as any[];
    expect(extractUserText(parts)).toBe('ok');
  });
});

describe('extractAssistantText', () => {
  it('behaves the same as extractUserText for well-formed parts', () => {
    const parts = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
    expect(extractAssistantText(parts)).toBe('a\nb');
  });

  it('ignores tool-result parts', () => {
    const parts = [
      { type: 'tool-result', text: 'nope' },
      { type: 'text', text: 'yes' },
    ];
    expect(extractAssistantText(parts)).toBe('yes');
  });
});

describe('extractCuesContent', () => {
  it('returns trimmed plain content unchanged', () => {
    expect(extractCuesContent('  ---\nfoo: bar\n---\n  ')).toBe('---\nfoo: bar\n---');
  });

  it('strips a ```markdown ... ``` fence', () => {
    const input = '```markdown\n---\nfoo: bar\n---\n```';
    expect(extractCuesContent(input)).toBe('---\nfoo: bar\n---');
  });

  it('strips a ```md ... ``` fence', () => {
    const input = '```md\n---\nfoo: bar\n---\n```';
    expect(extractCuesContent(input)).toBe('---\nfoo: bar\n---');
  });

  it('strips a bare ``` ... ``` fence with no language tag', () => {
    const input = '```\n---\nfoo: bar\n---\n```';
    expect(extractCuesContent(input)).toBe('---\nfoo: bar\n---');
  });

  it('slices from the frontmatter fence when preceded by short preamble', () => {
    const input = 'Sure, here you go:\n---\nfoo: bar\n---';
    expect(extractCuesContent(input)).toBe('---\nfoo: bar\n---');
  });

  it('does NOT slice when the frontmatter fence is at index 0', () => {
    const input = '---\nfoo: bar\n---';
    expect(extractCuesContent(input)).toBe(input);
  });

  it('does NOT slice when the preamble before --- is >= 200 chars', () => {
    const longPreamble = 'x'.repeat(250);
    const input = `${longPreamble}\n---\nfoo: bar\n---`;
    // fmIdx (250ish) is not < 200, so the preamble is left in place.
    expect(extractCuesContent(input)).toBe(input.trim());
  });

  it('handles a fenced block that itself contains frontmatter', () => {
    const input = '```markdown\nSure:\n---\nfoo: bar\n---\n```';
    expect(extractCuesContent(input)).toBe('---\nfoo: bar\n---');
  });

  it('returns content unchanged when there is no frontmatter at all', () => {
    expect(extractCuesContent('just some text')).toBe('just some text');
  });
});

describe('existingCuesMd / writeCuesMd (real temp-dir round trip)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cues-plugin-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when .cues/CUES.md does not exist', () => {
    expect(existingCuesMd(tmpDir)).toBeNull();
  });

  it('writes then reads back the same content', () => {
    writeCuesMd(tmpDir, '---\nfoo: bar\n---\n');
    expect(existingCuesMd(tmpDir)).toBe('---\nfoo: bar\n---\n');
  });

  it('creates the .cues directory if missing', () => {
    const cuesDir = path.join(tmpDir, '.cues');
    expect(fs.existsSync(cuesDir)).toBe(false);
    writeCuesMd(tmpDir, 'content');
    expect(fs.existsSync(cuesDir)).toBe(true);
    expect(fs.existsSync(path.join(cuesDir, 'CUES.md'))).toBe(true);
  });

  it('overwrites existing content on a second write', () => {
    writeCuesMd(tmpDir, 'first');
    writeCuesMd(tmpDir, 'second');
    expect(existingCuesMd(tmpDir)).toBe('second');
  });
});

describe('buildContext', () => {
  it('returns "" immediately when CONTEXT_TURNS <= 0 (never calls the client)', async () => {
    // CONTEXT_TURNS defaults to 5 (module-level const from env at
    // import time) in this test run, so this test instead verifies
    // the client-call path directly below; the <=0 short-circuit is
    // exercised via a fresh module import with the env var forced to
    // 0 in the next describe block.
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
    const result = await buildContext(client, 'sess-1');
    expect(result).toBe('');
  });

  it('builds lines from client.session.messages, trimming to the last CONTEXT_TURNS*2 entries', async () => {
    const msgs = [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'q1' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'a1' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'q2' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'a2' }] },
    ];
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({ data: msgs }),
      },
    };
    const result = await buildContext(client, 'sess-1');
    expect(result).toContain('[user] q1');
    expect(result).toContain('[assistant] a2');
  });

  it('falls back to client.session.message.list when .messages() rejects', async () => {
    const msgs = [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'from-list' }] }];
    const client = {
      session: {
        messages: vi.fn().mockRejectedValue(new Error('nope')),
        message: { list: vi.fn().mockResolvedValue({ data: msgs }) },
      },
    };
    const result = await buildContext(client, 'sess-1');
    expect(result).toContain('from-list');
  });

  it('truncates each line to 600 chars', async () => {
    const long = 'a'.repeat(1000);
    const msgs = [{ info: { role: 'user' }, parts: [{ type: 'text', text: long }] }];
    const client = { session: { messages: vi.fn().mockResolvedValue({ data: msgs }) } };
    const result = await buildContext(client, 'sess-1');
    // "[user] " prefix + 600 chars
    expect(result.length).toBe('[user] '.length + 600);
  });

  it('skips messages with no extractable text', async () => {
    const msgs = [
      { info: { role: 'user' }, parts: [] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'kept' }] },
    ];
    const client = { session: { messages: vi.fn().mockResolvedValue({ data: msgs }) } };
    const result = await buildContext(client, 'sess-1');
    expect(result).toBe('[assistant] kept');
  });

  it('returns "" when the client throws synchronously', async () => {
    const client = {
      session: {
        get messages() {
          throw new Error('boom');
        },
      },
    };
    const result = await buildContext(client, 'sess-1');
    expect(result).toBe('');
  });

  it('handles res.data as an object with a nested messages array', async () => {
    const msgs = [{ role: 'user', parts: [{ type: 'text', text: 'nested' }] }];
    const client = {
      session: { messages: vi.fn().mockResolvedValue({ data: { messages: msgs } }) },
    };
    const result = await buildContext(client, 'sess-1');
    expect(result).toContain('nested');
  });
});

describe('buildContext with CONTEXT_TURNS=0 (module re-import)', () => {
  const ORIGINAL_ENV = process.env['OPENCUES_CONTEXT_TURNS'];

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env['OPENCUES_CONTEXT_TURNS'];
    else process.env['OPENCUES_CONTEXT_TURNS'] = ORIGINAL_ENV;
    vi.resetModules();
  });

  it('short-circuits to "" without ever calling the client', async () => {
    process.env['OPENCUES_CONTEXT_TURNS'] = '0';
    vi.resetModules();
    const mod = await import('./cues');
    const messages = vi.fn();
    const result = await mod.buildContext({ session: { messages } }, 'sess-1');
    expect(result).toBe('');
    expect(messages).not.toHaveBeenCalled();
  });
});

describe('cuesPlugin — chat.message hook (end to end, client mocked)', () => {
  let tmpDir: string;
  let tmpHome: string;
  const ORIGINAL_CWD = process.cwd;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cues-plugin-e2e-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cues-plugin-home-'));
    // Plant a real SKILL.md at the plugin-bundled location so
    // loadSkillText() (called at the top of runCuesUpdate) finds it —
    // without this the hook always no-ops before ever touching
    // client.session.create.
    const skillDir = path.join(tmpHome, '.config/opencode/plugins');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'cues.SKILL.md'), '# Cues skill\nGenerate CUES.md.\n');
    setFakeHomedir(tmpHome);
    // The plugin falls back to process.cwd() when input.directory is
    // unset; we always pass input.directory explicitly below so this
    // is just a safety net.
    process.cwd = () => tmpDir;
    vi.resetModules();
  });

  afterEach(() => {
    process.cwd = ORIGINAL_CWD;
    process.env = { ...ORIGINAL_ENV };
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
    setFakeHomedir(null);
    vi.resetModules();
  });

  function makeClient(promptImpl: () => Promise<any>) {
    return {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'sess-throwaway-1' } }),
        prompt: vi.fn(promptImpl),
        delete: vi.fn().mockResolvedValue(undefined),
        messages: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
  }

  it('writes .cues/CUES.md from the LLM response on the happy path', async () => {
    const { cuesPlugin, existingCuesMd: existingCuesMdFresh } = await import('./cues');
    const client = makeClient(async () => ({
      data: { parts: [{ type: 'text', text: '---\nname: proj\n---\n```json\n[]\n```' }] },
    }));
    const plugin = await cuesPlugin({ client, directory: tmpDir } as any);
    await plugin['chat.message'](
      { sessionID: 'real-session' },
      { parts: [{ type: 'text', text: 'tell me about kubernetes' }] },
    );
    expect(client.session.create).toHaveBeenCalledTimes(1);
    expect(client.session.delete).toHaveBeenCalledTimes(1);
    expect(existingCuesMdFresh(tmpDir)).toContain('name: proj');
  });

  it('does nothing when the user message has no extractable text', async () => {
    const { cuesPlugin, existingCuesMd: existingCuesMdFresh } = await import('./cues');
    const client = makeClient(async () => ({ data: { parts: [] } }));
    const plugin = await cuesPlugin({ client, directory: tmpDir } as any);
    await plugin['chat.message']({ sessionID: 'real-session' }, { parts: [] });
    expect(client.session.create).not.toHaveBeenCalled();
    expect(existingCuesMdFresh(tmpDir)).toBeNull();
  });

  it('never throws even when client.session.create rejects (errors are swallowed)', async () => {
    const { cuesPlugin, existingCuesMd: existingCuesMdFresh } = await import('./cues');
    const client = {
      session: {
        create: vi.fn().mockRejectedValue(new Error('network down')),
        prompt: vi.fn(),
        delete: vi.fn(),
      },
    };
    const plugin = await cuesPlugin({ client, directory: tmpDir } as any);
    await expect(
      plugin['chat.message'](
        { sessionID: 'real-session' },
        { parts: [{ type: 'text', text: 'hello' }] },
      ),
    ).resolves.toBeUndefined();
    expect(existingCuesMdFresh(tmpDir)).toBeNull();
  });

  it('still writes the file (partial-file-better-than-nothing) when the response has no frontmatter', async () => {
    const { cuesPlugin, existingCuesMd: existingCuesMdFresh } = await import('./cues');
    const client = makeClient(async () => ({
      data: { parts: [{ type: 'text', text: 'not a cues file at all' }] },
    }));
    const plugin = await cuesPlugin({ client, directory: tmpDir } as any);
    await plugin['chat.message'](
      { sessionID: 'real-session' },
      { parts: [{ type: 'text', text: 'hi' }] },
    );
    expect(existingCuesMdFresh(tmpDir)).toBe('not a cues file at all');
  });

  it('reads parts from output.message.parts when output.parts is absent', async () => {
    const { cuesPlugin, existingCuesMd: existingCuesMdFresh } = await import('./cues');
    const client = makeClient(async () => ({
      data: { parts: [{ type: 'text', text: '---\nx: 1\n---' }] },
    }));
    const plugin = await cuesPlugin({ client, directory: tmpDir } as any);
    await plugin['chat.message'](
      { sessionID: 'real-session' },
      { message: { parts: [{ type: 'text', text: 'hi via message.parts' }] } },
    );
    expect(existingCuesMdFresh(tmpDir)).toContain('x: 1');
  });

  it('warns and no-ops when no SKILL.md is found at any known location', async () => {
    // Remove the SKILL.md we planted in beforeEach so loadSkillText()
    // returns null for every candidate path.
    fs.rmSync(path.join(tmpHome, '.config/opencode/plugins/cues.SKILL.md'));
    const { cuesPlugin, existingCuesMd: existingCuesMdFresh } = await import('./cues');
    const client = makeClient(async () => ({ data: { parts: [] } }));
    const plugin = await cuesPlugin({ client, directory: tmpDir } as any);
    await plugin['chat.message'](
      { sessionID: 'real-session' },
      { parts: [{ type: 'text', text: 'hello' }] },
    );
    expect(client.session.create).not.toHaveBeenCalled();
    expect(existingCuesMdFresh(tmpDir)).toBeNull();
  });

  it('skips the whole session when hookInput.sessionID is already an own (in-flight) session', async () => {
    const { cuesPlugin } = await import('./cues');
    // Simulate the recursion guard by holding session.prompt open until
    // we've fired a second hook call with the SAME sessionID the first
    // call was assigned.
    let resolvePrompt!: (v: any) => void;
    const promptPromise = new Promise((resolve) => { resolvePrompt = resolve; });
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'sess-recursive' } }),
        prompt: vi.fn().mockImplementation(() => promptPromise),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    const plugin = await cuesPlugin({ client, directory: tmpDir } as any);

    const firstCall = plugin['chat.message'](
      { sessionID: 'outer-session' },
      { parts: [{ type: 'text', text: 'first message' }] },
    );

    // Give the microtask queue a turn so session.create resolves and
    // 'sess-recursive' lands in the plugin's ownSessions set before we
    // simulate the recursive re-entrant call.
    await Promise.resolve();
    await Promise.resolve();

    // Recursive call: OpenCode firing chat.message for our own
    // throwaway session while it's still in flight.
    await plugin['chat.message']({ sessionID: 'sess-recursive' }, { parts: [{ type: 'text', text: 'echo' }] });

    // Only the outer call's session.create should have run.
    expect(client.session.create).toHaveBeenCalledTimes(1);

    resolvePrompt({ data: { parts: [{ type: 'text', text: '---\ndone: true\n---' }] } });
    await firstCall;
    expect(client.session.delete).toHaveBeenCalledTimes(1);
  });
});

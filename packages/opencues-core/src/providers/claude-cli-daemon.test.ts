/**
 * ClaudeCliDaemon — unit tests with a fake spawn.
 *
 * No actual `claude` binary runs in CI. The injected `spawn` returns a
 * controllable fake child-process pair so we can drive the lifecycle
 * deterministically: emit stream-json events, force exit, etc.
 *
 * Run with: node --test dist/providers/claude-cli-daemon.test.js
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import {
  ClaudeCliDaemon,
  ClaudeCliDaemonPool,
  resolveModelFamily,
  type SpawnedProcess,
  type SpawnFn,
} from './claude-cli-daemon';

// ─── Fake subprocess ────────────────────────────────────────────────────

interface FakeChild {
  proc: SpawnedProcess;
  stdin: FakeWritable;
  stdout: FakeReadable;
  stderr: FakeReadable;
  spawnedCommand: string;
  spawnedArgs: string[];
  spawnedEnv: Record<string, string>;
  /** Test helper: emit a line on stdout (newline appended automatically). */
  emitStdoutLine(line: string): void;
  /** Test helper: trigger 'exit' with a code. */
  fakeExit(code: number): void;
  /** Test helper: trigger 'error'. */
  fakeError(err: Error): void;
}

class FakeWritable extends EventEmitter {
  written: string[] = [];
  write(chunk: string | Buffer): boolean {
    this.written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  }
}

class FakeReadable extends EventEmitter {}

function makeFakeSpawn(): { spawn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (command, args, env): SpawnedProcess => {
    const stdin = new FakeWritable();
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const procEmitter = new EventEmitter();
    let killed = false;
    const proc = {
      stdin: stdin as unknown as NodeJS.WritableStream,
      stdout: stdout as unknown as NodeJS.ReadableStream,
      stderr: stderr as unknown as NodeJS.ReadableStream,
      kill(_signal?: NodeJS.Signals | number): boolean {
        killed = true;
        setImmediate(() => procEmitter.emit('exit', 0));
        return true;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        procEmitter.on(event, listener);
        return proc;
      },
    } as unknown as SpawnedProcess;
    const child: FakeChild = {
      proc,
      stdin,
      stdout,
      stderr,
      spawnedCommand: command,
      spawnedArgs: args,
      spawnedEnv: env,
      emitStdoutLine(line: string) { stdout.emit('data', Buffer.from(line + '\n')); },
      fakeExit(code: number) { if (!killed) procEmitter.emit('exit', code); },
      fakeError(err: Error) { procEmitter.emit('error', err); },
    };
    children.push(child);
    return proc;
  };
  return { spawn, children };
}

function resultEvent(text: string): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('ClaudeCliDaemon — lazy spawn + queue + correlation', () => {
  it('does NOT spawn until first invoke()', () => {
    const { spawn, children } = makeFakeSpawn();
    new ClaudeCliDaemon({ model: 'haiku', systemPrompt: 'sys', spawn });
    assert.strictEqual(children.length, 0, 'spawn must be lazy');
  });

  it('first invoke() spawns one child and writes the prompt to stdin as stream-json', async () => {
    const { spawn, children } = makeFakeSpawn();
    const d = new ClaudeCliDaemon({ model: 'haiku', systemPrompt: 'sys', spawn });
    const p = d.invoke('hello');
    // Spawn happened
    assert.strictEqual(children.length, 1);
    const c = children[0];
    // Stdin received the JSON-encoded user message
    assert.strictEqual(c.stdin.written.length, 1);
    const written = JSON.parse(c.stdin.written[0].trim());
    assert.deepStrictEqual(written, { type: 'user', message: { role: 'user', content: 'hello' } });
    // Resolve with a result event
    c.emitStdoutLine(resultEvent('hi back'));
    assert.strictEqual(await p, 'hi back');
    d.shutdown();
  });

  it('per-model flag table is applied at spawn time', () => {
    const { spawn, children } = makeFakeSpawn();
    new ClaudeCliDaemon({ model: 'haiku', systemPrompt: 'h', spawn }).invoke('q').catch(() => {});
    new ClaudeCliDaemon({ model: 'sonnet', systemPrompt: 's', spawn }).invoke('q').catch(() => {});
    new ClaudeCliDaemon({ model: 'opus', systemPrompt: 'o', spawn }).invoke('q').catch(() => {});
    assert.strictEqual(children.length, 3);
    const haikuArgs = children[0].spawnedArgs.join(' ');
    const sonnetArgs = children[1].spawnedArgs.join(' ');
    const opusArgs = children[2].spawnedArgs.join(' ');
    // Common baseline flags
    for (const args of [haikuArgs, sonnetArgs, opusArgs]) {
      assert.match(args, /--bare/);
      assert.match(args, /--no-session-persistence/);
      assert.match(args, /--input-format stream-json/);
      assert.match(args, /--output-format stream-json/);
      assert.match(args, /--exclude-dynamic-system-prompt-sections/);
      assert.match(args, /--disable-slash-commands/);
      assert.match(args, /--append-system-prompt/);
    }
    // Per-model: only sonnet has --effort low
    assert.doesNotMatch(haikuArgs, /--effort/);
    assert.match(sonnetArgs, /--effort low/);
    assert.doesNotMatch(opusArgs, /--effort/);
    // Per-model env
    assert.strictEqual(children[0].spawnedEnv.CLAUDE_CODE_DISABLE_THINKING, '1');
    assert.strictEqual(children[0].spawnedEnv.MAX_THINKING_TOKENS, '0');
    assert.strictEqual(children[1].spawnedEnv.CLAUDE_CODE_DISABLE_THINKING, '1');
    assert.strictEqual(children[1].spawnedEnv.MAX_THINKING_TOKENS, undefined); // sonnet must NOT set this
    assert.strictEqual(children[2].spawnedEnv.CLAUDE_CODE_DISABLE_THINKING, '1');
    assert.strictEqual(children[2].spawnedEnv.MAX_THINKING_TOKENS, '0');
  });

  it('queues parallel invocations and processes them serially', async () => {
    const { spawn, children } = makeFakeSpawn();
    const d = new ClaudeCliDaemon({ model: 'haiku', systemPrompt: 'sys', spawn });
    const p1 = d.invoke('one');
    const p2 = d.invoke('two');
    const p3 = d.invoke('three');
    // Only the first prompt should be written to stdin so far
    const c = children[0];
    // Allow the microtask queue to settle so the daemon enqueues + writes
    await new Promise<void>((r) => setImmediate(r));
    assert.strictEqual(c.stdin.written.length, 1, 'must serialise — only one prompt in flight');
    c.emitStdoutLine(resultEvent('R1'));
    assert.strictEqual(await p1, 'R1');
    // Second prompt now in flight
    await new Promise<void>((r) => setImmediate(r));
    assert.strictEqual(c.stdin.written.length, 2);
    c.emitStdoutLine(resultEvent('R2'));
    assert.strictEqual(await p2, 'R2');
    await new Promise<void>((r) => setImmediate(r));
    assert.strictEqual(c.stdin.written.length, 3);
    c.emitStdoutLine(resultEvent('R3'));
    assert.strictEqual(await p3, 'R3');
    d.shutdown();
  });

  it('subprocess crash mid-flight rejects pending requests', async () => {
    const { spawn, children } = makeFakeSpawn();
    const d = new ClaudeCliDaemon({ model: 'haiku', systemPrompt: 'sys', spawn });
    const p1 = d.invoke('one');
    const p2 = d.invoke('two');
    children[0].fakeExit(1);
    await assert.rejects(p1, /subprocess exited/);
    await assert.rejects(p2, /subprocess exited/);
    d.shutdown();
  });

  it('rejects non-success result events with a clear error', async () => {
    const { spawn, children } = makeFakeSpawn();
    const d = new ClaudeCliDaemon({ model: 'haiku', systemPrompt: 'sys', spawn });
    const p = d.invoke('q');
    children[0].emitStdoutLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }));
    await assert.rejects(p, /non-success result/);
    d.shutdown();
  });

  it('shutdown() rejects in-flight + queued requests', async () => {
    const { spawn } = makeFakeSpawn();
    const d = new ClaudeCliDaemon({ model: 'haiku', systemPrompt: 'sys', spawn });
    const p1 = d.invoke('one');
    const p2 = d.invoke('two');
    d.shutdown();
    await assert.rejects(p1, /shut down/);
    await assert.rejects(p2, /shut down/);
  });

  it('handles split / partial stdout chunks (line-delimited parser)', async () => {
    const { spawn, children } = makeFakeSpawn();
    const d = new ClaudeCliDaemon({ model: 'haiku', systemPrompt: 'sys', spawn });
    const p = d.invoke('q');
    const c = children[0];
    // Emit the result event as two split chunks; ensure parser reassembles.
    const event = resultEvent('parsed-correctly');
    const half = Math.floor(event.length / 2);
    c.stdout.emit('data', Buffer.from(event.slice(0, half)));
    c.stdout.emit('data', Buffer.from(event.slice(half) + '\n'));
    assert.strictEqual(await p, 'parsed-correctly');
    d.shutdown();
  });

  it('idle reap kills the subprocess after idleReapMs with no requests', async () => {
    const { spawn, children } = makeFakeSpawn();
    const d = new ClaudeCliDaemon({ model: 'haiku', systemPrompt: 'sys', spawn, idleReapMs: 20 });
    const p = d.invoke('q');
    children[0].emitStdoutLine(resultEvent('ok'));
    await p;
    assert.strictEqual(d.isAlive, true);
    // Wait past idleReapMs
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(d.isAlive, false, 'should reap after idle window');
  });

  it('post-reap invoke spawns a fresh subprocess', async () => {
    const { spawn, children } = makeFakeSpawn();
    const d = new ClaudeCliDaemon({ model: 'haiku', systemPrompt: 'sys', spawn, idleReapMs: 20 });
    await (async () => {
      const p = d.invoke('first');
      children[0].emitStdoutLine(resultEvent('R1'));
      await p;
    })();
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(d.isAlive, false);
    // Next invoke spawns a new child
    const p2 = d.invoke('second');
    assert.strictEqual(children.length, 2, 'must respawn after reap');
    children[1].emitStdoutLine(resultEvent('R2'));
    assert.strictEqual(await p2, 'R2');
    d.shutdown();
  });
});

describe('resolveModelFamily — alias + full-name handling', () => {
  it('aliases map to themselves', () => {
    assert.strictEqual(resolveModelFamily('haiku'), 'haiku');
    assert.strictEqual(resolveModelFamily('sonnet'), 'sonnet');
    assert.strictEqual(resolveModelFamily('opus'), 'opus');
  });

  it('case-insensitive', () => {
    assert.strictEqual(resolveModelFamily('Haiku'), 'haiku');
    assert.strictEqual(resolveModelFamily('SONNET'), 'sonnet');
  });

  it('full version-pinned names resolve to family', () => {
    assert.strictEqual(resolveModelFamily('claude-haiku-4-5-20251001'), 'haiku');
    assert.strictEqual(resolveModelFamily('claude-haiku-3-5'), 'haiku');
    assert.strictEqual(resolveModelFamily('claude-sonnet-4-6'), 'sonnet');
    assert.strictEqual(resolveModelFamily('claude-opus-4-7'), 'opus');
  });

  it('throws on unknown names with a clear error', () => {
    assert.throws(
      () => resolveModelFamily('gpt-4o-mini'),
      /cannot infer model family/,
    );
    assert.throws(
      () => resolveModelFamily('llama-3-70b'),
      /haiku.*sonnet.*opus/,
    );
  });
});

describe('ClaudeCliDaemon — model pass-through (alias vs full name)', () => {
  it('passes full version-pinned name verbatim to --model', () => {
    const { spawn, children } = makeFakeSpawn();
    const d = new ClaudeCliDaemon({
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'sys',
      spawn,
    });
    d.invoke('q').catch(() => {});
    const args = children[0].spawnedArgs;
    // --model gets the literal string the user supplied
    const modelIdx = args.indexOf('--model');
    assert.strictEqual(args[modelIdx + 1], 'claude-haiku-4-5-20251001');
    // Flag tuning still picks the haiku family
    assert.doesNotMatch(args.join(' '), /--effort/);
    assert.strictEqual(children[0].spawnedEnv.MAX_THINKING_TOKENS, '0');
  });

  it('claude-sonnet-4-6 (full name) gets the sonnet flag tuning', () => {
    const { spawn, children } = makeFakeSpawn();
    const d = new ClaudeCliDaemon({ model: 'claude-sonnet-4-6', systemPrompt: 's', spawn });
    d.invoke('q').catch(() => {});
    const args = children[0].spawnedArgs;
    assert.strictEqual(args[args.indexOf('--model') + 1], 'claude-sonnet-4-6');
    assert.match(args.join(' '), /--effort low/);
    // Sonnet must NOT set MAX_THINKING_TOKENS (interferes)
    assert.strictEqual(children[0].spawnedEnv.MAX_THINKING_TOKENS, undefined);
  });

  it('unsupported model name throws at spawn time (not silently)', () => {
    const { spawn } = makeFakeSpawn();
    const d = new ClaudeCliDaemon({ model: 'gpt-4o-mini', systemPrompt: 's', spawn });
    return assert.rejects(d.invoke('q'), /cannot infer model family/);
  });
});

describe('ClaudeCliDaemonPool — get-or-create + key isolation', () => {
  it('returns the SAME daemon for the same (model, systemPrompt) key', () => {
    const { spawn } = makeFakeSpawn();
    const pool = new ClaudeCliDaemonPool({ spawn });
    const a = pool.get('haiku', 'same');
    const b = pool.get('haiku', 'same');
    assert.strictEqual(a, b);
    assert.strictEqual(pool.size, 1);
  });

  it('returns DIFFERENT daemons for different system prompts', () => {
    const { spawn } = makeFakeSpawn();
    const pool = new ClaudeCliDaemonPool({ spawn });
    const a = pool.get('haiku', 'prompt-A');
    const b = pool.get('haiku', 'prompt-B');
    assert.notStrictEqual(a, b);
    assert.strictEqual(pool.size, 2);
  });

  it('returns DIFFERENT daemons for different models', () => {
    const { spawn } = makeFakeSpawn();
    const pool = new ClaudeCliDaemonPool({ spawn });
    const h = pool.get('haiku', 'same');
    const s = pool.get('sonnet', 'same');
    assert.notStrictEqual(h, s);
    assert.strictEqual(pool.size, 2);
  });

  it('shutdownAll() drops every daemon + clears the map', () => {
    const { spawn } = makeFakeSpawn();
    const pool = new ClaudeCliDaemonPool({ spawn });
    pool.get('haiku', 'a');
    pool.get('sonnet', 'b');
    pool.get('opus', 'c');
    assert.strictEqual(pool.size, 3);
    pool.shutdownAll();
    assert.strictEqual(pool.size, 0);
  });
});

// Scenario: the polled-host blank-trigger journey.
//
// The resolver's explicit-`_` gate (resolver.ts ~1018) only lets blank
// sources fire when the `_` was armed by a real `_` keystroke OR the
// underscore COUNT increased between consecutive text events. Both are
// keystroke-era signals. On apple-notes the daemon delivers one coarse
// text-change per poll tick — a user who deletes an answered cue and
// types a new one produces equal counts, so every blank after the first
// was silently masked (live repro 2026-07-06: "Draft an email body _"
// never dispatched; only `explicit-_ gate BLOCKED` at debug level).
//
// The fix: the daemon detects a fresh standalone marker in the changed
// region and dispatches a synthetic standalone-`_` KeyEvent through
// BootResult.dispatchKey BEFORE the text-change — feeding the arm
// signal through the same onUnderscoreKey path real keyboards use.
// These scenarios pin both halves. Per the agentic-scenario rules they
// assert the RUNTIME CONTRACT (trigger armed vs blocked, via the
// resolver's own log lines), never LLM output.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { boot, type BootResult } from './boot';

// The live symptom was the ABSENCE of any source dispatch — no
// "FluidBlank: starting" line ever appeared. That's the contract these
// scenarios pin (never LLM output; the fake key means the call itself
// errors after dispatch, which is fine — dispatch is the assertion).
const DISPATCHED = /(FluidBlank|TransformBlank): starting/;

describe('universal-band (polled-host) blank-trigger scenarios', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevOpencuesHome: string | undefined;
  let prevDebug: string | undefined;

  beforeEach(() => {
    // Hermeticity: never read the real ~/.cues (check-test-hermeticity.sh).
    // HOME itself is sandboxed — boot()'s search paths include ${HOME}/.cues,
    // and a real user config (83 blanks) makes routing nondeterministic:
    // e.g. "capital of portugal" hits the shipped `countries` keyword blank
    // and FluidBlank correctly cedes, breaking the dispatch assertion.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-an-scen-'));
    prevHome = process.env.HOME;
    prevOpencuesHome = process.env.OPENCUES_HOME;
    prevDebug = process.env.DEBUG_OPENCUES;
    process.env.HOME = tmpHome;
    process.env.OPENCUES_HOME = tmpHome;
    process.env.DEBUG_OPENCUES = '1';
    // The gate's debug lines gate on the debug-mode scalar once loaded.
    fs.writeFileSync(path.join(tmpHome, 'OPENCUES.md'), '---\ndebug-mode: on\n---\n');
    // A wholly-empty config tree makes the resolver skip building
    // sources ("no cuesConfig/blanksConfig") — one minimal CUES.md
    // makes it build the LLM blank sources the scenarios exercise.
    fs.writeFileSync(path.join(tmpHome, 'CUES.md'), '---\nname: scenario-sandbox\n---\n');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevOpencuesHome === undefined) delete process.env.OPENCUES_HOME;
    else process.env.OPENCUES_HOME = prevOpencuesHome;
    if (prevDebug === undefined) delete process.env.DEBUG_OPENCUES;
    else process.env.DEBUG_OPENCUES = prevDebug;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  interface Session {
    result: BootResult;
    logs: string[];
    text: string;
  }

  // Daemon cursor semantics: just after the last standalone `_`,
  // else text end (tick.ts synthCursor).
  function cursorFor(text: string): number {
    const i = text.lastIndexOf('_');
    return i >= 0 ? i + 1 : text.length;
  }

  async function bootSession(): Promise<Session> {
    const logs: string[] = [];
    const session: Session = { result: undefined as unknown as BootResult, logs, text: '' };
    session.result = boot({
      hostName: 'apple-notes',
      hostVersion: '0.0.0-test',
      cwd: tmpHome,
      getText: () => session.text,
      getCursorOffset: () => cursorFor(session.text),
      setText: (t: string) => { session.text = t; },
      setCursorOffset: () => {},
      forceRender: () => {},
      pushText: (t: string) => { session.text = t; },
      readFile: async (p: string) => {
        try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
      },
      readDir: async (p: string) => {
        try {
          return fs.readdirSync(p, { withFileTypes: true })
            .map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
        } catch { return null; }
      },
      writeFile: async () => {},
      log: (_lvl, msg) => { logs.push(String(msg)); },
      llmApiKey: 'test-fake-key-never-called-successfully',
      // Cover whichever provider the default routing resolves to —
      // dispatch (the assertion) happens before any network call.
      llmApiKeys: {
        GROQ_API_KEY: 'test-fake-key-never-called-successfully',
        CEREBRAS_API_KEY: 'test-fake-key-never-called-successfully',
      },
      llmDebounceMs: 50,
    });
    // Resolver subscribes after ConfigLoader.load() resolves; its
    // subscribe() rebuild logs "Resolver: built ..." at info level.
    await vi.waitFor(() => {
      if (!logs.some(l => l.includes('Resolver: built'))) {
        throw new Error('not subscribed yet; logs: ' + JSON.stringify(logs.slice(-10)));
      }
    }, { timeout: 3000, interval: 20 });
    return session;
  }

  /** Synthetic standalone-`_` arm: what the daemon sends before a
   *  user text-change whose changed region contains a fresh marker.
   *  event.text is the buffer WITHOUT the marker char (pre-insert
   *  state), cursorOffset the marker's position — the exact shape
   *  onUnderscoreKey expects for its standalone check. */
  function armMarker(s: Session, text: string): void {
    const idx = text.lastIndexOf('_');
    s.result.dispatchKey({
      key: '_',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      text: text.slice(0, idx) + text.slice(idx + 1),
      cursorOffset: idx,
    });
  }

  function notify(s: Session, text: string): void {
    s.text = text;
    s.result.notifyTextChange(text, cursorFor(text), 'user');
  }

  async function waitDispatch(s: Session): Promise<void> {
    await vi.waitFor(() => {
      if (!s.logs.some(l => DISPATCHED.test(l))) {
        throw new Error('no dispatch yet; log tail: ' + JSON.stringify(s.logs.slice(-8)));
      }
    }, { timeout: 2000, interval: 20 });
  }

  /** Debounce is 50ms in these sessions — 400ms of silence proves the
   *  resolver masked the blank rather than merely not-yet-fired. */
  async function expectNoDispatch(s: Session): Promise<void> {
    await new Promise(r => setTimeout(r, 400));
    expect(s.logs.filter(l => DISPATCHED.test(l))).toEqual([]);
  }

  it('REPRO: second cue in one poll tick never dispatches without an arm signal', async () => {
    const s = await bootSession();
    // First cue after boot: previousText is '' → count 0→1 → dispatches.
    notify(s, 'capital of portugal _\n');
    await waitDispatch(s);

    // User erases the note and types a NEW cue, arriving as ONE coarse
    // text-change: count 1→1, both texts end in `_`, no keystroke
    // channel → every blank source stays masked. This was the live
    // "nothing's happening" bug (2026-07-06, note p904).
    s.logs.length = 0;
    notify(s, 'Draft an email body _ \n\n\n\n');
    await expectNoDispatch(s);
    s.result.dispose();
  });

  it('FIX: a synthetic standalone-_ KeyEvent arms the gate for the same journey', async () => {
    const s = await bootSession();
    notify(s, 'capital of portugal _\n');
    await waitDispatch(s);

    s.logs.length = 0;
    const next = 'Draft an email body _ \n\n\n\n';
    armMarker(s, next);          // ← what the daemon now does
    notify(s, next);
    await waitDispatch(s);
    s.result.dispose();
  });

  it('arm is one-shot: a later cue with equal counts still needs its own arm', async () => {
    const s = await bootSession();
    const first = 'question one _\n';
    armMarker(s, first);
    notify(s, first);
    await waitDispatch(s);

    s.logs.length = 0;
    notify(s, 'question two _\n'); // no arm this time
    await expectNoDispatch(s);
    s.result.dispose();
  });

  it('a _ typed adjacent to a word does not arm (standalone check holds)', async () => {
    const s = await bootSession();
    notify(s, 'first _\n');
    await waitDispatch(s);
    s.logs.length = 0;
    const next = 'snake_case everywhere\n';
    // daemon would not send this (no standalone marker), but even if a
    // host sent a bogus arm for an attached _, onUnderscoreKey declines:
    const idx = next.indexOf('_');
    s.result.dispatchKey({
      key: '_',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      text: next.slice(0, idx) + next.slice(idx + 1),
      cursorOffset: idx,
    });
    notify(s, next);
    await expectNoDispatch(s);
    s.result.dispose();
  });
});

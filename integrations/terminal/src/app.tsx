// Standalone OpenCues terminal app.
//
// Renders a single full-width TextareaRenderable with a one-line
// statusline below it. On Ctrl+S (or Ctrl+D / Enter-on-empty / submit
// keybind) the current buffer is printed to stdout and the process
// exits — same shape as $EDITOR-style invocations.

import { render, useKeyboard, useRenderer } from '@opentui/solid';
import { createSignal, onMount } from 'solid-js';
import type { TextareaRenderable } from '@opentui/core';
import { SyntaxStyle, TextAttributes } from '@opentui/core';
import { startOpenCues, dispatchOpenCuesKey } from './bootstrap';

interface AppOpts {
  initialText: string;
  outputPath: string | null;
}

function App(props: AppOpts) {
  const renderer = useRenderer();
  const [tip, setTip] = createSignal<string | null>(null);
  let textarea: TextareaRenderable | undefined;
  const syntax = SyntaxStyle.create();

  onMount(() => {
    if (!textarea) return;
    textarea.syntaxStyle = syntax;
    if (props.initialText) {
      textarea.setText(props.initialText);
      textarea.cursorOffset = props.initialText.length;
    }
    startOpenCues({
      renderer,
      textarea,
      syntax,
      // The oc-edit shim cd's into integrations/terminal/ to find
      // bunfig.toml, so process.cwd() inside the app is the terminal
      // dir — not where the user actually invoked oc-edit. The shim
      // captures the calling cwd in OPENCUES_USER_CWD; use that if
      // set, fall back to process.cwd() for in-repo dev runs.
      cwd: process.env.OPENCUES_USER_CWD || process.cwd(),
      onTipChange: (t) => setTip(t),
    });
    textarea.focus();

    // oc-popup now hides the outer status bar BEFORE invoking
    // oc-edit (so the inner UI doesn't trigger a redraw cascade
    // mid-render). Nothing for us to do here for the bar.
  });

  useKeyboard((evt: any) => {
    // Unified shortcuts across both panels of oc-shell:
    //   Ctrl+Alt+S — submit here, opens the popup from oc-shell.
    //   Ctrl+Alt+Q — cancel here, exits oc-shell entirely.
    // Same chord serves the same SEMANTIC action on both layers.
    //
    // The terminal encodes Ctrl+Alt+<letter> as ESC + Ctrl-<letter>,
    // which OpenTUI surfaces as `{ ctrl: true, meta: true, name: 'x' }`.
    // We also accept the raw byte sequences as a defensive fallback
    // in case an emulator forwards them pre-decoded.
    if (evt.ctrl && evt.meta && evt.name === 's') {
      finish(textarea?.plainText ?? '', 0);
      return;
    }
    if (evt.sequence === '\x1b\x13') {  // ESC + Ctrl-S literal
      finish(textarea?.plainText ?? '', 0);
      return;
    }
    if (evt.ctrl && evt.meta && evt.name === 'q') {
      finish('', 130);
      return;
    }
    if (evt.sequence === '\x1b\x11') {  // ESC + Ctrl-Q literal
      finish('', 130);
      return;
    }
    // Forward to OpenCues first; only fall through to OpenTUI's own
    // textarea key handling if the runtime didn't consume it.
    dispatchOpenCuesKey(evt);
  });

  function finish(text: string, exitCode: number): void {
    // Tear down OpenTUI BEFORE writing to stdout. The renderer holds
    // the terminal in the alt-screen buffer; anything written there
    // is discarded when we leave alt-screen mode. Calling
    // renderer.destroy() restores the main screen — stdout writes
    // after that show up in the user's shell.
    try { renderer?.destroy?.(); } catch { /* swallow */ }
    try {
      if (props.outputPath) {
        require('node:fs').writeFileSync(props.outputPath, text);
      } else {
        // Trailing newline so the text doesn't collide with the
        // shell's next prompt (which is on the line below).
        process.stdout.write(text + '\n');
      }
    } catch { /* swallow */ }
    setTimeout(() => process.exit(exitCode), 0);
  }

  return (
    <box style={{ flexDirection: 'column', width: '100%', height: '100%', paddingLeft: 1, paddingRight: 1 }}>
      <box style={{ flexGrow: 1, width: '100%' }}>
        <textarea
          ref={(t: TextareaRenderable) => { textarea = t; }}
          style={{ width: '100%', height: '100%' }}
          wrapMode="word"
        />
      </box>
      {/*
        Statusline — same dark bar, same brand block, same fg
        colour as the outer oc-shell tmux bar. When this popup is
        open the outer bar hides itself completely (see
        oc-shell.tmux.conf), so visually the bar "jumps" from the
        bottom of the screen up into the popup. Only the action
        words change: outer says "Input Box / Exit", inner says
        "Submit / Cancel".
        When a tip is active (the runtime hovered a word and
        surfaced its tip), show that across the full width instead.
      */}
      <box
        style={{
          height: 1,
          width: '100%',
          flexDirection: 'row',
          backgroundColor: '#1a1a1a',
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        {tip() != null
          ? <text fg="#ffffff">{tip()}</text>
          : <box style={{ flexDirection: 'row' }}>
              {/* Brand: reverse-video bright-white badge, then wordmark in plain bright white */}
              <text fg="#1a1a1a" bg="#ffffff" attributes={TextAttributes.BOLD}>C_</text>
              <text fg="#ffffff"> OpenCues_  ·  Submit: Ctrl+Alt+S   ·   Cancel: Ctrl+Alt+Q</text>
            </box>}
      </box>
    </box>
  );
}

function parseArgs(argv: string[]): { initialText: string; outputPath: string | null } {
  let initialText = '';
  let outputPath: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') {
      outputPath = argv[++i] ?? null;
    } else if (a === '--initial' || a === '-i') {
      initialText = argv[++i] ?? '';
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: oc-edit [--initial TEXT] [--out FILE]');
      console.log('       echo TEXT | oc-edit');
      process.exit(0);
    } else if (!a.startsWith('-')) {
      // Positional: treat as a file to edit.
      try { initialText = require('node:fs').readFileSync(a, 'utf8'); outputPath = a; } catch {}
    }
  }
  return { initialText, outputPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  // Pipe-from-stdin shortcut: if stdin isn't a TTY, slurp it as initial text.
  if (!process.stdin.isTTY && !args.initialText) {
    args.initialText = await new Promise<string>((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { buf += chunk; });
      process.stdin.on('end', () => resolve(buf));
    });
  }

  await render(() => <App initialText={args.initialText} outputPath={args.outputPath} />);
}

main().catch((err) => {
  console.error('[oc-edit] fatal:', err);
  process.exit(1);
});

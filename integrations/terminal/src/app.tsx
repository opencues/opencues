// Standalone OpenCues terminal app.
//
// Renders a single full-width TextareaRenderable with a one-line
// statusline below it. On Ctrl+S (or Ctrl+D / Enter-on-empty / submit
// keybind) the current buffer is printed to stdout and the process
// exits — same shape as $EDITOR-style invocations.

import { render, useKeyboard, useRenderer } from '@opentui/solid';
import { createSignal, onMount } from 'solid-js';
import type { TextareaRenderable } from '@opentui/core';
import { SyntaxStyle } from '@opentui/core';
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
  });

  useKeyboard((evt: any) => {
    // Ctrl+S commits the buffer; Ctrl+C exits without committing.
    if (evt.ctrl && (evt.name === 's' || evt.sequence === '\x13')) {
      finish(textarea?.plainText ?? '', 0);
      return;
    }
    if (evt.ctrl && (evt.name === 'c' || evt.sequence === '\x03')) {
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
    <box style={{ flexDirection: 'column', width: '100%', height: '100%' }}>
      <box style={{ flexGrow: 1, width: '100%' }}>
        <textarea
          ref={(t: TextareaRenderable) => { textarea = t; }}
          style={{ width: '100%', height: '100%' }}
          wrapMode="word"
        />
      </box>
      <box style={{ height: 1, width: '100%', flexDirection: 'row' }}>
        <text>{tip() ?? 'opencues — Ctrl+S submit, Ctrl+C cancel'}</text>
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

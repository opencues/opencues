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
import { startOpenCues, dispatchOpenCuesKey, resetOpenCuesBufferState } from './bootstrap';

interface AppOpts {
  initialText: string;
  outputPath: string | null;
  /** When true, never exit on submit/cancel — resize the host tmux
   *  pane back to 1 row and forward focus to the target pane instead.
   *  `oc-shell` spawns one keep-alive instance per session so popup
   *  activation is just a tmux resize, not a fresh bun spawn. */
  keepAlive?: boolean;
  /** tmux pane id (e.g. "%0") that submitted text gets pasted into.
   *  Required when keepAlive is set. */
  targetPane?: string;
  /** Text the shell-integration captured from $READLINE_LINE just
   *  before this oc-edit opened. On cancel (Alt+Shift+↓ / Esc /
   *  Ctrl+Q / Ctrl+Alt+Q), we paste this BACK into the shell pane to
   *  undo the line-clearing the capture function did — restoring the
   *  prompt to the user's pre-Alt+Shift+↑ state. On submit we paste
   *  the textarea's current contents instead. */
  restoreOnCancel?: string;
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
      // The oc-edit shim cd's into integrations/shell/ to find
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
    // Unified shortcuts across both panels of `oc-shell`:
    //   Ctrl+Alt+S — submit here, opens the popup from `oc-shell`.
    //   Ctrl+Alt+Q — cancel here, exits `oc-shell` entirely.
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
    // Plain Ctrl+S is an unadvertised alias for the submit chord.
    // The status bar only shows "Ctrl+Alt+S" so we don't overload
    // the user with synonyms, but the bare chord lands here too —
    // useful for emulators that swallow Alt.
    if (evt.ctrl && !evt.meta && evt.name === 's') {
      finish(textarea?.plainText ?? '', 0);
      return;
    }
    if (evt.sequence === '\x13' && !evt.meta) {  // Ctrl-S literal byte
      finish(textarea?.plainText ?? '', 0);
      return;
    }
    // M-C-q is cancel. In keep-alive mode the tmux root binding is
    // context-aware: from the shell pane it kills the session, from
    // the oc-input pane it forwards M-C-q here so we can clear the
    // textarea + slide back down (no paste). In legacy popup mode it
    // exits the popup with empty buffer.
    if (evt.ctrl && evt.meta && evt.name === 'q') {
      finish('', 130);
      return;
    }
    if (evt.sequence === '\x1b\x11') {  // ESC + Ctrl-Q literal
      finish('', 130);
      return;
    }
    // Plain Ctrl+Q — unadvertised cancel alias, same rationale as
    // plain Ctrl+S above.
    if (evt.ctrl && !evt.meta && evt.name === 'q') {
      finish('', 130);
      return;
    }
    if (evt.sequence === '\x11' && !evt.meta) {  // Ctrl-Q literal byte
      finish('', 130);
      return;
    }
    // Plain Escape — unadvertised cancel alias. In keep-alive mode
    // this calls finish() (so the textarea clears + slides down,
    // matching the cancel semantic). In legacy popup mode Esc falls
    // through to the runtime (which uses it to dismiss tips, etc.).
    if (props.keepAlive && (evt.name === 'escape' || evt.sequence === '\x1b')) {
      finish('', 130);
      return;
    }
    // Forward to OpenCues first; only fall through to OpenTUI's own
    // textarea key handling if the runtime didn't consume it.
    dispatchOpenCuesKey(evt);
  });

  function finish(text: string, exitCode: number): void {
    if (props.keepAlive) {
      // Keep-alive (slide-pane) mode. What we paste back into the
      // shell pane depends on how we exited:
      //   • Submit (exitCode === 0): paste the textarea's current
      //     contents (what the user wants to send to the shell).
      //   • Cancel (exitCode === 130): paste props.restoreOnCancel,
      //     which is whatever the shell-integration captured from
      //     $READLINE_LINE at activate time. This undoes the
      //     line-clearing the capture function did, so the shell's
      //     prompt is restored to its pre-Alt+Shift+↑ state.
      //   • Both: empty string ⇒ inject nothing.
      const toInject = exitCode === 0 ? text : (props.restoreOnCancel ?? '');
      if (toInject && props.targetPane) {
        try { injectIntoPane(props.targetPane, toInject); } catch { /* swallow */ }
      }
      if (textarea) {
        try {
          textarea.setText('');
          textarea.cursorOffset = 0;
        } catch { /* swallow */ }
      }
      // Clear per-buffer runtime state (DynDefs, HighlightState, SpanFill,
      // SelectorSatellite) so the next open of the slide-pane starts
      // from zero. Without this, a prompt-improver rewrite committed
      // this session leaves a blank-attributed DynDef in memory; the
      // next `improve prompt _` keystroke hits the stale def, the
      // resolver's `if (existing && existing.blankName) continue` guard
      // fires, and the new substitute silently skips.
      try { resetOpenCuesBufferState(); } catch { /* swallow */ }
      deactivate();
      return;
    }
    // Legacy popup / standalone mode: tear down + write + exit.
    try { renderer?.destroy?.(); } catch { /* swallow */ }
    try {
      if (props.outputPath) {
        require('node:fs').writeFileSync(props.outputPath, text);
      } else {
        process.stdout.write(text + '\n');
      }
    } catch { /* swallow */ }
    setTimeout(() => process.exit(exitCode), 0);
  }

  function deactivate(): void {
    // Kill this pane entirely. The bun process exits, the pane is
    // removed, and tmux's layout collapses back to just the shell
    // pane + status bar — no idle row, no border. Next activation
    // creates a fresh oc-edit pane via the M-C-s binding's
    // split-window command.
    const tmuxBin = process.env.OPENCUES_TMUX || 'tmux';
    const me = process.env.TMUX_PANE;
    try {
      if (me) runTmux(tmuxBin, ['kill-pane', '-t', me]);
    } catch { /* if kill-pane fails we'll exit below regardless */ }
    // Belt-and-braces: process.exit too in case kill-pane was a no-op
    // (e.g. tmux is gone). 50ms gives time for kill-pane to land.
    setTimeout(() => process.exit(0), 50);
  }

  // In keep-alive (slide-pane) mode the brand bar lives in tmux's
  // status bar at the terminal bottom — owned by tmux, untouched by
  // opentui's lifecycle, so it never flashes on respawn/resize.
  // Render only the textarea. When a tip is active we still surface
  // it inline below the textarea (one-row bar) so cycle feedback
  // works during edit.
  if (props.keepAlive) {
    return (
      <box style={{ flexDirection: 'column', width: '100%', height: '100%', paddingLeft: 1, paddingRight: 1 }}>
        <box style={{ flexGrow: 1, width: '100%' }}>
          <textarea
            ref={(t: TextareaRenderable) => { textarea = t; }}
            style={{ width: '100%', height: '100%' }}
            wrapMode="word"
          />
        </box>
        {tip() != null && (
          <box style={{ height: 1, width: '100%', paddingLeft: 1, paddingRight: 1 }}>
            <text>{tip()}</text>
          </box>
        )}
      </box>
    );
  }

  // Legacy popup / standalone mode: full layout with inline statusline.
  return (
    <box style={{ flexDirection: 'column', width: '100%', height: '100%', paddingLeft: 1, paddingRight: 1 }}>
      <box style={{ flexGrow: 1, width: '100%' }}>
        <textarea
          ref={(t: TextareaRenderable) => { textarea = t; }}
          style={{ width: '100%', height: '100%' }}
          wrapMode="word"
        />
      </box>
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
              <text fg="#1a1a1a" bg="#ffffff" attributes={TextAttributes.BOLD}>C_</text>
              <text fg="#ffffff"> OpenCues_  ·  Submit: Ctrl+Alt+S   ·   Cancel: Ctrl+Alt+Q</text>
            </box>}
      </box>
    </box>
  );
}

// ─── tmux helpers (keep-alive / slide-pane mode) ──────────────────────

function runTmux(tmuxBin: string, args: string[]): void {
  // Synchronous spawn — we want the tmux command to land before we
  // proceed (e.g., resize must finish before select-pane). Using
  // Bun.spawnSync avoids the @types/node dependency on child_process.
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  spawnSync(tmuxBin, args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function injectIntoPane(targetPane: string, text: string): void {
  // Mirror bin/oc-popup's send-keys / paste-buffer logic. Three modes:
  //   typed       — literal keystrokes via send-keys -l, C-j between
  //                 lines. Best for TUIs that distinguish C-j from
  //                 C-m (Claude Code, vim, emacs). Default.
  //   bracketed   — paste-buffer -p; shell holds the block as one
  //                 editable chunk, newlines do NOT execute.
  //   raw         — paste-buffer; each \n is Enter.
  const tmuxBin = process.env.OPENCUES_TMUX || 'tmux';
  const mode = process.env.OPENCUES_POPUP_PASTE_MODE || 'typed';
  if (mode === 'typed') {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) runTmux(tmuxBin, ['send-keys', '-t', targetPane, '-l', lines[i]!]);
      if (i < lines.length - 1) runTmux(tmuxBin, ['send-keys', '-t', targetPane, 'C-j']);
    }
    return;
  }
  // bracketed / raw: stage the text in a named tmux paste buffer, paste,
  // delete the buffer. Going via load-buffer keeps multi-MB drafts
  // possible without command-line length limits.
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const tmp = path.join(os.tmpdir(), `oc-popup-buf-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, text);
  try {
    runTmux(tmuxBin, ['load-buffer', '-b', 'oc-popup', tmp]);
    const flags = mode === 'raw'
      ? ['-b', 'oc-popup', '-t', targetPane]
      : ['-p', '-b', 'oc-popup', '-t', targetPane];
    runTmux(tmuxBin, ['paste-buffer', ...flags]);
    runTmux(tmuxBin, ['delete-buffer', '-b', 'oc-popup']);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* swallow */ }
  }
}

function parseArgs(argv: string[]): {
  initialText: string;
  outputPath: string | null;
  keepAlive: boolean;
  targetPane: string | null;
} {
  let initialText = '';
  let outputPath: string | null = null;
  let keepAlive = false;
  let targetPane: string | null = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') {
      outputPath = argv[++i] ?? null;
    } else if (a === '--initial' || a === '-i') {
      initialText = argv[++i] ?? '';
    } else if (a === '--keep-alive') {
      keepAlive = true;
    } else if (a === '--target-pane') {
      targetPane = argv[++i] ?? null;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: oc-edit [--initial TEXT] [--out FILE]');
      console.log('       echo TEXT | oc-edit');
      console.log('Slide-pane mode (used by `oc-shell`):');
      console.log('       oc-edit --keep-alive --target-pane <pane-id>');
      process.exit(0);
    } else if (!a.startsWith('-')) {
      try { initialText = require('node:fs').readFileSync(a, 'utf8'); outputPath = a; } catch {}
    }
  }
  return { initialText, outputPath, keepAlive, targetPane };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  // Shell-integration: tmux's Alt+Shift+↑ binding first sends Alt+m
  // to the shell pane (which fires our bind -x function), then opens
  // this oc-edit. The function captured $READLINE_LINE, cleared the
  // prompt, and wrote the captured text to $OPENCUES_LINE_BUF.
  //
  // We use the captured text BOTH as the textarea's initial content
  // AND as `restoreOnCancel` — so cancelling re-pastes the original
  // back into the shell pane, undoing the line-clearing.
  let restoreOnCancel: string | undefined;
  const lineBuf = process.env['OPENCUES_LINE_BUF'];
  if (lineBuf && !args.initialText) {
    try {
      const fs = require('node:fs');
      if (fs.existsSync(lineBuf)) {
        const captured = fs.readFileSync(lineBuf, 'utf8');
        if (captured) {
          args.initialText = captured;
          restoreOnCancel = captured;
        }
        fs.unlinkSync(lineBuf);
      }
    } catch { /* swallow */ }
  }

  // Pipe-from-stdin shortcut: if stdin isn't a TTY, slurp it as initial text.
  if (!process.stdin.isTTY && !args.initialText) {
    args.initialText = await new Promise<string>((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { buf += chunk; });
      process.stdin.on('end', () => resolve(buf));
    });
  }

  await render(() => <App
    initialText={args.initialText}
    outputPath={args.outputPath}
    keepAlive={args.keepAlive}
    targetPane={args.targetPane ?? undefined}
    restoreOnCancel={restoreOnCancel}
  />);
}

main().catch((err) => {
  console.error('[oc-edit] fatal:', err);
  process.exit(1);
});

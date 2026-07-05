// Standalone OpenCues terminal app.
//
// Renders a single full-width TextareaRenderable with a one-line
// statusline below it. On Ctrl+S (or Ctrl+D / Enter-on-empty / submit
// keybind) the current buffer is printed to stdout and the process
// exits — same shape as $EDITOR-style invocations.

// ─── Signal hygiene ─────────────────────────────────────────────────────
// Swallow SIGINT so Ctrl+C doesn't kill the bun process. The terminal
// driver translates Ctrl+C / `\x03` into SIGINT BEFORE our keyboard
// handler sees the byte; bun's default SIGINT handler exits the
// process, leaving tmux holding an empty pane while the runtime is
// dead. Result: the input box "still works" visually but cues stop
// firing (no runtime to respond) until the user closes + re-opens
// the pane. We bind a no-op listener so the process survives and
// Ctrl+C is effectively inert. `SIGTERM` is not swallowed — that
// path (e.g. `oc-shell` parent killing the pane) is a legitimate
// shutdown signal.
process.on('SIGINT', () => { /* no-op — Ctrl+C must not kill the pane */ });

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
  // Word-wrap the tip into up to 3 rows so long lines (tutorial coach,
  // completion recap, catalogue notices) GROW the bar instead of
  // clipping at the pane edge. Deterministic manual wrap — OpenTUI
  // <text> doesn't reliably wrap inside a sized box. Recomputed per
  // render so pane resizes re-wrap.
  const tipRows = (): string[] => {
    const t = tip();
    if (t == null) return [];
    const width = Math.max(20, (process.stdout.columns ?? 80) - 4);
    const rows: string[] = [];
    let rest = t.trim();
    while (rest.length > 0 && rows.length < 3) {
      if (rest.length <= width) { rows.push(rest); break; }
      let cut = rest.lastIndexOf(' ', width);
      if (cut < width * 0.6) cut = width; // no good break point — hard cut
      rows.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest.length > 0 && rows.length === 3 && rows[2].length > 1) {
      rows[2] = rows[2].slice(0, Math.max(0, width - 1)) + '…';
    }
    return rows.length > 0 ? rows : [''];
  };
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
    // Only ADVERTISED shortcuts are bound. The status bar lists them
    // so the user sees every keystroke the input pane responds to:
    //
    //   Ctrl+Alt+S — submit (paste textarea contents into shell pane)
    //   Ctrl+Alt+Q — cancel (clear + slide back down)
    //
    // Same chord serves the same SEMANTIC action across both layers
    // (the input pane and the outer oc-shell). The terminal encodes
    // Ctrl+Alt+<letter> as ESC + Ctrl-<letter> — OpenTUI surfaces it
    // as `{ ctrl: true, meta: true, name: 'x' }`. Raw byte sequences
    // are accepted as a defensive fallback in case an emulator
    // forwards them pre-decoded.
    //
    // ⚠ No silent / unadvertised aliases. We previously bound plain
    // Ctrl+S, plain Ctrl+Q, plain Esc, and Ctrl+C as un-advertised
    // synonyms. Ctrl+C in particular interacted badly with the
    // tmux/bun signal stack — `\x03` was sometimes delivered as
    // SIGINT to bun before useKeyboard saw it, breaking the runtime
    // mid-session. If you want to wipe the buffer, use Ctrl+Alt+Q
    // (cancel) and re-open with Alt+Shift+↑. If you need a new
    // shortcut, add it AND announce it in the status bar.
    if (evt.ctrl && evt.meta && evt.name === 's') {
      finish(textarea?.plainText ?? '', 0);
      return;
    }
    if (evt.sequence === '\x1b\x13') {  // ESC + Ctrl-S literal — Ctrl+Alt+S byte form
      finish(textarea?.plainText ?? '', 0);
      return;
    }
    if (evt.ctrl && evt.meta && evt.name === 'q') {
      finish('', 130);
      return;
    }
    if (evt.sequence === '\x1b\x11') {  // ESC + Ctrl-Q literal — Ctrl+Alt+Q byte form
      finish('', 130);
      return;
    }
    // Ctrl+C — wipe the textarea in-session AND reset per-buffer
    // runtime state (DynDefs, HighlightState, SpanFill, Selector-
    // Satellite). Without the reset, the next blank typed in the
    // same pane would silently no-op via the resolver's existing-
    // def guard.
    //
    // Now safe to bind because render() was called with
    // `exitOnCtrlC: false` — OpenTUI no longer installs the
    // process.exit() handler on SIGINT, so the byte reaches us
    // here intact.
    if ((evt.ctrl && !evt.meta && evt.name === 'c') || evt.sequence === '\x03') {
      try {
        if (textarea) {
          textarea.setText('');
          textarea.cursorOffset = 0;
        }
        resetOpenCuesBufferState();
      } catch { /* swallow */ }
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
          <box style={{ height: tipRows().length + 1, width: '100%', flexDirection: 'column' }}>
            {tipRows().map((row, i) =>
              i === 0 && row.startsWith('C_ ')
                ? <box style={{ flexDirection: 'row', height: 1 }}>
                    <text fg="#ffffff" attributes={TextAttributes.BOLD | TextAttributes.INVERSE}>C_</text>
                    <text>{row.slice(2)}</text>
                  </box>
                : <text>{row}</text>)}
            <text> </text>
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
              <text fg="#ffffff" attributes={TextAttributes.BOLD | TextAttributes.INVERSE}>C_</text>
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

  // `exitOnCtrlC: false` — opt out of OpenTUI's default SIGINT
  // handler that calls process.exit(). Otherwise Ctrl+C kills the
  // bun process, tmux holds an empty pane, runtime is dead, cues
  // silently stop firing. See @opentui/core CliRenderer config.
  // (Module-level `process.on('SIGINT', ...)` alone isn't enough
  // because Node listeners are cumulative — OpenTUI's handler still
  // fires alongside ours and exits the process anyway.)
  await render(() => <App
    initialText={args.initialText}
    outputPath={args.outputPath}
    keepAlive={args.keepAlive}
    targetPane={args.targetPane ?? undefined}
    restoreOnCancel={restoreOnCancel}
  />, { exitOnCtrlC: false });
}

main().catch((err) => {
  console.error('[oc-edit] fatal:', err);
  process.exit(1);
});

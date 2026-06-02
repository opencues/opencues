'use strict';

// Pick the navigation modifier combo displayed in the `opencues run`
// banner's Keys line. Mirrors the runtime's `resolveNavKeymap(configured,
// hostName)` in `@opencues/runtime/src/modules/nav-keymap.ts` — kept here
// because the CLI doesn't need to load the runtime build just to print
// one hint line. Drift risk is low: this only decides what STRING to
// print; the actual key dispatch is owned by the runtime, which has its
// own (canonical) resolver.
//
// Resolution:
//   - macOS (any host): "Ctrl+Option". That's the physical key label on
//     a Mac keyboard. Mac Terminal.app users get Ctrl+Option+arrow to
//     work too via the runtime's double-ESC synth (mac-keyboard.ts);
//     Ghostty / iTerm2 send modifier-encoded CSI natively. Chrome on
//     macOS routes through the DOM's altKey on the user's keyboard, so
//     the label is correct there as well.
//   - Linux / Windows / anything else: "Ctrl+Alt". Plain xterm-modifier
//     CSI; the Alt key is labelled Alt.
//
// `platform` defaults to `process.platform` but is passed explicitly so
// the function is unit-testable across darwin / linux / win32 / freebsd.
//
// Does NOT read the user's explicit `nav-keymap: ctrl-alt|ctrl-shift`
// override in ~/.cues/OPENCUES.md — the banner is informational and the
// auto-default covers ~every shipped setup. If overrides ever need to be
// honoured, a 5-line regex grep against the file is enough; no need to
// import the full ConfigLoader.

/**
 * @param {string} host - 'claude-code' | 'opencode' | 'chrome' | 'gemini-cli' | 'shell'
 * @param {string} [platform] - process.platform value; defaults to current process
 * @returns {'Ctrl+Option' | 'Ctrl+Alt'}
 */
function pickNavCombo(host, platform = process.platform) {
  if (platform === 'darwin') return 'Ctrl+Option';
  return 'Ctrl+Alt';
}

module.exports = { pickNavCombo };

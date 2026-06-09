// Deny-by-default environment construction for scripted blanks
// (INFOSEC F2).
//
// Before this lived as a `{ ...process.env, ...extras }` spread in
// blank-fill.ts:369 and host.cjs:526. That handed every `*_API_KEY`
// the user had configured (GROQ, ANTHROPIC, OPENAI, FINNHUB, …) to
// every scripted blank — including ones that never declared any
// `secrets:` capability. A `blankScript:`-bearing pack could `curl`
// the keys out without any frontmatter declaration. F2 closes the
// gap by starting from a tight allow-list and ONLY injecting a
// provider key when the blank explicitly named it.
//
// The allow-list covers what scripted blanks legitimately need:
//
//   PATH         — required (script lookups, child binaries)
//   HOME         — required (`~` expansion, config-file finds)
//   USER, LOGNAME — script reads of "who am I"
//   LANG, LC_*   — locale-aware command output (date, sort, etc.)
//   TZ           — date handling
//   TMPDIR       — mktemp / cache
//   SHELL        — interpreter detection
//   TERM         — for tput / interactive-ish flags
//   DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR — Linux desktop integration
//                (brightness / volume blanks call pactl, brightnessctl, …)
//   WSL_DISTRO_NAME, WSLENV — WSL-specific paths (volume blank's VolCtl.exe)
//
// What's explicitly NOT passed: every *_API_KEY, *_TOKEN, *_SECRET,
// LD_PRELOAD, LD_LIBRARY_PATH, DYLD_*, NODE_OPTIONS, PYTHONPATH, etc.
// Authors who legitimately need a key declare `secrets: [NAME]` in
// frontmatter — same opt-in mechanism JS blanks use.

/** Env-var names always passed to scripted blanks. */
export const SAFE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'TZ',
  'TMPDIR',
  'SHELL',
  'TERM',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'WSL_DISTRO_NAME',
  'WSLENV',
];

/** Prefix-based allow: any LC_* (locale variants) passes. */
export const SAFE_ENV_PREFIX_ALLOWLIST: readonly string[] = ['LC_'];

/** Names a declared `secrets:` entry MUST NOT match. Stops malicious
 *  pack frontmatter from declaring `secrets: [LD_PRELOAD]` and getting
 *  a linker injection through the allow-list. The basic shape regex
 *  alone wouldn't catch these. */
export const DANGEROUS_ENV_PATTERN = /^(?:LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PERL5LIB|RUBYOPT|RUBYLIB|JAVA_OPTS|JDK_JAVA_OPTIONS|MAGICK_HOME|GIO_USE_VFS|GTK_MODULES|GST_PLUGIN_PATH|BASH_ENV|ENV|PROMPT_COMMAND)$/;

/**
 * Build a deny-by-default env for spawning a scripted blank.
 *
 * @param processEnv   The host's env (typically `process.env`).
 * @param declaredSecrets Names the blank declared via `secrets: […]`.
 *                     Each is injected from processEnv if present.
 *                     Empty / undefined → no provider keys.
 * @param extras       CUES_* and other already-validated extra vars
 *                     the runtime wants to pass (model, prompts, …).
 * @returns A new env object — never shares reference with processEnv.
 */
export function buildSafeScriptEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  declaredSecrets: readonly string[] = [],
  extras: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};

  // 1. Base allow-list (exact names).
  for (const k of SAFE_ENV_ALLOWLIST) {
    const v = processEnv[k];
    if (typeof v === 'string') out[k] = v;
  }

  // 2. Prefix allow-list (LC_*).
  for (const [k, v] of Object.entries(processEnv)) {
    if (typeof v !== 'string') continue;
    if (SAFE_ENV_PREFIX_ALLOWLIST.some(p => k.startsWith(p))) {
      out[k] = v;
    }
  }

  // 3. Declared secrets (blank opted-in via `secrets: [NAME]`).
  //    Two layers of name-shape check so a malicious frontmatter can't
  //    declare `secrets: [LD_PRELOAD]` or `secrets: [PATH]` and shadow
  //    a runtime-injected base env var or pass a dangerous linker
  //    name through.
  const baseSet = new Set(SAFE_ENV_ALLOWLIST);
  for (const name of declaredSecrets) {
    if (typeof name !== 'string' || !name) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    if (DANGEROUS_ENV_PATTERN.test(name)) continue;
    if (baseSet.has(name)) continue; // can't shadow the base allow-list
    const v = processEnv[name];
    if (typeof v === 'string') out[name] = v;
  }

  // 4. Extras (already validated CUES_*).
  for (const [k, v] of Object.entries(extras)) {
    if (typeof v === 'string') out[k] = v;
  }

  return out;
}

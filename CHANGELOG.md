# Changelog

All notable changes to OpenCues will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **Scope of this section**: only changes tied to an actual package version bump are listed. The project shipped many other features and fixes since 0.1.0 (sentence cues, auditors, agent-rewrite, ambient/user context, etc.) without bumping versions at the time — those landed in source but aren't formally versioned, so they're tracked in git, not here. From now on, the rule in `docs/architecture/versioning.md` § Discipline keeps changelog entries and version bumps shipping together.

### Fix — Multi-fork CC install fan-out + boot-smoke gate + per-fork drift advisory

PR #117 (Claude Fable 5) added `packages/opencues-core/src/providers/claude-cli-daemon.ts`. `integrations/claude-code/patches/setup.sh` hard-coded the dist subdirs it copied into each fork (`sources` only), so the new `providers/` subdir was silently dropped at install time. The installed bundle's `@opencues/core/model-aliases.js` then `require('./providers/claude-cli-daemon')` blew up at boot, the CC patch's outer try/catch swallowed the error, and every CC session came up with `__oc.failed=true` — no cues, no blanks, no log line, no install error. The install reported `✓ installed + validated`.

Three structural fixes, in order of how-much-it-could-have-prevented:

- **`integrations/claude-code/patches/setup.sh`** now recursively copies every subdir under `packages/opencues-core/dist/*/` instead of a hard-coded list. Adding a new dist subdir is now structurally safe — `cp` covers it.
- **`integrations/claude-code/bin/install.cjs` `validateFork()`** now runs a boot-smoke probe: `spawnSync(node, '-e', 'require(<spec>)')` from the fork's root for each path the CC patch's bootstrap actually requires (`@opencues/runtime`, `dist/adapters/cc/v2.1/boot.js`, `dist/src/blanks/index.js`, `dist/src/security/{spawn-sandbox,sandbox-runner}.js`, `dist/src/user-blanks/registry.js`). If any spec fails to load, the install refuses to ship the fork with a clear error pointing at the broken require + the setup.sh § 5 fix shape. This catches the failure class as a build error instead of as a silent runtime degradation.
- **`packages/opencues-runtime/adapters/cc/v2.1/boot.ts`** now calls `checkRuntimeDrift(adapter)` at boot. Every other host already got this via `buildSharedRuntime`; CC's hand-wired per-band boot was missing it since PR #47 landed. Direct launches of a stale CC fork — bypassing both `opencues run`'s CLI-side srcHash check AND the install fan-out — now surface a loud `warn` line in `/tmp/opencues.log` naming the fork + the fix command.

Plus the broader multi-fork awareness this pulled in:

- **`packages/opencues-cli/src/lib/version-markers.cjs`** — new `enumerateCCForks()` walks every `~/claude-code-cues*` dir on disk and returns the ones with a real CC binary, canonical first.
- **`integrations/claude-code/bin/install.cjs` `doInstall()`** — fans out across every detected fork by default. Each fork gets per-fork drift check + targeted rebuild only when stale. `--canonical-only` opts out. `--target` unchanged.
- **`packages/opencues-cli/src/commands/update.cjs`** — when host is at current-pin, the drift check now walks every CC fork before deciding "nothing to do". The fan-out into `rebuildHostInPlace` covers all forks via the installer's new logic.
- **`packages/opencues-cli/src/commands/doctor.cjs`** — extra CC forks are no longer "dev relics to delete." Each fork's drift status surfaces as a discrete row (stale → warn, missing marker → warn, fresh → info). Truly orphaned dirs (no CC binary at all) still surface as "safe to remove."
- **`integrations/claude-code/CLAUDE.md`** — iteration loop now reads "`opencues install claude-code` and the install fans out across every fork." The previous `OPENCUES_CC_TARGET=~/claude-code-cues-150/...` ritual is preserved as a CI / one-off-target escape hatch.

Concrete failure mode the boot-smoke gate prevents: any future PR adding a new `@opencues/runtime/dist/<subdir>/<file>.js` referenced by the patch's bootstrap, where setup.sh's copy step misses the file. Today only setup.sh copies are gated; if `integrations/{opencode,gemini-cli,shell}/patches/setup.sh` (which already use `cp -r dist/`) ever switch to a hard-coded list, the same bug class returns there. The CC smoke probe pattern can be lifted into a shared helper if needed.

`@opencues/runtime` 0.3.1 → 0.3.2 (boot-time drift advisory added to CC boot).
`opencues` (CLI) 0.2.1 → 0.2.2 (multi-fork fan-out + boot-smoke gate + per-fork drift in doctor).

### Feature — Claude Fable 5 support + global `anthropic-subscription` routing

Anthropic shipped **Claude Fable 5** (Mythos-class frontier model) on 2026-06-09. This change wires it across both provider paths AND adds a global control for how every anthropic-class `with <model>` override gets dispatched.

- **`@opencues/core` (0.3.6 → 0.3.7)** — Fable 5 wired into both provider adapters:
  - `llm-provider.ts:anthropic.knownModels` adds `claude-fable-5` (HTTP API path).
  - `llm-provider.ts:claude-code-cli.knownModels` adds `fable` + `claude-fable-5` (subscription path).
  - `providers/claude-cli-daemon.ts` gains a new `fable` model family with Opus-mirroring flag tuning (`CLAUDE_CODE_DISABLE_THINKING=1`, `MAX_THINKING_TOKENS=0`, no `--effort`) pending a real `tests/benchmarks/thinking-budget/` row.
  - `model-aliases.ts` `COMMON_ALIASES['fable']` resolves `with fable _` to `(anthropic, claude-fable-5)`. The CLI's `--model` does NOT alias-resolve short `fable` — only `opus/sonnet/haiku` are CLI-side aliases — so passing the full id `claude-fable-5` is what the daemon actually sends.
- **Subscription preference — every anthropic-class `with` (anthropic / claude / opus / sonnet / haiku / fable / any full id) auto-routes through the local `claude` CLI** when the binary is on PATH. New `applySubscriptionPreference` post-processor in `model-aliases.ts` rewrites every override whose resolved provider is `'anthropic'` to `'claude-code-cli'` (model string passes verbatim). Non-anthropic overrides (`with cerebras`, `with gemini`, `with gpt-oss`, …) are never touched.
  - `isClaudeCliAvailable()` helper in `providers/claude-cli-daemon.ts` caches a `which claude` probe per-process. Cold ~3-8 ms, warm ~0.002 ms.
  - `resolveOverride` in both `FluidBlankSource` and `TransformBlankSource` now short-circuits on `provider.transport === 'cli'` before its `apiKey` gate — the CLI provider auths via `claude /login`, not an env var, so the lookup would have rejected every subscription override otherwise. Caught by agentic scenarios 72 + 74 during validation.
- **`@opencues/runtime` (0.3.0 → 0.3.1)** — New `anthropic-subscription` global scalar in `OPENCUES.md`, registered in the FEATURES menu so `opencues settings _` cycles it. Three values:
  - **`prefer`** (default) — auto-route through CLI when available, silently fall back to HTTP API when missing.
  - **`only`** — billing safety. Always dispatch through CLI; the call FAILS at spawn time if the binary isn't on PATH (no silent API charge).
  - **`off`** — global opt-out; every anthropic-class override goes through the HTTP API regardless of CLI availability.
  - The scalar flows OpenCuesState → CueContext → applySubscriptionPreference, hot-reloads via ConfigLoader.
- **Per-call cost trade-off**. Subscription calls are bundled in the user's Pro/Max/Team/Enterprise plan but average 30–100% slower than the API (no streaming, higher TTFT variance). Bench across both paths confirmed Fable 5 at 4–10s end-to-end typical (vs sub-second for Haiku).
- **No runtime fallback yet**. If the CLI is installed but auth has expired or the model isn't on the user's subscription tier, the dispatch surfaces the CLI error rather than silently retrying through the API. Adding runtime fallback would need explicit error classification + a session-level "CLI is broken" cache; tracked as a follow-up.
- **Tests**: 32 unit tests in `model-aliases.test.ts` pin every routing cell (including the new `mode='off' | 'only'` branches and the non-anthropic-untouched invariant). Plus end-to-end agentic scenarios 72-75 in opencues-agentic, all green on opencode 1.14.17. Existing override scenarios 65-67 updated to pin `anthropic-subscription: off` so their assertions stay deterministic.
- **Docs**: `docs/architecture/model-override.md` + `docs/features/model-override.md` document the full coverage matrix, plumbing, cost trade-off, and "no runtime fallback" caveat. The feature-table at the top of `docs/features/model-override.md` now lists `fable` alongside opus/sonnet/haiku.

### Security — user-blank loader migrated to `isolated-vm` — F1 escape closed (INFOSEC F1)

**This is the structural fix for the F1 vm-sandbox escape.** Node's `vm.runInContext` is not a security boundary against adversarial JS — `Promise.constructor('return process')()` reaches the host realm, then `process.env` exposes every API key and `child_process.execSync` runs arbitrary commands. The June 2026 security review live-confirmed this against the shipped sandbox. The prior PR shipped a stopgap (load-time warn); this PR closes the gap structurally.

- **`@opencues/runtime` (0.2.8 → 0.3.0, minor bump — wire-format change for user-blank `ctx.fetch`)** — `node-loader.ts` rewritten to run user JS in a real V8 isolate via `isolated-vm`. The isolate is a fresh realm: its `Promise`, `URL`, `Date`, `Math`, `RegExp`, `Function` etc. are its OWN intrinsics, not the host's. The constructor-chain pivot lands you in the isolate's `Function` constructor, which resolves `process` against the isolate's empty global — undefined. New `isolated-vm@^5.0.4` runtime dependency.
- **Wire-format change**: `ctx.fetch` returns a plain Response-shape object `{ ok, status, statusText, headers, text, text(), json() }` instead of a real `Response`. Real Response objects can't cross the isolate boundary; the shim preserves `.text()` / `.json()` so existing user code continues working. **Breaking for** any third-party blank that uses `r.body`, `r.arrayBuffer()`, `r.blob()`, `r.headers.get()`, or that holds a streaming reference. **Not breaking for** any shipped blank (they're all TS classes via `BUILTIN_BLANKS`, not custom JS).
- **12 escape-pivot tests** in `node-loader.f1-escape.test.ts` pin the closure: Promise/Date/URL/Math/JSON/setTimeout `.constructor`, proto-walk via `Object.getPrototypeOf`, bracket-form obfuscation `Promise['cons'+'tructor']`, host-global reachability check (`process` / `require` / `Buffer` / `globalThis.process` all `undefined`). Plus a memory-bound sanity check and a dispose-lifecycle test.
- **Cost model** (Linux x64, Node 22, isolated-vm 5.0.4): per-isolate creation 5-10ms (one-time per blank load); per-context 1-2ms (reused across invocations); per-invocation 1-3ms cold, sub-ms warm. Prior loader was ~0.1ms per invocation with no security boundary — 10-30× slowdown is acceptable since blanks fire per `_` keystroke, not per-frame, and the result cache eliminates most repeat work.
- **`security-audit.md` row #2** flipped 🟡 → 🟢 (was just amber after the F1 stopgap; now structurally closed). `Recently resolved` log entry added. The Open Follow-up entry for the isolated-vm migration is removed since it's now landed.
- **`pnpm-workspace.yaml`** adds `isolated-vm` to `onlyBuiltDependencies` (native module — `prebuild-install` covers Linux/macOS/Windows on common Node versions, falls back to `node-gyp` compile).
- **Chrome content-script Worker path unchanged** — it's structurally separate (page-CSP-bounded, no Node `vm` involved). The chrome-host process (Node-based) uses the same isolated-vm path as CC/OC/Gemini.

This supersedes the F1 stopgap warn (PR #106). When both PRs land, the warn from PR #106 is no longer load-bearing.
### Security — `blankScript:` blanks must declare `sandbox:` explicitly (INFOSEC F9)

The F9 doctor PR (#102) surfaced the unconfined-by-default footgun: `bwrap` / `sandbox-exec` only wraps when a blank declares `sandbox: strict`, and most don't. This PR closes the gap structurally at the install-time gate.

- **`opencues review` (`packages/opencues-cli/src/commands/review.cjs`)** — refuses any pack with `blankScript:` lacking a `sandbox:` declaration as a hard error (sev: `error`, exit 1). `sandbox: off` produces a warn (explicit acknowledgement of full host privileges). `sandbox: strict` is clean. Any other value is a hard error. Authors can no longer ship a `blankScript:` blank without making an explicit confinement choice.
- **`@opencues/runtime` (0.2.8 → 0.2.9)** `BlankFill.maybeRunScripts` — one-time per-blank-name warn when a script-backed blank lacks `sandbox:` at runtime. Pre-F9 installs that slipped past review get a loud diagnostic in `/tmp/opencues.log` and the host's console: "BlankFill: X declares blankScript: without sandbox: — running UNCONFINED... INFOSEC F9". Per-blank dispatch refusal (rather than warn) deferred to v2 once the broader pack ecosystem migrates.
- **All shipped defaults already declare** explicit `sandbox:` (volume / brightness / opencues / sentinel → `sandbox: off`; example → `sandbox: strict`). No regression for shipped blanks.
- **Tests**: 5 new in `review.f9.test.cjs` cover every code path (missing → error; strict → clean; off → warn; bogus value → error; non-scripted → unaffected). 3 new in `blank-fill.f9-warn.test.ts` pin: warn fires once for missing-sandbox + spawn still happens (back-compat); strict + off both silent.
- **`security-audit.md` row #17** updated with the F9 install-time gate.
### Security — scripted blanks get a deny-by-default env, not the host's full process.env (INFOSEC F2)

Pre-fix, `BlankFill.maybeRunScripts` built the child env as `{ ...process.env, ...extras }`. Every scripted blank received every `*_API_KEY` the host had loaded — including ones the blank never declared in `secrets:`. A `blankScript:`-bearing pack could `curl` GROQ_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, FINNHUB_API_KEY etc. out without any frontmatter declaration. Per the F2 finding (live-confirmed against the chrome-host), the per-blank allow-list claim in `security-audit.md` rows #5/#7 only ever covered the JS-blank `ctx.secrets` path.

- **`@opencues/runtime` (0.2.8 → 0.2.9)** — new `security/safe-env.ts` exports `buildSafeScriptEnv(processEnv, declaredSecrets, extras)`. Base allow-list: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `TZ`, `TMPDIR`, `SHELL`, `TERM`, `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `WSL_DISTRO_NAME`, `WSLENV` plus every `LC_*` locale variant. Provider keys land in the child env ONLY when the blank's frontmatter `secrets: [NAME]` declared them. Malicious declarations (`secrets: [LD_PRELOAD]`) are refused via `DANGEROUS_ENV_PATTERN` (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`, `BASH_ENV`, `PROMPT_COMMAND`, …).
- **`@opencues/runtime` (`blank-fill.ts:369`)** — replaces the `{ ...process.env, ...extras }` spread with a `buildSafeScriptEnv` call. The `CUES_*` extras (model, apiUrl, prompts, …) are layered as the last step exactly as before.
- **`@opencues/chrome` (0.2.4 → 0.2.5)** — `host/host.cjs` mirrors the same allow-list (PATH/HOME/locale/desktop-integration) AND switches `filterMessageEnv` from a `CUES_*`-only allow-list to a `[A-Z_][A-Z0-9_]*` shape check + dangerous-name deny-list. The host now trusts the runtime's curated wire env (which already filtered to declared secrets) and applies the deny-list as a second line of defence. The `{ ...process.env, ...filterMessageEnv(msg.env) }` spread becomes `{ ...buildBaseHostEnv(), ...filterMessageEnv(msg.env) }` — process.env's `*_API_KEY` never reach the child.
- **11 new tests** in `safe-env.test.ts` cover: base allow-list passes; every common provider key dropped when undeclared; declared FINNHUB_API_KEY injected; LD_PRELOAD/DYLD_*/NODE_OPTIONS/PYTHONPATH unconditionally dropped; malicious `secrets: [LD_PRELOAD]` refused; declared secret can't shadow PATH; malformed name shapes (lowercase, dashes, leading digits) refused; CUES_* extras layer correctly; returns a new object; drift tests pin `DANGEROUS_ENV_PATTERN` shape + `SAFE_ENV_ALLOWLIST` excludes any `*_API_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD`.
- **`security-audit.md`** rows #5/#7 already updated for F4. The F2 fix completes the closure: rows now describe both the JS-blank AND scripted-blank secret-containment paths.
### Security — dependency CVE sweep (INFOSEC DA1–DA7)

`pnpm audit` reported 7 advisories across the dep graph; this PR closes all of them. Mix of direct bumps and `pnpm-workspace.yaml` overrides (pnpm 10 moved the override location out of `package.json` — the old `pnpm.overrides` is silently ignored, which is the same trap CLAUDE.md called out for `onlyBuiltDependencies`).

- **DA1 vitest** `2.x → ^4.1.0` (root + opencues-runtime + chrome). [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) — vitest UI dev server arbitrary file read + execute.
- **DA4 esbuild** `^0.21.x → ^0.25.0` (root + chrome). [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) — dev-server CORS bypass.
- **DA5 vite** override `6.4.3` (was 5.4.21 transitive). [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) — optimized-dep `.map` path traversal. Vitest 4 also requires vite ≥ 6, so the pin satisfies two needs.
- **DA2 seroval** override `>=1.4.1` (transitive via solid-js in shell). Five separate advisories — RCE + prototype pollution + 3 DoS vectors — one fix.
- **DA3 immutable** override `>=3.8.3` (transitive via @types/draft-js + draft-js in chrome). [GHSA-wf6x-7x77-mvgw](https://github.com/advisories/GHSA-wf6x-7x77-mvgw) — prototype pollution.
- **DA6 file-type** override `>=21.3.1` (transitive via jimp in shell). [GHSA-5v7r-6r5c-r473](https://github.com/advisories/GHSA-5v7r-6r5c-r473) — DoS via malformed ASF input.
- **DA7 diff** override `>=8.0.3` (transitive via @opentui/core in shell). [GHSA-73rr-hh4g-fpgx](https://github.com/advisories/GHSA-73rr-hh4g-fpgx) — DoS in parsePatch / applyPatch.
- `pnpm-workspace.yaml` also picks up the migrated `onlyBuiltDependencies: [esbuild]` config that CLAUDE.md flagged as silently dropped under pnpm 10.

`pnpm audit` after: **No known vulnerabilities found.** All 1609 runtime tests + 176 chrome tests pass under vitest 4.1.8 (the 3 pre-vitest-4-compatibility chrome failures are fixed by the upgrade — same test files now green). Chrome bundle rebuilds cleanly under esbuild 0.25.
### Security — chrome native host: interpreter allow-list + writable-target allow-list (INFOSEC F3)

The chrome native-messaging host's `handleExec` and `handleWriteFile` previously enforced a path-only sandbox (everything must resolve under `CUE_ROOT`) but had no command-name / inline-code / target-basename restrictions. That made them a latent write-then-execute primitive: `write-file` could drop a `blanks/<x>/blank.js` that the user-blank registry would auto-load + execute on the next `fs.watch` tick, and `handleExec` accepted `bash -c '<arbitrary>'` because non-absolute args were returned unchanged by `sandboxArg`. Today the only thing that protects this is the manifest's absence of `externally_connectable` (closed defensively in F6); F3 closes the latent primitive structurally.

- **`@opencues/chrome` (0.2.4 → 0.2.5)** — new `host/host-validators.cjs` exports `INTERPRETER_ALLOWLIST` (`bash`, `sh`), `INLINE_CODE_FLAG_PATTERN` (refuses `-c`, `--command`, `-e`, `--eval`, `-p`, `--exec`, `--cmd`, `-i`, `--inline`, `--source`), `WRITABLE_BASENAMES` (`OPENCUES.md`, `IDENTITY.md`, `CUES.md`), `isWritableTarget`, and `validateExec`.
- **`host.cjs`** — `handleWriteFile` refuses any target whose basename isn't in `WRITABLE_BASENAMES`. `handleExec` refuses non-allow-listed interpreters, inline-code flags, and non-path-shaped `args[0]` when bash/sh is the interpreter. Absolute paths under `CUE_ROOT` (compiled-binary case) keep working through the prior `sandboxArg` realpath check.
- **19 tests** in `host-validators.test.cjs` covering: each writable basename accepted, arbitrary `.md` / script extensions refused, bash/sh + path passes, node/python3/curl refused, `bash -c` refused, `bash --command` refused, `bash -l` (flag as args[0]) refused, missing/empty inputs refused, and a structural drift test pinning both allow-lists.

Defence-in-depth pairs with F6 (sender-auth on the SW relay) — F6 closes the entry-point, F3 closes the primitive even when the entry is reachable.
### Security — `opencues doctor` surfaces the unconfined-blanks footgun (INFOSEC F9)

The OS sandbox (`bwrap` / `sandbox-exec`) was already checked, but it's only wired on `blankScript: sandbox: strict` — blanks that don't declare `sandbox: strict` run with the user's full filesystem + network privileges regardless of whether the OS confiner is installed. Most real-world scripted blanks don't opt in, so the "I have bwrap installed, I'm safe" assumption silently held nothing.

- **`opencues doctor`** — new `scanScriptedBlanks` helper iterates `~/.cues/blanks/` + `$OPENCUES_HOME/blanks/` and reports "X of Y scripted blanks declare `sandbox: strict`". When Y > X, prints a loud `bad` line + a `warn` finding naming up to 3 unwrapped blanks by folder name.
- **Status quo** — does NOT flip the default to strict (would break trusted/first-party blanks; that's the F9 follow-up that needs separate review).
- **4 new tests** in `doctor.scanblanks.test.cjs`: mixed strict/unstrict counted correctly, empty install returns zeros, built-in TS blanks (no `blankScript:`) are ignored, malformed frontmatter silently skipped.
### Security — chrome SW listeners authenticate sender + fetch proxy origin-allow-list (INFOSEC F6)

Every `chrome.runtime.onMessage` listener in `background.ts` previously ignored the `sender` arg and acted on the message unconditionally — safe today ONLY because the manifest declares no `externally_connectable`. That one manifest property was the entire authentication boundary for the `exec` / `write-file` / `user-blank-invoke` relays + the `opencues:fetch` open relay. If `externally_connectable` ever lands or a content-script bug exposes the relay, those become arbitrary-page-reachable.

- **`@opencues/chrome` (0.2.4 → 0.2.5)** — new `sw-auth.ts` module exports `isInternalSender(sender)` (`sender.id === chrome.runtime.id`) and `isFetchOriginAllowed(url)` (origin must be in `FETCH_ALLOWED_ORIGINS`, derived from manifest `host_permissions`). Every listener in `background.ts` now sender-auths before acting: refuses with a self-describing error response when the sender isn't internal.
- **Fetch-proxy origin allow-list** — `opencues:fetch` refuses any URL whose origin isn't in `host_permissions`. Closes the open-relay attack where any context that can post a message uses the SW as a CORS-bypassing fetcher to attacker-chosen hosts with attacker-chosen headers.
- **Drift tests** — `manifest-security.test.ts` (10 tests) asserts the manifest has NO `externally_connectable` (load-bearing property cannot regress) AND that `FETCH_ALLOWED_ORIGINS` matches `host_permissions` exactly (no drift between code and manifest). Plus 4 unit tests for `isFetchOriginAllowed` (allowed, refused-undeclared, refused-scheme-variant, refused-malformed) + 4 for `isInternalSender` (matching id, mismatched id, undefined, no-id).
### Security — `opencues review` catches the constructor-chain escape and string-concat obfuscation (INFOSEC F5)

The static review's denylist flagged `eval`, `new Function`, dynamic `import()`, and Node built-in names (`process`, `require`, `child_process`, `fs`, …). It did NOT flag `.constructor` chains — the actual vm-sandbox escape pivot. Worse, the scan stripped string literals first, so a payload hidden in `Promise['cons'+'tructor']('return process')()` had every telltale token stripped before the regex ran, and `opencues review` returned exit 0 on a working RCE PoC.

- **`opencues` CLI (`review.cjs`)** — six new hard-blocker patterns: `.constructor`, `["constructor"]` (bracket form), `Reflect`, `globalThis`, `__proto__`, `Object.{get,set}PrototypeOf`. Each refuses the pack with `sev: 'error'`, mirrors the AST rewriter's stance.
- **Dual scan** — the existing stripped-literals heuristic kept (low false-positive on JSDoc/URL strings), plus a new RAW-source scan for the escape patterns AND a string-concat-fragment detector (warn) that catches the `'cons'+'tructor'` / `'pro'+'cess'` style of hide-in-strings obfuscation.
- **11 new tests** in `review.test.cjs` cover: each escape pattern as a hard blocker, the string-concat obfuscation warn, clean code produces no errors, and the pre-existing `import()` + `eval` heuristics still fire.

INFOSEC F5 is a defence-in-depth ground gain — F1 is the structural fix (a real isolate). This raises the bar for the naive PoC and the obfuscated PoC without changing the runtime trust model.

### Security — `enforceSecretBindings` becomes a deny-by-default destination allow-list (INFOSEC F4)

The prior model was a substring scan: refuse the request if the literal secret VALUE appeared in URL/headers/body, otherwise allow. A malicious user-blank could trivially bypass it by encoding the secret (`btoa(k)`, hex, or fragmentation) before sending — the substring scan misses anything that doesn't share the literal bytes. Audit row #5/#6 listed residual "None" — that claim overstated the guarantee.

Two-layer guard now:

- **`@opencues/runtime` (0.2.8 → 0.2.9)** — `secret-leak-guard.ts:enforceSecretBindings` layer 1 (destination allow-list, primary): when ANY declared secret has a non-empty `secret-hosts.<NAME>` binding, EVERY outbound `ctx.fetch` host must be in the UNION of those bindings — payload content is irrelevant. Encoded exfil defeated structurally (the attacker can't reach `evil.com` regardless of how the value is encoded). Layer 2 (literal-value scan, secondary): within the allow-list, still scan URL/headers/body for bound secret values — catches multi-secret cross-talk (GROQ value sent to finnhub.io host is refused even though finnhub.io is in the union).
- **5 new tests** in `secret-leak-guard.test.ts` covering: base64-encoded exfil refused; fragmented-value exfil refused; non-secret-bearing fetch to non-binding host refused; multi-secret union honoured for non-secret fetch; layer-2 cross-secret scan within union. Plus 1 new test asserting the error message lists the union for diagnostics. 15 tests total.
- **`security-audit.md` row #5** updated to reflect two-layer guard and `Recently resolved` log entry added.

### Security — Gemini API key moved off URL query string into `x-goog-api-key` header (INFOSEC F8)

`?key=<apiKey>` puts secrets in URLs — they land in server/proxy access logs, browser history, the Referer header, and the chrome path also pipes them through the `opencues:fetch` SW proxy. Other providers correctly use `Authorization: Bearer` / `x-api-key` headers. Gemini's documented API contract accepts the key in either place, so the fix is mechanical: switch to `x-goog-api-key`.

- **`@opencues/core`** — `GEMINI` adapter `buildRequest` returns a URL with no query string and a `x-goog-api-key` header. Test updated to assert the URL contains neither `gem_test` nor `key=`, and the header carries the key.
- **`opencues check-keys` (CLI probe)** — same shape.
- **chrome popup boot-time key audit + popup probe** — same shape.

### Security — `opencues set-key` always tightens `~/.cues/.env` perms (INFOSEC F7)

`fs.writeFileSync({ mode: 0o600 })` only applies the mode when the file is newly created. An existing `~/.cues/.env` with looser perms (created by hand or copied with default umask) was rewritten in place without ever being chmod'd, so plaintext API keys could remain world/group-readable. The chrome host then loads this file into `process.env` and hands it to every scripted blank ([F2](../INFOSEC_FINDINGS.md#f2)), so loose perms compounded that exposure.

- **`opencues` CLI (`set-key`)** — always `chmod 0o600` the file and `0o700` the parent dir after writing, regardless of whether the file pre-existed. Warns when the prior mode was broader than `0600` so users know their key was previously readable.
- Three regression tests in `set-key.test.cjs`: create-from-scratch lands at 0600/0700; pre-existing 0644 file gets tightened; pre-existing 0640 file gets tightened. Existing key lines preserved across the rewrite.

### Added — per-call `with <model>` LLM dispatch override for fluid-blank and transform-blank

Adds a `with <name>` token anywhere in the buffer before `_` (`make formal X with opus _`, `atomic number of oxygen with cerebras _`) to flip the dispatch target for ONE call without writing any scalar to disk. The next `_` keystroke without `with X` goes back to the configured bucket. Five-tier token resolution: common aliases (opus / haiku / sonnet / nano / mini / flash / gpt-oss / llama / claude / anthropic / cerebras / groq / openai / gemini / openrouter), provider id, exact model name, prefix in any `knownModels`, substring fallback. Always on — no scalar gates it.

- **`@opencues/core` (0.3.4 → 0.3.5)** — new `model-aliases.ts` module with `detectModelOverride` + `resolveAlias` + `stripModelOverride`. 21 unit tests in `model-aliases.test.ts` pin token resolution, last-match-wins tie-break, regex word-boundary (`without` doesn't match), and strip behaviour.
- **`@opencues/core` (0.3.4 → 0.3.5)** — `FluidBlankSource` and `TransformBlankSource` constructors gain an optional `apiKeys: Readonly<Record<string, string | undefined>>` field (keyed by `envKeyName` — matches `resolveLLM` at `llm-provider.ts:1817`). At the top of `getCues`, each source detects the override, resolves it to a (provider, model, apiKey) target, and dispatches THAT call through it. FluidBlank threads override args explicitly; TransformBlank stores them on a private `_currentOverride` field cleared in a `finally` block (the field pattern is safe under the resolver's one-getCues-per-generation contract + sibling-abort).
- **`@opencues/core` (0.3.4 → 0.3.5)** — `ConfigIntentSource.getCues` cedes synchronously when `detectModelOverride` matches. Without this, `make formal with opus _` was reliably misclassified as `cues-llm-provider: anthropic:claude-opus-4-7` and written to disk. The cede prevents the misfire AND saves the classifier LLM round-trip on inputs ConfigIntent shouldn't claim. The settings-flip syntax (`change to opus _`, `switch to cerebras _`) doesn't contain `with` — the cede doesn't fire — the classifier runs normally.
- **`@opencues/core` (0.3.4 → 0.3.5)** — `fluid-blank.started` and `transform-blank.started` events grow an optional `modelOverride: { provider, model, token }` field for harness assertions. Only set when the override resolved successfully (matches AND apiKey available).
- **Strip + WIPE handling** — `with <token>` is removed from the LLM-bound prompt so the model never sees the override hint. For FluidBlank WIPE mode, span is forced to `[0, context.text.length)` when the override is active, so the token wipes from the buffer along with the lookup phrase. (FILL mode trade-off: `with <token>` lingers when the buffer matches the copula/equation/question shape — partial remapping from stripped-offsets to original-offsets is a v2 follow-up.)
- **`tests/agentic/scenarios/` 65-71** — seven JSON scenarios covering the happy path (fluid-blank + transform-blank), ConfigIntent synchronous cede, unknown-token cede, multi-`with` last-match-wins, `without` regex word-boundary, and the regression guard that `change to <provider> _` still fires fluid-config.

Full design + threat model: `docs/architecture/model-override.md`. User-facing summary: `docs/features/model-override.md`.

### Fixed — fluid-config `change to opus _` / `switch to cerebras _` latency (7–10× faster steady-state)

Two stacked perf wins in the same path. Wallclock for `change to opus _` dropped from 1.8–4.3s to ~270ms (warm); `switch to cerebras _` from 2.2s to ~280–370ms.

- **`@opencues/core` (0.3.3 → 0.3.4)** — `CueResolver.resolve()`'s parallel branch now creates one `AbortController` per source (chained off `context.signal`). When a higher-priority source emits a *whole-buffer claim* (`spanStart === 0 && spanEnd >= text.length` — the signature ConfigIntent + selector-satellite blanks + TransformBlank-rewrite use), strictly-lower-priority in-flight siblings are aborted. Their results would have been wiped by the splice anyway; aborting saves the LLM round-trip. Before this, FluidBlank + TransformBlank dispatched to the blanks bucket (Claude Opus in the reported repro) ran to completion while ConfigIntent on Cerebras had already produced the winning verdict — the resolver waited for the slowest sibling. Closes the in-batch-cancellation follow-up the existing comment at `resolver.ts:96–100` named (#76 was scoped to the supersede / generation-roll case only). Three new scenario tests in `resolver.test.ts` pin the abort fires on whole-buffer claim, does NOT fire on point-wise claim, and that the outer context signal cascades.
- **`@opencues/core` (0.3.3 → 0.3.4)** — `ConfigIntentSource.callLLM` now forces `reasoningEffort: 'low'` (was inheriting the cerebras provider default `medium`). The classifier output is 3 short lines; medium reasoning added 700–1500ms with zero accuracy gain. The fluid-config bench (`tests/benchmarks/fluid-config/`) already runs at `low` and held 100% precision / 90–100% holdout recall across 5 providers — re-running the bench was not required for this change (no prompt edit), but the cap aligns the runtime with the bench-validated configuration. Mirrors FluidBlank's same-rationale floor at `fluid-blank-source.ts:995`.

### Fixed — chrome LinkedIn messaging composer Send button stays disabled after transform-blank

LinkedIn's messaging composer (`<div class="msg-form__contenteditable">`) gates its Send button on React state that only flips when the editor's input pipeline observes content. The previous fallthrough hit the generic-CE branch (`execCommand('insertHTML')` with `<div>` blocks), which lands the DOM mutation but doesn't trip the React state — text appears in the box but Send stays disabled, as if the placeholder was still active. Distinct from the LinkedIn *share* composer (Quill), which already had a working path (#91).

- **`@opencues/chrome` (0.2.3 → 0.2.4)** — new `isLinkedInMessaging` detector + a new branch in `replaceAllText` that mirrors the proven Quill fallback: Range-API select-all + per-line `execCommand('insertText')` + `execCommand('insertParagraph')` between. These fire `inputType: "insertText"` / `"insertParagraph"` events matching real typing, so LinkedIn's React listener catches them and updates the state.
- **Trade-off** — multiple undo entries (one per execCommand) on LinkedIn messaging vs the single-entry contract other sites carry. Acceptable for now; the alternative is the current "can't send" state, which is strictly worse. Single-entry path would require finding LinkedIn's private editor instance.

### Added — chrome Quill write path for LinkedIn share composer

LinkedIn's share composer ships a Quill build whose private `__quill` instance is renamed in their bundle, so the editor-API path (`editor.setText`) we use elsewhere isn't reachable. Generic `execCommand('insertHTML')` was reverted within a microtask by Quill's MutationObserver — substitutions appeared briefly then disappeared. Three iterations were needed to converge on a path that holds: paragraph-break shape (`<p>` for `\n\n+`, `<br>` for `\n`), lazy `__quill` re-attach attempt before each call, earlier activation in the write-path ladder. Companion paragraph-break shape fix in the runtime's managed-editor `replaceAllText` emit (split on `\n\n+` for paragraph breaks, inline `<br>` for soft breaks).

- **`@opencues/chrome` (0.2.2 → 0.2.3)** — adds `isQuillEditor` + a Quill branch in `replaceAllText`: tries `quill.clipboard.dangerouslyPasteHTML(html, 'user')` first, then `quill.setText(condensed, 'user')`, then a `selectNodeContents` range + per-line `execCommand('insertText')` + `insertParagraph` fallback when `__quill` isn't reachable. Manifest.json + package.json bumped in lockstep (per CLAUDE.md § "Chrome integration — bump manifest.json AND package.json in lockstep") — prior drift (0.2.1 manifest stuck while package.json moved to 0.2.2 across 5 PRs) was the trigger to formalise this rule.
- **Companion runtime fix** — `replaceAllText`'s managed-editor block emit now splits on `\n\n+` for paragraph breaks and uses inline `<br>` for soft breaks within a paragraph. Previously emitted one block per `\n`, which on editors with default `<p>` margin (Lexical, ProseMirror, Quill) stacked margin + margin = double-spacing. Generic contenteditables (Gmail, YouTube) keep per-line `<div>` emission because they lack default block-margin styling.

### Fixed — BlankFill's staleness check no longer silently drops substitutes during co-owned loading animations

Latent bug introduced by `0097d65` (2026-05-28, "blank-loading: refcount animator so Resolver + BlankFill don't race"). The refcount commit fixed the *opposite* race (resolver's fast return killing BlankFill's animation before the first frame paints) but didn't update BlankFill's `applyAsyncFill` staleness check at `blank-fill.ts:484`. Pre-refcount, when BlankFill's script returned, the resolver's prior `stop` had already restored `_` to the buffer, so `target.word === '_'` passed and the substitute landed. Post-refcount, BlankFill's `stop` is a no-op until the resolver also releases, so the buffer still carries a loading-frame char when `applyAsyncFill` reads it — the staleness guard rejects and the substitute is silently dropped.

PR #74 (blank-context skip) made the resolver's typical-case return so fast that this race rarely fires in production today, but the structural latent bug remained: any code path where the resolver outlives BlankFill's release (parallel-mode in-batch waits, sentence-cue + transform-blank concurrent dispatch, future modules taking the loading-owner role) re-exposes it.

- **`@opencues/runtime` (0.2.7 → 0.2.8)** — new public predicate `BlankLoadingAnimator.isOurSlotChar(wordIndex, char): boolean` returns true for the literal `_` or any of the slot's currently-active frame characters (per-slot frames so user-supplied custom frames in `blank-loading-frames` are also recognised). `BlankFill.applyAsyncFill` consults the predicate via `this._loading?.isOurSlotChar(slot.index, target.word) ?? false` — staleness now means "user typed a real character over our slot", not "the animator painted a frame here".
- **5 new regression tests** in `packages/opencues-runtime/src/modules/blank-loading.test.ts`'s new `isOurSlotChar — staleness-check helper` block: (1) `_` always recognised, even for an unknown slot; (2) any bounce-frame char in an active slot; (3) non-frame, non-`_` char rejected (real user-typed-over case); (4) frame-char query against inactive slot rejected; (5) custom-mode user-supplied frames recognised. Full runtime suite (1593 tests) passes.
- **No latency change** — purely a correctness fix that closes the latent silent-drop bug class. The larger animator → render-directive overlay refactor (Item #5 in the perf audit) remains a follow-up for structurally removing the entire bug class by not painting frame chars into the buffer at all.

### Changed — ConfigLoader parallelises every independent fs read on each `_loadOnce`

Pre-fix, `ConfigLoader._loadOnce` ran fs reads in serialised waves: OPENCUES.md → IDENTITY.md → per-path master batch → per-path folder discovery (sequential for-loop) → per-folder `prewalk` (sequential for-loop) → per-scope walks (sequential for-loop). Every read in each wave was independent of every other wave's, but `await` boundaries forced strict order. On a typical install (2-3 search paths × ~100 .md files), the reload paid sum-of-reads instead of max-of-reads. Cold reloads on a synced / mounted filesystem (WSL, sshfs, network home) showed 50-200ms unnecessary spin.

Post-fix: every independent read fans out under one top-level `Promise.all` in `_loadOnce` (settings + identity + per-path master batch + per-path folder discovery), and the two for-loops inside `_discoverFolders` become `Promise.all(entries.map(...))` and `Promise.all(['cues', 'blanks', 'auditors'].map(...))`. The downstream merge/fold logic is unchanged — same priority semantics, same fold-low-to-high overlay rule.

- **`@opencues/runtime` (0.2.6 → 0.2.7)** — single-file change in `packages/opencues-runtime/src/modules/config-loader.ts`. The top-level Promise.all hoists 4 categories of fs work (settings, identity, master batch, folder discovery) into one parallel wave; `_discoverFolders`'s per-entry and per-scope walks parallelise inside. No API surface changes; callers see the same `load()` Promise resolving with the same result shape, just faster on cold reads.
- **No new tests** — the existing config-loader suite (33 tests) covers all loader-output invariants and continues to pass; parallelisation is an implementation detail that preserves output semantics. Adding a "parallelism" test would essentially time the load and is too host-dependent to pin reliably.
- **Estimated win** — 50-200ms per cold `_loadOnce` on WSL / mounted FS. Invisible on a fast SSD. The 2s `maybeReload` debounce + 5s background poll mean this fires at most a few times per second of UI activity; the cumulative saving over an hour-long session is small but visible during cold-startup spikes.

### Changed — Resolver also skips forwarding `identityContext` when no consumer source will fire (symmetric with the blank-context gate)

PR #74 added a gate that skips the `blankContext` provider fetch when no consumer source (FluidBlank, TransformBlank) will fire. The symmetric site — `identityContext` forwarding in the same `_resolver.resolve(...)` call — was left as legacy "forward whenever `identity-context-mode !== 'off'`". The identity catalog is in-memory at ConfigLoader so the cost saving is small (no IO), but the symmetric correctness + payload-size win is worth the one-line gate.

- **`@opencues/runtime` (0.2.5 → 0.2.6)** — the same `noBlankContextConsumer(cleanWords, claimed)` predicate that gates `blankContext` now also gates `identityContext`: skip when either (a) the buffer has no `_` at all, or (b) every `_` is in the keyword-bound set passed via `keywordBoundSlotIndices`.
- **4 new regression tests** in `packages/opencues-runtime/src/modules/resolver.test.ts`'s new `identity-context skip for keyword-bound slots (symmetric with blank-context)` block: (1) every-`_`-claimed → not forwarded; (2) no-`_`-claimed → forwarded; (3) mode=off → not forwarded regardless; (4) no-`_` at all → not forwarded.

### Fixed — Parallel resolver enforces claim-then-bail semantics (TransformBlank → FluidBlank vandalism prevented)

The runtime resolver always passes `parallel: true` to the underlying `CueResolver`. Pre-fix, parallel mode dispatched every source with the SAME starting `consumedBlankSlots` (each call saw an empty claim set), and the post-dispatch processing didn't enforce the claim either — a lower-priority source's `wordIndex` results overlapping a higher-priority source's `consumedBlankSlots` (or its own filled `wordIndex`) would slip through, "vandalising" the higher-priority intent. Concrete shape: TransformBlank classifies `make this draft more formal _ hi bob` as TRANSFORM but APPLY emits no rewrite → `consumedBlankSlots: [last `_`]`. FluidBlank in the same batch produces a stray lookup answer for the same `_` and substitutes it, turning the user's compose intent into a question answer.

Post-fix: the parallel branch reconciles claims after the parallel batch resolves. Sources are walked in priority-descending order (constructor sorts that way); `consumedBlankSlots` accumulates as we process each source; every source's results are filtered against the accumulated set (excluding the source's OWN claim — a source can fill the slot it claimed). A higher-priority source's content-bearing result on a `wordIndex` also suppresses lower-priority results at the same index, closing the same-priority-tiebreak corner where two parallel sources both produced content.

- **`@opencues/core` (0.3.2 → 0.3.3)** — `CueResolver.resolve`'s parallel branch now post-filters each source's results against the accumulated `consumedBlankSlots` set, and accumulates each filtered source's produced `wordIndex` into that same set so subsequent (lower-priority) sources can't overwrite it.
- **4 new regression tests** in `packages/opencues-core/src/resolver.test.ts`'s new `parallel mode — higher-priority claims suppress lower-priority sibling results` block: (1) lower-priority result dropped on higher-priority claim-and-bail; (2) lower-priority result dropped on higher-priority content claim; (3) different-`wordIndex` results survive; (4) source's own `consumedBlankSlots` does NOT filter its own results.
- **No latency change** — same parallel dispatch; the reconciliation is in-memory post-processing. The cost not addressed in this PR: lower-priority sources still PAY for the LLM call even when their result is dropped. That's the in-batch sibling-cancellation follow-up; #76 (perf/abort-llm-on-stale-generation) covers the supersede case but not intra-batch.

### Added — BlankFill result cache: repeat `volume _` / `weather _` calls within TTL skip the spawn

Every keystroke that creates a fillable `_` slot spawns the blank's `get` script. On WSL, `bash → /mnt/c/...VolCtl.exe` is ~150ms of fork+exec overhead per call; for network-backed blanks (weather / stocks / hackernews / crypto / claude-status) it's ~500ms of HTTP. Repeat invocations with identical args within a short window (user backspaces the substituted answer and retypes `_`, cycles dismiss → re-summon, or quickly retries) re-paid that cost for the same byte-for-byte result.

The shipped fix is a per-blank result cache in BlankFill keyed by `<blankName>::<keyword>|<contextWords>`. On a hit within TTL, the cached stdout is spliced through the same `applyAsyncFill` path that the post-spawn success branch uses — the spawn doesn't happen at all.

- **`@opencues/core` (0.3.1 → 0.3.2)** — new `blankCacheTtlMs?: number` field on `BlankConfig` + the frontmatter struct + the parser case. Documented with per-blank guidance: action blanks (volume / brightness) at the default; ambient blanks (stocks 5-15s, weather 60s) higher. Strict integer parse; negatives + non-numeric drop silently.
- **`@opencues/runtime` (0.2.4 → 0.2.5)** — `BlankFill._resultCache: Map<string, {output, fetchedAt, ttlMs}>` with LRU semantics (insertion-order Map + cap 32 entries). Cache-hit path mirrors the spawn-success path: emits `blank.invoked` with `cacheHit: true` for observability, bumps LRU recency by delete+re-insert, clears the pending-dedup entry, and calls `applyAsyncFill` directly. On spawn success, the result is cached only when `exitCode === 0 && stdout` — failures stay un-cached so retries are cheap. Default TTL `BlankFill.DEFAULT_CACHE_TTL_MS = 2000` (override per-blank). Setting `blankCacheTtlMs: 0` in BLANK.md frontmatter disables the cache for that blank.
- **4 new regression tests** in `packages/opencues-runtime/src/modules/blank-fill.test.ts` (`BlankFill result cache` block): identical-args repeat → cache hit (no second spawn); past-TTL → cache miss (spawn fires again); `blankCacheTtlMs: 0` → cache disabled (every call spawns); failure (exit≠0) → NOT cached → next call spawns. Each test uses a `reArmAndPush` helper that mirrors the real user keystroke flow (clear buffer + re-type `_` so the explicit-`_` gate arms) so the cache path is exercised against the same dispatch path production uses.
- **Measured win (estimated, not benchmarked)** — ~150ms per repeat WSL spawn (volume / brightness); ~500ms per repeat network call (stocks / weather). Visible on the cycle-then-cycle-back path and on quick "backspace + retype" recovery. No effect on first-call latency.
- **Why this PR doesn't touch the shipped `defaults/blanks/*.md`** — every blank gets the 2000ms default which is safe for action blanks. Ambient blanks (stocks / weather) would benefit from a longer TTL but tuning them is a separate trade-off (correctness window vs cache hit rate) that should go through its own bench. Authors can opt any blank in via `blankCacheTtlMs: <ms>` in BLANK.md today.

### Added — transform-blank wires blank-as-context end-to-end

Blank-as-context's June 2026 v1 shipped fluid-blank-only — transform-blank (the compose / rewrite surface) consumed identity-context but not ambient blank-context tokens. The deferral was bench-gated, not architectural — `docs/architecture/blank-as-context.md:36-38` named it as the next milestone. This change closes that deferral.

The structural difference matters: fluid-blank already has the deterministic keyword path (`weather london _` works regardless of catalog), so blank-context for fluid is a convenience layer over a working path. Transform-blank has NO keyword path for ambient data — there is no way to type `weather london _` in the middle of `draft an email about today's weather`. Wiring blank-context into transform-blank is the structural unlock that lets compose flows reference live ambient data ("draft email about btc", "tweet about how stocks are doing", "morning standup: weather + crypto + nvda") with the runtime substituting live values into the prose locally.

- **`@opencues/core` (0.2.3 → 0.3.0)** — added `renderBlankContextCatalogForTransform` (a transform-flavoured prompt block: no INPUT/ANSWER examples since transform has no such shape; rules phrased for long-output prose; emit verbatim, never invent bracket-tokens from covers-hints, third-party `[Recipient Name]` / `[Date]` placeholders survive). Wired into TransformBlankSource at three prompt sites (GENERATIVE / 3-pass APPLY / FUSED). `resolveSentinels` now merges identity + blank-context catalogs into a single post-processor pass via `mergeCatalogs`, with `preserveUnknown: true` so non-catalog brackets in long bodies aren't stripped. 3-pass VERIFY REPAIR path also re-runs the post-processor to catch the edge case where VERIFY hallucinates a token in its correction.
- **Default frontmatter additions** (`defaults/blanks/*/BLANK.md`) — every shipping blank now declares `as-context:` explicitly. Data sources default ON (weather, stocks, crypto, hackernews, claude-status); action / write / loop-hazard blanks default OFF with a one-line rationale (volume, brightness, prompt, answer, sentinel, opencues, dictionary). Concrete slot lists:
  - **weather**: `context-bind: workCity` — binds to the existing `IDENTITY.md:workCity` field. `[WEATHER <CITY>]`.
  - **stocks**: `context-slots: NVDA, AAPL, TSLA, MSFT, GOOGL`. Documented in-frontmatter how to swap to `context-bind: portfolio` (with split + ack) for a personal watchlist.
  - **crypto**: `context-slots: BTC, ETH`. Majors only.
  - **hackernews**: `context-slots: top`. Single-slot — current top story.
  - **claude-status**: `context-slots: api`. Useful for "is claude working _" / "should i wait to retry _" routing.

  Per-blank audit table at `docs/architecture/blank-as-context.md:216` updated to match shipped state.

- **Bench evidence** — new `tests/benchmarks/blank-context-recall/transform-prod-bench.ts`. 7 compose-flow scenarios (email about weather, tweet about BTC, multi-token standup, identity+blank-context mix, etc.) hitting real Cerebras gpt-oss-120b: **7/7** with live substitution into prose. Plus 7 new unit tests at `packages/opencues-core/src/sources/transform-blank-blank-context.test.ts` pinning catalog injection (3-pass APPLY + FUSED), safe/raw mode contracts, post-processor substitution, and `preserveUnknown` survival of `[Recipient]` / `[Date]` placeholders.

**The user-facing scenarios this unlocks** — `draft an email to the team about today's weather _`, `write a tweet about how btc is doing _`, `compose a morning standup mentioning weather and crypto _`, `add a P.S. about today's btc price _`. All produce live-data prose without a keyword break. Threat-model parity with identity-context: `safe` mode keeps live values off the wire (substitution is local post-LLM); `raw` mode opt-in inlines them.

### Fixed — fluid-blank catalog recall +26pp via FUSED prompt rebalance

The FUSED_SYSTEM_PROMPT carries 30+ plain-prose factual-lookup examples that established a strong "answer in prose" prior — strong enough that catalog tokens were being dropped on indirect phrasings (`how are my stocks doing _` → empty answer; `biggest mover in my portfolio _` → invented `[PORTFOLIO]` bracket-token; `what's it like outside _` → prose instead of `[WEATHER LONDON]`). The shipped catalog block had a CRITICAL DECISION RULE but no inline counterweight to the plain-prose pull.

- **`@opencues/core` (0.2.2 → 0.2.3)** — `FUSED_SYSTEM_PROMPT` adds an explicit PRIORITY ORDER section (catalog tokens FIRST when a USER CONTEXT or BLANK CONTEXT block is present), plus an anti-hallucination rule: covers-hints are routing synonyms, NEVER bracket-token names ("portfolio" in the covers for `[STOCKS NVDA]` routes there; it does NOT license emitting `[PORTFOLIO]`). The empty-answer failure mode is named explicitly as the worst outcome.
- **Bench evidence** — new `tests/benchmarks/blank-context-recall/` matrix (30-35 cases, 5-provider matrix shape lifted from the matrix bench). Cerebras gpt-oss-120b on the production path: 25/35 (71.4%) → 34/35 (**97.1%**). Positive class 65% → 100%; negative 100% preserved. Ambient bench (`fluid-blank-ambient/fused-bench.ts`) holds at 174/176 — within noise.
- **Re-run before editing `FUSED_SYSTEM_PROMPT`** — `OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss npx tsx tests/benchmarks/blank-context-recall/prod-bench.ts`. Target: positive ≥95%, negative 100%, no invented bracket-tokens.

### Added — spec-version gate (the standard's "MUST refuse newer" rule, finally enforced)

The `SPEC.md` § Version policy clause "A conforming reader MUST refuse to parse a file whose declared spec version is higher than the reader's pinned SPEC_VERSION" used to be normative-but-inert — the parsers ignored the `spec:` frontmatter field entirely. Conformance fixtures pretended to cover it via regex-matching the fixture content, never calling into the runtime.

Now actually enforced:

- **`@opencues/core` (0.2.1 → 0.2.2)** — `spec-version.ts` adds `parseSpecPin`, `isSpecCompatible`, and `SPEC_OMIT_DEFAULT`. Every parser entry (`parseCuesMd`, `parseSingleCueMd`, `parseSingleAuditorMd`, `parseCuesMaster`, `parseBlanksMaster`, `parseAuditorsMaster`) calls the gate before producing a config. On refusal, an empty `CuesMdConfig` is returned with a populated `specError` field. `discover.ts` honours the gate and exposes an optional `log` hook so callers see refusal reasons. The algorithm encodes both the draft (`0.x`) and post-stable (`1.0+`) regimes: newer-major refuse, newer-minor refuse, AND post-1.0 cross-major refuse (major bumps are breaking by definition).
- **`@opencues/runtime` (0.2.1 → 0.2.2)** — `ConfigLoader` wires the discover log hook + every master-file load checks `specError` and emits `[warn] ConfigLoader: <file> refused — <reason>`. Refused sources are visible in `/tmp/opencues.log` instead of silently missing.
- **Conformance test rewritten** — `conformance.test.ts`'s `spec-too-new` case now calls `parseSingleCueMd` directly and asserts the returned config has `specError` set + no sources/blanks/auditors populated. The fixture-only regex check it replaced was technically passing the conformance suite without exercising any production code path.
- **39 new tests** — `spec-version.test.ts` (32 unit tests covering the algorithm against future versions: a 2.0 reader, 1.5 reader, pre-release suffix semantics, unparseable input) + `discover.spec-version.test.ts` (7 integration tests covering the log hook + the back-compat "omit-default never moves forward" invariant).

**The bug this prevents.** Without the gate, a `0.2-alpha` runtime silently accepts files declaring `spec: opencues/99.0`. The runtime tries to honour any feature the file uses — including future surfaces the runtime can't model — and produces incoherent results. With the gate, the runtime says "I'm 0.2, file declares 99.0, refused" and the user sees a single warn line they can act on.

**Forward-compat invariant.** `SPEC_OMIT_DEFAULT` stays at `opencues/0.1-alpha` permanently. When the spec bumps to 0.3, 1.0, 2.0, etc., legacy spec-less files still load (the default is always ≤ the runtime's version). New files SHOULD declare their target explicitly. Codified in `CLAUDE.md` § Spec-omit-default is permanent.

### Breaking + Added — identity-context rename, blank-as-context feature, and `opencues context`/`opencues cleanup` CLI

**Renamed** the personal-data feature from `sentinels` → `identity-context`:

- `~/.cues/SENTINELS.md` → `~/.cues/IDENTITY.md`
- `sentinels-mode` scalar in OPENCUES.md → `identity-context-mode`
- Public exports: `parseSentinelsMd` → `parseIdentityMd`, `renderSentinelsCatalog` → `renderIdentityContextCatalog`, `postProcessSentinels` → `postProcessContext`, types `Sentinels`/`Sentinel`/`SentinelsMode` → `Identity`/`IdentityField`/`ContextMode`
- CLI: `opencues sentinels` → `opencues identity`
- Source files: `packages/opencues-core/src/sentinels{,-validator}.ts` → `identity-context.ts` / `identity-validator.ts`
- Docs: `docs/features/sentinels.md` + `docs/architecture/sentinels.md` → `identity-context.md` siblings

No runtime back-compat reads. `opencues seed-configs` self-heals: `USER.md` → `SENTINELS.md` → `IDENTITY.md` two-hop rename + rewrites legacy scalar names in `OPENCUES.md`. Runs automatically on `opencues install <host>` for every existing user.

Why the rename — `sentinels` named the implementation (bracket tokens), not the content (identity), and conflicted with three sibling features (blank-context, ambient-context) all sharing the same `<context>` prompt block. The new umbrella is "context" with three sources (identity / blank / ambient). See `docs/features/identity-context.md`.

**Added — blank-as-context** (`docs/features/blank-as-context.md`): blanks can opt into surfacing their current values as ambient sentinel-style tokens for fluid-blank without the user typing the keyword. Stocks, weather, crypto, etc. become available as `[STOCK AAPL]`, `[WEATHER LONDON]` tokens that the LLM can emit; runtime substitutes after the response. Off by default per scalar `blank-context-mode: off | safe | raw` + per-blank `as-context: off | safe | raw` frontmatter. Bench evidence at `tests/benchmarks/blank-sentinels-matrix/FINDINGS.md` — 5-method × 5-provider × 6-count matrix (9,200 LLM calls); `safe-tokens` wins on every provider tested (100% on Cerebras + Groq, 99.4-99.7% on Gemini + OpenAI, 92.9% on Claude Haiku).

**Added — `opencues context list`**: unified inspection surface for all three context sources (identity / blank / ambient). Shows mode scalar, file paths, active tokens. `--json` for scripting. (LLM provider/model pair-display lives in `opencues doctor` from #68.)

**Added — `opencues cleanup`**: find and SIGTERM orphan host processes left behind by prior `opencues run` invocations. Also wired into `opencues run opencode|gemini-cli` as a predecessor-kill so fresh launches supersede prior instances for the same project. `--host`, `--project`, `--kill`, `--force`, `--json` flags. Self-protective: walks the current process's ppid chain to avoid killing its own ancestor.

**Fixed — config-intent classifier false-positive on identity-related lookups**: the rename created semantic collision between the user-typed phrase `mother's maiden name _` and the scalar name `identity-context-mode`. The classifier was applying `identity-context-mode safe` instead of ceding to fluid-blank. Added six NEGATIVE example phrases (`mother's maiden name`, `my email`, `my name`, `who am I`, `what's my github`, `i work at`) to the classifier's few-shot prompt. The positive setting-flip path (`let it use my personal info when answering _`) still routes correctly.

**Fixed — ConfigIntent auto-corrects stale model when switching provider via NL**: companion to PR #68's pair-display + cycling-resets-model fix, on the NL-classifier-apply path. When a user types `switch blanks to anthropic _`, ConfigIntent now reads the current `<bucket>-llm-model` scalar (via a new optional `readScalar` callback) and overwrites it with the new provider's `defaultModel` if the existing model belongs to a different provider's namespace. The runtime wires `readScalar` from `ConfigLoader.opencuesState.settings`; existing test callers without it get the old "leave alone" behaviour. Two new tests pin both branches.

Versions bumped: `@opencues/core` 0.1.12 → 0.2.1, `@opencues/runtime` 0.1.20 → 0.2.1, `opencues` (CLI) 0.1.10 → 0.2.0, `@opencues/chrome` 0.1.4 → 0.2.1.

### Fixed — bogus API key no longer fails silently when the provider's 401 body lacks an HTTP status number

Reported as part of switch-model testing: users with an invalid `ANTHROPIC_API_KEY` typed `_` and saw nothing happen — no buffer change, no inline error, no UI signal at all. The runtime *was* hitting the provider and *was* getting a 401 back, but Anthropic's response body is shaped as a 200-ish JSON envelope containing `{"type":"error","error":{"message":"invalid x-api-key","type":"authentication_error"}}`. `parseResponse` correctly threw `Error("anthropic error: invalid x-api-key")`, but `classifyHttpError` only matched HTTP-status numbers like `401` / `403` — the textual error fell through to the silent default, no `formatLLMErrorAsSubstitute` was called, and no inline message landed in the buffer.

Fix: `classifyHttpError` now also matches textual auth-error patterns (`invalid_api_key`, `invalid x-api-key`, `incorrect api key`, `api key not valid`, `authentication_error`, `authentication failed`, `permission_denied`, `unauthorized`). Anthropic, OpenAI, Groq, Gemini, and any future provider whose 401 body carries no HTTP status number now surface the same `[OpenCues: API key rejected ...]` substitute that 401/403 already did. Pre-existing `\b40[13]\b` HTTP-status path remains, so providers that *do* prefix the message with `HTTP 401` are still caught by the same branch.

Companion precision tweak: the `fluid-blank.bailed` event now carries the classified reason (`invalid-api-key`, `model-not-found`, etc.) instead of always reporting the generic `llm-error`. Event-stream consumers can now assert on the specific failure class without grepping log strings. The `llm-error` fallback is preserved for unclassified (silent / 5xx / malformed-response) failures.

Five new unit tests in `fluid-blank-error-substitute.test.ts` pin each provider's textual auth-error shape (Anthropic / OpenAI+Groq / Gemini / generic `authentication_error` / bare `Unauthorized`).

Version bumped: `@opencues/core` 0.1.11 → 0.1.12.

### Added — fluid-config `provider:model` pair display + granular model discovery via `config _`

Two UX gaps closed in one PR. Builds on top of #66 (provider cycling now skips values whose env key isn't set) — the pair-aware cycling here composes cleanly with that filter: cycling the provider skips ineligible providers AND resets the sibling model on the way, so neither "no env key" nor "stale model" pairs can persist.

**The pair-display gap.** Typing `use claude opus for auditors _` previously wrote both `auditors-llm-provider: anthropic` AND `auditors-llm-model: claude-opus-4-7` to OPENCUES.md, but the satellite splice showed only `auditors-llm-provider anthropic` — the model was set silently. Worse, cycling the provider satellite (Ctrl+Alt+Up on `anthropic`) walked to `openai` without touching the model scalar, shipping the invalid pair `openai + claude-opus-4-7` as soon as the next LLM dispatch fired (→ 400). Fix: ConfigIntent now emits the satellite as `anthropic:claude-opus-4-7` (one splitWords token; `:` is non-whitespace) with new `satelliteCyclingValue: 'anthropic'` metadata so cycling state stores just the provider while the buffer shows the full pair. The runtime reads the new metadata in `resolver.ts:1372`. The user always sees what model they got.

**The discovery gap.** Models weren't reachable from the `config _` cycling menu at all — only the three `*-llm-provider` scalars were in FEATURES. Users had to type natural language or hand-edit OPENCUES.md to pick a model. Fix: `FeatureSpec` gains an optional `valuesProvider?: (settings) => readonly ValueSpec[]` callback. Three new entries register `cues-llm-model`, `auditors-llm-model`, `blanks-llm-model` with a `valuesProvider` that reads the sibling `*-llm-provider` and enumerates that provider's `knownModels` from `llm-provider.ts`. The first cyclable value is always `default` (treated by `normalizeModelScalar` in resolver.ts as equivalent to absent — falls through to the provider's `defaultModel`). Cycling provider in `cycling.ts` now also writes `default` to the sibling model scalar via `providerScalarToModelScalar`, keeping the (provider, model) pair invariant by construction — no cycle path can land on an invalid pair.

`getMenuDefinitions` accepts an optional `settings` argument so dynamic values reflect live state. `applyOpenCuesScalar` overlays the three dynamic definitions on top of any existing file-shipped settings block on every scalar mutation (`overlayDynamicDefinitions` in config-loader.ts), so cycling provider immediately reshapes the model menu without waiting for the 2.5s reload-suppression window.

Test coverage: 8 new vitest cases in `feature-registry.test.ts` (valuesProvider shape + provider→model derivation), 4 new in `fluid-config.scenarios.test.ts` (pair splice + cycling-state semantics), 10 new in `llm-config-cycling.scenarios.test.ts` (provider-cycle-resets-model invariant across all three buckets + non-bucket scalars unaffected). Agentic scenario at `tests/agentic/scenarios-ts/fluid-config-pair-and-model-discovery.ts` drives the full live journey.

Versions bumped: `@opencues/core` 0.1.10 → 0.1.11, `@opencues/runtime` 0.1.19 → 0.1.20.

### Added — cycling `*-llm-provider` settings now SKIPS values whose env key isn't set

Same "test before you switch" property the chrome popup enforces natively: cycling on the CLI hosts (CC / OC / gemini / shell) must not land on a provider value the runtime can't actually dispatch with. Prior to this change, `config _` → cycle to `blanks-llm-provider` → Ctrl+Alt+Up stepped through every registry-declared value blindly. A user with only `CEREBRAS_API_KEY` set could land on `groq`, commit `blanks-llm-provider: groq` to `~/.cues/OPENCUES.md`, then watch every subsequent `_` silently no-op until they read `/tmp/opencues.log` (or, with #65 landed, see the inline `[OpenCues: API key rejected ...]` substitute).

New predicate `isProviderValueCyclable(providerId, apiKeys, { isCliAvailable? })` in `@opencues/core/llm-provider.ts` encodes the eligibility rule: `inherit` is always cyclable; `transport: 'cli'` providers (claude-code-cli, openai-subscription) are cyclable iff their CLI binary is on PATH; `optionalAuth: true` providers (opencode-zen) are cyclable without a key; all others require `apiKeys[provider.envKeyName]` to be set. Cycling reads it via a new `getApiKeys: () => apiKeys` callback threaded through `buildSharedRuntime` and the per-host adapter bands.

Safety net: when the filter would collapse a setting's value list to empty (no eligible providers + no `inherit` in the list), the cycle falls back to the unfiltered list so it still steps SOMEWHERE — the runtime then surfaces the resulting LLM-call failure inline (#65) rather than freezing the menu on the same value forever.

Scope is intentionally narrow — only `llm-provider`, `cues-llm-provider`, `auditors-llm-provider`, `blanks-llm-provider` scalars are filtered. Other settings (voice-mode, debug-mode, tips-mode, etc.) cycle unchanged. Hosts that don't thread `getApiKeys` (back-compat path) keep the pre-change blind-cycle semantic, so third-party adapters don't break.

7 new tests in `cycling.test.ts` pin the matrix (zero keys / one key / multi-key cycling forward + reverse / back-compat default / never-empty safety net / non-provider-scalar pass-through). 6 unit tests in `llm-provider.test.ts` pin `isProviderValueCyclable` independently across http / cli / optionalAuth / unknown-id / legacy-alias cases.

Versions bumped: `@opencues/core` 0.1.9 → 0.1.10, `@opencues/runtime` 0.1.18 → 0.1.19.

### Fixed — fluid-blank chain extension now survives a multi-word first answer

Pre-existing regression surfaced by live-testing the scroll-order fix below. Fluid-blank stored its DynDef `spanEnd` as the END OF THE FIRST WORD of the substitution (`newSpanEnd = newWord.end` in `resolver.ts:1235`). For a single-word answer that happened to be correct; for a multi-word answer like `William Shakespeare` inserted at char 0, `spanEnd` landed at 7 (end of `William`) instead of 19 (end of `Shakespeare`). The next substitute's chain verbatim check (`liveText.slice(spanStart, spanEnd) === currentAlt`) then compared `"William "` against `"William Shakespeare"` and bailed, dropping the first link from the chain — a 3-step lookup chain ended up only 2 links deep, with the original prompt + first answer silently missing from the walk-back history.

Fix: set `newSpanEnd = start + answer.length` (the FULL substituted range) in `resolver.ts:1235`. New scenario test at `blank-chain.scenarios.test.ts` pins the case explicitly.

Version bumped: `@opencues/runtime` 0.1.17 → 0.1.18.

### Fixed — fluid-blank AND transform-blank cycle order now match every other blank type ([#61](https://github.com/opencues/opencues/issues/61))

Cycling through a fluid-blank chain (`translate to japanese _` → `… translate to chinese _`) or a transform-blank chain (`draft email _` → continue → another transform) moved in the opposite direction from list-blanks / selector-satellite / sentence-cues. After the first substitution the buffer showed the answer (`こんにちは`); the DynDef stored `[question, answer]` with `currentIndex: 1`, so pressing Up (+1) wrapped from the end of the array straight to the oldest question instead of stepping back one item. With a chain `[q1, a1, q2, a2]` at `currentIndex=3`, Up jumped all the way to `q1` while Down only walked to `q2` — opposite of every other blank where `alts[0]` is the current visible and Up advances through `alts[1..]` one entry at a time.

The bug structurally affected both LLM-blank chain pipelines (`fluid-blank` and `transform-blank`) because they share the same `[oldest, …, newest]` chronological layout with `currentIndex` pointing at the tail. The initial PR only fixed fluid-blank per the narrow issue title; manual testing in CC surfaced that `draft email _` (transform-blank) had identical broken cycling, so the fix was extended to transform-blank.

Fix: store both fluid-blank AND transform-blank alternatives in reverse-chronological order — `[newestAnswer, newestQuestion, …priorItems]` with `currentIndex: 0`. Up now walks backward through history one entry at a time (newest answer → newest question → prior answer → original prompt), matching the convention list-blanks and sentence-cues already use. Chain truncate-on-branch flipped accordingly for both pipelines: drop the items NEWER than where the user cycled to (the indices BELOW `currentIndex` in the new layout) before prepending the next substitution. Tests at `packages/opencues-runtime/src/modules/blank-chain.scenarios.test.ts` and `transform-blank.scenarios.test.ts` updated for the new shape.

Version bumped: `@opencues/runtime` 0.1.15 → 0.1.17.

### Fixed — Claude Code: second `_` in a chain silently dropped (ZWS leaks into KeyEvent)

CC-only regression after [#52](https://github.com/opencues/opencues/pull/52). Chaining `_` triggers (`draft email _` → `… translate to japanese _`) worked on OpenCode but failed on Claude Code: the second transform never fired, the `_` just sat in the buffer. Root cause: the CC adapter's `dispatchKey` passed `iz.text` straight into `normaliseKeyEvent` (`packages/opencues-runtime/adapters/cc/v2.1/boot.ts:708-727`) without stripping the render-kick `\u200B`/`\u200C` marker that `__oc_pushHostText` toggles to defeat React's string-equality bail. Resolver's `onUnderscoreKey` (added by #52) simulates the standalone-`_` check via `splitWords`, which matches `\S+`; the ZWS is non-whitespace, so it glues to the cursor word — the trailing `_` is no longer detected as standalone, the one-shot gate refuses to arm, and `onTextChange` falls through to the debounced path with `allowBlanks=false`, masking the blank source. OC isn't affected because it doesn't render-kick.

Fix: strip ZWS at the KeyEvent boundary, same pattern as `checkTextDrift` (boot.ts:282) and `applyRender` (boot.ts:771-772) already use — this was the missing fourth row in the boundaries table in `integrations/claude-code/CLAUDE.md`. Adapter test pinned via `KeyEvent.text + cursorOffset are ZWS-stripped before reaching onKey handlers`.

Version bumped: `@opencues/runtime` 0.1.14 → 0.1.15.

### Fixed — LLM blanks silently dead on auto-routed Cerebras (invalid provider/model pair) + provider errors now surface inline

One root cause: a provider-blind default model leaking into an auto-routed provider of a different model namespace. The guiding principle for the fix: **always land on a valid (provider, model) pair; if a real error remains (credits, auth, …) surface it inline; never silently ship an invalid model.**

1. **Valid-pair guarantee — defaulting (`packages/opencues-runtime/src/modules/resolver.ts`).** The resolver no longer falls back to the host-supplied (legacy Groq-namespaced) `defaultModel` for the global MODEL tier. With `CEREBRAS_API_KEY` set and no `llm-provider:`/`llm-model:` in OPENCUES.md, auto-route correctly picked the Cerebras *provider* but the host default model `openai/gpt-oss-120b` was injected as `globalModel`, overriding Cerebras's own native `gpt-oss-120b` — so every `_` fluid/transform blank died with `provider error: Model openai/gpt-oss-120b does not exist … (code=model_not_found)`. (Script/static blanks like `weather _` were unaffected.) `globalModel` now comes ONLY from an explicit choice (`llm-model:` scalar or host-UI `modelOverride`); with neither, `resolveLLM` falls through to the resolved provider's own `defaultModel`, valid by construction. Two regression tests pin the invariant via the `resolverFactory` capture hook.

2. **Valid-pair guarantee — canonicalization (`packages/opencues-core/src/llm-provider.ts`).** New `canonicalizeModelForProvider()` normalises a known cross-namespace model alias INTO the resolved provider's own namespace on the PRIMARY dispatch path (previously the gpt-oss `openai/`-prefix ↔ bare translation only happened on the *fallback* path). A stale or mistyped `llm-model: openai/gpt-oss-120b` paired with Cerebras is now healed to `gpt-oss-120b` **before** the call instead of bouncing as `model_not_found`. Deliberately narrow (gpt-oss family only); an unknown/genuinely-wrong model is left untouched so the provider rejects it and the runtime surfaces that inline. Unit + `resolveLLM` integration tests cover both directions and the no-op cases.

3. **Provider errors surface inline like 401/404 (`packages/opencues-core/src/sources/fluid-blank-source.ts`).** `classifyHttpError` now recognizes two error classes that previously carried no HTTP status number and fell through to the silent default (visible only in `/tmp/opencues.log`):
   - **`model-not-found`** — `model_not_found` / `not_found_error` / "does not exist" / "do not have access". Checked before the generic 404 branch so a model 404 is attributed to the model, not the endpoint URL.
   - **`insufficient-credits`** — 402 / `payment_required` / `insufficient_quota` / "out of credits" / "billing". This is the "real" downstream error once canonicalization has landed a valid model — the account simply can't pay for the call.
   Both route through the existing `formatLLMErrorAsSubstitute` path, painting actionable inline messages. Reasons added to every formatter union site (`resolver.ts`, `build-sources.ts`, `boot-common.ts` native formatter, chrome `boot.ts`).

4. **Observability — resolver-side explicit-`_` gate now logs its suppression (`packages/opencues-runtime/src/modules/resolver.ts`).** When the explicit-`_` keystroke gate suppresses a blank trigger on the resolver path (fluid / transform / config-intent), it previously did so completely silently — no `starting` line, nothing even at debug level — so a `_` that "did nothing" was undiagnosable from the log. It now emits a `debug`-level `Resolver: explicit-_ gate BLOCKED …` line mirroring `BlankFill`'s existing one, surfaced under `debug-mode: on` (or `DEBUG_OPENCUES`).

Versions bumped: `@opencues/core` 0.1.8 → 0.1.9, `@opencues/runtime` 0.1.13 → 0.1.14.

### Changed — Provider rename `claude-cli` → `claude-code-cli`, llama-3.3 removed from Groq catalogue, CLI providers added to smoke

Follow-up on the LLM-provider fix below. Renamed the Anthropic CLI-transport provider id from `claude-cli` to `claude-code-cli` to match the official product name and remove ambiguity ("claude-cli" reads as a generic Claude CLI; the canonical user-facing brand for the binary is "Claude Code"). `canonicalizeProviderId()` keeps legacy user configs (`globalProvider: claude-cli`) silently working — old id resolves to canonical at every user-input boundary (resolveLLM + validateEndpoint + getProvider). Drop after 2027-01-01.

`llama-3.3-70b-versatile` removed from Groq's `knownModels` — it's not a reasoning model, so the adapter's default `reasoning_effort: low` 400s on it. The `modelRejectsReasoningEffort` predicate keeps it usable via direct OPENCUES.md edit; the classifier just doesn't surface it.

Smoke runner now also covers the two CLI-transport providers (`claude-code-cli`, `openai-subscription`) — `probe()` branches on `transport === 'cli'` and dispatches via `invokeCli()` instead of `fetch()`. Verified live 2026-06-02: 20 of 21 combos pass; the one failure was the user's expired `codex login` (actionable, not a bug — the runner correctly surfaced the API's auth-expired message).

Version bumped: `@opencues/core` 0.1.7 → 0.1.8 (single bump covers both fixes).

### Fixed — LLM providers: temperature/reasoning-effort deprecations + stale model catalogues

User reported `draft email _` producing no output in claude-cues despite doctor reporting healthy. Log trace caught the actual failure: `anthropic error: \`temperature\` is deprecated for this model.` — every blank routing through `blanks-llm-provider: anthropic` (Claude 4.x) was silently dying in the LLM call. A live smoke runner ([`tests/integration/llm-providers-smoke.cjs`](tests/integration/llm-providers-smoke.cjs)) verifying all 19 shipped (provider, model) combinations against real keys caught three more latent failures:

- **anthropic + claude-{opus,sonnet,haiku}-4-*** rejected `temperature`. Anthropic deprecated the field on the entire Claude 4.x family in June 2026. Now omitted at request build (`modelRejectsTemperature` registry). OpenRouter passthrough to `anthropic/claude-*` also covered.
- **groq + llama-3.3-70b-versatile** rejected `reasoning_effort` with HTTP 400. Groq's adapter previously claimed "non-reasoning models silently ignore it" — they don't on llama. Now gated by `modelRejectsReasoningEffort` registry; gpt-oss companions (which REQUIRE the field) keep getting it.
- **cerebras** catalogue listed `qwen-3-235b-a22b-instruct-2507` which Cerebras's `/v1/models` endpoint no longer returns. Removed from `knownModels`.
- **gemini** catalogue listed `gemini-3.1-flash` / `gemini-3.1-pro` which 404 on the live API. Google switched to the `gemini-flash-latest` / `gemini-pro-latest` rolling aliases. Updated.

Capability matrix lives in two registry consts in `llm-provider.ts` (`TEMPERATURE_REJECTING_MODELS`, `REASONING_EFFORT_REJECTING_MODELS`). Adding a future deprecation is a one-line append. 24 unit-test pins in `llm-provider.temperature.test.ts` cover the predicates + the buildRequest forwarding (Anthropic inline body + buildOpenAIBody-driven Groq/OpenRouter/Cerebras/OpenAI shared body). Live smoke runner (opt-in, requires API keys) verifies every catalogue entry actually accepts a minimal request — re-run on any model-catalogue or provider-adapter edit:

```bash
node tests/integration/llm-providers-smoke.cjs           # smoke every combo
node tests/integration/llm-providers-smoke.cjs --models  # list known combos
```

Verified live: 19/19 combos pass after the fix. Version bumped: `@opencues/core` 0.1.7 → 0.1.8.

### Changed — Blanks fire only on explicit `_` keystroke (cursor-split bug)

Explicit-`_` gate for blank activation (`packages/opencues-runtime/src/modules/{resolver,blank-fill}.ts`). FluidBlank / TransformBlank / ConfigIntent and script-backed blanks (volume, brightness, …) now fire ONLY when the `_` in the buffer was placed by an explicit user keystroke. A `_` exposed via cursor-relocation (typing `monologue_` and then splitting it to `monologue _`), paste, or programmatic `setText` is suppressed. Resolver and BlankFill each arm a one-shot flag on a plain `_` keypress, but only when the simulated insertion would produce a standalone `_` — so typing `_` adjacent to an existing word never arms. The flag is cleared at the end of the next `onTextChange` (exception: spaced-mode unconfirmed `_` keeps it through one extra dispatch so the confirming space still dispatches). `MockAdapter.pushText` auto-fires the `_` keystroke when the new text introduces additional `_` chars; the new `pushTextNoKeystroke` is the explicit opt-out for paste/programmatic-insertion simulations. Three scenario tests pin the user journey.

A follow-up commit on the same branch adds an event-bridge synth on `text:` injection that grows the underscore count — keeps the gate honest when text arrives through programmatic paths that bypass `onKey`.

Version bumped: `@opencues/runtime` 0.1.12 → 0.1.13.


### Fixed — Terminal.app Ctrl+Option+arrow: stdin byte-rewrite (completes the #51 synth)

Real-device testing of the [#51](https://github.com/opencues/opencues/pull/51) synth on a **default** Terminal.app profile (claude-cues 2.1.158, Ink) showed it still did nothing. A runtime probe of the raw event proved why: Ink **splits** the `\x1b\x1b[A` chord into two events *before any consumer sees it* — a standalone `escape` (seq `\x1b`) + a plain arrow (seq `\x1b[A`), same millisecond. After the split the arrow no longer carries the double-ESC prefix, so the event-level `shouldSynthesizeMacDoubleEscCtrl` gate can never fire (`synthFired:false` on every arrow; zero `ctrl:true` in the dispatch log).

The fix runs one layer earlier — at the raw stdin bytes, before Ink parses:

- **`packages/opencues-runtime/src/modules/mac-keyboard.ts`** — new pure `rewriteMacDoubleEscArrows(chunk)` rewrites `\x1b\x1b[A/B/C/D` → `\x1b[1;7A/B/C/D` (modifier param `7` = Ctrl(4)+Alt(2)+1 — the exact bytes Ghostty/iTerm2 already send, which Ink decodes to `{ctrl:true, alt:true}`). Plus `installMacDoubleEscStdinRewrite(stdin)` — darwin-gated, idempotent. Ink/CC consume stdin via 'readable' + `read()` with `setEncoding('utf8')`, so the installer wraps `read()` (the path that matters; chunks arrive as utf8 STRINGS, handled by a string-form rewrite) plus `emit('data')` for flowing hosts — each normalised before Ink's keypress parser sees it.
- **`packages/opencues-runtime/adapters/cc/v2.1/boot.ts`** — installs it once in `boot()` (CC only; shell / OC / gemini receive pre-parsed events and don't read stdin).

Safe by the **contiguous-byte invariant**: the terminal writes the chord's 4 bytes atomically → one stdin buffer; a real lone Escape arrives as its own buffer. Matching `\x1b\x1b[A` only within a single buffer therefore can never swallow a real Escape — no state, no timing window, no Escape latency. **Strictly darwin-gated — a complete no-op on Windows/Linux**: the installer returns early (`platform !== 'darwin'`) before wrapping stdin, so the byte rewrite is never reached off macOS. Degradation floor: on split-chunk transports (tmux/ssh) it no-ops, identical to the prior release. The #51 event-level synth is retained (no-op on this path, still covers hosts that preserve the full sequence). gemini-cli's matrix-❌ row is fixable by the same installer in its bootstrap (follow-up).

Version bumped: `@opencues/runtime` 0.1.11 → 0.1.12.

### Added — Bootstrap-coverage tests + banner-combo extraction (no behaviour change)

Follow-up to the macOS Ctrl+Option+arrow fix in [#51](https://github.com/opencues/opencues/pull/51). Two surfaces were behaviour-correct but untested:

- **OpenTUI bootstraps** (`integrations/shell/src/bootstrap.ts`, `integrations/opencode/patches/opencuesBootstrap.ts`) inlined the modifier-coalesce for the runtime `Modifiers` shape. Now factored into `buildOpenTuiModifiers(evt)` in `@opencues/runtime/src/modules/mac-keyboard.ts`, pinned by 19 new test cases in `mac-keyboard.test.ts` covering: Mac Terminal.app double-ESC (all 4 arrows + meta preservation), Ghostty / iTerm2 xterm-modifier CSI (Ctrl+Option+arrow + plain Option+arrow), Linux/Windows xterm (Ctrl+Alt+arrow, plain Alt+arrow regression guard, plain arrow), Ctrl+Shift+arrow + 4-modifier combinations, the alt-coalesce truth table (option/alt/meta cross-product), and defensive edge cases (missing sequence, missing key). Both bootstraps now delegate verbatim — drift between the two is structurally impossible.
- **Banner combo label** (`packages/opencues-cli/src/commands/run.cjs`) had inline `pickNavCombo(host)` that read `process.platform` directly — not testable. Now extracted to `packages/opencues-cli/src/lib/nav-combo.cjs` with an explicit `platform` parameter (defaults to `process.platform`); pinned by 21 new `node:test` cases in `nav-combo.test.cjs` across `darwin / linux / win32 / freebsd / openbsd / sunos / aix` × every shipped host. Confirms macOS reads "Ctrl+Option" (matches physical Mac keyboard label) and every other platform reads "Ctrl+Alt"; chrome's label follows the user's keyboard, not the browser env.

Net coverage: **+40 unit pins** across the two surfaces flagged as untested in #51's post-merge audit. Runtime suite now 1496 tests; CLI suite now 133 tests. Versions bumped: `@opencues/runtime` 0.1.10 → 0.1.11, `opencues` CLI 0.1.8 → 0.1.9, `@opencues/shell` 0.1.3 → 0.1.4, `@opencues/opencode` 0.1.2 → 0.1.3.

### Fixed — macOS Ctrl+Option+arrow now works on every terminal, including Terminal.app

A tester reported `Ctrl+Alt+arrow` doing nothing on macOS. `cat -v` testing traced the byte stream Mac Terminal.app emits for Ctrl+Option+arrow: `\x1b\x1b[A` (double-ESC + CSI). The Ctrl modifier byte is missing — Terminal.app doesn't encode it — but **the double-ESC prefix is a unique signature**: no other macOS key combination produces double-ESC arrow CSI. Plain Option+Left/Right emits word-jump bytes (`^[b` / `^[f`), not arrow codes; plain arrows omit the ESC prefix entirely. Both Ink and OpenTUI parsers detect double-ESC and surface `option: true` on the arrow event (see `ink/parse-keypress.js:471` and `@opentui/core parse.keypress:5957`).

Three sites now synthesise `ctrl: true` when the runtime sees `option && arrow && !ctrl`, so the `ctrl-alt` matcher fires on Mac Terminal.app exactly the way it does on Ghostty / iTerm2 (which already transmit the Ctrl bit in modifier-encoded CSI like `\x1b[1;7A`):

- **`packages/opencues-runtime/adapters/cc/v2.1/adapter.ts:328-380`** — synth in `normaliseKeyEvent`, covers CC for both forks (cli.js 2.1.110 + native 2.1.150/158).
- **`integrations/shell/src/bootstrap.ts:412-440`** — synth in `dispatchOpenCuesKey`. Same OpenTUI host as OC.
- **`integrations/opencode/patches/opencuesBootstrap.ts:511-540`** — same synth.

Per-integration matrix on macOS after this PR:

| Integration | Mac Terminal.app | Ghostty / iTerm2 |
|---|---|---|
| CC | ✅ works (synth fires on double-ESC) | ✅ works (synth is no-op, ctrl already true) |
| OC | ✅ works | ✅ works |
| shell | ✅ works | ✅ works |
| gemini-cli | ❌ Gemini's own parser at `KeypressContext.tsx:585` reads `alt` from the CSI modifier byte and discards the outer ESC-prefix from a double-ESC sequence. Mac Terminal users on gemini-cli need to install Ghostty or iTerm2 (which emit modifier-encoded CSI directly and bypass the parser quirk). | ✅ works |
| chrome | ✅ DOM `altKey` works in any Mac browser | ✅ same |

Also in this PR:

- **`packages/opencues-runtime/src/modules/nav-keymap.ts`** — removed the `TERM_PROGRAM=Apple_Terminal → ctrl-shift` auto-fallback. It was based on the wrong assumption that Ctrl+Alt+arrow was stripped; per `cat -v` testing, *Ctrl+Shift+arrow* is the combo Terminal.app actually strips, so the fallback was making things worse. `auto` now resolves to `ctrl-alt` everywhere (chrome stays hard-pinned).
- **`docs/install.md`** macOS section rewritten — Terminal.app now works without manual configuration thanks to the synth above. Earlier drafts of this PR recommended toggling "Use Option as Meta key" in profile settings; that's no longer required for OpenCues itself (users may still want it for general shell ergonomics).
- **Shared helper** `packages/opencues-runtime/src/modules/mac-keyboard.ts` exports `shouldSynthesizeMacDoubleEscCtrl`. Single source of truth used by all three sites above; 16-test pin in `mac-keyboard.test.ts` covers every byte-shape × terminal × edge-case combination.

Versions bumped: `@opencues/runtime` 0.1.9 → 0.1.10, `@opencues/core` 0.1.6 → 0.1.7, `opencues` CLI 0.1.7 → 0.1.8, `@opencues/shell` 0.1.2 → 0.1.3, `@opencues/opencode` 0.1.1 → 0.1.2. Banner in `opencues run` shows "Ctrl+Option" on darwin to match the physical Mac keyboard label.

User-facing upgrade path: `opencues run <host>` auto-rebuilds on next launch (srcHash drift detection from June 2026). No manual terminal-settings toggle required.

### Added — Self-healing forks: `opencues run <host>` auto-rebuilds on source drift

The "git pull and existing forks silently keep running pre-pull bytecode forever" trap is now closed structurally. Three pieces shipping together in this batch:

- **`packages/opencues-cli/src/lib/version-markers.cjs`** gains `computeSourceHash(repoRoot)` — a SHA-256 over every file under `packages/opencues-runtime/src/**` + `packages/opencues-core/src/**` + `packages/opencues-core/node-http-adapter.js`. `writeMarker` records it; `checkDrift` returns `status: 'stale', reason: 'srcHash'` when it diverges from the bundle's recorded hash. Load-bearing because it fires on ANY source byte change, not just package.json bumps — developers forgetting to bump no longer masks drift.
- **`packages/opencues-cli/src/commands/run.cjs`** calls `ensureFreshBundle(host, ctx)` at the top of every `opencues run <host>` invocation. Stale → transparently runs `opencues install <host> --no-prompts --yes` before spawning the host. One info line tells the user what's happening (`bundle is stale (source files changed since last install). Rebuilding before launch`). `--no-rebuild-check` opts out.
- **CLAUDE.md** gains a "Drift-prevention discipline" section codifying the new mechanism, the contract for adding bundled source dirs, and what contributors MUST do when changing `@opencues/{core,runtime}/src/**`.

### Added — `@opencues/core` 0.1.4 → 0.1.5
- **0.1.4 → 0.1.5** (PR #37 — nav-keymap): new `nav-keymap` scalar in FEATURES (`auto` | `ctrl-alt` | `ctrl-shift`). Auto resolves per host: chrome → ctrl-alt always (browser owns ctrl-shift+arrow); macOS Terminal.app (`TERM_PROGRAM=Apple_Terminal`) → ctrl-shift; everything else → ctrl-alt. Lets macOS Terminal.app users keep navigating without switching terminal emulators.

### Added — `@opencues/runtime` 0.1.5 → 0.1.6
- **0.1.5 → 0.1.6** (PR #37 — nav-keymap): `OpenCuesState.navKeymap` field with parser + `applyOpenCuesScalar` support; new `nav-keymap.ts` module exporting `resolveNavKeymap(configured, hostName)`. `Navigation` + `Cycling` subscribe both modifier combos at boot and gate each handler per-keystroke against the resolved keymap — flipping the scalar in OPENCUES.md hot-reloads without restart. Chrome adapter band skips the ctrl-shift subscription entirely (browser owns it for text selection).

### Added — `opencues` CLI 0.1.5 → 0.1.6
- **0.1.5 → 0.1.6** (PRs #38 / #39 / #40 / #41 + this batch):
  - PR #38: `opencues run <host>` launch banner with key hints + `--skip-banner` opt-out. Banner held in alt-screen for 3s minimum dwell so the Keys line is actually readable.
  - PR #39: shell-install tmux noise reduction — consolidated from 4 mentions per install to ≤2. Vendored-first preflight check skips the system-tmux warning when `~/.opencues/vendor/tmux/bin/tmux ≥ 3.2` is present.
  - PR #40: banner Keys section restructured so "Keys" is the leftmost section header with ├─/└─ branches hanging beneath; description column aligned across both Ctrl+Alt (12) and Ctrl+Shift (14) widths.
  - PR #41: vendor-pins test sandboxed via temp-`$HOME` so `pnpm test` stops deleting the real user's `~/.opencues/vendor/tmux/`.
  - This batch: `ensureFreshBundle` drift check + auto-rebuild on `opencues run`; `version-markers.cjs` gains `computeSourceHash` + `srcHash` + `reason` fields.

### Added — `@opencues/shell` 0.1.1 → 0.1.2
- **0.1.1 → 0.1.2** (PR #39): `bin/install.cjs` no longer prints the duplicate "tmux not installed" note (preflight in `opencues install` is now the single source of truth); the auto-vendor message names WHY it's running (`▸ System tmux is X.Y (oc-shell needs ≥ 3.2). Vendoring tmux 3.4 to ~/.opencues/vendor/tmux/`); `patches/setup.sh` tail prints only `✓ Shell build done.`, with the Launch / Open input / Optional-shell-integration summary moved into install.cjs so it lands AFTER the vendor step, not before.

### Added — `@opencues/core` 0.1.0 → 0.1.4
- **0.1.0 → 0.1.1**: Three-bucket LLM routing (`cues` / `auditors` / `blanks`). FEATURES registry gains three bucket scalars; `ConfigLoader` parses `cues-llm-provider` / `auditors-llm-provider` / `blanks-llm-provider` with back-compat read for legacy singular `blank-llm-*`. `build-sources.ts` routes per-bucket via `cuesBucket*` / `blanksBucket*` instead of the single `blankGlobal*`; the trust-class guard refuses `trainsOnInput: true` providers on prose buckets. Canonical doc: `docs/architecture/llm-routing.md`.
- **0.1.1 → 0.1.2**: Fluid-config natural-language provider/model switching. `ConfigIntentVerdict` becomes a discriminated union (`setting` | `provider` | `none`); SYSTEM_PROMPT rewritten with three INTENT classes; `validateAgainstRegistry` handles both verdict kinds. `ProviderAdapter.knownModels` (optional `readonly string[]`) bounds the model catalogue the classifier may route to — 2-5 curated entries per provider.
- **0.1.2 → 0.1.3**: Bare provider switches default to the **blanks** bucket. `"switch to anthropic _"` now writes `blanks-llm-provider: anthropic` (was `cues-llm-provider`). Cues and auditors require explicit scope; rationale: blanks is the user-opt-in `_` surface most likely targeted by a bucket-less phrase.
- **0.1.3 → 0.1.4** (PR #32 — Sentinels infrastructure): TransformBlankSource now consumes the SENTINELS.md catalog — `draft email _`, `write a bio _`, etc. resolve sender sentinels via the same post-processor FluidBlank uses, with `preserveUnknown: true` so non-sender placeholders (`[Recipient Name]`, `[Date]`) survive untouched. New `validateSentinelWrite` discriminated chokepoint (`sentinels-validator.ts`) enforces key shape, value caps (256 chars / 64 fields), control-character filter, and token-collision detection for any code path that mutates SENTINELS.md. Renames: file `USER.md` → `SENTINELS.md`; symbols `UserContext*` → `Sentinels*`, `parseUserMd` → `parseSentinelsMd`, etc.; scalar `user-context-mode:` → `sentinels-mode:`. Back-compat: ConfigLoader reads both scalar names; seed-configs self-heals the file + scalar rename. Audit row #24 codifies the new write-surface threat model.

### Added — `@opencues/runtime` 0.1.0 → 0.1.5
- **0.1.0 → 0.1.1** (PR #17 chain-history): sequential LLM-blank substitutes chain into walkable history so the user can cycle back through prior fill-ins.
- **0.1.1 → 0.1.2**: typed bucket fields (`cuesLlmProvider` / `auditorsLlmProvider` / `blanksLlmProvider`) on `OpenCuesState` with back-compat parsing; `boot-common.buildAgentLLMResolver` reads the auditors bucket so `agent-rewrite` routes through it.
- **0.1.2 → 0.1.3**: `applyOpencuesScalar` now awaits the disk write — back-to-back applyScalar calls (ConfigIntent's provider+model verdict path) serialise on disk instead of racing the read-modify-write.
- **0.1.3 → 0.1.4** (PR #32 — Sentinels rename): `OpenCuesState.userContextMode` → `sentinelsMode`; `ConfigLoader` parses the new `sentinels-mode:` scalar with back-compat fall-through to legacy `user-context-mode:`. No behaviour change for users who haven't opted into sentinels.
- **0.1.4 → 0.1.5** (PR #34 — sentinel-write blank): new `SentinelBlank` class in `BUILTIN_BLANKS` handles `set sentinel <key> <value> _` and `remove sentinel <key> _`. Every write routes through `@opencues/core`'s `validateSentinelWrite` chokepoint (no parallel paths). New `sentinelsMdIO` field on `BuiltinBlankContext`; the blank registers only when the host wires it. Errors paint visibly into the buffer as `[err] <detail>` — never silent, never throws. 7 layered defences documented in security-audit.md row #24.

### Added — `opencues` CLI 0.1.1 → 0.1.5
- **0.1.1 → 0.1.2** (Option-B self-heal): `seed-configs` cleans up legacy built-in / user-blank collisions left over from the May 2026 user-blank migration. Per-host log prefix; per-version markers.
- **0.1.2 → 0.1.3**: `seed-configs` self-heals legacy `blank-llm-*` → `blanks-llm-*` rename in place; `doctor` grows a "LLM routing" section showing effective resolution per bucket; `doctor` tmux check honors the vendored 3.4 fallback (`~/.opencues/vendor/tmux`); `update` detects stale bundled `@opencues/{core,runtime}` and transparently rebuilds instead of short-circuiting; CC install's "already healthy" hint bolds the `--rebuild` flag; help screen's Providers row shows three buckets instead of four per-aspect surfaces; `update` exports `isTested` / `isKnownIncompatible` (regression fix).
- **0.1.3 → 0.1.4** (PR #33): SIGINT race fix — `opencues update` registers signal handlers BEFORE `acquireLock` writes the lockfile (see CLI #33 entry above).
- **0.1.4 → 0.1.5** (PR #32 — Sentinels CLI + migrations): new `opencues sentinels` command (interactive interview + scriptable `list` / `set` / `add` / `remove` / `rm` / `path` / `list --json`). Smart defaults from `git config` and `gh api user`. All writes route through `@opencues/core`'s `validateSentinelWrite`. `seed-configs` self-heals `~/.cues/USER.md` → `~/.cues/SENTINELS.md` (pre-SEED step so user data survives) and `user-context-mode:` → `sentinels-mode:` (legacy-value-wins when both present). `doctor` surfaces leftover legacy artifacts with `opencues seed-configs` as the fix command.

### Added — `@opencues/claude-code` 0.1.0 → 0.1.2
- Single-fork CC install: one fork at `~/claude-code-cues/` handles both cli.js (≤2.1.111) and native-binary (≥2.1.113) shapes via tweakcc 4.0.13+ shape detection. `claude-code-cues-150` retired. Opt-in statusline. Native 2.1.150 support. Subsequent same-minor bumps (2.1.158 promoted to `current-pin` 2026-05-31) ride this band without a package-version bump — same adapter, same anchors, only `compat.json` updates.
- **0.1.1 → 0.1.2** (PR #34): CC bootstrap wires `sentinelsMdIO` so the keyword-bound `set sentinel _` / `remove sentinel _` blank can write to `~/.cues/SENTINELS.md`. Writes route through `@opencues/core`'s `validateSentinelWrite`; no parallel write paths. Security-audit row #24.

### Added — `@opencues/chrome` 0.1.0 → 0.1.2
- Bundle ships the new `BLANK.md` frontmatter (the user-blank migration that retired the per-host built-in/user-blank duplication).
- **0.1.1 → 0.1.2** (PR #34): Chrome bootstrap wires `sentinelsMdIO` so the sentinel blank works on contenteditables + normal inputs. Writes go through chrome.storage via the same validator chokepoint.

### Added — `@opencues/opencode` 0.1.0 → 0.1.1
- **0.1.0 → 0.1.1** (PR #34): OC bootstrap wires `sentinelsMdIO` for the sentinel blank.

### Added — `@opencues/gemini-cli` 0.1.0 → 0.1.1
- **0.1.0 → 0.1.1** (PR #34): Gemini bootstrap wires `sentinelsMdIO` for the sentinel blank.

### Added — `@opencues/shell` 0.1.0 → 0.1.1
- **0.1.0 → 0.1.1** (PR #34): Shell (`oc-edit`) bootstrap wires `sentinelsMdIO` for the sentinel blank.

### Added — new packages introduced this period
- **`@opencues/runtime` 0.1.0** — host-agnostic runtime scaffold (HostAdapter types, MockAdapter, conformance suite). Replaces the inline runtime code that previously lived in the CC patch.
- **`opencues` CLI 0.1.0** — front-door CLI (`opencues install <host>`, `opencues run <host>`, `opencues doctor`, `opencues review`, `opencues check-keys`, `opencues set-key`, `opencues seed-configs`, `opencues update`).
- **Per-integration `package.json`** scaffolding — each integration ships its own version + compat metadata for `opencues update` to consume.
- **`@opencues/chrome` 0.1.0** — MV3 extension with CSS Custom Highlight API for in-page rendering, contenteditable + Lexical + ProseMirror + Draft.js engine support.
- **`@opencues/gemini-cli` 0.1.0** — Gemini CLI 0.41.x integration (React/Ink host).
- **`@opencues/terminal` 0.1.0** — standalone Bun + OpenTUI app (`oc-edit`). Later evolved into `@opencues/shell` (the `oc-shell` tmux-popup launcher).
- **`@opencues/codex` 0.0.1** — integration skeleton (Stage 1, not user-ready).
- **`opencues` (placeholder) 0.0.1** — minimal placeholder published to the npm registry to reserve the package name. Handover runbook in `CLAUDE.md`.

### Changed
- **Renamed `blank-llm-*` (singular) → `blanks-llm-*` (plural)** for the blanks bucket scalars (core 0.1.0 → 0.1.1). Runtime reads both names; `seed-configs` rewrites legacy → new in place on the next `opencues install` run. Back-compat fallback to be removed in a future release.

### Fixed (paired with version bumps above)
- **`applyOpencuesScalar` race on back-to-back disk writes** (runtime 0.1.2 → 0.1.3) — ConfigIntent's provider-verdict apply path writes two scalars sequentially (`<scope>-llm-provider`, then `<scope>-llm-model`). The previous fire-and-forget disk write let the second invocation read the file before the first write landed, so the final file held only one of the two scalars. Fix awaits the `ProcessHandle.result` from `blankInvoke` / `spawnProcess`.
- **`opencues update --to <ver>` crashed on the post-install hint path** (CLI 0.1.2 → 0.1.3) — `compatLib.isTested` was defined but not exported, so the success-line hint that suggests adding the version to `compat.tested` threw `TypeError`. Host had already pinned + installed by that point — the user impact was just a confusing trailing stack. Fixed by exporting `isTested` and `isKnownIncompatible`.

---

## [0.1.0] - 2026-04-10

Initial pre-release. All core features implemented with a working Claude Code integration.

### Features

#### Navigation & Interaction
- **Feature 1: Navigation** — Ctrl+Alt+Left/Right moves between interactive words (cue-controls, step patterns, local tips, LLM alternatives, multi-word spans). Index-based targeting skips non-interactive words.
- **Feature 2: Cycling** — Ctrl+Alt+Up/Down replaces the focused word through a five-tier priority: custom cue-controls → control-bound blanks → step controls → consume-all alts → LLM alternatives. Linked words synchronize automatically.
- **Feature 3: Visual Cues** — Real-time ANSI styling with three visual states: normal (white), dimmed (gray, has alternatives), highlighted (bold white, currently focused). Dimming appears within ~500ms of typing.
- **Feature 4: Cursor Preservation** — Cursor offset adjusts automatically when a replaced word differs in length, keeping the editing position stable during cycling.

#### Cue Sources
- **Feature 5: Linked Words** — LLM detects semantic pairs (e.g. "boy"/"his") and cycles them together to the same alternative index when either is changed.
- **Feature 6: Local Cues** — O(1) hash-map lookup from a JSON tips file provides instant alternatives (<5ms) without LLM round-trips. Merged with LLM results; tip-sourced words are never overwritten.
- **Feature 7: Remote Cues** — LLM-generated alternatives via a resolver that classifies source scope (word vs blank), applies priority, and combines multiple domain sources (grammar, legal, medical, financial) into a single API call.

#### Blanks
- **Feature 8: Fill-in-the-Blank** — Type `_` and get contextual completions. 10 built-in modes: math (`2+2=_` → `4`), factual (`capital of France is _` → `Paris`), translation, unit conversion, spelling, color codes, HTTP codes, timezone, roman numerals, and grammar. Three-stage classification: regex → keywords → LLM classifier.
- **Feature 9: Multi-Word Spans** — Alternatives that are multiple words (e.g. "Jeff Bezos") navigate, dim, and cycle as a single unit. Span tracking maintains original indices across word-count changes.

#### Controls
- **Feature 11: Cue-Controls** — Words that trigger external scripts on cycle. Navigate to "volume" and press Up/Down to change actual system volume. Supports DynDef-bound step matching (e.g. `50%` adjacent to a `volume` keyword), list-based values, and dynamic script outputs.
- **Feature 12: Control-Bound Blanks** — `volume _` auto-populates with the live system value; cycling writes back via script. Supports numeric step, string format, read-only, dismissible, suffix display, keyword expansion, and keyword clearing. Multi-word keywords match consecutive words as a single phrase.
- **Feature 17: Selector + Satellite Blanks** — `opencues settings _` expands into two linked words: a selector that picks a setting and a satellite that shows/writes its value. Cycling the selector swaps the satellite's entire alt list. The backing config (`OPENCUES.md`) uses a unified `settings:` block with colocated values and per-value tips. Indent-agnostic parser detects structure by key names, not whitespace.

#### System
- **Feature 10: Per-Word Clearing** — Editing text intelligently preserves alternatives at unchanged positions. Only words that actually changed are invalidated. Selector/satellite pairs cascade: clearing either side clears its partner.
- **Feature 13: Auto-Submit** — Three-tier debounced analysis triggers LLM resolution automatically: space-typed (immediate), typing-pause (350ms), mid-edit (1s). Eager tips lookup pre-populates before debounce fires.
- **Feature 14: Cursor Export** — Synchronous JSON export of highlight state to `/tmp/` on every render, consumed by the status line script and available to external tools.
- **Feature 15: Secondary Display** — Status line shows cue-tips and cycle position for the focused word. Per-alternative tips during cycling. Suppressed when no tip resolves.
- **Feature 16: Hot-Reload Config** — TTL-based polling (~2s) reloads all `.md` config files without restart. Parse errors preserve the previous config. Covers CUES.md, BLANKS.md, controls, OPENCUES.md.
- **Feature 18: Tip Priority** — Fixed resolution order: satellite per-value tips → selector tips → control blank tips → cue-control script tips → local cue tips → LLM tips. Control-bound words are shielded from LLM overwrite.

#### Controls Included
- **Volume** — System volume control with word-based (Up/Down key presses) and blank-based (exact set via Core Audio API) cycling
- **Brightness** — Screen brightness control via blank
- **Affirmations** — Static list control cycling through motivational phrases
- **Stocks** — Read-only API control fetching live stock prices from Finnhub (reddit, nvidia, apple, google, microsoft, amazon, tesla, meta)
- **Weather** — Read-only API control fetching live weather from Open-Meteo (any city/country, today/tomorrow/weekend/weekly)
- **Hacker News** — Dynamic list control fetching live HN front page titles via RSS
- **Prompt Improver** — Consume-all control with two-step LLM (model + prompts in `cue.md`): extracts prompt/conditions, returns 3 improved versions + original as cycling alternatives. First control using `blankConsumeAll`.
- **OpenCues Settings** — Selector+satellite control for live OpenCues configuration (voice-mode, debug-mode, tips-mode, output-format, display mode)

### Project

- **opencues-core** — Pure TypeScript library (resolver, config parser, HTTP adapter, 5 source types, 5 response parsers)
- **Claude Code integration** — via tweakcc patches (wordHighlight.ts, dynamicHighlight.ts, cursorStateExport.ts)
- **418 unit tests** across 6 test files + 390-sentence live benchmark
- **19 feature concept docs** + 8 implementation guides + glossary
- **8 Claude Code integration docs** covering all implementation details
- GitHub org at `opencues/opencues`
- Issue templates, PR template, CODE_OF_CONDUCT.md, SECURITY.md
- Pre-launch checklist with audit results

[0.1.0]: https://github.com/opencues/opencues/releases/tag/v0.1.0

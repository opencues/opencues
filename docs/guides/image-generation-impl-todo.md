# Image generation — implementation TODO (chrome first, then test, then rollout)

> Companion to `docs/guides/image-generation.md` (research + design). This is the
> ordered build plan to take the prototype (`research/image-gen-demo/`) into the
> real runtime, **starting with chrome**, testing, then the other hosts. Branch:
> `research/image-generation-notes`.

## Review — where the prototype landed (what's validated, what's assumed)

**Validated in the harness (host-agnostic logic):**
- Language-invariant classifier (GENERATE / EDIT / CEDE) — en/fr/ja.
- Generate (flux/schnell @512 → 256 master → display) and edit (kontext-dev,
  ≥256 floor) — both end-to-end, with real cost/latency numbers.
- Target resolution: classifier ordinal/descriptor → cursor-adjacency → first
  (best-guess; no cede-on-ambiguity for v1).
- Ephemeral session masters + orphan GC; text persistence (strip only the
  verbatim trigger, keep prefix); inline loader = exact shipped OpenCues bounce
  loader (frames `_ - ‾ -`, palette, 150ms); full lifecycle logging.

**Assumed / not yet real (the work below):**
- A standalone classifier (must join the existing semantic-`_` family or share
  its pass). Binary payload via a non-existent `insertImage`. Masters in page JS,
  not the runtime. Single-text-node parsing. Color via inline style, not the
  chrome Custom Highlight API. No `HostAdapter`/resolver/provider-bucket wiring.

---

## Phase 0 — decisions to lock before coding

- [ ] **Classifier placement** — share the existing semantic-`_` classification
      pass (FluidBlank/ConfigIntent/BlankIntent) vs a dedicated ImageIntent call.
      Decide via a bench (the SUMMON −24pp "one job per call" risk). Default lean:
      start as its **own** source/call for isolation; fold in later if the bench
      shows no recall loss.
- [ ] **Consent / cost guard** — `_` is consent; add a per-session/?per-minute
      image-op cap + hard debounce. Confirm no auto-fire ever.
- [ ] **Models** — locked: `flux/schnell` (gen), `flux-kontext/dev` (edit),
      `flux/dev` escalation. Provider `fal`. Master 256, generate 512.
- [ ] **Ambiguity policy** — best-guess for v1 (documented), revisit cede-and-ask
      after two-image usage is real.

---

## Phase 1 — core (host-agnostic): generate/edit + provider bucket

- [ ] `packages/opencues-core/src/` — add `generateImage(prompt, {size, model, httpAdapter})`
      and `editImage(masterBytes, instruction, {model, httpAdapter})`. **Must take
      an `httpAdapter`** (chrome fetch vs `NodeHttpAdapter`) — see
      `chrome-runtime-compat.md`; never `new NodeHttpAdapter` unguarded
      (`lint-runtime-browser-safe.sh`).
- [ ] Provider call shapes from the guide (fal `/fal-ai/...`, `sync_mode`,
      `image_size`, kontext `image_url`). Catch→`this.log(...)` before returning
      an error envelope (per the source-catch contract).
- [ ] **Images provider bucket** — mirror `llm-routing.md`: add
      `images-provider` / `images-model` / `images-edit-model` /
      `images-master-size` to `feature-registry.ts` FEATURES; resolve via the
      bucket ladder in `build-sources`. (Image gen is a side-effecting `_` action,
      trust class = blank.)
- [ ] **Key plumbing** — `FAL_KEY` flows like LLM keys: env on native,
      `chrome.storage` live-mutation on chrome (`Resolver.options.apiKeys`
      pattern, `chrome-llm-keys.md`).
- [ ] Unit tests for the two functions with a stub httpAdapter (hermetic — no
      real network, `check-test-hermeticity.sh`).

## Phase 2 — HostAdapter contract: image output + masters

- [ ] `packages/opencues-runtime/src/adapter.ts` — add to `HostAdapter`:
      `imageOutputMode?(): 'insert' | 'clipboard' | 'path' | 'none'` (dynamic,
      per-target, like `supportsCycling`) and
      `insertImage?(bytes, opts: {mime, alt, width, height}): {id}` (or the
      delivery appropriate to the mode). Terminal hosts return `'path'`/`'none'`.
- [ ] **Image registry** in the runtime (session-scoped): `id → {master(256),
      prompt, seed}`. Ephemeral; orphan-GC keyed off the live node set the host
      reports. Define the host hook that lists current images (ordinal + label +
      position) for the classifier.
- [ ] Gate: an ImageBlank registers only when `imageOutputMode() !== 'none'` —
      structurally pruned on hosts that can't show images (mirror the
      `supportsCycling:false` universal-integration prune).

## Phase 3 — Chrome adapter: insert, loader, masters, keys

- [ ] `packages/opencues-runtime/adapters/chrome/v1/adapter.ts` — implement
      `imageOutputMode()='insert'` + `insertImage()` writing an
      `<img data-oc-id>` into the contenteditable as **one undo entry**
      (`insertHTML` engine path — reuse the `project_chrome_replaceall_undo`
      learnings: PM/Lexical/generic engines differ).
- [ ] **Loader via the real `BlankLoadingAnimator`** — do NOT hand-roll. Wire the
      `_` slot through `blank-loading.ts`; color via the CSS Custom Highlight API
      (`runtime-renderer.ts`, `LOADING_STYLE_ID`, `blank-loading-colors-rgb`) —
      the prototype's inline color is the stand-in this replaces.
- [ ] Masters registry lives in the runtime (Phase 2), keyed by `data-oc-id`;
      orphan GC via a MutationObserver-equivalent on the field.
- [ ] Key audit at boot (`verifyLlmKeyAtBoot` sibling for `FAL_KEY`); degrade
      with a logged advisory if missing (don't silently no-op — the chrome
      silent-degrade bug class).
- [ ] Wire into `integrations/chrome/src/opencues-bootstrap.ts`; respect the
      native-prototype value setter for framework fields.

## Phase 4 — ImageBlank source: classify, target, strip, ephemeral

- [ ] New `CueSource` (or BlankFill route) for image-intent. Trigger = `_`-gate;
      classify (Phase 0 decision). Generate → FluidBlank-shaped; edit →
      TransformBlank-shaped (binary, owns whole output → replace).
- [ ] **Target resolution** — classifier ordinal/descriptor → cursor-adjacency →
      first (best-guess). Feed the classifier the bounded image list (ordinal +
      label), ambient-context style.
- [ ] **Text persistence** — strip only the verbatim trigger at completion,
      preserve any prefix (prototype's `stripTrigger`). Route the command-window
      through `keyword-window.ts` / `summonPhraseStart` semantics so it stays
      consistent with the other `_` sources.
- [ ] **Ephemeral masters** — frozen on reset/submit; expired edits cede with a
      note. No persistence layer.
- [ ] **No-landmine** — a failed/slow gen or edit must never wipe/block the
      buffer; add a throwing-provider fail-safe scenario test
      (`feedback_no_logical_landmines`).

## Phase 5 — build / sync / manual TEST (chrome) ← the test gate

- [ ] `cd integrations/chrome && npm run build`; bump **both** `manifest.json` +
      `package.json` (lockstep rule).
- [ ] Sync to the Windows extension dir / `opencues sync chrome` (WSL → /mnt/c).
- [ ] **Manual test matrix** (record results):
  - generate (en + a non-English prompt) → image inserts, loader = real bounce.
  - edit by cursor-adjacency, by name ("the first one"), by click-select.
  - prefix kept ("Here's my idea: a red apple _"); CEDE leaves text intact.
  - failure (kill key / fast-sdxl) → inline note, surrounding text untouched.
  - undo (Ctrl+Z) = single step removes the image.
  - delete an image → master GC'd (check `[chrome][imggen]` in `/tmp/opencues.log`).
  - reload/submit → images frozen, edits cede.
- [ ] Confirm lifecycle logs land as `[chrome][imggen]` via `adapter.log` (the
      prototype's `clog` phases are the line set).
- [ ] Gates: `bash scripts/pre-pr.sh` (esp. `check-chrome-bundle.sh`,
      `lint-runtime-browser-safe.sh`, `version-bump-gate`, doctor).

## Phase 6 — close the harness→adapter gaps

- [ ] Command parsing across mixed text+image nodes (not single-text-node).
- [ ] Remove `fast-sdxl` from any shipped surface (demo-only).
- [ ] Orphan-GC + ephemeral lifetime defined precisely (reload/submit; no idle TTL).

## Phase 7 — spec / version / docs

- [ ] **SPEC_VERSION bump** — binary blank payload is a wire-format change
      (`spec-version.ts` + the full bump checklist in CLAUDE.md).
- [ ] `feature-registry.ts` FEATURES + (if typed access needed) `OpenCuesState` +
      `config-loader.ts` parse case for the image-mode scalar.
- [ ] CHANGELOG + per-package version bumps (core/runtime/chrome).
- [ ] Update `docs/features/` (user-facing) + the canonical guide; flip status
      from research → shipped.

## Phase 8 — cross-platform rollout (post-chrome)

Follow `docs/guides/image-generation.md` → "Experimenting on other platforms".
Per host (CC, OpenCode, gemini-cli, shell, android):
- [ ] **Stage 0 manual capability probe** (Ctrl+V / path / @file / drag-drop) →
      pick the delivery rung. Fill the matrix.
- [ ] Implement the winning rung (path-injection default) reusing the chrome core.
- [ ] generate → edit → loader+log verification (`[host][imggen]`).
- [ ] Record the per-host verdict back into the guide's matrix.

---

## Definition of done — chrome v1

Generate + edit work in a chrome rich input: language-invariant trigger, real
OpenCues bounce loader, inline insert with single-step undo, ordinal/adjacency
edit on a ≥256 master, prefix-preserving, ephemeral (frozen on reset), failures
never corrupt the buffer, full `[chrome][imggen]` logging, all `pre-pr.sh` gates
green, SPEC_VERSION + versions bumped. Other hosts: not started (Phase 8).

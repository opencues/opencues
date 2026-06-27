# Image Generation — Research Notes & Provider Guide

> **Status: research / exploratory (June 2026).** Not wired into the runtime
> yet — there is no image-blank or image provider in `llm-provider.ts` today.
> This is a decision record + reference for when we add one. Lives on the
> `research/image-generation-notes` branch; keep it off `master` until we
> actually ship an image feature.

The question that started this: *can OpenCues produce a small raster image
(e.g. a 50–500px icon/illustration) fast and cheaply, the way the text blanks
return sub-second answers?* Short answer: **not from an LLM, and not for free —
but a dedicated fast image-inference service (fal.ai) gets you a recognizable
image in ~0.3–0.7s for ~$0.003.** The rest of this doc is the evidence and the
recipe.

---

## TL;DR / recommendation

- **Use `fal-ai/flux/schnell` as the primary path.** Fastest measured
  (~0.3–0.7s end-to-end), recognizable output, ~$0.003/image, and it
  silently snaps invalid sizes for you.
- **Generate at ≥512px, then downscale locally** to the target size
  (sub-millisecond via `sharp`/ImageMagick). Never request <512 natively —
  quality collapses below the model's training resolution.
- **Keep a Together AI key as the multi-model bench** — one key, ~25 image
  models (FLUX.2, Gemini, gpt-image, Seedream, Imagen, Qwen, SDXL) on one
  `/v1/images/generations` endpoint. Slower (~0.8–1.5s) and rate-limited, but
  unbeatable for A/B-ing models.
- **Model choice dominates quality.** `fast-sdxl` and `flux/schnell` are the
  same speed class (~1s) but only flux produces usable images. Don't pick a
  "fast" model without checking output.

Env vars (paid external dependency — **never commit keys**):
`FAL_KEY`, `TOGETHER_API_KEY`.

---

## Model picks (decision matrix)

The one-line policy: **fal.ai `flux/schnell` at ≥512 → downscale locally**, with
`flux/dev` as the quality escalation and Together AI as the model bench.

| Job | Model | Provider | Why |
|---|---|---|---|
| **Default / workhorse** | `flux/schnell` | fal.ai | Best speed-for-quality measured: ~0.5s, recognizable, $0.003/img. Same speed class as fast-sdxl but actually usable. |
| **Quality / hero images** | `flux/dev` (28 steps) | fal.ai | Cleanest output, ~1s, ~$0.025. Use only when schnell isn't crisp enough. |
| **Multi-model A/B + future-proofing** | catalog: `FLUX.2`, `gemini-3-pro-image`, `gpt-image-1.5`, `seedream-4`, `imagen-4`, `qwen-image` | Together AI | One key, ~25 models, one endpoint. For evaluation, not the hot path. |
| **Cost-critical batch (later)** | `flux/schnell` | Runware | ~$0.0006/img — 5× cheaper if we ever bulk-generate. |
| **Avoid** | `fast-sdxl` | — | Same speed as flux/schnell, produces abstract blobs. No reason to use it. |
| **Avoid for latency** | `gemini-2.5-flash-image`, `gpt-image-1` | — | ~5–40s. Fine for a deliberate async action; wrong for anything snappy. |

**Untested, evaluate next:** `FLUX.2 [klein]` (newer, sub-second — may beat
schnell) and `Z-Image-Turbo`. Both available on Together, so cheap to A/B when
we get there.

---

## The problem: fast, small raster out

OpenCues' text blanks resolve in well under a second. The hope was a raster
image could ride a similar path. Three approaches were tested; the first two
are dead ends.

### Dead end 1 — LLM emits base64 of a PNG/JPEG

A text model *could* in principle print the base64 of a tiny image. It can't.
PNG pixel data is zlib/DEFLATE-**compressed** and every chunk carries a
**CRC32 checksum**; JPEG/WebP/GIF are similarly compressed/checksummed. An LLM
can't run DEFLATE or compute a CRC in its head, so it emits plausible-looking
bytes that fail to decode.

Measured: `gemini-3.1-flash-lite` → `CRC FAIL on IDAT`; `gpt-5.4-mini` →
`truncated IDAT chunk`. **Size is irrelevant** — a 5×5 fails the same way. The
format internals, not the dimensions, are the wall.

(SVG *does* work — it's text-native markup, no compression/checksum. Both
models emitted valid `<svg><rect/></svg>` in ~1s. But SVG is vector, not
raster. If vector output is acceptable, "fast model → SVG → rasterize locally"
is a real path. For raster, it isn't.)

### Dead end 2 — LLM emits an uncompressed raster format (PPM/Netpbm)

PPM P3 is plain ASCII, no compression, no checksum — so a fast model *can*
emit valid pixels. But raster is inherently **O(pixels)** and an LLM is
**O(tokens)**:

| Target | Result (cerebras gpt-oss-120b) | Tokens |
|---|---|---|
| 8×8 | ✅ valid → local PNG encode in 2ms | 1457 |
| 16×16 | ❌ blew the 4000-token cap mid-stream | maxed |
| 50×50 | ❌ blew the 16000-token cap, truncated | maxed |

Works only at sprite scale (~8×8). Token cost explodes with pixel count and
reliability collapses by 16×16. Not "efficient" by any measure.

### Dead end 3 (slow, not wrong) — omni/chat image models

These produce real raster but are slow and size-inflexible:

| Model | Latency | Size behavior |
|---|---|---|
| `gemini-2.5-flash-image` | ~5s | **fixed ~1MP**; ignores requested size (asked 512/128 → got 1024²); only `aspectRatio` honored |
| `gemini-3-pro-image-preview` | 14s (1K) / 19s (2K) / 30s (4K) | resolution tiers, no small option |
| OpenAI `gpt-image-1` | 9.5s (low) / 19s (med) / 41s (auto) | 1024 min |

~5s is the *floor* here — 10–50× the text blanks. Can't ride a keystroke; would
have to be an explicit async, spinner-backed action. **Not** the fast/small
path we wanted.

---

## What works: fast image-inference services

The category that delivers fast small raster is **few-step distilled diffusion
models on serverless GPU hosts**. No single dominant "Cerebras of image gen" —
it splits by what you optimize for:

| Provider | Best at | Notes |
|---|---|---|
| **fal.ai** | **Speed** | Custom CUDA kernels, sub-second on FLUX. Our primary. Snaps invalid sizes silently. |
| **Together AI** | **Model breadth** | One key, ~25 image models. Slower, rate-limited, strict /16 sizes. |
| **Replicate** | Biggest catalog (1000+) | General-purpose, not speed-tuned. |
| **Runware** | **Cheapest** (~$0.0006/img) | Volume economics; consider if we ever batch. |
| **WaveSpeedAI** | Exclusive models + 99.9% SLA | Seedream/Kling/WAN. |

Authoritative live head-to-head:
<https://artificialanalysis.ai/image/providers/flux-1-schnell>

---

## Benchmarks (measured in our environment, June 2026)

Prompt: *"a round marble-top cafe table with slim black metal legs, single
object, centered, isolated on a plain white background, clean minimalist
product illustration"*. Model: `flux/schnell`, 4 steps, seed 7, generated
natively at each size. Sample images in `~/table-review/` (local, not committed).

### fal.ai — `fal-ai/flux/schnell`

| Requested | Got (snaps /16) | End-to-end | Server inference |
|---|---|---|---|
| 100 | 96×96 | 689 ms | 0.051 s |
| 200 | 192×192 | 655 ms | 0.053 s |
| 300 | 288×288 | 445 ms | 0.055 s |
| 400 | 400×400 | 322 ms | 0.062 s |
| 500 | 496×496 | 359 ms | 0.068 s |

**Key finding: end-to-end does NOT scale with size** (~0.3–0.7s across the
board). Server inference is flat ~0.05–0.07s; the variance is network/queue
overhead. The 100px was slowest only because it was the cold first call.
**Size is a quality decision, not a speed one.**

### Together AI — `black-forest-labs/FLUX.1-schnell`

| Target | Req (snapped /16) | Got | End-to-end |
|---|---|---|---|
| 100 | 96 | 96×96 | 1271 ms |
| 200 | 208 | 208×208 | 1208 ms |
| 300 | 304 | 304×304 | 1545 ms |
| 400 | 400 | 400×400 | 819 ms |
| 500 | 496 | 496×496 | 1345 ms |

~2× slower than fal. **Two integration gotchas:** rejects non-multiple-of-16
sizes with HTTP 400 (`height must be a multiple of 16`) — fal snaps silently;
and rate-limits aggressively (HTTP 429 on back-to-back calls — needed ~3s
spacing + exponential backoff to complete the batch).

> The advertised "free FLUX.1-schnell tier" did **not** apply:
> `FLUX.1-schnell-Free` is no longer serverless (needs a dedicated
> deployment). The working model is the standard **paid** `FLUX.1-schnell`.

### Model-quality comparison (512px, same prompt)

| Model | Latency | Quality |
|---|---|---|
| `fal-ai/fast-sdxl` | ~1.1–1.3s | ❌ abstract blobs — unusable |
| `fal-ai/flux/schnell` | ~0.67s | ✅ clean table |
| `fal-ai/flux/dev` (28 steps) | ~1.07s | ✅ cleanest |
| Together `FLUX.1-schnell` | ~0.95s | ✅ clean table |

`fast-sdxl` was *faster-class but produced garbage*. flux at the same speed
produced clean output. **This is why model choice matters more than steps/size.**

---

## Model quality issues — why fast-sdxl failed and flux didn't

Diffusion models generate by **iteratively denoising** random noise toward an
image over many steps (normally 25–50). Three things observed in testing, and
their causes:

### 1. Few-step distillation collapse (the fast-sdxl blobs)

`fast-sdxl` is *distilled* to run in 1–4 steps (that's why it's fast/cheap). At
4 steps it has almost no room to converge. For prompts outside its comfort
zone — like a flat illustration — it **collapses into texture/blob noise**
because it runs out of denoising passes before forming a coherent object. Not
broken; just under-stepped. `flux/schnell` is *also* ~4-step distilled but a
newer, stronger architecture (rectified-flow transformer, Black Forest Labs)
with much better few-step distillation, so 4 steps converges cleanly.
**Takeaway: "fast" is not one quality tier — pick the model by output, not by
its speed label.**

### 2. Sub-training-resolution collapse (the 0.1 KB blank returns)

Models are trained at a native resolution (SDXL ~1024², classic SD ~512²). Ask
for 96×96 and the model is far out-of-distribution — the latent grid is too
small to hold coherent structure, so output degrades and sometimes **collapses
to near-uniform** (we saw 2/5 calls return ~0.1 KB blanks at 96px). This is
*the* reason for the rule: **generate at ≥512 and downscale locally.** The
downscale looks lossless and is free; you sidestep the collapse entirely.

### 3. VAE-factor size constraints (the snapping / 400 errors)

Denoising happens in a compressed **latent**, produced by a VAE that
downsamples by a fixed factor (SDXL 8×, flux 16×). Dimensions must be divisible
by that factor or the latent grid doesn't tile. So 100 → 96/112. **fal snaps
silently; Together rejects with a 400.** Same constraint, different ergonomics.
A helper should snap to the model's factor before calling.

### 4. Why you can't just "turn up quality"

- **Steps:** on distilled models (schnell/turbo) more steps barely helps and
  can hurt — they're trained for a fixed tiny step count. Quality comes from
  choosing `dev`/`pro`, not cranking steps.
- **Guidance (CFG):** turbo/lightning/schnell are *guidance-distilled*, so the
  usual prompt-adherence knob is baked in and largely inert. Steer with the
  prompt and the model choice, not CFG.

---

## The recipe

```
1. Choose model by quality: flux/schnell (fast+good) or flux/dev (slower, best)
2. Generate at 512×512 (or the model's native res), steps=4 for schnell
3. Snap width/height to the VAE factor (16 for flux, 8 for sdxl) before calling
4. Use sync_mode (fal) / b64_json (Together) to get bytes inline — no download
5. Downscale to the target size locally (sharp / ImageMagick) — sub-ms
6. Pin a seed for reproducibility
```

### fal.ai request

```
POST https://fal.run/fal-ai/flux/schnell
Authorization: Key $FAL_KEY
Content-Type: application/json

{ "prompt": "...", "image_size": "square", "num_inference_steps": 4,
  "format": "png", "sync_mode": true, "seed": 7 }
```
- `image_size`: preset (`square`=512², `square_hd`=1024², `portrait_*`,
  `landscape_*`) **or** custom `{ "width": N, "height": N }`.
- `sync_mode: true` → image returned inline as a `data:` URI (skips the ~0.5s
  hosted-file download).
- Response: `{ images: [{ url, width, height }], seed, timings: { inference } }`.

### Together AI request

```
POST https://api.together.xyz/v1/images/generations
Authorization: Bearer $TOGETHER_API_KEY
Content-Type: application/json

{ "model": "black-forest-labs/FLUX.1-schnell", "prompt": "...",
  "width": 512, "height": 512, "steps": 4, "n": 1, "response_format": "b64_json" }
```
- `width`/`height` **must be multiples of 16** (400 otherwise).
- Expect HTTP 429 on bursts — space calls and back off.
- Response: `{ data: [{ b64_json | url }] }`.
- `GET https://api.together.xyz/v1/models` lists the ~25 serverless image
  models (swap the `model` string to A/B FLUX.2 / Gemini / gpt-image /
  Seedream / Imagen / Qwen / SDXL on the same endpoint).

---

## Cost

| Model / provider | Per image | Notes |
|---|---|---|
| fal `flux/schnell` | **~$0.003** | $0.003/MP, **1 MP minimum** → flat for all sub-1MP sizes (100–500px all cost the same) |
| fal `fast-sdxl` | ~$0.0009 | cheaper but unusable quality |
| fal `flux/dev` | ~$0.025 | ~8× schnell; best quality |
| Runware `flux/schnell` | ~$0.0006 | cheapest at volume |
| Gemini flash-image | ~1290 tokens/img flat | size-independent |

Cost, like speed, is **flat across 100–500px** for flux/schnell (everything
rounds up to the 1 MP minimum). fal's balance API lags several minutes, so
instant before/after polling reads stale — measure cost over a batch or trust
the published rate.

---

## Caveats / gotchas (learned the hard way)

- **fal balance API lags** — `GET https://rest.alpha.fal.ai/billing/user_balance`
  doesn't reflect spend for minutes. Don't use it for instant cost deltas.
- **Together rate-limits hard** on the standard tier — back-to-back calls 429.
  Any real integration needs spacing + retry/backoff.
- **Together requires /16 sizes**, fal auto-snaps. Snap client-side to be safe.
- **Never request <512 natively** — blank/garbage returns below training res.
- **`fast-sdxl` is a trap** — same speed as flux/schnell, garbage output.
- **The "free" Together tier wasn't free** — `*-Free` model ids need dedicated
  deployments now.

---

## Efficiency model — cost, classify latency, and the gate

An "always-on image generator" sounds expensive; the design makes it cheap by
**gating every costly call behind a near-free classifier, and firing only on the
explicit `_` keystroke.**

### Cost per action

| User action | Calls | Cost |
|---|---|---|
| Normal text ending in `_` (not an image) | 1 classify | **~$0.0001** (≈ free; CEDE, no image call) |
| Generate an image | 1 classify + 1 generate | **~$0.003** |
| Edit an image | 1 classify + 1 edit | **~$0.02** |

The only spend that scales is the image call itself, and it fires **once per
deliberate request**, at the cheapest model/size that works. Everything around
it (trigger, classify, storage, sizing) is built to add ~zero cost:

- **`_`-gating = explicit consent.** Nothing runs on other keystrokes — no
  polling, no speculative/background generation. The `_` is the user's "yes."
- **Cheap gate protects expensive calls.** The classifier (~$0.0001, ~0.3 s)
  decides whether to spend the $0.003/$0.02. A misfire costs a hundredth of a
  cent, not an image. Same shape as the blank-intent gate.
- **One call resolves intent *and* target** (ordinal/descriptor) — no second
  round-trip. Image calls are single-shot (no multi-pass).
- **Smallest viable size.** Edits run at the **256 master** (the benchmarked
  floor), not 1024. Generate at 512, downscale locally (free), never pay for
  1024 unasked.
- **Ephemeral = zero infra.** Masters live in memory, dropped on reload — no
  storage, DB, or CDN cost between sessions.
- **Cerebras prefix-caching** keeps the classifier's big stable system prompt
  cached, so each classify only processes the short user text.
- **Failures cede, don't retry-spam.**

### Classify latency (measured)

~0.25–0.45 s warm (cerebras gpt-oss-120b, prefix-cached) — e.g. 257/281/293/454
ms in harness runs. It's **sequential before** the image call (you need the
verdict first), so it adds ~0.3 s:

- generate ≈ 0.28 s classify + 0.8 s gen ≈ **~1.1 s**
- edit ≈ 0.28 s classify + 1.8 s edit ≈ **~2.1 s**

That ~0.3 s is the **price of language-invariance**. The keyword alternative
("draw"/"image:") is ~0 ms but English-anchored — explicitly rejected (cf. the
`model_override` removal and the ConfigIntent language-invariant boundary).

### The classifier: standalone in the harness, shared in the real thing

> ⚠️ **The harness uses its OWN standalone classifier** (a fresh cerebras call
> in `research/image-gen-demo/server.mjs`). It does **not** touch the runtime's
> classifier infra — it's a prototype outside the resolver.

OpenCues already has this classifier family, and image-intent should **join**
it, not duplicate it:

- `BlankIntentClassifier` (blank-intent gate)
- `ConfigIntentSource` (fluid-config — semantic `_` → settings)
- `FluidBlankSource` / `TransformBlankSource` (semantic `_` lookups / rewrites)

These already classify `_`-triggered text, already pay the ~0.3 s, already use
the cerebras-cached pattern and the shared keyword-window + cede discipline. So
the real question isn't "is the classify cheap" but **"should image-intent share
the existing classification pass or get its own call?"**

- **Share the pass:** one classify decides fluid-blank / config-change /
  image-gen / edit / … → ~zero *new* latency (the runtime is already classifying).
- **Its own call:** isolates the prompt, but adds a round-trip.

**Open decision (validate on the bench):** widening one classifier's job risks
recall — we saw SUMMON-in-classifier drop −24 pp until split into its own call
(the "one job per call" lesson). So share-vs-split is a real trade-off to
measure, not assume. The harness sidesteps it by being standalone.

## Cross-medium delivery (the output ladder)

The image-blank works on more than rich-DOM hosts. The feature is identical
everywhere — `_`-gate + classifier + generate/edit are unchanged — **only the
last-inch *delivery* differs per host.** Think of it as a capability,
`imageOutputMode() → insert | clipboard | path`, that degrades gracefully.

**Key correction (June 2026):** CC, OpenCode, and gemini-cli all accept
**Ctrl+V image paste**, so they are NOT text-only input surfaces. The generated
image can become a real multimodal attachment on the outgoing message, not just
a text reference. The terminal hosts move *up* the ladder.

| Medium | Real image? | Delivery |
|---|---|---|
| chrome contenteditable / web rich editors | ✅ inline | `insertImage` DOM node (binary sidecar) |
| **Claude Code / OpenCode / gemini-cli** | ✅ yes | **file-path injection** (default) or **clipboard** — both ingest as a real image |
| markdown-aware web inputs | ✅ rendered | `![](path)` text substitute |
| Android (accessibility service) | ⚠️ partial | path / clipboard, app-dependent (`commitContent` not generally reachable) |

### Two delivery mechanisms for the Ctrl+V hosts

**(a) File-path injection — DEFAULT for CLI hosts.** Generate → temp file →
inject the path as text → the host resolves the path to a real image attachment.
- Rides the **existing text-substitute pipeline** — no binary sidecar, no
  clipboard platform code.
- These CLIs already resolve image paths / `@file` refs to real images, so it's
  a full image input, not a degraded text experience.
- The file persists → free reload-survival + the agentic host can `Read` it
  (a generated image becomes a tool input, e.g. `draw a diagram _`).

**(b) Clipboard delivery — optional, richer, fiddlier.** Generate → write PNG to
the system clipboard → host's native Ctrl+V ingests.
- Platform-specific clipboard-image plumbing (Linux `wl-copy`/`xclip`, macOS
  `osascript`, **WSL→Windows is genuinely awkward**), plus the
  synthesize-paste-vs-ask-user question.
- Use only where the platform clipboard-image path is reliable.

**Recommendation:** path-injection as the default CLI delivery (robust,
portable, reuses existing machinery, agent-consumable); clipboard as an opt-in
richer mode; inline-insert for chrome. Almost every host lands on a real-image
rung — the text-only fallback is rarely the endpoint.

### Editing across mediums

The edit reference generalizes: the DOM node (chrome) / the path or
last-pasted attachment (CLIs). kontext-dev runs on the master → re-deliver:
**overwrite the same file** so the path/link stays stable (any renderer shows
the new image), or write a new path and update the substitute text.

### Per-medium persistence asymmetry (deliberate)

The "ephemeral, no reload survival" decision was a **chrome** decision
(in-memory master). On **file-path hosts the file *is* the master**, so edits
survive naturally. This asymmetry is intentional, not accidental — document it
per host so a future change doesn't "fix" one to match the other by mistake.

### Verify before implementing

- [ ] Confirm CC / OpenCode / gemini-cli each ingest a generated PNG **by file
      path** (not only interactive Ctrl+V) — the path-injection default hinges
      on this. (Drag-drop / `@file` / paste-of-path behaviors differ per host.)
- [ ] Decide synthesize-paste vs ask-user for any clipboard delivery.
- [ ] Prefer the host's *normal* ingest paths over calling internal image-attach
      functions directly (seam-anchor fragility across host upgrades).

## Experimenting on other platforms (post-chrome)

**Chrome is the reference implementation; every other host is tested *after* it.**
Reason: only the **delivery rung** changes per host (see Cross-medium delivery
above) — the whole core (`_`-gate, classifier, generate/edit, blank loader,
session masters, lifecycle logging) is shared and gets proven on chrome first.
So per-host work is small and mostly about *delivery* + confirming the shared
core carries over. We can't test the others yet because each needs its adapter
band + the delivery code, and we want chrome to factor out the shared core first.

### What's already proven (don't re-test per host)

The harness validated, host-agnostically: classifier (language-invariant),
generate (flux/schnell→256 master→display), edit (kontext-dev, ≥256 floor),
target resolution (ordinal / cursor-adjacency / select), ephemeral masters,
the real blank loader, and the 15-point lifecycle log. Per-host experiments
assume these and test only what's host-specific.

### Stage 0 — capability probe (manual, NO OpenCues code) — do this first

The single highest-value step per host, and it needs no integration code: find
out **how the host's input accepts an image.** Generate a PNG to a file (the
harness or a one-off fal call does this), then in the *real* host try each
ingestion method and record which yields a genuine image attachment:

| Host | Ctrl+V clipboard image | type/paste a file path | `@file` reference | drag-drop |
|---|---|---|---|---|
| Claude Code | ? | ? | ? | ? |
| OpenCode | ? | ? | ? | ? |
| gemini-cli | ? | ? | ? | ? |
| shell (OpenTUI) | ? | ? | ? | ? |
| Android | ? | ? | ? | ? |

Fill this in by hand. The winning column is that host's **default delivery
rung** (we expect file-path for the CLIs; verify, don't assume — it's the
load-bearing assumption from Cross-medium delivery). This probe can even run
before chrome is done — it's pure host behavior.

### Stage 1–4 — per-host experiment sequence (after chrome ships)

1. **Delivery wiring (minimal).** Implement only the winning rung from Stage 0
   (path-injection first). Reuse the chrome core unchanged; the host adapter
   gets `imageOutputMode()` + the deliver call (write file / set clipboard /
   insert path). Nothing else should change.
2. **Generate experiment.** `a red apple _` → confirm a real image lands in the
   host's input (attachment or rendered), and that the **base blank loader
   renders** in that host (terminals already animate the `_` for text blanks —
   confirm it reuses that, doesn't reinvent).
3. **Edit experiment.** Establish the host's image *reference* (path / last
   attachment), then `make it blue _` → confirm kontext-dev runs on the master
   and re-delivery updates the right image. Note the per-medium persistence
   (file-based hosts: the file *is* the master → edits survive; that asymmetry
   is intentional).
4. **Loader + log verification.** Confirm the lifecycle emits via `adapter.log`
   with a `[<host>][imggen]` prefix into `/tmp/opencues.log` (the harness's
   `clog` phases are the exact line set). Grep `[imggen]` per host to compare
   traces against chrome's known-good run.

### Per-host notes / unknowns to resolve during the experiment

- **Claude Code / OpenCode / gemini-cli** — accept Ctrl+V images (confirmed by
  the user); expected default = **file-path injection**. Open: does each ingest
  a *path* (not just interactive paste)? Does the terminal render a preview, or
  is it attach-only? Bonus: the generated file is `Read`-able by the agent.
- **shell (OpenTUI)** — same OpenTUI base as OpenCode; expect similar behavior,
  but confirm OpenTUI's input accepts an image path / clipboard at all.
- **Android (accessibility service)** — hardest. Text-field injection is
  text-only; `commitContent` image insertion is app-specific. Expect to land on
  **path or clipboard**, app-dependent — probe several target apps, don't
  generalize from one.
- **Loader on terminals** — the braille-rotate glyph already animates for text
  blanks on CC/OC/gemini; the image loader must reuse that exact path, not a new
  animation. Verify, since this demo only proved it visually in a browser.

### Record results back here

After each host's experiment, fill the Stage-0 table and add a one-line verdict
(rung chosen, render-vs-attach, edit-persistence) so the matrix becomes the
real cross-host capability map instead of the current "expected" one.

### Harness → real-adapter gaps (carry these into the chrome impl)

The prototype is minimal/sufficient for proving logic, but two simplifications
must be fixed when promoting (they don't affect the experiment plan, only the
real code):

- **Single-text-node command parsing.** The harness reads the command from one
  caret text node; a real contenteditable line can span nodes (text after an
  inline image). The adapter must resolve the command range across nodes.
- **`fast-sdxl` model option** is comparison-only (deliberately bad output) —
  drop it from any shipped surface; it exists in the harness to show contrast.

## Integration notes for OpenCues (future)

Nothing in the runtime calls image endpoints today — all providers in
`packages/opencues-core/src/llm-provider.ts` are text/chat. To wire image-gen
in:

1. A small `generateImage(prompt, { size, provider })` util — fal default,
   Together fallback, with VAE-factor snapping + 429 backoff baked in.
2. A provider entry / key plumbing (`FAL_KEY` / `TOGETHER_API_KEY`) mirroring
   how text providers read keys.
3. An image-blank surface if we want `_`-triggered generation — but note the
   latency class (~0.3–5s depending on provider/model) means it's an explicit
   async action with a spinner, **not** a keystroke-path blank. See the
   "no logical landmines" discipline — a slow/failed image call must never
   block or corrupt the buffer.

Sample scratch scripts used for this research (local, not committed):
`/tmp/falimg.mjs`, `/tmp/faltables.mjs`, `/tmp/togtables.mjs`,
`/tmp/b64gen.mjs`, `/tmp/ppm2.mjs`. Sample outputs in `~/table-review/`.

---

*Last updated: June 2026 — research branch `research/image-generation-notes`.*

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

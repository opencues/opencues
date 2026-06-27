# Image-gen integration prototype (research harness)

A runnable stand-in for the real OpenCues image-blank, used to observe the
**integration side effects** (async insert, cancel-on-edit, undo, sizing,
failure handling) without touching any host adapter. Part of the
`research/image-generation-notes` branch — not shipped.

## Run

```bash
source ~/.bashrc                       # loads FAL_KEY (server-side only)
node research/image-gen-demo/server.mjs
```
Open <http://localhost:8788> (WSL2 forwards localhost to the Windows browser).

## Try

In the input box, type a trigger ending in `_`:
- `draw a red apple _`
- `image: sunset over water _`

The trigger text is removed, a spinner placeholder appears in place, and the
image is generated (fal) and inserted. You can also paste an image directly.

## Side effects to watch (the point of this harness)

- **Latency** — ~0.5–1 s for flux/schnell; the placeholder is the UX bridge.
- **Type-during-generation** — keep typing after the trigger; the caret moves
  past the placeholder and your text is preserved (no buffer corruption).
- **Cancel-on-edit** — delete the placeholder before it resolves; the result
  is discarded (logged), nothing is inserted.
- **Failure** — pick `fast-sdxl` or kill the network; the placeholder becomes
  an inline `[image failed: …]`, surrounding text untouched (no landmine).
- **Quality** — switch the model dropdown: `flux/schnell` good, `flux/dev`
  best/slower, `fast-sdxl` deliberately bad (abstract blobs) for contrast.
- **Sizing** — generate at 512, downscale locally to 100/200/300px on insert.
- **Undo** — Ctrl+Z behavior on the inserted image is an observed side effect
  (contenteditable may not make it a single step — note what it does).
- **Cost** — running tally in the corner (~$0.003/img on flux/schnell).

## What this proves / doesn't

Proves the insert-mechanics + async-flow that the real chrome adapter would
need. Does **not** touch `HostAdapter` / `setText` / the resolver — promoting
this into the real extension means adding `supportsImageInsert()` +
`insertImage()` to the adapter contract and an `ImageBlank` source, gated to
rich-DOM hosts only. See `docs/guides/image-generation.md`.

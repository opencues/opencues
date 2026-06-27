# Image-gen integration prototype (research harness)

A runnable stand-in for the OpenCues image-blank — **generate + edit** with the
agreed design — used to observe integration side effects without touching any
host adapter. Part of `research/image-generation-notes`; not shipped.

## Run

```bash
source ~/.bashrc                       # FAL_KEY + CEREBRAS_API_KEY (server-side only)
node research/image-gen-demo/server.mjs
```
Open <http://localhost:8788>.

## Design realized here

- **Language-invariant intent.** Every `_`-terminated phrase is classified by a
  fast LLM (cerebras gpt-oss-120b) into `GENERATE | EDIT | CEDE` — no keyword
  list. Works in any language ("dessine…", "リンゴを緑にして").
- **Generate** → fal `flux/schnell` @512 → a **256 session master** → display
  copy at the chosen px, inserted where the command was (command text wiped).
- **Edit** → fal `flux-kontext/dev` on the target's 256 master → replace in
  place (the ≥256 floor: edits below collapse).
- **Targeting (precedence):** explicit reference from the classifier
  (`make the first one… ` / "the apple one") → cursor-adjacency → else cede.
  Click an image to force-select it as the target.
- **Two+ images:** keyed session registry; ordinals come from DOM order; the
  classifier resolves "first/second/the-X-one" against the image labels.
- **Ephemeral masters:** held in memory only. **Clear/Submit or reload freezes
  every image** (master dropped → edits cede). Nothing is persisted.

## Side effects to watch

- classify latency (~0.3–0.8s) before generate/edit starts (status line shows it)
- generate ~0.5–1s, edit ~2s; type during either — text is preserved
- failure → inline note, surrounding content untouched (no landmine)
- editing a frozen image (after Clear) → cedes with a note
- undo (Ctrl+Z) on an inserted/edited image — observe what contenteditable does
- cost tally (corner): ~$0.003 gen, ~$0.02 edit, classify ~free

## Endpoints

- `POST /classify {text, images:[{ordinal,label}]}` → `{verdict, prompt, instruction, target}`
- `POST /generate {prompt, size, model}` → `{ok, dataUrl, ms, ...}` (inline)
- `POST /edit {imageDataUrl, instruction}` → `{ok, dataUrl, ms, ...}` (inline)

## Not the real integration

No `HostAdapter` / `setText` / resolver. Promotion = `supportsImageInsert()` +
`insertImage()` on the adapter, an `ImageBlank` source feeding the same
classifier, an images provider-bucket, gated to rich-DOM hosts. See
`docs/guides/image-generation.md`.

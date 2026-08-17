# OpenCues for DeepSeek Harness

Word alternatives and `_`-gated blank fill-ins, in the dsh composer.

Type `the capital of iceland is _` and the `_` becomes `Reykjavik`. Type
`i has three cats fix typos _` and the line rewrites itself. Misspell a word
and it is offered back to you, cycled with `Ctrl+Alt+↑`. Nothing is sent
anywhere until you type an `_` or the buffer sits still — and if you never do,
the plugin is invisible.

**No API key required.** By default every call routes through the model dsh
is already configured with, so there is nothing to sign up for.

## Install

```sh
dsh plugin --profile web add @opencues/dsh
```

Reload the tab. That is the whole install: no fork, no patch step, no version
pin, no separate host process. Remove it with
`dsh plugin --profile web remove @opencues/dsh`.

The published package ships prebuilt, so pnpm runs **no install-time build**
and never asks you to allow one. (A `github:` install would — see
[Distribution](#distribution).)

## What you get

| | |
|---|---|
| `_` fill-in | `the capital of iceland is _`, `weather in london _`, `nvidia _` |
| Rewrite | `<your text> fix typos _`, `make it formal _` |
| Word cues | spelling and domain alternatives, cycled with `Ctrl+Alt+↑` / `↓` |
| Sentence cues | a whole-sentence rewrite offered passively; your text is never changed without a keystroke |
| Navigation | `Ctrl+Alt+→` / `←` to step word by word |

`Ctrl+Alt+↑` needs a word activated first — press `Ctrl+Alt+→` to land on one.
Pressing it with nothing active does nothing, by design.

## Which model sees your text

**Settings → Plugins → OpenCues.** Two choices, and the tab states the
trade-off rather than hiding it:

- **Use this app's model** (default) — your text goes to the same model as
  your conversation. No key, nothing to configure. Measured ~1.0s for a
  suggestion.
- **Use my own provider** — routes through OpenCues' own per-bucket settings
  using keys from your environment (`CEREBRAS_API_KEY`, `GROQ_API_KEY`, …).
  Noticeably faster, ~0.3s, which is worth having for cues that appear while
  you type.

dsh's own LLM layer exposes many providers, so a third option is to activate
a fast one **inside dsh** and keep the no-key convenience.

The same tab carries every OpenCues feature setting. Those are written to your
`~/.cues/OPENCUES.md`, the same file the other OpenCues integrations read — so
a change here applies to Claude Code and OpenCode too, not just this tab.

## Configuration

With no configuration at all you get the shipped defaults, baked into the
package. Nothing to install, nothing to seed.

If you have (or want) your own OpenCues config, put it in `~/.cues/` — or
`<your project>/.cues/` for project-scoped cues — and it takes precedence,
per file. See [opencues.com](https://opencues.com) for the config format.

## Credentials

**No API key value ever reaches the page.** That matters more here than on
most hosts: dsh is a plugin host, so the page context is shared with every
other plugin you have installed, and a key handed to the page is a key handed
to all of them.

The config route reports key *names* only, the runtime is handed placeholders,
and a local route substitutes the real secret on the way out — for an
allowlisted https destination only. Stated plainly, because it is not
absolute: another plugin could still ask that route to spend your quota, but
it cannot read the key and use it elsewhere. Exfiltration is the harm being
closed.

## Distribution

Published to npm with the browser bundle and config defaults prebuilt, which
is deliberate. The alternative — installing from git — requires you to add the
package to `allowBuilds` in your profile's `pnpm-workspace.yaml`, and that is
**permission to execute the package's code on your machine at install time**,
outside any sandbox. We would rather not ask for it, so we ship artifacts.

Building from a checkout of this repo instead:

```sh
pnpm install
pnpm --filter @opencues/dsh build          # writes client.js + default-opencues.md
dsh plugin --profile web add /path/to/opencues/integrations/dsh
```

### Shipping a release of this plugin

Four steps, and **only the first is inside this repo** — the rest are npm, a
GitHub repo setting, and an external PR, so none of them can be carried by a
pull request here. That is exactly why they are written down.

1. **Bump + changelog** — `integrations/dsh/package.json`, root `CHANGELOG.md`.
2. **Publish** — `cd integrations/dsh && npm publish`. `prepublishOnly` runs
   `build.mjs`, so the tarball carries `client.js` + `default-opencues.md`
   prebuilt. Verify with `npm pack` first: it should list exactly
   `client.js`, `index.js`, `package.json`, `default-opencues.md`,
   `cordis.patch.yml`, `README.md` and declare **no `dependencies`**.
   Publishing prebuilt is what lets users skip pnpm's `allowBuilds`
   build-approval prompt.
3. **The `dsh-plugin` GitHub topic** on `opencues/opencues`. This is the one
   discoverability mechanism dsh itself endorses (their README) and the one
   the community aggregators auto-collect from — dshmarketplace.dev indexes
   the whole topic. A monorepo is fine; the topic lives on the repo, not the
   subdirectory.

   ⚠ **Fix the repo description in the same pass.** Auto-collected listings
   quote it verbatim, and it currently names Claude Code / OpenCode / Gemini
   CLI / shell / Chrome and *not* DeepSeek Harness — so the topic alone would
   publish us to a dsh registry with a description that never mentions dsh.
4. **`awesome-dsh-plugin`** (optional, but it is what several registries and
   the in-dsh plugin market read from — ~1000 entries). One YAML file, named
   by their monorepo convention `<owner>__<repo>--<sub-path>.yml`, so for us
   `data/plugins/opencues__opencues--integrations-dsh.yml`, then
   `npm ci && node scripts/generate-readme.mjs` and commit the regenerated
   READMEs alongside it:

   ```yaml
   url: https://github.com/opencues/opencues/tree/master/integrations/dsh
   name: opencues/opencues#integrations-dsh
   category: ui
   description:
     en: Word alternatives and underscore-gated fill-ins in the composer. End a line with _ and it is filled; misspellings are flagged as you type. Routes through the model dsh is already configured with, so it needs no API key.
   ```

   Only `description.en` is required — a maintainer adds the `zh`. `category`
   is one of `ui usage theme model session memory tools browser vision voice
   docs skill workflow git notify dev security remote market fun`; `ui` is the
   composer-surface bucket and the set is explicitly not fixed, so expect a
   maintainer may move it. **Quote any description containing `: `** or YAML
   reads it as a nested key.

   Their stated bar: `dsh.bundle` declared in `package.json` — *"most rejected
   submissions declare only `dsh.client`"*, and we declare both — plus a repo
   at least a day old with 10+ commits, real working code, and **no marketing
   language**, which is why the phrasing above is flat and mechanical.

## Status

First release. Known gaps:

- **Inline notes render as a floating overlay**, not spliced into the line
  the way the terminal hosts do. The note is anchored and theme-aware, but it
  is a box above the text rather than a line under it.
- **Firefox is untested.** The paint uses the CSS Custom Highlight API
  (Firefox 140+); it feature-detects and degrades rather than breaking.
- **dsh is `0.1.0-rc`** and advertises breaking changes. The two contracts
  this builds on are annotated frozen upstream, but expect maintenance.

Implementation notes, host-contract findings and the reasoning behind the
design are in [CLAUDE.md](./CLAUDE.md).

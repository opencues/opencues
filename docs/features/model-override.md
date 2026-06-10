# Model Override (per-call `with <model>`)

Pin a specific LLM provider/model for ONE blank call without changing
your default. Add `with <name>` anywhere in the buffer before `_` and
the next fluid-blank lookup or transform-blank rewrite dispatches
through that target — your `~/.cues/OPENCUES.md` scalars stay
untouched, and the very next `_` keystroke (without `with X`) goes
back to your configured bucket.

```
make formal: the cat sat on the mat with opus _
   → dispatches to anthropic/claude-opus-4-7 for this rewrite only
   → next `_` you type goes back to your configured blanks bucket

atomic number of oxygen with cerebras _
   → fast lookup through cerebras/gpt-oss-120b

write a haiku about typewriters with sonnet _
   → claude-sonnet-4-6 for this one call
```

Always on — there's no `model-override-mode` scalar to enable. Useful
when your default is a fast cheap model but you want to spot-test a
slower or smarter one for one specific prompt without touching config.

---

## What gets matched

The matcher walks every `with <token>` in the buffer and picks the
**last** resolved match (closest to `_` is what you're currently
editing — earlier `with X` tokens are revision history). Resolution
order:

1. **Common aliases** — curated shorthand that maps to a specific
   (provider, model) pair:

   | Token | Resolves to |
   |---|---|
   | `opus` | anthropic / claude-opus-4-7 |
   | `haiku` | anthropic / claude-haiku-4-5-… |
   | `sonnet` | anthropic / claude-sonnet-4-6 |
   | `fable` | anthropic / claude-fable-5 |
   | `claude` | anthropic / (provider default = haiku) |
   | `anthropic` | anthropic / (provider default = haiku) |

   > **Every anthropic-class override (the rows above for opus/sonnet/haiku/fable/claude/anthropic) auto-prefers your Claude subscription when the `claude` CLI is installed.** Falls back to the API otherwise. See [Subscription preference](#subscription-preference).

   | `nano` | openai / gpt-5.4-nano |
   | `mini` | openai / gpt-5.4-mini |
   | `flash` | gemini / gemini-3.1-flash-lite |
   | `gpt-oss` | cerebras / gpt-oss-120b |
   | `llama` | groq / (provider default) |

2. **Provider name** — any registered provider id: `anthropic`,
   `cerebras`, `groq`, `openai`, `gemini`, `openrouter`. Uses the
   provider's `defaultModel`.

3. **Exact model name** — any model in any provider's `knownModels`
   list. `claude-opus-4-7`, `gpt-5.4-mini`, etc. Pinpoint match.

4. **Prefix in a known model** — `gpt-5` resolves to `gpt-5.4` (shortest
   matching wins so you don't land on a more-specific variant by
   accident).

5. **Substring anywhere in a known model** — last-resort. `4-7` finds
   `claude-opus-4-7`.

Unknown tokens (`with fish _`, `with the cat _`) **fall through to no
override** — the call dispatches through your configured bucket as
normal.

---

## Subscription preference

If the `claude` CLI is on your `PATH` (i.e. you have Claude Pro / Max / Team / Enterprise and the desktop CLI installed), **every anthropic-class `with`** routes through your subscription — no API tokens consumed. That covers:

- `with anthropic` / `with claude` — generic, defaults to haiku
- `with opus` / `with sonnet` / `with haiku` / `with fable` — named models
- `with claude-opus-4-7` / `with claude-fable-5` / any full Anthropic model id

If the CLI isn't installed, every one of those calls falls through to the regular Anthropic HTTP API (using your `ANTHROPIC_API_KEY`). The fall-back is automatic and silent.

```
the committee considered the report with opus _
                ↑
   ┌────────────┴───────────────┐
   │  claude CLI on PATH?       │
   ├────────────────────────────┤
   │  YES → claude -p (your sub)│
   │  NO  → api.anthropic.com   │
   └────────────────────────────┘
```

**Non-Anthropic overrides aren't affected.** `with cerebras`, `with gpt-oss`, `with gemini`, `with nano`, etc. always go through their own provider's HTTP path — the subscription only covers Anthropic models.

**Cost trade-off:** subscription calls are bundled in your plan but average 30-100% slower than the API for cue / blank surfaces (no streaming, higher TTFT variance under Anthropic load).

**Controlling it globally.** Set `anthropic-subscription` in `~/.cues/OPENCUES.md`:

| Value | Behaviour |
|---|---|
| `prefer` (default) | Try CLI subscription. Fall back to API when `claude` isn't on PATH. |
| `only` | **Billing safety.** Always use the CLI. If it isn't available the call FAILS rather than silently spending API tokens. Use this when you have a subscription and never want surprise API charges. |
| `off` | Always use the Anthropic HTTP API, even when the CLI is installed. |

```yaml
anthropic-subscription: only   # never silently spend API tokens
```

Hot-reloads — no restart needed. You can also cycle it in-buffer with `opencues settings _` (cycle to `anthropic-subscription`, then cycle the value).

**Per-call escape hatch.** If you want the API path for ONE call without flipping the global scalar, use a non-anthropic override — `with cerebras`, `with gpt-oss`, `with gemini` — for completions where speed matters more than weights.

**No runtime fallback:** if the CLI is installed but auth has expired, or the model isn't on your subscription tier (e.g. Fable 5 outside the 2026-06-09 → 06-22 intro window for non-Pro users), the call surfaces the CLI's error rather than silently retrying through the API. Re-auth (`claude /login`) or pick a different model.

---

## How it interacts with everything else

### `change to X` / `switch to X` syntax still works

The settings-flip syntax doesn't contain `with` — it sails through
fluid-config (the classifier) unchanged:

```
change to opus _              → writes blanks-llm-provider: anthropic
                                 + blanks-llm-model: claude-opus-4-7
                                 to ~/.cues/OPENCUES.md (persistent flip)

make formal X with opus _     → does NOT write OPENCUES.md
                                 dispatches THIS call to opus, then forgets
```

If you want every blank to use opus, use `change to opus _`. If you
want just this one to use opus, use `with opus _`.

### `without`, `with the`, etc.

The token must start with a letter and resolve to a known
model/provider. Regex word-boundary on `with` prevents `without` from
matching. Filler like `with the cat` matches `with` + `the`, but `the`
doesn't resolve to anything — no override fires.

### Cycling after a model-override substitute

Same as any other substitute: the original buffer (including `with
opus`) is held as `alternatives[0]`. Press Ctrl+Alt+Down to revert,
Ctrl+Alt+Up to bring the model-override rewrite back.

### What the LLM actually sees

The `with <token>` substring is **stripped** from the prompt body
before dispatch. The model sees a clean instruction:

| You type | LLM receives | Buffer ends as |
|---|---|---|
| `make formal: X with opus _` | `make formal: X _` | (Opus's formal rewrite) |
| `atomic number of oxygen with cerebras _` | `atomic number of oxygen _` | `8` |

So `with opus` doesn't leak into the rewrite as styling instructions
or noise.

### What's NOT touched

- **`~/.cues/OPENCUES.md` scalars** — `blanks-llm-provider:` /
  `blanks-llm-model:` are NEVER written by the override path.
- **Bucket trust class** — overrides happen at dispatch only. The
  bucket selection that gates `trainsOnInput` providers (today
  `opencode-zen`) still applies to which surfaces can use which
  providers; you can't bypass the consent gate by typing `with
  opencode-zen _`.
- **Fallback chain** — `groq ↔ cerebras` auto-fallback is wired to
  your configured target, not the override. If the override provider
  fails, the call fails (silently retries on next keystroke); it
  doesn't fall back to a peer.
- **Cycling state** — the DynDef's `alternatives[0]` is your original
  text. Down-arrow brings it back literally.

---

## What needs to be set up

Just an API key for whichever providers you want to summon:

```bash
export ANTHROPIC_API_KEY=…    # for opus / haiku / sonnet / claude
export CEREBRAS_API_KEY=…     # for cerebras / gpt-oss
export GROQ_API_KEY=…         # for groq / llama
export OPENAI_API_KEY=…       # for openai / nano / mini / gpt-5
export GEMINI_API_KEY=…       # for gemini / flash
export OPENROUTER_API_KEY=…   # for openrouter
```

If a `with <model>` token resolves but you don't have that provider's
key in env (or in `chrome.storage` for the chrome extension), the
override **silently falls through** — the call dispatches through
your configured bucket and a debug-level log line says why:

```
FluidBlank: model-override skip — no apiKey for provider 'anthropic' (token="opus")
```

No error, no buffer mess. Get the key set, retry.

---

## Where it works

| Integration | Model override | Notes |
|---|---|---|
| Claude Code | Yes | Keys read from env. |
| OpenCode | Yes | Same. |
| Gemini CLI | Yes | Same. |
| Chrome | Yes | Keys read from `chrome.storage` (the popup), forwarded into the resolver. |
| Shell / Terminal | Yes | Built into the runtime; works wherever fluid-blank or transform-blank fires. |

No host-specific config — the override path lives in `@opencues/core`
and every host wires the apiKeys map the same way.

---

## Debugging

While testing, watch the log for the per-call override line:

```bash
tail -f /tmp/opencues.log | grep model-override
```

Expected shape (info level for FluidBlank, debug level for
TransformBlank — TransformBlank uses `this.log` not `this.logInfo`):

```
FluidBlank: model-override → anthropic/claude-opus-4-7 (token="opus")
ConfigIntent: ceding — buffer carries 'with <model>' override token (per-call override path)
```

If the override didn't fire when you expected, possible causes (top
to bottom in likelihood):

1. Token doesn't resolve (try `with anthropic _` or `with claude-opus-4-7 _`).
2. No API key for the matched provider (look for the "skip" log line).
3. The buffer keyword-bound to a different blank
   (e.g. `volume _`, `dictionary _`) — those have higher priority and
   don't read the override.
4. Mode is `off` (`fluid-blank-mode: off` / `transform-blank-mode:
   off` in OPENCUES.md — the source isn't built so the override
   detector never runs).

---

## See also

- [`docs/architecture/model-override.md`](../architecture/model-override.md) — full architecture, resolution table, dispatch path, event shape.
- [`docs/architecture/llm-routing.md`](../architecture/llm-routing.md) — bucket precedence the override slots above.
- [`docs/features/fluid-config.md`](fluid-config.md) — `change to <provider> _` (the persistent flip alternative).
- [`packages/opencues-core/src/model-aliases.ts`](../../packages/opencues-core/src/model-aliases.ts) — the matcher itself.

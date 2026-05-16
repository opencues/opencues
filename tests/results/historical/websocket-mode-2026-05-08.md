# Cross-provider transport bench — Responses API (HTTP/WS) vs chat-completions

**Date:** 2026-05-08
**Trials:** 5 per cell, median reported
**Network:** WSL2 → openai.com / api.groq.com / api.cerebras.ai
**Run:** `pnpm --filter @opencues/core bench:websocket`

## What this measures

Same three OpenCues-shaped workloads × six (model, transport) cells:

| Provider | Model | Transports | Reasoning |
|---|---|---|---|
| OpenAI | `gpt-5-nano` | Responses HTTP + WS | `'minimal'` (rejects `'none'`) |
| OpenAI | `gpt-5.4-nano` | Responses HTTP + WS | `'none'` |
| OpenAI | `gpt-5.4-mini` | Responses HTTP + WS | `'none'` |
| OpenAI | `gpt-5.5` | Responses HTTP + WS | `'none'` |
| Groq | `openai/gpt-oss-120b` | chat-completions HTTP | `'low'` |
| Cerebras | `gpt-oss-120b` | chat-completions HTTP | `'low'` |

Workloads:

- **SINGLE** — one P1-style call. Single round-trip; pure transport overhead.
- **FLUID-CHAIN** — 2 turns (SEGMENT → ANSWER). Chain via `previous_response_id` on Responses API; independent calls on chat-completions.
- **XFORM-CHAIN** — 3 turns (EXTRACT → APPLY → VERIFY). Same chaining mechanic.

For chat-completions transports there's no chaining mechanic — each turn is an independent call. Mirrors how OpenCues' production code uses Groq/Cerebras today.

---

## Results — all models, all workloads

### SINGLE (1 turn)

| Rank | Model | Transport | Median total |
|---|---|---|---|
| **1** | **groq/gpt-oss-120b** | CHAT | **226ms** |
| 2 | cerebras/gpt-oss-120b | CHAT | 386ms |
| 3 | openai/gpt-5.4-nano | WS-RESP | 509ms |
| 4 | openai/gpt-5.4-mini | WS-RESP | 572ms |
| 5 | openai/gpt-5.4-nano | HTTP-RESP | 717ms |
| 6 | openai/gpt-5-nano | WS-RESP | 719ms |
| 7 | openai/gpt-5.4-mini | HTTP-RESP | 816ms |
| 8 | openai/gpt-5.5 | WS-RESP | 1056ms |
| 9 | openai/gpt-5-nano | HTTP-RESP | 1075ms |
| 10 | openai/gpt-5.5 | HTTP-RESP | 1238ms |

### FLUID-CHAIN (2 turns)

| Rank | Model | Transport | Median total | Per-turn medians |
|---|---|---|---|---|
| **1** | **groq/gpt-oss-120b** | CHAT | **419ms** | 261ms, 148ms |
| 2 | cerebras/gpt-oss-120b | CHAT | 531ms | 227ms, 266ms |
| 3 | openai/gpt-5.4-mini | WS-RESP | 936ms | 514ms, 422ms |
| 4 | openai/gpt-5.4-nano | WS-RESP | 938ms | 502ms, 436ms |
| 5 | openai/gpt-5.4-nano | HTTP-RESP | 1563ms | 695ms, 898ms |
| 6 | openai/gpt-5.4-mini | HTTP-RESP | 1564ms | 778ms, 863ms |
| 7 | openai/gpt-5.5 | WS-RESP | 1971ms | 1185ms, 785ms |
| 8 | openai/gpt-5-nano | WS-RESP | 2033ms | 1262ms, 771ms |
| 9 | openai/gpt-5-nano | HTTP-RESP | 2167ms | 1087ms, 1042ms |
| 10 | openai/gpt-5.5 | HTTP-RESP | 2480ms | 1281ms, 1147ms |

### XFORM-CHAIN (3 turns)

| Rank | Model | Transport | Median total | Per-turn medians |
|---|---|---|---|---|
| **1** | **groq/gpt-oss-120b** | CHAT | **549ms** | 193ms, 176ms, 140ms |
| 2 | cerebras/gpt-oss-120b | CHAT | 1481ms | 278ms, 425ms, 717ms |
| 3 | openai/gpt-5.4-nano | WS-RESP | 2029ms | 672ms, 611ms, 668ms |
| 4 | openai/gpt-5.4-mini | WS-RESP | 2160ms | 816ms, 666ms, 575ms |
| 5 | openai/gpt-5-nano | WS-RESP | 2721ms | 950ms, 660ms, 971ms |
| 6 | openai/gpt-5.4-mini | HTTP-RESP | 3072ms | 1008ms, 986ms, 1151ms |
| 7 | openai/gpt-5.5 | WS-RESP | 3183ms | 1162ms, 945ms, 1086ms |
| 8 | openai/gpt-5.4-nano | HTTP-RESP | 3566ms | 1061ms, 1113ms, 1467ms |
| 9 | openai/gpt-5-nano | HTTP-RESP | 4084ms | 1171ms, 1124ms, 1783ms |
| 10 | openai/gpt-5.5 | HTTP-RESP | 4257ms | 1282ms, 1390ms, 1593ms |

---

## Per-model HTTP-RESP vs WS-RESP deltas (OpenAI only)

| Model | SINGLE | FLUID-CHAIN | XFORM-CHAIN |
|---|---|---|---|
| gpt-5-nano (minimal) | −33.1% | −6.2% | −33.4% |
| gpt-5.4-nano | −29.0% | **−40.0%** | **−43.1%** |
| gpt-5.4-mini | −29.9% | **−40.2%** | −29.7% |
| gpt-5.5 | −14.7% | −20.5% | −25.2% |

Every OpenAI model wins on every workload — range −6% to −43%. Smallest WS gain is `gpt-5-nano` FLUID-CHAIN (−6%); biggest is `gpt-5.4-nano` XFORM-CHAIN (−43%).

---

## The headline finding

**Groq is fastest on every workload. Cerebras is solid second. OpenAI Responses + WebSocket is third-or-below.**

Best speedups vs the OpenAI best (mini/nano WS):

| Workload | Groq vs best OpenAI | Cerebras vs best OpenAI |
|---|---|---|
| SINGLE | **2.3× faster** (226 vs 509) | 1.3× faster (386 vs 509) |
| FLUID-CHAIN | **2.2× faster** (419 vs 936) | 1.8× faster (531 vs 936) |
| XFORM-CHAIN | **3.7× faster** (549 vs 2029) | 1.4× faster (1481 vs 2029) |

This is despite Groq + Cerebras running independent chat-completions calls per turn (no chaining mechanic) while OpenAI gets to use the WebSocket cache. The wafer-silicon model speed dominates everything.

For OpenCues' actual production workloads (transform-blank, fluid-blank, agent-rewrite), **groq + gpt-oss-120b stays the right default**. There's no realistic latency case for OpenAI Responses + WS on these workloads.

If you needed OpenAI specifically (capability or compliance reasons), the WebSocket vs HTTP delta is real — 30–43% on transform-blank chains for the smaller models — but it's making the slow path less slow, not catching up.

---

## Cerebras-specific note

Cerebras gpt-oss-120b XFORM-CHAIN had an unusual per-turn pattern: 278ms → 425ms → **717ms**. The other workloads (SINGLE, FLUID-CHAIN) were tight against Groq. The growing per-turn cost on the 3-turn chain is worth noting — possibly cold-cache miss as a different worker picks up turn 3, or token-output growing per turn faster than groq. Worth a re-run on a separate occasion to see if it's stable.

---

## Wire trace — what each transport sends

Captured live for the 3-turn XFORM workload (`gpt-5-nano` for OpenAI, `gpt-oss-120b` for Groq).

### HTTP — Responses API

```
POST /v1/responses                         turn 1: 1595ms
  body: {model:"gpt-5-nano", store:true, input:[<user msg>],
         instructions:"<system prompt>", reasoning:{effort:"minimal"}}

POST /v1/responses                         turn 2: 1157ms
  body: {model, store:true, input:[<new user msg only>],
         previous_response_id:"<turn-1 id>"}

POST /v1/responses                         turn 3: 1813ms
  body: {model, store:true, input:[<new user msg only>],
         previous_response_id:"<turn-2 id>"}
```

### WebSocket — Responses API

```
[OPEN wss://api.openai.com/v1/responses]

send response.create                       turn 1:  939ms
  body: {type:"response.create", model, store:false, input:[<user msg>],
         instructions:"<system prompt>", reasoning:{effort:"minimal"}}

send response.create                       turn 2:  864ms
  body: {type:"response.create", model, store:false, input:[<new user msg>],
         previous_response_id:"<turn-1 id>"}

send response.create                       turn 3:  829ms
  body: {type:"response.create", model, store:false, input:[<new user msg>],
         previous_response_id:"<turn-2 id>"}
[CLOSE]
```

### Groq — chat-completions

```
POST https://api.groq.com/openai/v1/chat/completions     turn 1: 259ms
  body: {model:"openai/gpt-oss-120b", messages:[{role:"system", ...},
         {role:"user", ...}], reasoning_effort:"low", ...}

POST .../chat/completions                                  turn 2: 173ms
  body: <fresh request — no chain mechanic, system+user spelled out again>

POST .../chat/completions                                  turn 3: 140ms
  body: <fresh request again>
```

The Groq path sends the full system + user every turn — no `previous_response_id` equivalent on chat-completions. Yet each turn lands faster than any OpenAI turn. Model-on-hardware speed dominates.

---

## What this means for OpenCues

| Surface | Production-default recommendation |
|---|---|
| Word-cues (1 LLM call per source per text-change) | **Groq + gpt-oss-120b**. 226ms beats every OpenAI option by 2×+ |
| Fluid-blank (P1 SEGMENT → P3 ANSWER) | **Groq**. 419ms total beats best OpenAI (mini WS) 936ms |
| Transform-blank (EXTRACT → APPLY → VERIFY) | **Groq**. 549ms total beats best OpenAI (5.4-nano WS) 2029ms — a **1.5-second** absolute saving on every transform-blank fire |
| Agent-rewrite | **Groq**. Same as SINGLE |
| Auditors (1 composed LLM call) | **Groq**. Same as SINGLE |

**Cerebras gpt-oss-120b is a viable fallback** — within 1.5–2× of Groq on most workloads, comparable model quality, and the existing groq↔cerebras auto-fallback in `withFallback()` already covers transient Groq failures with this model.

**WebSocket mode integration:** only worth adding if a user picks OpenAI for capability reasons (not latency). Not a runtime default. The 30–43% savings on chained workloads is real, but the Groq baseline is so far ahead that even a 50% WS win on every OpenAI call wouldn't change the ranking.

## Note: Groq and Cerebras don't have WebSocket mode for inference

Researched 2026-05-08, twice. **Neither provider offers a WebSocket transport for chat-completions or any equivalent text-inference call.** Two near-misses that look like they could be it:

### Groq

- HTTP only. Endpoints: `/v1/chat/completions`, `/v1/responses`, audio, models, batches. Streaming via SSE.
- Groq ships a `/v1/responses` endpoint (the OpenAI Responses-API surface) but its `previous_response_id` field is documented as **"Not supported. Always null."** — a compat shim, not a real chained API. Without chaining, there's no connection-local state for a WebSocket cache to cache.
- Groq's "Compound" system is just multi-tool orchestration over normal HTTP. Not a transport feature.

### Cerebras

- HTTP only on `/v1/chat/completions`. No `/v1/responses` endpoint listed in the documented surface.
- **Has a `wss://` endpoint, but only via the LiveKit integration** (`inference-docs.cerebras.ai/integrations/livekit`). LiveKit is a WebRTC voice/conferencing platform — that `wss://` URL connects voice agents to LiveKit rooms, not chat-completions. You can't call gpt-oss-120b text generation through it.
- **Cerebras hardware sits behind some OpenAI WebSocket models** (GPT-5.3-Codex-Spark per the OpenAI×Cerebras partnership announcement), but the WebSocket connection terminates at `api.openai.com` — direct Cerebras customers don't get WebSocket access through `api.cerebras.ai`.

### Implication

There is no Groq-WS or Cerebras-WS cell to benchmark. The cross-provider table above is final. If/when either provider exposes a real chat-completions WebSocket transport with a chaining mechanic, this bench script can add the cells with minimal change — `runWs` is generic over endpoint URL.

## Reproducibility

```bash
OPENAI_API_KEY=… GROQ_API_KEY=… CEREBRAS_API_KEY=… \
  pnpm --filter @opencues/core bench:websocket
```

Source: `packages/opencues-core/scripts/bench-websocket-mode.ts`. Toggle `SHOW_WIRE_TRACE = false` at the top to suppress the wire trace; bump `TRIALS` for tighter medians.

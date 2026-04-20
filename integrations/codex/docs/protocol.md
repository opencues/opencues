# Codex ↔ Daemon JSON-RPC Protocol

Wire format between the `opencues-bridge` Rust crate (inside Codex TUI) and the Node-side daemon (`@opencues/runtime`).

## Transport

- **Channel:** stdio of the daemon subprocess. Bridge writes to daemon stdin, reads daemon stdout.
- **Framing:** line-delimited JSON. Exactly one JSON object per line. `\n` is the frame separator. No length prefix needed.
- **Encoding:** UTF-8.
- **Direction:** bidirectional, asynchronous. Either party can send notifications at any time. Requests get matched to responses by `id`.

## Frame shape

JSON-RPC 2.0:

```json
{ "jsonrpc": "2.0", "method": "...", "params": { ... }, "id": 1 }    // request
{ "jsonrpc": "2.0", "result": { ... }, "id": 1 }                       // response
{ "jsonrpc": "2.0", "error": { "code": ..., "message": "..." }, "id": 1 }  // error
{ "jsonrpc": "2.0", "method": "...", "params": { ... } }               // notification (no id)
```

## Methods (bridge → daemon)

### `boot` (request)

Sent once at startup. Daemon initializes ConfigLoader, etc.

```json
{ "method": "boot", "params": {
  "hostVersion": "0.x.x",
  "cwd": "/home/user/some/project",
  "configSearchPaths": ["/home/user/some/project/.opencues", "/home/user/.opencues"],
  "tipsPath": "/home/user/.opencues/tips.json"
}, "id": 1 }
```

Response: `{ "result": { "ok": true } }` once ConfigLoader has loaded.

### `text-change` (notification)

Bridge sends after every text mutation in the ChatComposer. No response expected.

```json
{ "method": "text-change", "params": {
  "text": "the quick brown fox",
  "cursorOffset": 9,
  "source": "user"
}}
```

`source` is `"user"` for user typing, `"runtime"` for daemon-driven writes (cycle results echoed back via `set-text` notification — see below).

### `key` (request)

Bridge sends every key event the daemon might want. Daemon responds with whether it consumed the event.

```json
{ "method": "key", "params": {
  "key": "ArrowUp",
  "modifiers": { "ctrl": true, "alt": true, "shift": false, "meta": false },
  "text": "the quick brown fox",
  "cursorOffset": 9
}, "id": 42 }
```

Response: `{ "result": { "consumed": true } }` if the daemon handled it (e.g. cycled a word). Bridge swallows the event. Otherwise `{ "consumed": false }` and the bridge passes the event through to Codex's normal handling.

### `force-render` (notification)

Bridge requests the daemon re-emit current directives. Used when the TUI redraws and wants the latest state without waiting for a text/key event.

```json
{ "method": "force-render" }
```

## Methods (daemon → bridge)

### `set-text` (notification)

Daemon mutates the buffer (e.g. as a result of cycling). Bridge applies it to the TextArea.

```json
{ "method": "set-text", "params": {
  "text": "the quick red fox",
  "cursorOffset": 9
}}
```

Bridge then sends a `text-change` with `source: "runtime"` so the daemon can reclassify (avoid feedback loops).

### `directives` (notification)

Daemon emits the latest render state. Bridge stores + applies on next paint.

```json
{ "method": "directives", "params": {
  "dim":     [{ "start": 4, "end": 9 }, { "start": 16, "end": 19 }],
  "active":  { "start": 10, "end": 13 },
  "tip":     "color synonym"
}}
```

`dim` ranges are character offsets into the current text. `active` is the highlighted/focused word (single range or null). `tip` is the text shown in the status line.

### `log` (notification)

Daemon-side log line that bridge can route to its own logging (or `/tmp/opencues.log`).

```json
{ "method": "log", "params": { "level": "info", "msg": "ConfigLoader loaded 14 cues" } }
```

## Lifecycle

1. Bridge spawns daemon subprocess (`node ~/.claude/opencues/codex-daemon/index.js` or wherever the install put it).
2. Bridge sends `boot` request, awaits response.
3. Bridge wires up TUI hooks — calls `text-change`, `key`, `force-render` on user activity.
4. Daemon emits `set-text`, `directives`, `log` as appropriate.
5. On TUI shutdown, bridge closes daemon stdin → daemon exits cleanly.

## Errors

Standard JSON-RPC error codes:
- `-32700` parse error
- `-32600` invalid request
- `-32601` method not found
- `-32602` invalid params
- `-32603` internal error

Plus OpenCues-specific:
- `-32000` daemon not yet booted (bridge should retry the request after `boot` resolves)
- `-32001` config load failed (daemon recovers; bridge should surface in TUI)

## Versioning

Protocol version isn't in the wire today — both ends pin to whatever the workspace builds. If we ever ship the bridge crate to crates.io independently of `@opencues/runtime`, add a `protocol-version` field to the `boot` request.

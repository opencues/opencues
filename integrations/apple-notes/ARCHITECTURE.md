# Apple Notes integration — full system structure (for review)

Written 2026-07-09 for cofounder review. Every claim carries a file
pointer. Companions: `notes.md` (bug post-mortems), `NOTES-PLATFORM.md`
(measured platform behaviour), `CLAUDE.md` (invariants),
`docs/architecture/universal-integration.md` (the no-cycling profile).

---

## 1. The direct question first: "there is no memory — why does this
##    happen here and nowhere else?"

Both halves of that sentence are correct, and they are compatible.

**There is no memory.** Nowhere in the stack — this host or any other —
is conversation history stored or fed to the LLM. Every resolution
starts from the current buffer text and nothing else. The resolver
builds its prompt per-call (`packages/opencues-core/src/sources/*`);
the only caches are value caches (blank results, fluid variant pool),
not context.

**The difference is what "the buffer" is.** All hosts run the SAME
runtime, byte-for-byte (`@opencues/{core,runtime}`; this host's boot is
`packages/opencues-runtime/adapters/apple-notes/v1/boot.ts`, wired
through the same `buildSharedRuntime`/`buildBlankContextProvider`
helpers in `boot-common.ts` as OC/shell/gemini). TransformBlank's
contract on every host is: *buffer in → rewritten buffer out*
(`docs/architecture/transform-blank.md`). What differs per host is the
buffer's lifecycle:

| Host | Buffer | Lifecycle |
|---|---|---|
| claude-code | the prompt input box (S1/S2 seams into cli.js) | user presses Enter → submitted → **cleared by the host** |
| opencode | the composer input | submitted → cleared |
| shell (oc-shell) | the tmux input pane | submitted → cleared |
| gemini-cli | the Ink input | submitted → cleared |
| chrome | the focused DOM field | usually submitted/navigated away |
| **apple-notes** | **the entire note** | **persistent document — never cleared** |

On every other host the buffer is EPHEMERAL: each command begins in a
~empty input box because the previous command's text left with the
previous submit. In Notes there is no submit. The note accumulates
every command and answer, so "rewrite the whole buffer" grows without
bound — same code, different substrate. A chrome user composing one
giant Gmail draft and running transform commands inside it would hit
the identical degradation; nobody uses an input field that way, and
everybody uses a note that way.

So: not memory, not divergent host code — a document is not an input
box. Section 7 lists the options that follow from that.

---

## 2. System structure

```
opencues run apple-notes  (aliases: notes, applenotes)
  └─ node integrations/apple-notes/dist/daemon.js       ← single instance (lock: /tmp/opencues-apple-notes.lock)
       │
       ├─ NotesBridge (src/notes-bridge.ts)             ← one osascript spawn per op, JSON over stdout
       │    ├─ jxa/status.js            Notes running?                    (~30ms)
       │    ├─ jxa/list-notes.js        bulk id+mod enumeration           (~90ms @ 343 notes)
       │    ├─ jxa/deleted-ids.js       Recently-Deleted exclusion set    (~90ms, refreshed 10s)
       │    ├─ jxa/fetch-plaintexts.js  plaintext for CHANGED notes only  (~200ms)
       │    ├─ jxa/read-note.js         plaintext+body of one note        (~200ms)
       │    └─ jxa/fill-note.js         CAS write: re-read, byte-compare,
       │                                splice, write — ONE osascript     (~150ms)
       │
       ├─ tick.ts — PURE state machine (49 unit tests, no osascript)
       │    ├─ change detection        selectChanged (modificationDate delta)
       │    ├─ echo classification    lastWriteHash ring (sha256 of our writes;
       │    │                          matching poll content → source 'runtime')
       │    ├─ active-note election   userEditAt: the note the USER last typed in
       │    │                          (never mod-dates — sync/echo can't steal focus)
       │    ├─ id continuity          temp→permanent CoreData id remap ('id-remapped')
       │    ├─ adaptive cadence       150ms hot / 500ms active / 2s idle / 10s paused
       │    └─ line diff              diffLines → minimal changed region
       │
       ├─ daemon.ts — I/O glue
       │    ├─ poll loop              status → deleted-ids → enumerate → fetch
       │    │                          → applyPoll(events) → dispatch to runtime
       │    ├─ FSEvents wake          fs.watch on Notes' group container:
       │    │                          any note write → immediate poll (no sleep)
       │    ├─ virtual buffer         runtime writes land in memory; getText serves
       │    │                          them back BYTE-IDENTICAL (contract, § 4)
       │    ├─ flush pipeline         50ms settle / 150ms max-wait → serialized
       │    │                          doFill: [read] → diff → splice → CAS
       │    │                          outcome: landed | retry(×6 @400ms) | fatal
       │    ├─ arm                    synthetic standalone-`_` KeyEvent (the
       │    │                          resolver's explicit-`_` gate needs
       │    │                          keystroke-shaped evidence)
       │    └─ redispatch             multi-cue notes: after a fill, remaining `_`
       │                               re-dispatched once (dedupe-guarded)
       │
       └─ boot() — packages/opencues-runtime/adapters/apple-notes/v1/
            └─ THE STANDARD RUNTIME, unmodified:
                 Resolver [config-intent, fluid-blank, transform-blank]
                 + BlankFill (keyword/script blanks: stocks, weather, countries…)
                 + blank-context / identity-context (same providers as CC/OC)
                 Universal/no-cycling profile: supportsCycling()=false —
                 word-cues, selector/satellite, list blanks pruned at
                 registration (docs/architecture/universal-integration.md)
```

### Write path (unique to this host — we do not own the document)

Every other integration writes its buffer directly (it owns the input
widget). Here the note belongs to Notes.app, other devices, and iCloud,
so every write is defensive:

1. Runtime writes (animation frames every ~150ms, then the answer) land
   in the **virtual buffer** — never straight to the note.
2. A settle-debounced **flush** takes the latest content, line-diffs it
   against the tracked snapshot, and **splices only the changed lines**
   into the note's HTML body (`adapters/apple-notes/v1/html-text.ts`;
   never a body rebuild — that would destroy formatting/attachments).
   Duplicate cue lines disambiguate by the diff's line index.
3. The write is **CAS-verified inside one osascript call**
   (`fill-note.js` re-reads and byte-compares the body before writing;
   ~150ms race window, measured).
4. The written text's hash enters the **echo ring** so the next poll
   classifies our own write as `source: 'runtime'` (not a user edit).
5. Transient failures (snapshot race with typing, CAS conflict, id
   swap) **retry up to 6× at 400ms**; a user edit always wins and
   cancels the retry.

### Read/detection path

- No key events exist on this platform — that is WHY every other
  integration patches an editor and this one polls. AppleEvents reads
  return Notes' LIVE text (no autosave dependency).
- FSEvents on the group container fires within ~1ms of any note write
  (user autosave, iCloud sync, our own fill) and short-circuits the
  poll sleep; our own osascript READS fire nothing (measured — no
  self-wake loop).
- Measured end-to-end today: detection ~0.3-0.9s, first animation frame
  ~0.9s from note write, script blanks < 1s, LLM answers = detection +
  ~0.5s resolver debounce + model latency (~0.6-1.5s on
  cerebras/gemma-4-31b) + ~0.2s render. Frames at ~6fps (the ~150ms
  osascript CAS is the floor).

---

## 3. What is IDENTICAL to the other integrations

- `@opencues/core` + `@opencues/runtime`: same packages, same builds,
  staged by the same installer pattern as shell (`patches/setup.sh`,
  stage-before-daemon-tsc).
- Source set, routing, prompts, blank registry, blank-context /
  identity-context providers, LLM buckets — all shared. Zero forks.
- The `getText`/`setText` **byte-identity contract**
  (`docs/guides/porting-to-new-integration.md`): the runtime reads back
  exactly what it wrote. This host satisfies it through the virtual
  buffer; canonical forms (trailing `\n`) are applied only on the
  note-write side.
- Boot key bag, statusline file, event bridge, config hot-reload.

## 4. What NECESSARILY diverges, and why

| Divergence | Forced by | Consequence |
|---|---|---|
| Polling + FSEvents instead of key events | Notes has no scripting callbacks / key hooks | detection floor ~0.3-0.9s (others: 0ms — they own the keystroke) |
| Synthetic `_` KeyEvent arming | resolver's explicit-`_` gate expects keystrokes | `tick.ts freshMarkerIndex` decides what counts as "freshly typed" |
| Virtual buffer + splice/CAS writes | we don't own the document; iCloud/devices write concurrently | echo ring, retry ladder, attachment/oversize guards |
| No-cycling universal profile | no key/cursor/render channel | word-cues & cycling pruned; fluid/transform/config-intent + script blanks only |
| Active-note ELECTION | multi-document host: something must pick the buffer | `userEditAt` (the note the user last typed in) — the polled equivalent of "the focused editor" |
| Persistent buffer | a note is a document, not an input box | § 1 — the accumulation property; see § 7 |

## 5. Bug ledger (all found & fixed 2026-07-08/09, each pinned by tests)

Full narratives in `notes.md`; one line each here:

1. **Temp→permanent CoreData id swap** (`t…`→`p…` on UI-created notes)
   read as delete+create, killing in-flight fills. → id continuity
   (`id-remapped`). *The* recurring breaker; invisible to
   AppleScript-based tests (permanent id at birth).
2. **Mod-date active election** let iCloud sync / deletions / echoes
   steal the buffer mid-resolution. → `userEditAt` election.
3. **Virtual buffer normalized the trailing newline before getText**,
   violating byte-identity; the resolver discarded its own completed
   answers. → normalize at flush only.
4. **Splice aborted on duplicate cue lines** (content-only match). →
   diff-line-index disambiguation.
5. **Animation rest-frame re-dispatch** spawned fake user events that
   aborted live resolutions. → dedupe seeded at every arm site.
6. **Recently-Deleted notes stayed enumerated** and competed for the
   election. → exclusion set (90ms JXA, 10s refresh).
7. **One-shot answer writes lost to typing races** ("resyncs next poll"
   was only true for frames). → outcome-based flush retry.
8. **Paragraph window** (shipped + retired same day): scoping the
   buffer to one paragraph fixed accumulation but broke multi-paragraph
   content operations ("prompts only affect lines up to a return").
   Whole-note scope restored by user decision.

## 6. Test & verification posture

- `tick.ts` is pure: 49 unit tests, no osascript (echo, election,
  id-remap, cadence, diff).
- Band tests: 44 (`packages/opencues-runtime/adapters/apple-notes/`,
  incl. html-text splice + scenario tests).
- **Mandatory e2e rule** (learned the hard way, `notes.md`): any
  verification MUST include a UI-created note (⌘N + typing). Notes
  created via AppleScript get permanent ids at birth and are
  structurally blind to the id-swap class.
- Observability: per-fill phase breakdown
  (`settleMs/queueMs/readMs/spliceMs/casMs/totalMs`), `echoMs`,
  poll heartbeat (1/min: ticks, enumerated/excluded/tracked/active),
  byte-level diff detail on every snapshot-mismatch drop.

## 7. Known limitation + the decision in front of us

**Accumulation** (§ 1): with whole-note scope, transform quality and
latency degrade as a single note accumulates commands + answers,
because the model must reproduce the whole document verbatim per
command. Options:

a) **Usage convention (current):** a note per task; short notes stay
   fast and sharp indefinitely.
b) **"Full note in, patch out" (recommended engineering fix):**
   TransformBlank sees the whole buffer but emits only the changed
   region; the resolver's bounded-span splice path still exists for
   exactly this (`docs/architecture/blank-sources.md`). Core change,
   gated on re-running the transform benches
   (`tests/benchmarks/transform-blank/`). Fixes every host, including
   long chrome fields. Est. 2-3 days.
c) Paragraph scoping — tried, retired (§ 5.8): wrong for multi-
   paragraph content.

Secondary quality note: `gemma-4-31b` (current blanks/cues/auditors
model) was never bench-validated for this pipeline; it occasionally
answers imperative drafts as sentence completions and mangles long
verbatim reproductions. `gpt-oss-120b` is the bench-validated,
~2× faster option on Cerebras.

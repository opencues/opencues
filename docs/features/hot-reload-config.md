---
last_updated: 2026-04-05
---

# Feature 15: Hot-Reload Config

Config file changes take effect within ~2 seconds, without restarting the integration.

## Behaviour

All `.md` config files are watched via a TTL cache. When the TTL expires (2s), the next analysis trigger re-parses all config files and rebuilds the resolver. From the user's perspective: save a file, type a word, see the new config.

**What hot-reloads:**
- `cues.md` — tips, prompt sources, ignore list
- `blanks.md` — blank-fill modes, parsers
- `controls.md` — cue-control definitions
- `cues/{name}/cue.md` — folder-based word sources
- `controls/{name}/cue.md` — folder-based controls (adding or removing a folder)

**What does not hot-reload:**
- The cues-core module itself (loaded once at process start)
- The HTTPS connection pool (NodeHttpAdapter — independent of config)
- TTS speed/script path (set at patch-generation time from `~/.tweakcc/config.json`)

## Mechanics

The integration uses a TTL cache rather than file watchers:

1. At startup, `_configLoadedAt = 0` and `_reloadCuesConfig()` runs immediately.
2. On every analysis pass (when the user types), if `Date.now() - _configLoadedAt > 2000` and no LLM request is in flight, `_reloadCuesConfig()` fires.
3. `_reloadCuesConfig()` sets `_configReloading = true`, parses all files into local variables, merges results, then applies atomically to globals — so a failed parse leaves the previous state intact.
4. The resolver is rebuilt and `_resolverGeneration` is incremented. Any in-flight LLM response from the old resolver is discarded when it returns (generation mismatch).
5. `_dynLastAnalyzed` is cleared so all visible words re-analyze against the new config.

## Guarantees

| Scenario | Result |
|----------|--------|
| File saved mid-LLM-call | In-flight result discarded; next trigger uses new config |
| Parse error (broken YAML) | Previous config preserved; retried after next TTL |
| Tip removed from cues.md | Removed from lookup map (rebuilt from scratch, not merged) |
| New `cues/` folder added | Picked up on next reload |
| `controls/` folder deleted | Control word no longer active after next reload |
| Config edited during cycling | Cycling completes with old alts; next analysis uses new config |

## Integration Notes

- The 2s TTL only triggers when the user types. A config change while the user is idle takes effect on the first keystroke after 2s.
- The `_configReloading` flag prevents concurrent analysis during the rebuild window.
- The rebuild is synchronous and fast (~1–5ms for typical configs).

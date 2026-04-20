---
last_updated: 2026-04-02
---

# Adding a New Integration

How to add cues support to a new editor or platform.

## Structure

Create a new directory under `integrations/`:

```
integrations/my-editor/
├── docs/                    # Implementation docs
│   ├── navigation.md        # How navigation works in this editor
│   ├── cycling.md           # How cycling works
│   ├── alternatives.md      # How alternatives are generated/displayed
│   ├── config.md            # Editor-specific configuration
│   └── ...                  # One doc per feature group
├── src/                     # Source code
└── tests/                   # Integration tests
```

## What to implement

Read `docs/features/README.md` for the full list. At minimum, implement:

| Priority | Feature | Why |
|----------|---------|-----|
| **Required** | Navigation (1) | Core interaction — user needs to select words |
| **Required** | Cycling (2) | Core interaction — user needs to change words |
| **Required** | Visual Cues (3) | User must see what's interactive |
| **Required** | Remote Cues (7) | The primary value — smart word suggestions |
| **Required** | Auto-Submit (12) | Analysis must trigger automatically |
| Recommended | Local Cues (6) | Instant alternatives, much faster than remote cues |
| Recommended | Fill-in-the-Blank (8) | Popular feature for knowledge/math |
| Recommended | Secondary Display (14) | Shows cue-tips and cycle position |
| Optional | Linked Words (5) | Agreement tracking |
| Optional | Multi-Word Spans (9) | Complex but useful for factual answers |
| Optional | Cue-Controls (11) | Platform-specific external triggers |
| Optional | Cursor Export (13) | For external tool integration |

## Using opencues-core

Every integration uses the same opencues-core library:

```typescript
import { buildSourcesFromConfig, createResolver, parseCuesMd, NodeHttpAdapter } from 'opencues-core';

// 1. Set up HTTP adapter
const httpAdapter = new NodeHttpAdapter({
  providerOverrides: { "api.groq.com": { reasoning_effort: "low", max_tokens: 400 } }
});

// 2. Build sources from .md config files
const cuesCfg = parseCuesMd(fs.readFileSync('cues.md', 'utf8'));
const blanksCfg = fs.existsSync('blanks.md') ? parseCuesMd(fs.readFileSync('blanks.md', 'utf8')) : undefined;
const sources = buildSourcesFromConfig(cuesCfg, blanksCfg, {
  httpAdapter, endpoint: 'https://api.groq.com/openai/v1/chat/completions',
  apiKey: process.env.GROQ_API_KEY, defaultModel: 'openai/gpt-oss-120b',
});

// 3. Create resolver
const resolver = createResolver(sources);

// 4. Analyse text
const result = await resolver.resolve({
  text: "The quick fox",
  words: ["The", "quick", "fox"],
  metadata: { targetIndices: [1, 2] }
});

// 5. Use results
for (const cue of result.results) {
  console.log(`${cue.word}: ${cue.alternatives.join(', ')}`);
}
```

For local cues:

```typescript
import { parseLocalCueFile, buildLookupMap, lookupMultiple } from 'opencues-core';

const tipsData = parseLocalCueFile(tipsJsonString);
const tipsMap = buildLookupMap(tipsData);
const result = lookupMultiple(words, tipsMap);
// result.found = WordDef[], result.missingIndices = number[]
```

## Platform-specific decisions

Each integration makes its own choices for:

| Decision | Examples |
|----------|---------|
| **Navigation UI** | Keyboard shortcuts, click, hover, gesture |
| **Visual rendering** | ANSI codes, CSS classes, editor decorations |
| **Trigger mechanism** | Keystroke listener, debounced input event, save hook |
| **Status display** | Status bar, tooltip, hover card, sidebar panel |
| **State storage** | globalThis, React state, editor API, file |
| **Configuration** | JSON file, editor settings, environment variables |

## Documentation convention

Each integration doc should state which features it implements:

```markdown
# Navigation — My Editor

Implements feature 1 from `docs/features/navigation.md`.

**Source file:** `src/navigation.ts`
```

## Checklist

- [ ] Directory created at `integrations/my-editor/`
- [ ] Implements required features (1, 2, 3, 7, 12)
- [ ] Uses opencues-core for LLM/local cue logic
- [ ] Docs reference feature numbers from `docs/features/`
- [ ] Tests cover core functionality
- [ ] README.md with install instructions

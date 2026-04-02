---
last_updated: 2026-04-02
---

# Adding a New Feature

How to add a new feature concept to the cues system.

## 1. Document the concept

Create a new file in `docs/features/`:

```
docs/features/my-feature.md
```

Follow this template:

```markdown
---
last_updated: YYYY-MM-DD
---

# My Feature

[2-3 sentence description of what the feature does and why.]

## How it works

[Conceptual explanation. No code, no platform specifics.]

## Data model

[What fields/state does this feature need? What does the integration store?]

## Integration requirements

[What must an integration provide to support this feature?]
```

## 2. Update the feature index

Add a row to `docs/features/README.md`:

```markdown
| 15 | [My Feature](my-feature.md) | Brief description |
```

## 3. Implement in cues-core (if needed)

If the feature needs new LLM logic, sources, or data types:

1. Add types to `packages/cues-core/src/types.ts`
2. Add source/logic to `packages/cues-core/src/sources/`
3. Export from `packages/cues-core/src/index.ts`
4. Add tests

## 4. Implement in each integration

For Claude Code: add to the appropriate patch file and create/update the CC doc.

For other integrations: follow `adding-an-integration.md` for the integration's doc structure.

## 5. Checklist

- [ ] Feature concept doc in `docs/features/`
- [ ] Feature index updated in `docs/features/README.md`
- [ ] cues-core changes (if needed)
- [ ] At least one integration implements it
- [ ] Integration doc references the feature number

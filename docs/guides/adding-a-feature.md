---
last_updated: 2026-07-04
---

# Adding a New Feature

How to add a new feature concept to OpenCues. Two distinct cases, and
they need different follow-through:

- **A new `OPENCUES.md` scalar** (a toggle/setting a user can flip) —
  the registry handles almost everything for you. Skip to
  [If it's a toggle](#if-its-a-toggle-registry-driven) below.
- **A new capability with no user-facing scalar** (e.g. a new cue
  source class, a new `_` shape) — write the concept doc, then
  implement per [`adding-an-integration.md`](adding-an-integration.md)'s
  "Wire the new host into shared code" section if it touches adapter
  behavior.

Worked example for the toggle case: `max-thinking`
(`docs/architecture/max-thinking.md`) went from "doesn't exist" to
shipped as one `FEATURES` entry + one config-loader parse case — no
edits to `host.cjs`, `doctor.cjs`, or `seed-configs.cjs` were needed.

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

Real, filled-in examples to copy from: `docs/features/max-thinking.md`
(a scalar-driven feature, short) or `docs/features/agent-task.md` (a
capability with real runtime behavior, longer).

## 2. Update the feature index

Add a row to `docs/features/README.md`, in the chapter that fits it
best (see that file's own "Contents" list) — the number is a stable
identifier, so pick the next unused one and don't renumber existing
rows:

```markdown
| 43 | [My Feature](my-feature.md) | Brief description |
```

## If it's a toggle (registry-driven)

**Do not** hand-edit `host.cjs`'s file-push list, `doctor.cjs`'s
diagnostic rows, or `seed-configs.cjs`'s templates — all three are
derived from the registry now, and editing them directly just
reintroduces the drift the registry was built to close. Instead:

1. Append one entry to `FEATURES` (or `MENU_TUNABLES`) in
   `packages/opencues-core/src/feature-registry.ts`.
2. If TypeScript consumers need a typed field (not just a string),
   also add it to `OpenCuesState` and the parse case in
   `packages/opencues-runtime/src/modules/config-loader.ts` — a drift
   test pins that every registry scalar has a matching typed field.
3. Add the runtime logic that reads the scalar (wherever the feature
   actually lives — a source, a module, a resolver branch).
4. Add tests.

Full walkthrough with a concrete example (`agent-mode: on/off`):
[`docs/architecture/feature-registry.md`](../architecture/feature-registry.md)
§ "How to add a new feature".

## If it needs new adapter behavior

Follow [`adding-an-integration.md`](adding-an-integration.md)'s "Wire
the new host into shared code" section — it covers exactly this: new
code in `@opencues/core`/`@opencues/runtime`, JSON schemas, docs/specs,
templates, and which per-host files need a touch.

## Checklist

- [ ] Feature concept doc in `docs/features/`
- [ ] Feature index updated in `docs/features/README.md`
- [ ] If a toggle: one `FEATURES`/`MENU_TUNABLES` entry (not hand-edits to host.cjs/doctor.cjs/seed-configs.cjs)
- [ ] If new adapter behavior: wired per `adding-an-integration.md`
- [ ] Tests added
- [ ] At least one integration implements it end-to-end

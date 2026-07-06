# Status-bar position (Chrome)

**Chrome-only.** Where the in-page floating OpenCues status bar sits.
The CLI hosts (Claude Code, OpenCode, Gemini CLI, Shell) render into
their host's own footer/statusline and ignore this setting.

Chrome has no host statusline, so OpenCues paints its own floating bar
over the page to show tips, the cycling menu, provider-health, and the
kata coach. On a real web page that bar can occlude content, so its
position is user-configurable.

| Value | Effect |
|---|---|
| `bottom` | **Default.** Full-width band along the bottom of the viewport. |
| `top` | Full-width band along the top. |
| `right` | Compact panel in the bottom-right corner (the original "half mode"). |

All three wrap onto multiple lines when the content is long, so a long
tip or coach line is never truncated.

## Changing it

Three ways, all equivalent (they write the same `statusbar-position`
scalar in `~/.cues/OPENCUES.md`):

- **Settings menu** — `opencues settings _`, cycle to *Status-bar
  position* (only listed on Chrome — see host-scoping below).
- **Fluid-config intent** — type a plain request ending in `_`:
  `move the status bar to the top _`, `status bar bottom _`. The
  fluid-config classifier routes it to this setting (it's a real
  FEATURE, so it's in the classifier's choice space automatically).
- **Edit the file** — `statusbar-position: top` in `OPENCUES.md`
  frontmatter.

## Host-scoping — why it's Chrome-only in the menus

`statusbar-position` is declared in the FEATURES registry
(`packages/opencues-core/src/feature-registry.ts`) with
`hostScope: ['chrome']`. That flag does two things, in lockstep:

1. **Settings menu** — the setting only appears when cycling settings on
   Chrome. On the CLI hosts it's hidden (it would be inert — they don't
   paint this bar).
2. **Fluid-config classifier** — the intent classifier's prompt is
   built per-host from the registry, filtered by `hostScope`. On
   non-Chrome hosts the setting isn't even in the classifier's choice
   space, so `move the status bar _` can't accidentally resolve to a
   no-op there.

Both paths derive from the single `hostScope` field, so they can't
drift. This is the general mechanism for any host-specific setting —
see [`docs/architecture/feature-registry.md`](../architecture/feature-registry.md).

## Implementation pointers

- Registry entry: `feature-registry.ts` (`scalar: 'statusbar-position'`,
  `camelCase: 'statusbarPosition'`, `hostScope: ['chrome']`).
- Rendering + position application:
  `integrations/chrome/src/runtime-statusbar.ts`
  (`setStatusbarPosition` / `applyPosition` / `refreshPosition`) and the
  `.oc-status-bar--pos-{bottom,top,right}` rules in
  `integrations/chrome/src/content.css`.
- Host-filtered classifier prompt: `buildFeatureBlock(hostName)` in
  `packages/opencues-core/src/sources/config-intent-source.ts`.

// scripts/bundle.ts — pre-build src/app.tsx to dist/app.js for fast
// popup launches.
//
// Why this exists (and why `bun build --plugin` from the CLI doesn't
// suffice): @opentui/solid exposes its JSX runtime only via a bun
// plugin (`@opentui/solid/bun-plugin`). At runtime, bunfig.toml
// preloads `@opentui/solid/preload` which registers the plugin
// globally; that's how src/app.tsx works without an explicit JSX
// import. For BUILDING, we need to apply the same plugin via the
// programmatic Bun.build() API — the CLI doesn't pick up the
// preload's global registration.
//
// Output: dist/app.js (~20KB), warm-launch ~200ms instead of the
// ~1.5-2s cold start that re-running src/app.tsx pays.

import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const start = Date.now()

// (Tried bytecode: true to skip parsing on subsequent runs — Bun
// 1.3.13 segfaults inside the bytecode loader for our module graph.
// Disabled until the bun bug is fixed upstream.)
const result = await Bun.build({
  entrypoints: ["./src/app.tsx"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  // Externals — modules that resolve at runtime via the staged
  // node_modules. Keeping the heavy deps external also keeps the
  // bundle small (~20KB instead of ~MB).
  external: [
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
    "@opencues/core",
    "@opencues/runtime",
  ],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  // The plugin transforms JSX inline (babel-preset-solid under the
  // hood) so the output has no `import { jsx } from
  // '@opentui/solid/jsx-runtime'` calls — those would resolve to the
  // package's .d.ts and crash at runtime.
  plugins: [createSolidTransformPlugin()],
})

if (!result.success) {
  console.error("bundle failed:")
  for (const m of result.logs) console.error("  " + m.message)
  process.exit(1)
}

const elapsed = Date.now() - start
const bytes = result.outputs[0]?.size ?? 0
console.log(`bundle: dist/app.js  ${(bytes / 1024).toFixed(2)} KB  (${elapsed}ms)`)

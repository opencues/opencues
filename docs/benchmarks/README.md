---
last_updated: 2026-07-04
---

# Benchmark write-ups (dated snapshots)

This directory holds narrative, point-in-time benchmark reports — human-readable write-ups of a specific comparison run on a specific date. It is **not** the live benchmark system.

For current numbers, the runnable bench code, and the up-to-date cross-bench landing page, go to **[`tests/benchmarks/`](../../tests/benchmarks/BENCHMARKS.md)** instead — specifically:

- [`tests/benchmarks/BENCHMARKS.md`](../../tests/benchmarks/BENCHMARKS.md) — the current cross-bench landing page ("given my task and constraints, which provider × mode should I pick?").
- [`tests/benchmarks/CLAUDE.md`](../../tests/benchmarks/CLAUDE.md) — how the bench harness is laid out, and how to add a new provider/model.
- Each pipeline's own `EXPERIMENTS.md` (e.g. `tests/benchmarks/transform-blank/EXPERIMENTS.md`) — the running experiment log with every design decision's accuracy delta.

A file here (e.g. [`2026-05-08-provider-bench.md`](2026-05-08-provider-bench.md)) is a **snapshot** — pricing, latency, and default-provider framing reflect what was true on that date and may since be stale. Treat it as historical evidence for a past decision, not a live reference.

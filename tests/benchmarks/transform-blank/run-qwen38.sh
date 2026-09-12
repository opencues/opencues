#!/usr/bin/env bash
set -euo pipefail
# qwen/qwen3.8-27b is Groq PREVIEW tier with an 8000 TPM org-wide cap
# (confirmed live) and FUSED_SYSTEM alone is ~3.6k tokens, so this can
# sustain only ~2 calls/min. Serial (parallel=1) + patient rate-limit
# retries (production's own backoff, not a bench hack) + a representative
# 38-case subset (2 per category, 19 categories) instead of the full 487
# keeps this to a tractable wall-clock time.
export OPENCUES_GROQ_MODEL="qwen/qwen3.8-27b"
export OPENCUES_RATE_LIMIT_RETRIES=8
cd "$(dirname "$0")/../../.."
npx tsx tests/benchmarks/transform-blank/prod.ts --provider groq --parallel 1 --only-file tests/results/qwen38-subset-ids.txt

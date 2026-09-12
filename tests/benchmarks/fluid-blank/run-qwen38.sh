#!/usr/bin/env bash
set -euo pipefail
# See transform-blank/run-qwen38.sh for the same 8000-TPM-preview-tier
# rationale. fluid-blank's answer-mode P1/P3 prompts are much smaller
# (~500-900 tokens each) than transform-blank's FUSED_SYSTEM, so the full
# 137-case suite is tractable serially — groq-qwen38.ts's chat() already
# parses Groq's "try again in Xs" hint and waits exactly that.
export OPENCUES_BENCH_PROVIDER="groq-qwen38"
export OC_BENCH_RETRIES=10
cd "$(dirname "$0")/../../.."
npx tsx tests/benchmarks/fluid-blank/run.ts --mode answer --parallel 1

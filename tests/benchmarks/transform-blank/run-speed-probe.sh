#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
npx tsx tests/benchmarks/transform-blank/speed-probe-qwen38.ts

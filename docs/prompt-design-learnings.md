---
last_updated: 2026-03-31
---

# Prompt Design Learnings

General principles learned from optimizing LLM prompts.

## 1. Output Tokens Dominate Latency

Input prompt size has minimal impact on latency. A 320-line prompt runs at similar speed to a 60-line prompt if they produce similar output lengths.

**Why:** LLMs process input tokens in parallel but generate output tokens sequentially. A long prompt with short output is faster than a short prompt with long output.

**Implication:** Don't over-optimize input size. Focus on output efficiency.

## 2. Test Variance, Not Just Averages

A minimal prompt may average well in benchmarks but have high variance between runs. A slightly larger prompt with explicit guidance can produce more consistent results.

**Implication:** Run multiple tests. Consistency matters more than peak performance.

## 3. Explicit Guidance Improves Consistency

Telling the model exactly what to look for (e.g., "Provide 3 alternatives per word: synonym, opposite, creative") constrains it to produce predictable output.

**Implication:** Be specific about what you want. Vague prompts produce inconsistent results.

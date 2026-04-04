# OpenCues — TODOs

## Classifier

- **Detect misclassification before full LLM round-trip.** Currently if the classifier picks the wrong source (e.g., factual for a grammar input), the wrong source makes a full LLM call, gets empty results, then falls back to grammar — costing two LLM round-trips. Could the system detect early that the source will fail (e.g., confidence score from classifier, or a quick pre-check on the input) and skip straight to the fallback?

## Benchmark

- **Reduce word alternative flakiness.** ~41% of word tests are flaky across runs because the LLM returns valid synonyms not in the expected list. Options: widen expected lists based on multi-run data, switch to semantic similarity checking instead of exact match, or accept a "valid alternative" threshold rather than checking for specific words.

# OpenCues — TODOs

## Classifier

- **Detect misclassification before full LLM round-trip.** Currently if the classifier picks the wrong source (e.g., factual for a grammar input), the wrong source makes a full LLM call, gets empty results, then falls back to grammar — costing two LLM round-trips. Could the system detect early that the source will fail (e.g., confidence score from classifier, or a quick pre-check on the input) and skip straight to the fallback?


# OpenCues — TODOs

## Classifier

- **Detect misclassification before full LLM round-trip.** Currently if the classifier picks the wrong source (e.g., factual for a grammar input), the wrong source makes a full LLM call, gets empty results, then falls back to grammar — costing two LLM round-trips. Could the system detect early that the source will fail (e.g., confidence score from classifier, or a quick pre-check on the input) and skip straight to the fallback?

## Control-Bound Blanks

- **LLM-based prompt relevance detection.** Instead of relying solely on keyword matching + proximity for binding blanks to controls, use the LLM to determine if the user's input is semantically relevant to a control. For example, "make it louder _" has no keyword match but is clearly a volume intent. A lightweight classifier prompt could route ambiguous inputs to the right control — similar to how the blanks classifier routes to math/factual/grammar modes. This would make control-bound blanks work with natural language rather than requiring exact keyword placement.

## Weather Control

- **More robust location extraction.** The current approach scans context words from the end and takes the first non-skip word as the location. This works for common phrasings ("What is the weather in London _") but is fragile — any unknown word near the end could be mistaken for a location. Possible improvements:
  - Geocode multiple candidate words and pick the one with the highest population.
  - Use a two-pass approach: first try words after prepositions like "in", "for", "at"; fall back to reverse scan.
  - Use the LLM classifier to extract the location from natural language before calling the weather API.
- **Multi-word location names.** "New York", "San Francisco", "Cape Town" are split into separate words. The script currently only picks one word. Could try adjacent word combinations (e.g., "New" + "York" → "New York") and geocode the combined string.


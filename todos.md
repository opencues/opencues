# OpenCues — TODOs

## Keyword-bound blanks

- **LLM-based prompt relevance detection.** Instead of relying solely on `blankKeywords` + `blankProximity` for binding `_` to a blank, use the LLM to determine if the user's input is semantically relevant to a registered blank. For example, "make it louder _" has no keyword match but is clearly a volume intent. A lightweight classifier could route ambiguous inputs to the right blank — bridging keyword-bound blanks (`BlankSource`) and free-form lookups (`FluidBlankSource`).

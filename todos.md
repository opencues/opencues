# OpenCues — TODOs

## About.md — user context file

- **User-level identity/preferences file injected into LLM prompts.** Lets the user declare stable facts (name, country, locale, tone, free-form notes) that the resolver fluidly weaves into every call. Lives at `~/.cues/ABOUT.md` (user-level only — projects can't override, same scoping as system-settings frontmatter). Likely shape: hybrid — structured frontmatter for fields blanks branch on (`name`, `locale`, `timezone`) + a `notes:` body for free-form prose. Resolver exposes `ctx.about` to sources/prompt templates; gated through one accessor rather than raw string-interp. Wire once into `RoutedWordSourceGroup` prompt assembly so every source benefits without per-source code. Open question: opt-in per source vs always-on (always-on is cheaper but leaks identity into every call).

## Keyword-bound blanks

- **LLM-based prompt relevance detection.** Instead of relying solely on `blankKeywords` + `blankProximity` for binding `_` to a blank, use the LLM to determine if the user's input is semantically relevant to a registered blank. For example, "make it louder _" has no keyword match but is clearly a volume intent. A lightweight classifier could route ambiguous inputs to the right blank — bridging keyword-bound blanks (`BlankSource`) and free-form lookups (`FluidBlankSource`).

## Weather blank

- **More robust location extraction.** The current approach scans context words from the end and takes the first non-skip word as the location. Works for common phrasings ("What is the weather in London _") but is fragile — any unknown word near the end could be mistaken for a location. Possible improvements:
  - Geocode multiple candidate words and pick the one with the highest population.
  - Two-pass: first try words after prepositions like "in", "for", "at"; fall back to reverse scan.
  - Use an LLM call to extract the location from natural language before hitting the weather API.
- **Multi-word location names.** "New York", "San Francisco", "Cape Town" split into separate words. The blank currently only picks one word. Could try adjacent word combinations (e.g., "New" + "York" → "New York") and geocode the combined string.

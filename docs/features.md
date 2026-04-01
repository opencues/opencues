---
last_updated: 2026-04-01
---

# Cues Feature Concepts

Platform-agnostic feature specifications. Each integration implements these concepts with its own UI.

---

## 1. Word Navigation

Move between words in the input. The user selects which word to focus on.

**Navigation modes:**

| Mode | What's navigable | Example |
|------|-----------------|---------|
| Numbers | Only numeric tokens | `"abc 1 test 3"` → 1, 3 |
| Words | All words | `"abc 1 test 3"` → abc, 1, test, 3 |
| Gender | Only gender root words (boy/girl) | `"The boy said he"` → boy |
| Both | Numbers + gender roots | `"The boy has 3 cats"` → boy, 3 |

Additionally, words with LLM alternatives or tips are always navigable regardless of mode.

Action words (configured external triggers) are always navigable.

---

## 2. Word Cycling

Replace the focused word with an alternative from the `alts` array.

- `currentAltIndex` tracks position in the cycle
- Original word is always `alts[0]`
- Wraps around: after the last alt, returns to `alts[0]`

**Cycling priority** (checked in order):
1. **Action word** → trigger external action, don't modify word
2. **Gender root** (boy/girl) → use hardcoded linked group flip, skip LLM alts
3. **Dynamic alts** → cycle through `alts` array from `_dynDefs`
4. **Number** → increment/decrement
5. **Gender (non-root)** → handled via linked words

### Number Increment/Decrement

Numbers have special cycling behaviour:

- **Up**: increments by 1 (no upper limit): 0 → 1 → 2 → 3...
- **Down**: decrements by 1, but never below the **floor**
- The **floor** is the original value captured on first Up or Down press (not when highlighting)
- Each number tracks its floor independently via an `originalNumbers` map keyed by word index
- Navigating away and back preserves the floor

Example: highlight `0`, press Up 4 times → 1 → 2 → 3 → 4. Press Down 6 times → 3 → 2 → 1 → 0 → 0 → 0 (floors at 0).

### Gender Cycling

Gender root words (boy/girl) trigger linked group flips:

- **Up** flips only the selected root's linked group:
  - boy → girl, he → she, him → her, his → her, man → woman, he's → she's
  - girl → boy, she → he, her → him, woman → man, she's → he's
- **Down** restores ALL words to original gender (stored in `originalGender`)
- **Case preservation**: character-by-character (He→She, HIM→HER, Boy→Girl)
- Only root words (boy/girl) are directly selectable; linked words change automatically

---

## 3. Visual States

Words need three visual states so the user knows what's interactive:

| State | Meaning | When |
|-------|---------|------|
| **Normal** | No alternatives available | Default |
| **Dimmed** | Has alternatives, can be navigated to | Word has `alts.length > 1` and word is IN the alts array |
| **Highlighted** | Currently selected for cycling | User navigated to this word |

When a word is highlighted AND part of a span or linked group, all related words also show the highlighted state.

Dimming applies to: numbers (if numberDimming enabled), gender root words, action words, and words with dynamic alternatives.

---

## 4. Cursor Position Preservation

When words change length (cycling, gender flip, number increment), the cursor must adjust:

- Replacement **before** cursor → offset adjusts by length difference (e.g., boy→girl adds 1)
- Replacement **after** cursor → offset unchanged
- Cursor at **end** of text → stays at end
- Gender restore (Down) → offset clamps to new text length

---

## 5. Linked Words

Words that must change together when any one of them cycles.

- `linked` array on each word definition contains indices of co-dependent words
- All linked words cycle to the same `currentAltIndex`
- When the user cycles a word, all its linked words update simultaneously

**Built-in linked groups (gender):**
- Male: boy, he, him, his, man, he's
- Female: girl, she, her, woman, she's

**LLM-generated links:**
The linked words prompt (`linked.txt`) detects semantic relationships:
- Gender agreement: "The boy loves his dog" → boy↔his
- Number agreement: "The cats chase their toys" → cats↔their↔toys
- Verb agreement: "She runs" → she↔runs

---

## 6. Tips System

Instant per-word alternatives and hints from a local JSON file. No LLM call needed (~0ms).

**How it works:**
1. At startup, tips file is parsed and a hash map is built (`buildLookupMap`) — O(n) once
2. On each analysis trigger, every word is checked against the map — O(1) per word
3. Words with matches get instant alts + tip text
4. Non-matching words are sent to the LLM

**Tips file supports two formats:**

Groups (synonyms share a tip, alts point to other concepts):
```json
{
  "id": "parallel-execution",
  "groups": [{
    "synonyms": ["agents", "sub-agents", "spawn"],
    "tip": "Spawn parallel workers via Task tool",
    "alts": ["swarm", "background"]
  }]
}
```

Words (individual entries):
```json
{
  "id": "extended-thinking",
  "words": {
    "ultrathink": {
      "tip": "Add 'ultrathink' for max reasoning",
      "alts": ["Tab", "deep thinking"]
    }
  }
}
```

**Per-alternative tips (`altTips`):**
When cycling from "agents" to "swarm", the tip updates to show swarm's tip. This is built at lookup time by cross-referencing other sections.

---

## 7. LLM Alternatives

For words not in the tips file, an LLM generates alternatives via cues-core's `CueResolver`.

**Sources (by priority):**

| Source | Priority | When | Output format |
|--------|----------|------|---------------|
| TipsFileSource | 100 | Always (instant) | Direct alternatives |
| MathSource | 90 | Input has `_` + looks like math | `COMPUTE=expression` → eval |
| FactualSource | 90 | Input has `_` + looks like factual | `ANSWER=value` |
| GrammarSource | 50 | Always (fallback) | `INDEX:alt1,alt2,alt3` |

**Priority resolution:** Higher priority wins. If tips and grammar both provide alts for the same word, tips wins. Same-priority results merge (deduplicated).

**GrammarSource prompt:** Requests "synonym, opposite, creative" for each word. Includes extensive examples for adjectives, adverbs, verbs, nouns, proper nouns, emotional words. Output: `1:gorgeous,ugly,stunning|3:joyful,sad,cheerful`

**Targeted index optimisation:** After the first full analysis, subsequent triggers only send words that don't already have valid alts. The prompt includes: "Generate exactly N entries for indices: X,Y."

---

## 8. Fill-in-the-Blank

Typing `_` (underscore) creates a blank that the system fills contextually.

**Classification:** The system detects what kind of blank this is:
- `looksLikeMath(text)` — contains operators, percentages, math keywords
- `looksLikeFactual(text)` — matches "the X of Y is", "who/what/when", capital/CEO patterns
- Default → grammar (fill with grammatically correct word)

**Blank position detection** (grammar mode):

| What's AFTER blank | What's BEFORE blank | Blank needs |
|-------------------|---------------------|-------------|
| Verb (ran, walked) | Determiner (The) | **NOUN** (subject) |
| Noun (dog, team) | Determiner (The) | **ADJECTIVE** |
| Noun/Adjective | Nothing (start) | **DETERMINER** |
| Adverb (quickly) | Subject | **VERB** |

Examples:
```
"The _ dog barked"  → big, small, brown, happy
"The _ ran quickly" → dog, boy, girl, athlete
"_ dog barked"      → The, A, My, That
"She _ quickly"     → ran, walked, moved
"4 * 12 = _"        → 48
"Capital of France is _" → Paris
```

**Context invalidation:** If words around the blank change (e.g., "CEO of Google" → "CEO of Microsoft"), cached alts are cleared and re-analysis triggers. Cycling the blank itself does NOT trigger invalidation.

**Separate prompts:** Grammar blanks use `blank_grammar.txt` (different from `grammar.txt`) because blank filling needs a different word TYPE than the surrounding words, while regular alternatives stay the same type.

---

## 9. Multi-Word Spans

An alternative can be multiple words (e.g., `_` → "Sundar Pichai", "toy" → "stuffed animal").

**The problem:** The system uses word indices for tracking. Replacing one word with two shifts all subsequent indices.

**The solution:** Span tracking maps each word of the replacement back to the original index:

```
Before: "The CEO of Google is _"         (indices 0-5)
After:  "The CEO of Google is Sundar Pichai"  (indices 0-6)

Span map: { 5: {originalIndex: 5, spanLength: 2},
            6: {originalIndex: 5, spanLength: 2} }
```

**Behaviour:**
- All span words cycle as a unit (cycling "Pichai" cycles "Sundar Pichai")
- Navigation to any span word redirects to the original index
- Non-original span positions are skipped during navigation
- Dimming and highlighting apply to all words in the span
- Re-analysis protects span words from getting individual alternatives
- Cycling back to a single word clears the span tracking

---

## 10. Per-Word Clearing

When the user edits text, alternatives are preserved intelligently rather than discarding everything.

**Rules:**

| Edit | What happens |
|------|-------------|
| Word changes to something IN alts | Update `currentAltIndex` (valid cycle) |
| Word changes to something NOT in alts | Word becomes non-navigable, but alts preserved |
| Word count changes (add/remove word) | Clear affected positions, auto-submit re-analyses |
| Word typed back to original | Alts restored (they were never deleted) |

**Typing recovery:** "dog" → "do" → "dog" — during "do", the word is not navigable (not in alts), but the alts array `["dog", "cat", "puppy"]` is preserved. When the user types "g" to make "dog" again, it matches alts and becomes navigable immediately.

**Why this matters:** Without per-word clearing, every keystroke would discard all LLM results (~400ms to regenerate). With it, only changed words need fresh analysis.

---

## 11. Action Words

Special words that trigger external actions instead of cycling through alternatives.

- Checked **first** before any other cycling logic
- The word is NOT modified — it triggers a side effect
- Configured per-word with custom arguments for up/down directions
- Examples: "volume" → system volume, "brightness" → screen brightness

**Priority:** Action words → dynamic alts → gender flip → number increment

---

## 12. Auto-Submit Trigger

Analysis fires automatically as the user types. Three tiers:

| Tier | Trigger | Debounce | Purpose |
|------|---------|----------|---------|
| 1 | Space typed (word count increases) | 50ms | Analyse just-completed word |
| 2 | No typing for 300ms | 300ms | Analyse final word (no trailing space) |
| 3 | Word edited mid-sentence (same count) | 50ms | Re-analyse changed word |

**Optimisations:**
- **Targeted indices**: after first full analysis, only words lacking alts are sent to the LLM
- **Duplicate prevention**: `_dynPending` flag prevents overlapping requests
- **Tips first**: instant tips lookup runs before LLM, merging results immediately
- **Skip if complete**: if all words have alts (from tips or previous LLM), skip LLM entirely

---

## 13. Cursor State Export

Export the current cursor position and context for external tools.

**Output format:**
```json
{
  "text": "hello world",
  "cursorPosition": 6,
  "currentWord": "world",
  "atEnd": false,
  "textLength": 11,
  "timestamp": 1705500000000
}
```

- Debounced writes (~100ms) to avoid I/O overhead
- Written to a configurable path (default: `/tmp/claude-cursor-state.json`)
- Enables external tools to react to cursor position

---

## 14. Status Display

Secondary display showing info about the highlighted word.

**What to show:**
- Current word name
- Position in cycle (e.g., "2/4")
- Tip text (if available from tips file)
- Per-alt tip when cycling (from `altTips`)

**Integration decides the UI:** status bar, tooltip, hover panel, sidebar, etc.

**Data source:** The highlight state is exported to a JSON file containing `highlightedWord`, `tip`, `alts`, `currentAltIndex`, and `altTips`. The display reads this and formats accordingly.

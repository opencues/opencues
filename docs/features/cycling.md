---
last_updated: 2026-04-02
---

# Word Cycling

Replace the focused word with an alternative from the `alts` array.

- `currentAltIndex` tracks position in the cycle
- Original word is always `alts[0]`
- Wraps around: after the last alt, returns to `alts[0]`

**Cycling priority** (checked in order):
1. **Action word** → trigger external action, don't modify word
2. **Gender root** (boy/girl) → use hardcoded linked group flip, skip LLM alts
3. **Dynamic alts** → cycle through alternatives from LLM/tips
4. **Number** → increment/decrement
5. **Gender (non-root)** → handled via linked words

### Number Increment/Decrement

Numbers have special cycling behaviour:

- **Up**: increments by 1 (no upper limit): 0 → 1 → 2 → 3...
- **Down**: decrements by 1, but never below the **floor**
- The **floor** is the original value captured on first Up or Down press (not when highlighting)
- Each number tracks its floor independently (keyed by position)
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



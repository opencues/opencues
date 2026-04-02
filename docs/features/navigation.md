---
last_updated: 2026-04-02
---

# Word Navigation

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



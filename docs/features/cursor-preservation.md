---
last_updated: 2026-04-02
---

# Cursor Position Preservation

When words change length (cycling, gender flip, number increment), the cursor must adjust:

- Replacement **before** cursor → offset adjusts by length difference (e.g., boy→girl adds 1)
- Replacement **after** cursor → offset unchanged
- Cursor at **end** of text → stays at end
- Gender restore (Down) → offset clamps to new text length



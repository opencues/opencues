---
last_updated: 2026-04-02
---

# Cursor Position Preservation

When words change length (cycling, number increment), the cursor must adjust:

- Replacement **before** cursor → offset adjusts by length difference
- Replacement **after** cursor → offset unchanged
- Cursor at **end** of text → stays at end



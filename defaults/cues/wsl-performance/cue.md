---
name: wsl-performance
---

```json
{
  "slow": {
    "tip": "Run on native Linux/macOS - WSL has overhead",
    "alts": [
      "wsl",
      "performance",
      "lag"
    ]
  },
  "wsl": {
    "tip": "WSL has overhead - native Linux/macOS is faster",
    "alts": [
      "slow",
      "performance",
      "lag"
    ]
  },
  "performance": {
    "tip": "For best performance, run on native Linux/macOS not WSL",
    "alts": [
      "slow",
      "wsl",
      "lag"
    ]
  },
  "lag": {
    "tip": "Experiencing lag? WSL is slower than native Linux/macOS",
    "alts": [
      "slow",
      "wsl",
      "performance"
    ]
  }
}
```

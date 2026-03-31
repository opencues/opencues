---
last_updated: 2026-03-31
---

# Blank Position Detection

The grammar prompt detects blank position to suggest appropriate word types.

## Position Rules

| Position | Example | Word Type | Alternatives |
|----------|---------|-----------|--------------|
| Start of sentence | `_ dog barked` | Determiner | The, A, My, That, His |
| After determiner | `The _ dog` | Adjective | big, small, brown, happy |
| Before verb | `The _ ran` | Noun | dog, boy, man, child |
| Verb position | `He _ loudly` | Verb | shouted, whispered, ran |

## How It Works

The prompt includes the instruction:

```
Check what comes BEFORE and AFTER the blank to determine word type needed.
```

### Detection Logic

1. **Blank at start + noun/adjective after** → Determiner
2. **Determiner before + noun after** → Adjective
3. **Determiner before + verb after** → Noun (subject)
4. **Subject before + adverb after** → Verb

## Examples

```
Input:  "_ quick fox jumped"
Output: 0:The,A,That,One,Each

Input:  "The _ fox jumped"
Output: 1:quick,slow,brown,sly,hungry

Input:  "The _ ran away"
Output: 1:dog,boy,man,fox,child

Input:  "She _ quickly"
Output: 1:ran,walked,moved,left,spoke
```
